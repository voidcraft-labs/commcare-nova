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
 *     non-owner denied, no auth read); a concurrent `project_id` move rejects
 *     `BlueprintCommitRejectedError` (retryable).
 *   - The batch re-applies onto the FRESH stored doc (a concurrent commit
 *     survives); a batch targeting a concurrently-removed entity or one the
 *     re-run verdict rejects is a `BlueprintCommitRejectedError`.
 *   - Media-attach expectations re-check against the `media_assets` rows read
 *     FOR SHARE (present+ready commits; a concurrently-deleted asset rejects).
 *   - The per-commit EDIT-lease refresh fires only for the lock-holding run.
 *   - `appendSyntheticBatch` upholds the identical seq+stream coupling (the
 *     migration twin: a reload-sentinel row).
 *
 * The `auth_member` role read (`projectRoleFor`) is mocked so each test controls
 * the actor's role; the reauth LOGIC downstream is the real code under test (the
 * role read itself is covered by the auth integration suites).
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

// The role read is the only auth dependency in the guarded path. Mock it so each
// test controls the actor's role (or null = non-member); the reauth LOGIC
// downstream is the real code under test.
const { projectRoleForMock } = vi.hoisted(() => ({
	projectRoleForMock: vi.fn<(u: string, o: string) => Promise<string | null>>(),
}));
vi.mock("@/lib/db/projectMembership", () => ({
	projectRoleFor: projectRoleForMock,
}));

const { appendSyntheticBatch, commitGuardedBatch, UNTITLED_APP_NAME } =
	await import("../apps");
const { CommitReauthError, BlueprintCommitRejectedError } = await import(
	"../commitGuard"
);
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

beforeEach(() => {
	// Default: the actor is an editor of the app's Project.
	projectRoleForMock.mockReset().mockResolvedValue("editor");
});

describe("commitGuardedBatch (Postgres)", () => {
	it("advances mutation_seq + appends the accepted_mutations row (the latch) in ONE transaction", async () => {
		const doc = minDoc();
		const appId = await seedApp(doc);
		const batchId = crypto.randomUUID();

		const result = await commitGuardedBatch({
			appId,
			batchId,
			runId: "run-1",
			mutations: renameVillageLabel(doc, "Home village"),
			actorUserId: OWNER,
			kind: "chat",
		});

		expect(result.seq).toBe(1);
		expect(result.deduped).toBe(false);
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
			kind: "chat",
		});
		expect(stream[0].mutations).toHaveLength(1);
	});

	it("persists the entity-row DIFF so the reassembled doc equals the committed doc", async () => {
		const doc = minDoc();
		const appId = await seedApp(doc);

		const result = await commitGuardedBatch({
			appId,
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
			batchId,
			mutations: renameVillageLabel(doc, "Home village"),
			actorUserId: OWNER,
			kind: "chat",
		});
		expect(first.deduped).toBe(false);
		expect(first.seq).toBe(1);

		// A second commit of the SAME batchId — even with different mutations —
		// replays the latch: same seq, deduped, no new write.
		const replay = await commitGuardedBatch({
			appId,
			batchId,
			mutations: renameVillageLabel(doc, "IGNORED — dedup replay"),
			actorUserId: OWNER,
			kind: "chat",
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
			batchId: crypto.randomUUID(),
			runId: "e1",
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
			batchId: crypto.randomUUID(),
			runId: "other-run",
			mutations: renameVillageLabel(doc, "Other run edit"),
			actorUserId: OWNER,
			kind: "chat",
		});

		const lock = await h.readRunLock(appId);
		expect(lock?.expireAt.getTime()).toBeLessThan(Date.now() + 5 * 60_000);
	});

	it("denies a non-member with a terminal CommitReauthError (nothing written)", async () => {
		const doc = minDoc();
		const appId = await seedApp(doc, { projectId: PROJECT });
		projectRoleForMock.mockResolvedValue(null); // not a member

		await expect(
			commitGuardedBatch({
				appId,
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
		projectRoleForMock.mockResolvedValue("viewer");

		await expect(
			commitGuardedBatch({
				appId,
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
			batchId: crypto.randomUUID(),
			mutations: renameVillageLabel(doc, "Home village"),
			actorUserId: OWNER,
			kind: "autosave",
		});
		expect(ok.seq).toBe(1);
		expect(projectRoleForMock).not.toHaveBeenCalled();

		await expect(
			commitGuardedBatch({
				appId,
				batchId: crypto.randomUUID(),
				mutations: renameVillageLabel(doc, "Peer edit"),
				actorUserId: MEMBER,
				kind: "autosave",
			}),
		).rejects.toBeInstanceOf(CommitReauthError);
		expect(projectRoleForMock).not.toHaveBeenCalled();
	});

	it("rejects a concurrent project_id move with a RETRYABLE BlueprintCommitRejectedError", async () => {
		const doc = minDoc();
		const appId = await seedApp(doc, { projectId: PROJECT });
		// The pre-txn reauth resolves the actor's role against PROJECT; a concurrent
		// move then flips the stored project_id BEFORE the transaction reads the
		// fresh row. Drive that interleaving from inside the mocked pre-txn role read
		// (which runs AFTER loadAppProjectId resolved PROJECT, BEFORE the txn).
		projectRoleForMock.mockImplementationOnce(async () => {
			await h
				.db()
				.updateTable("apps")
				.set({ project_id: "project-moved" })
				.where("id", "=", appId)
				.execute();
			return "editor";
		});

		await expect(
			commitGuardedBatch({
				appId,
				batchId: crypto.randomUUID(),
				mutations: renameVillageLabel(doc, "Home village"),
				actorUserId: MEMBER,
				kind: "autosave",
			}),
		).rejects.toBeInstanceOf(BlueprintCommitRejectedError);
		expect(await readSeq(appId)).toBe(0);
	});

	it("preauthorized: skips the pre-txn role read but still commits", async () => {
		const doc = minDoc();
		const appId = await seedApp(doc, { projectId: PROJECT });

		const ok = await commitGuardedBatch({
			appId,
			batchId: crypto.randomUUID(),
			mutations: renameVillageLabel(doc, "Home village"),
			actorUserId: MEMBER,
			kind: "autosave",
			preauthorized: { projectId: PROJECT },
		});
		expect(ok.seq).toBe(1);
		expect(projectRoleForMock).not.toHaveBeenCalled();
	});

	it("preauthorized: a concurrent move away from the passed projectId still rejects (in-txn gate authoritative)", async () => {
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
				preauthorized: { projectId: PROJECT },
			}),
		).rejects.toBeInstanceOf(BlueprintCommitRejectedError);
		expect(projectRoleForMock).not.toHaveBeenCalled();
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
			batchId: crypto.randomUUID(),
			mutations: [{ kind: "setAppName", name: "Renamed Concurrently" }],
			actorUserId: OWNER,
			kind: "autosave",
		});

		// Our batch (built against the stale `doc`) edits a DIFFERENT slot.
		const result = await commitGuardedBatch({
			appId,
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
			batchId: crypto.randomUUID(),
			mutations: attachVillageLabelImage(doc, assetId),
			actorUserId: OWNER,
			kind: "chat",
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
				batchId: crypto.randomUUID(),
				mutations: attachVillageLabelImage(doc, missingAssetId),
				actorUserId: OWNER,
				kind: "chat",
				mediaExpectations: [
					{ assetId: missingAssetId, kind: "image", slot: "label media" },
				],
			}),
		).rejects.toBeInstanceOf(BlueprintCommitRejectedError);
		expect(await readSeq(appId)).toBe(0);
	});
});

describe("appendSyntheticBatch (Postgres)", () => {
	it("advances mutation_seq + writes a reload-sentinel stream row atomically", async () => {
		const doc = minDoc();
		const appId = await seedApp(doc);
		const migrated = { ...doc, appName: "Migrated" };

		await appendSyntheticBatch(appId, toPersistableDoc(migrated));

		expect(await readSeq(appId)).toBe(1);
		const reloaded = await (await import("../apps")).loadApp(appId);
		expect(reloaded?.blueprint.appName).toBe("Migrated");

		// The stream row is a RELOAD SENTINEL: empty mutations, migration kind.
		const stream = await readStream(appId);
		expect(stream).toHaveLength(1);
		expect(stream[0]).toMatchObject({
			seq: 1,
			mutations: [],
			kind: "migration",
			actor_id: "migration",
		});
	});
});
