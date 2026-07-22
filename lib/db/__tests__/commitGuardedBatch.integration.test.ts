/**
 * The unified guarded writer against a REAL Postgres (the per-test-database
 * harness) — the commit chokepoint every blueprint commit (chat, MCP, auto-save,
 * the cross-Project move) shares.
 *
 * What this pins against a real `SELECT … FOR UPDATE` transaction:
 *
 *   - One transaction writes the entity-row DIFF, advances `mutation_seq`, and
 *     appends the `accepted_mutations` row (the delta + attribution) whose
 *     `UNIQUE (app_id, batch_id)` IS the idempotency latch. (NOTIFY delivery on
 *     the committed row is covered by the stream tests; here we assert the row.)
 *   - `mutation_seq` is a LITERAL `(fresh + 1)` read INSIDE the closure under the
 *     app-row lock, so a run of serial commits produces gap-free seqs, each
 *     re-reading the prior's advanced value.
 *   - A re-commit of the same `batchId` is idempotent — returns the prior
 *     seq/basis, writes NOTHING.
 *   - Per-commit reauth: a non-member / a role without `edit` is denied
 *     `CommitReauthError`; a null-`project_id` app defers to the owner (owner ok,
 *     non-owner denied, no auth read); a move away from the caller's expected
 *     Project rejects the distinct `AppProjectChangedError` terminal signal.
 *   - The batch re-applies onto the FRESH stored doc (a concurrent commit
 *     survives); a batch targeting a concurrently-removed entity or one the
 *     re-run verdict rejects is a `BlueprintCommitRejectedError`.
 *   - Media-attach expectations re-check against the `media_assets` rows read
 *     FOR SHARE (present+ready commits; a concurrently-deleted asset rejects).
 *   - The per-commit EDIT-lease refresh fires only for the lock-holding run.
 *   - `appendSyntheticBatch` upholds the identical seq+stream coupling while
 *     persisting the deterministic repair mutations under migration kind.
 *
 * The in-transaction `auth_member` role read is mocked so each test controls
 * the actor's fresh role; the reauth LOGIC downstream is the real code under
 * test (the role read itself is covered by the auth integration suites).
 *
 * Runs unconditionally under `npm test`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildDoc, caseListConfig, f, xp } from "@/lib/__tests__/docHelpers";
import { MAX_RUN_MINUTES } from "@/lib/db/constants";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import type { Mutation } from "@/lib/doc/types";
import type { BlueprintDoc } from "@/lib/domain";
import { setupAppStateTestDb } from "./appStateTestDb";

// The fresh role read is the only auth dependency in the guarded path. Mock it
// so each test controls the role observed under the app transaction's locks.
const { projectRoleForInTransactionMock } = vi.hoisted(() => ({
	projectRoleForInTransactionMock:
		vi.fn<(_tx: unknown, u: string, o: string) => Promise<string | null>>(),
}));
vi.mock("@/lib/db/projectMembership", () => ({
	// Keep the legacy out-of-transaction helper present for any incidental
	// module consumer; the guarded writer authorizes exclusively in-transaction.
	projectRoleFor: vi.fn(),
	projectRoleForInTransaction: projectRoleForInTransactionMock,
}));

const { appendSyntheticBatch, commitGuardedBatch, loadApp, UNTITLED_APP_NAME } =
	await import("../apps");
const {
	AppProjectChangedError,
	CommitReauthError,
	BlueprintCommitRejectedError,
} = await import("../commitGuard");
const { decomposeBlueprint } = await import("../blueprintRows");

const OWNER = "user-owner";
const MEMBER = "user-member";
const PROJECT = "project-1";

const h = setupAppStateTestDb("commit_guard_");

/** A minimal valid registration doc writing two case properties. */
function minDoc(appName = "Test"): BlueprintDoc {
	return buildDoc({
		appName,
		modules: [
			{
				name: "Mod",
				caseType: "patient",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						name: "Form",
						type: "registration",
						fields: [
							f({
								kind: "text",
								id: "case_name",
								label: "Name",
								case_property_on: "patient",
							}),
							f({
								kind: "text",
								id: "village",
								label: "Village",
								case_property_on: "patient",
							}),
						],
					},
				],
			},
		],
		caseTypes: [
			{
				name: "patient",
				properties: [
					{ name: "case_name", label: "Name" },
					{ name: "village", label: "Village" },
				],
			},
		],
	});
}

/** Seed a stored app at `mutation_seq: 0` with the given blueprint + tenancy,
 *  returning its id. Writes the `apps` scalar slice + the `blueprint_entities`
 *  rows exactly as `createApp` would, so the guarded writer reassembles it. */
async function seedApp(
	doc: BlueprintDoc,
	opts: { projectId: string | null; owner?: string } = { projectId: PROJECT },
): Promise<string> {
	const appId = crypto.randomUUID();
	const p = toPersistableDoc(doc);
	const formCount = p.moduleOrder.reduce(
		(s, m) => s + (p.formOrder[m]?.length ?? 0),
		0,
	);
	await h
		.db()
		.insertInto("apps")
		.values({
			id: appId,
			owner: opts.owner ?? OWNER,
			project_id: opts.projectId,
			app_name: p.appName,
			app_name_lower: (p.appName || UNTITLED_APP_NAME).toLowerCase(),
			connect_type: p.connectType ?? null,
			case_types: p.caseTypes === null ? null : JSON.stringify(p.caseTypes),
			logo: p.logo ?? null,
			module_count: p.moduleOrder.length,
			form_count: formCount,
			mutation_seq: 0,
			status: "complete",
			awaiting_input: false,
			error_type: null,
			deleted_at: null,
			recoverable_until: null,
			run_id: null,
			res_period: null,
			res_reserved: null,
			res_settled: null,
			res_user_id: null,
			res_run_id: null,
			lock_run_id: null,
			lock_actor_user_id: null,
			lock_expire_at: null,
		})
		.execute();
	const rows = decomposeBlueprint(p);
	if (rows.length > 0) {
		await h
			.db()
			.insertInto("blueprint_entities")
			.values(
				rows.map((r) => ({
					app_id: appId,
					uuid: r.uuid,
					kind: r.kind,
					parent_uuid: r.parent_uuid,
					ordinal: r.ordinal,
					data: JSON.stringify(r.data),
				})),
			)
			.execute();
	}
	return appId;
}

/** Seed a `ready` image asset in a Project. */
async function seedReadyImage(
	projectId: string,
	assetId = crypto.randomUUID(),
): Promise<string> {
	await h
		.db()
		.insertInto("media_assets")
		.values({
			id: assetId,
			project_id: projectId,
			owner: OWNER,
			content_hash: "a".repeat(64),
			mime_type: "image/png",
			extension: ".png",
			size_bytes: 1024,
			dimensions: JSON.stringify({ width: 64, height: 64 }),
			duration_ms: null,
			kind: "image",
			gcs_object_key: `projects/${projectId}/${"a".repeat(64)}.png`,
			original_filename: "icon.png",
			display_name: null,
			status: "ready",
			extract: null,
		})
		.execute();
	return assetId;
}

function villageUuid(doc: BlueprintDoc): string {
	const field = Object.values(doc.fields).find((fl) => fl.id === "village");
	if (!field) throw new Error("village field missing from fixture");
	return field.uuid;
}

function renameVillageLabel(doc: BlueprintDoc, label: string): Mutation[] {
	return [
		{
			kind: "updateField",
			uuid: villageUuid(doc),
			targetKind: "text",
			patch: { label },
		} as Mutation,
	];
}

function attachVillageLabelImage(
	doc: BlueprintDoc,
	assetId: string,
): Mutation[] {
	return [
		{
			kind: "setFieldMedia",
			fieldUuid: villageUuid(doc),
			slot: "label",
			media: { image: assetId },
		} as Mutation,
	];
}

/** The `mutation_seq` column (bigint → string) as a number. */
async function readSeq(appId: string): Promise<number> {
	const row = await h.readAppRow(appId);
	return Number(row?.mutation_seq);
}
/** All `accepted_mutations` rows for an app, seq-ordered. */
async function readStream(appId: string): Promise<
	Array<{
		seq: number;
		batch_id: string;
		run_id: string | null;
		actor_id: string;
		kind: string;
		mutations: unknown[];
	}>
> {
	const rows = await h
		.db()
		.selectFrom("accepted_mutations")
		.select(["seq", "batch_id", "run_id", "actor_id", "kind", "mutations"])
		.where("app_id", "=", appId)
		.orderBy("seq")
		.execute();
	return rows.map((r) => ({ ...r, seq: Number(r.seq) })) as never;
}

async function readRunFenceState(appId: string) {
	return h
		.db()
		.selectFrom("apps")
		.select([
			"mutation_seq",
			"status",
			"run_id",
			"res_period",
			"res_reserved",
			"res_settled",
			"res_user_id",
			"res_run_id",
			"lock_run_id",
			"lock_actor_user_id",
			"lock_expire_at",
			"updated_at",
		])
		.where("id", "=", appId)
		.executeTakeFirstOrThrow();
}

beforeEach(() => {
	// Default: the actor is an editor of the app's Project.
	projectRoleForInTransactionMock.mockReset().mockResolvedValue("editor");
});

describe("commitGuardedBatch (Postgres)", () => {
	it("persists MCP run attribution without granting it chat-holder authority", async () => {
		const doc = minDoc();
		const appId = await seedApp(doc);
		const batchId = crypto.randomUUID();

		const result = await commitGuardedBatch({
			appId,
			expectedProjectId: PROJECT,
			batchId,
			runId: "run-1",
			mutations: renameVillageLabel(doc, "Home village"),
			actorUserId: OWNER,
			kind: "mcp",
		});

		expect(result.seq).toBe(1);
		expect(result.deduped).toBe(false);
		expect(projectRoleForInTransactionMock).toHaveBeenCalledWith(
			expect.anything(),
			OWNER,
			PROJECT,
		);
		// The committed doc carries the edit.
		const village = Object.values(result.committedDoc.fields).find(
			(fl) => fl.id === "village",
		);
		expect(village && "label" in village && village.label).toBe("Home village");

		// The app row advanced its counter.
		expect(await readSeq(appId)).toBe(1);
		// The durable stream row carries the delta + attribution (the idempotency
		// latch is `UNIQUE (app_id, batch_id)` on this table).
		const stream = await readStream(appId);
		expect(stream).toHaveLength(1);
		expect(stream[0]).toMatchObject({
			seq: 1,
			batch_id: batchId,
			run_id: "run-1",
			actor_id: OWNER,
			kind: "mcp",
		});
		expect(stream[0].mutations).toHaveLength(1);
	});

	it("rejects chat attribution without explicit holder authority", async () => {
		const doc = minDoc();
		const appId = await seedApp(doc);
		const before = await readRunFenceState(appId);

		await expect(
			commitGuardedBatch({
				appId,
				expectedProjectId: PROJECT,
				batchId: crypto.randomUUID(),
				runId: "attribution-only",
				mutations: renameVillageLabel(doc, "Unauthorized chat write"),
				actorUserId: OWNER,
				kind: "chat",
			}),
		).rejects.toThrow("chat writes require matching chat holder authority");

		expect(await readRunFenceState(appId)).toEqual(before);
		expect(await readStream(appId)).toEqual([]);
	});

	it("persists the entity-row DIFF so the reassembled doc equals the committed doc", async () => {
		const doc = minDoc();
		const appId = await seedApp(doc);

		const result = await commitGuardedBatch({
			appId,
			expectedProjectId: PROJECT,
			batchId: crypto.randomUUID(),
			mutations: renameVillageLabel(doc, "Reassembled"),
			actorUserId: OWNER,
			kind: "autosave",
		});

		// Re-read the app fresh through the assembler and confirm the persisted
		// entity rows round-trip to the committed doc's village label.
		const { loadApp } = await import("../apps");
		const reloaded = await loadApp(appId);
		const village = Object.values(reloaded?.blueprint.fields ?? {}).find(
			(fl) => fl.id === "village",
		);
		expect(village && "label" in village && village.label).toBe("Reassembled");
		expect(reloaded?.mutation_seq).toBe(result.seq);
	});

	it("produces gap-free seqs across serial commits (each re-reads the advanced seq)", async () => {
		const doc = minDoc();
		const appId = await seedApp(doc);
		let working = doc;
		for (let i = 1; i <= 4; i++) {
			const result = await commitGuardedBatch({
				appId,
				expectedProjectId: PROJECT,
				batchId: crypto.randomUUID(),
				mutations: renameVillageLabel(working, `Village v${i}`),
				actorUserId: OWNER,
				kind: "autosave",
			});
			expect(result.seq).toBe(i);
			working = result.committedDoc;
		}
		expect((await readStream(appId)).map((r) => r.seq)).toEqual([1, 2, 3, 4]);
		expect(await readSeq(appId)).toBe(4);
	});

	it("is idempotent on a re-committed batchId — returns the prior seq/basis and writes nothing", async () => {
		const doc = minDoc();
		const appId = await seedApp(doc);
		const batchId = crypto.randomUUID();

		const first = await commitGuardedBatch({
			appId,
			expectedProjectId: PROJECT,
			batchId,
			mutations: renameVillageLabel(doc, "Home village"),
			actorUserId: OWNER,
			kind: "autosave",
		});
		expect(first.deduped).toBe(false);
		expect(first.seq).toBe(1);

		// A second commit of the SAME batchId — even with different mutations —
		// replays the latch: same seq, deduped, no new write.
		const replay = await commitGuardedBatch({
			appId,
			expectedProjectId: PROJECT,
			batchId,
			mutations: renameVillageLabel(doc, "IGNORED — dedup replay"),
			actorUserId: OWNER,
			kind: "autosave",
		});
		expect(replay.deduped).toBe(true);
		expect(replay.seq).toBe(first.seq);

		// The counter did NOT advance and only ONE stream row exists.
		expect(await readSeq(appId)).toBe(1);
		expect(await readStream(appId)).toHaveLength(1);
		// The replay returned the CURRENT committed doc (first edit), not the ignored batch.
		const village = Object.values(replay.committedDoc.fields).find(
			(fl) => fl.id === "village",
		);
		expect(village && "label" in village && village.label).toBe("Home village");
	});

	it("refreshes the EDIT run_lock lease on a commit by the lock-holding run", async () => {
		const doc = minDoc();
		const appId = await seedApp(doc);
		const nearExpiry = new Date(Date.now() + 60_000); // ~1 min
		await h
			.db()
			.updateTable("apps")
			.set({
				lock_run_id: "e1",
				lock_actor_user_id: OWNER,
				lock_expire_at: nearExpiry,
			})
			.where("id", "=", appId)
			.execute();

		await commitGuardedBatch({
			appId,
			expectedProjectId: PROJECT,
			batchId: crypto.randomUUID(),
			runId: "e1",
			chatRunHolder: { source: "chat", mode: "edit", runId: "e1" },
			mutations: renameVillageLabel(doc, "Lease refresh"),
			actorUserId: OWNER,
			kind: "chat",
		});

		const lock = await h.readRunLock(appId);
		expect(lock?.runId).toBe("e1");
		expect(lock?.expireAt.getTime()).toBeGreaterThan(
			Date.now() + (MAX_RUN_MINUTES - 2) * 60_000,
		);
	});

	it("does NOT refresh the run_lock lease on a commit by a DIFFERENT run", async () => {
		const doc = minDoc();
		const appId = await seedApp(doc);
		const nearExpiry = new Date(Date.now() + 60_000);
		await h
			.db()
			.updateTable("apps")
			.set({
				lock_run_id: "e1",
				lock_actor_user_id: OWNER,
				lock_expire_at: nearExpiry,
			})
			.where("id", "=", appId)
			.execute();

		await commitGuardedBatch({
			appId,
			expectedProjectId: PROJECT,
			batchId: crypto.randomUUID(),
			runId: "other-run",
			mutations: renameVillageLabel(doc, "Other run edit"),
			actorUserId: OWNER,
			kind: "mcp",
		});

		const lock = await h.readRunLock(appId);
		expect(lock?.expireAt.getTime()).toBeLessThan(Date.now() + 5 * 60_000);
	});

	it("rejects a stale reserved build batch without changing the live successor's doc, cursor, identity, or marker", async () => {
		const doc = minDoc();
		const appId = await seedApp(doc);
		const successorRun = "build-successor";
		await h
			.db()
			.updateTable("apps")
			.set({
				status: "generating",
				run_id: successorRun,
				res_period: "2026-07",
				res_reserved: 100,
				res_settled: false,
				res_user_id: OWNER,
				res_run_id: successorRun,
			})
			.where("id", "=", appId)
			.executeTakeFirstOrThrow();
		const before = await readRunFenceState(appId);

		await expect(
			commitGuardedBatch({
				appId,
				expectedProjectId: PROJECT,
				batchId: crypto.randomUUID(),
				runId: "stale-build",
				chatRunHolder: {
					source: "chat",
					mode: "build",
					runId: "stale-build",
				},
				mutations: renameVillageLabel(doc, "Stale build write"),
				actorUserId: OWNER,
				kind: "chat",
			}),
		).rejects.toBeInstanceOf(BlueprintCommitRejectedError);

		expect(await readRunFenceState(appId)).toEqual(before);
		expect(await readStream(appId)).toEqual([]);
		const reloaded = await loadApp(appId);
		const village = Object.values(reloaded?.blueprint.fields ?? {}).find(
			(field) => field.id === "village",
		);
		expect(village && "label" in village && village.label).toBe("Village");
	});

	it("rejects a stale edit batch without changing the live successor's doc, cursor, identity, marker, or lock", async () => {
		const doc = minDoc();
		const appId = await seedApp(doc);
		const successorRun = "edit-successor";
		await h
			.db()
			.updateTable("apps")
			.set({
				run_id: successorRun,
				res_period: "2026-07",
				res_reserved: 5,
				res_settled: false,
				res_user_id: OWNER,
				res_run_id: successorRun,
				lock_run_id: successorRun,
				lock_actor_user_id: OWNER,
				lock_expire_at: new Date(Date.now() + 10 * 60_000),
			})
			.where("id", "=", appId)
			.executeTakeFirstOrThrow();
		const before = await readRunFenceState(appId);

		await expect(
			commitGuardedBatch({
				appId,
				expectedProjectId: PROJECT,
				batchId: crypto.randomUUID(),
				runId: "stale-edit",
				chatRunHolder: {
					source: "chat",
					mode: "edit",
					runId: "stale-edit",
				},
				mutations: renameVillageLabel(doc, "Stale edit write"),
				actorUserId: OWNER,
				kind: "chat",
			}),
		).rejects.toBeInstanceOf(BlueprintCommitRejectedError);

		expect(await readRunFenceState(appId)).toEqual(before);
		expect(await readStream(appId)).toEqual([]);
		const reloaded = await loadApp(appId);
		const village = Object.values(reloaded?.blueprint.fields ?? {}).find(
			(field) => field.id === "village",
		);
		expect(village && "label" in village && village.label).toBe("Village");
	});

	it("denies a non-member with a terminal CommitReauthError (nothing written)", async () => {
		const doc = minDoc();
		const appId = await seedApp(doc, { projectId: PROJECT });
		projectRoleForInTransactionMock.mockResolvedValue(null); // not a member

		await expect(
			commitGuardedBatch({
				appId,
				expectedProjectId: PROJECT,
				batchId: crypto.randomUUID(),
				mutations: renameVillageLabel(doc, "Home village"),
				actorUserId: MEMBER,
				kind: "autosave",
			}),
		).rejects.toBeInstanceOf(CommitReauthError);
		expect(await readSeq(appId)).toBe(0);
	});

	it("denies a member whose role lacks `edit` (viewer) with CommitReauthError", async () => {
		const doc = minDoc();
		const appId = await seedApp(doc, { projectId: PROJECT });
		projectRoleForInTransactionMock.mockResolvedValue("viewer");

		await expect(
			commitGuardedBatch({
				appId,
				expectedProjectId: PROJECT,
				batchId: crypto.randomUUID(),
				mutations: renameVillageLabel(doc, "Home village"),
				actorUserId: MEMBER,
				kind: "autosave",
			}),
		).rejects.toBeInstanceOf(CommitReauthError);
	});

	it("null project_id: the owner commits, a non-owner is denied CommitReauthError (no auth read)", async () => {
		const doc = minDoc();
		const appId = await seedApp(doc, { projectId: null, owner: OWNER });

		const ok = await commitGuardedBatch({
			appId,
			expectedProjectId: null,
			batchId: crypto.randomUUID(),
			mutations: renameVillageLabel(doc, "Home village"),
			actorUserId: OWNER,
			kind: "autosave",
		});
		expect(ok.seq).toBe(1);
		expect(projectRoleForInTransactionMock).not.toHaveBeenCalled();

		await expect(
			commitGuardedBatch({
				appId,
				expectedProjectId: null,
				batchId: crypto.randomUUID(),
				mutations: renameVillageLabel(doc, "Peer edit"),
				actorUserId: MEMBER,
				kind: "autosave",
			}),
		).rejects.toBeInstanceOf(CommitReauthError);
		expect(projectRoleForInTransactionMock).not.toHaveBeenCalled();
	});

	it("denies when the fresh in-transaction membership read finds no role", async () => {
		const doc = minDoc();
		const appId = await seedApp(doc, { projectId: PROJECT });
		projectRoleForInTransactionMock.mockResolvedValue(null);

		await expect(
			commitGuardedBatch({
				appId,
				expectedProjectId: PROJECT,
				batchId: crypto.randomUUID(),
				mutations: renameVillageLabel(doc, "Home village"),
				actorUserId: MEMBER,
				kind: "autosave",
			}),
		).rejects.toBeInstanceOf(CommitReauthError);
		expect(await readSeq(appId)).toBe(0);
	});

	it("commits when the caller's expected Project still matches", async () => {
		const doc = minDoc();
		const appId = await seedApp(doc, { projectId: PROJECT });

		const ok = await commitGuardedBatch({
			appId,
			batchId: crypto.randomUUID(),
			mutations: renameVillageLabel(doc, "Home village"),
			actorUserId: MEMBER,
			kind: "autosave",
			expectedProjectId: PROJECT,
		});
		expect(ok.seq).toBe(1);
		expect(projectRoleForInTransactionMock).toHaveBeenCalledWith(
			expect.anything(),
			MEMBER,
			PROJECT,
		);
	});

	it("rejects when the app moved away from the caller's expected Project", async () => {
		const doc = minDoc();
		const appId = await seedApp(doc, { projectId: PROJECT });
		await h
			.db()
			.updateTable("apps")
			.set({ project_id: "project-moved" })
			.where("id", "=", appId)
			.execute();

		await expect(
			commitGuardedBatch({
				appId,
				batchId: crypto.randomUUID(),
				mutations: renameVillageLabel(doc, "Home village"),
				actorUserId: MEMBER,
				kind: "autosave",
				expectedProjectId: PROJECT,
			}),
		).rejects.toBeInstanceOf(AppProjectChangedError);
		expect(projectRoleForInTransactionMock).not.toHaveBeenCalled();
	});

	it("rejects a batch targeting a concurrently-removed field with BlueprintCommitRejectedError", async () => {
		const doc = minDoc();
		const appId = await seedApp(doc);
		const mutations: Mutation[] = [
			{
				kind: "updateField",
				uuid: "deleted-by-a-peer",
				targetKind: "text",
				patch: { label: "New label" },
			} as Mutation,
		];

		const err = await commitGuardedBatch({
			appId,
			expectedProjectId: PROJECT,
			batchId: crypto.randomUUID(),
			mutations,
			actorUserId: OWNER,
			kind: "autosave",
		}).catch((e) => e);
		expect(err).toBeInstanceOf(BlueprintCommitRejectedError);
		expect((err as Error).message).toContain("removed by someone else");
		expect(await readSeq(appId)).toBe(0);
	});

	it("rejects a batch the fresh-doc verdict rejects with BlueprintCommitRejectedError", async () => {
		const doc = minDoc();
		const appId = await seedApp(doc);
		// An unparseable XPath — a soundness finding the fresh-doc re-verdict rejects.
		const mutations: Mutation[] = [
			{
				kind: "updateField",
				uuid: villageUuid(doc),
				targetKind: "text",
				patch: { relevant: xp("if(") },
			} as Mutation,
		];

		await expect(
			commitGuardedBatch({
				appId,
				expectedProjectId: PROJECT,
				batchId: crypto.randomUUID(),
				mutations,
				actorUserId: OWNER,
				kind: "autosave",
			}),
		).rejects.toBeInstanceOf(BlueprintCommitRejectedError);
		expect(await readSeq(appId)).toBe(0);
	});

	it("re-applies the batch onto the FRESH stored doc, preserving a concurrent commit", async () => {
		const doc = minDoc("Original");
		const appId = await seedApp(doc);

		// A concurrent writer renamed the app AFTER we captured `doc`.
		await commitGuardedBatch({
			appId,
			expectedProjectId: PROJECT,
			batchId: crypto.randomUUID(),
			mutations: [{ kind: "setAppName", name: "Renamed Concurrently" }],
			actorUserId: OWNER,
			kind: "autosave",
		});

		// Our batch (built against the stale `doc`) edits a DIFFERENT slot.
		const result = await commitGuardedBatch({
			appId,
			expectedProjectId: PROJECT,
			batchId: crypto.randomUUID(),
			mutations: renameVillageLabel(doc, "Home village"),
			actorUserId: OWNER,
			kind: "autosave",
		});
		expect(result.seq).toBe(2);
		// The concurrent rename SURVIVES and our edit landed on top.
		expect(result.committedDoc.appName).toBe("Renamed Concurrently");
		const village = Object.values(result.committedDoc.fields).find(
			(fl) => fl.id === "village",
		);
		expect(village && "label" in village && village.label).toBe("Home village");
	});

	it("commits a media attach when the asset is present + ready inside the transaction", async () => {
		const doc = minDoc();
		const appId = await seedApp(doc, { projectId: PROJECT });
		const assetId = await seedReadyImage(PROJECT);

		const result = await commitGuardedBatch({
			appId,
			expectedProjectId: PROJECT,
			batchId: crypto.randomUUID(),
			mutations: attachVillageLabelImage(doc, assetId),
			actorUserId: OWNER,
			kind: "autosave",
			mediaExpectations: [{ assetId, kind: "image", slot: "label media" }],
		});

		expect(result.seq).toBe(1);
		const village = Object.values(result.committedDoc.fields).find(
			(fl) => fl.id === "village",
		);
		expect(village && "label_media" in village && village.label_media).toEqual({
			image: assetId,
		});
	});

	it("rejects a media attach whose asset was concurrently deleted (in-txn re-check)", async () => {
		const doc = minDoc();
		const appId = await seedApp(doc, { projectId: PROJECT });
		// The asset is GONE by the time the transaction reads the asset rows.
		const missingAssetId = crypto.randomUUID();

		await expect(
			commitGuardedBatch({
				appId,
				expectedProjectId: PROJECT,
				batchId: crypto.randomUUID(),
				mutations: attachVillageLabelImage(doc, missingAssetId),
				actorUserId: OWNER,
				kind: "autosave",
				mediaExpectations: [
					{ assetId: missingAssetId, kind: "image", slot: "label media" },
				],
			}),
		).rejects.toBeInstanceOf(BlueprintCommitRejectedError);
		expect(await readSeq(appId)).toBe(0);
	});

	it("rejects raw duplicateField as a typed commit rejection without writing", async () => {
		const doc = minDoc();
		const appId = await seedApp(doc, { projectId: PROJECT });
		const target = Object.values(doc.fields)[0];
		if (target === undefined) throw new Error("fixture has no field");

		await expect(
			commitGuardedBatch({
				appId,
				expectedProjectId: PROJECT,
				batchId: crypto.randomUUID(),
				mutations: [{ kind: "duplicateField", uuid: target.uuid }],
				actorUserId: OWNER,
				kind: "autosave",
			}),
		).rejects.toMatchObject({
			name: "BlueprintCommitRejectedError",
			message: expect.stringContaining("duplicateField is UI-only"),
		});
		expect(await readSeq(appId)).toBe(0);
		expect(await readStream(appId)).toEqual([]);
	});
});

describe("appendSyntheticBatch (Postgres)", () => {
	it("derives a deterministic batch and advances seq + migration stream atomically", async () => {
		const doc = minDoc();
		const appId = await seedApp(doc);
		const migrated = { ...doc, appId, appName: "Migrated" };

		await appendSyntheticBatch({
			appId,
			expectedBaseSeq: 0,
			targetDoc: toPersistableDoc(migrated),
			authority: {
				kind: "system",
				actorId: "system:test-migration",
				reason: "Integration test migration",
			},
		});

		expect(await readSeq(appId)).toBe(1);
		const reloaded = await (await import("../apps")).loadApp(appId);
		expect(reloaded?.blueprint.appName).toBe("Migrated");

		// Migration streams trigger reload, but the durable history stores the real
		// deterministic delta rather than an empty whole-document sentinel.
		const stream = await readStream(appId);
		expect(stream).toHaveLength(1);
		expect(stream[0]).toMatchObject({
			seq: 1,
			mutations: [{ kind: "setAppName", name: "Migrated" }],
			kind: "migration",
			actor_id: "system:test-migration",
		});
	});

	it("writes nothing and does not advance seq for an exact synthetic no-op", async () => {
		const doc = minDoc();
		const appId = await seedApp(doc);

		const result = await appendSyntheticBatch({
			appId,
			expectedBaseSeq: 0,
			targetDoc: toPersistableDoc({ ...doc, appId }),
			authority: {
				kind: "system",
				actorId: "system:test-noop",
				reason: "Integration test no-op",
			},
		});

		expect(result).toEqual({ kind: "noop", seq: 0 });
		expect(await readSeq(appId)).toBe(0);
		expect(await readStream(appId)).toEqual([]);
	});
});

describe("commitGuardedBatch — rename-expectation gate", () => {
	it("rejects a fresh-proven rename the caller's migration did not cover, and admits a covered one", async () => {
		const doc = minDoc();
		const appId = await seedApp(doc, { projectId: null });
		const village = Object.values(doc.fields).find((fl) => fl.id === "village");
		if (!village) throw new Error("fixture is missing the village field");
		const mutations: Mutation[] = [
			{ kind: "renameField", uuid: village.uuid, newId: "hamlet" },
		];

		// The batch's fresh re-apply renames village→hamlet, but the caller
		// claims NO pairs were case-store-migrated (the trailing-prior
		// shape: the migration ran for a different pair, or not at all).
		// Committing would strand row values with the rename evidence
		// expired, so the in-transaction gate rejects and writes nothing.
		await expect(
			commitGuardedBatch({
				appId,
				expectedProjectId: null,
				batchId: crypto.randomUUID(),
				mutations,
				actorUserId: OWNER,
				kind: "autosave",
				renameExpectations: [],
			}),
		).rejects.toBeInstanceOf(BlueprintCommitRejectedError);
		expect(await readSeq(appId)).toBe(0);

		// The same batch with its pair covered commits normally.
		const result = await commitGuardedBatch({
			appId,
			expectedProjectId: null,
			batchId: crypto.randomUUID(),
			mutations,
			actorUserId: OWNER,
			kind: "autosave",
			renameExpectations: [
				{ caseType: "patient", from: "village", to: "hamlet" },
			],
		});
		expect(result.seq).toBe(1);
	});

	it("rejects a pre-migrated diff rename when a peer's fresh writer keeps the old property", async () => {
		/* M's diff/undo/collab batch prepared village→hamlet from a prior containing only the first
		 * writer, then Phase A moved every saved `village` value. Before M's
		 * blueprint commit, a peer added the second unchanged `village` writer.
		 * Unlike interactive `renameField`, the diff encoding is an `updateField`
		 * id patch targeting only M's original UUID, so the peer stays on `village`.
		 * The fresh diff now suppresses the rename proof because `village` stays
		 * live for that keeper. Accepting M would leave the final schema with both
		 * properties while the keeper's values had already been moved to `hamlet`. */
		const fresh = buildDoc({
			appName: "Kept rename race",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					forms: [
						{
							name: "Original writer",
							type: "registration",
							fields: [
								f({
									kind: "text",
									id: "case_name",
									label: "Name",
									case_property_on: "patient",
								}),
								f({
									kind: "text",
									id: "village",
									label: "Moving village writer",
									case_property_on: "patient",
								}),
							],
						},
						{
							name: "Peer writer",
							type: "followup",
							fields: [
								f({
									kind: "text",
									id: "village",
									label: "Keeping village writer",
									case_property_on: "patient",
								}),
							],
						},
					],
				},
			],
			caseTypes: [
				{
					name: "patient",
					properties: [
						{ name: "case_name", label: "Name" },
						{ name: "village", label: "Village" },
					],
				},
			],
		});
		const appId = await seedApp(fresh, { projectId: null });
		const movingWriter = Object.values(fresh.fields).find(
			(field) => "label" in field && field.label === "Moving village writer",
		);
		if (!movingWriter) throw new Error("fixture is missing the moving writer");

		await expect(
			commitGuardedBatch({
				appId,
				expectedProjectId: null,
				batchId: crypto.randomUUID(),
				mutations: [
					{
						kind: "updateField",
						uuid: movingWriter.uuid,
						targetKind: "text",
						patch: { id: "hamlet" },
					} as Mutation,
				],
				actorUserId: OWNER,
				kind: "autosave",
				renameExpectations: [
					{ caseType: "patient", from: "village", to: "hamlet" },
				],
			}),
		).rejects.toThrow(
			'Saved case data was prepared for a rename of "village" to "hamlet"',
		);
		expect(await readSeq(appId)).toBe(0);
	});
});
