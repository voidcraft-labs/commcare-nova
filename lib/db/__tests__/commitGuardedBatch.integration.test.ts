/**
 * The unified guarded writer against a REAL Postgres (the per-test-database
 * harness) — the commit chokepoint every blueprint commit (chat, MCP, auto-save,
 * the cross-Project move) shares.
 *
 * What this pins against a real `SELECT … FOR UPDATE` transaction:
 *
 *   - One transaction writes the entity-row DIFF, advances `mutation_seq`, and
 *     appends the `app_changes` row (the delta + attribution) whose
 *     `UNIQUE (app_id, batch_id)` IS the idempotency latch. (NOTIFY delivery on
 *     the committed row is covered by the stream tests; here we assert the row.)
 *   - `mutation_seq` is a LITERAL `(fresh + 1)` read INSIDE the closure under the
 *     app-row lock, so a run of serial commits produces gap-free seqs, each
 *     re-reading the prior's advanced value.
 *   - A re-commit of the same `batchId` is idempotent — returns the prior
 *     seq/basis, writes NOTHING.
 *   - Per-commit reauth: a non-member / a role without `edit` is denied
 *     `CommitReauthError`; the creator receives no owner-only exception; a move
 *     away from the caller's expected Project rejects the distinct
 *     `AppProjectChangedError` terminal signal.
 *   - The batch re-applies onto the FRESH stored doc (a concurrent commit
 *     survives); a batch targeting a concurrently-removed entity or one the
 *     re-run verdict rejects is a `BlueprintCommitRejectedError`.
 *   - Media-attach expectations re-check against the `media_assets` rows read
 *     FOR SHARE (present+ready commits; a concurrently-deleted asset rejects).
 *   - The per-commit EDIT-lease refresh fires only for the lock-holding run.
 *   - `appendSyntheticBatch` upholds the identical seq+stream coupling while
 *     persisting deterministic repair mutations as a blueprint migration.
 *
 * The in-transaction `auth_member` role read is mocked so each test controls
 * the actor's fresh role; the reauth LOGIC downstream is the real code under
 * test (the role read itself is covered by the auth integration suites).
 *
 * Runs unconditionally under `npm test`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { testMediaAssetId, testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f, xp } from "@/lib/__tests__/docHelpers";
import { MAX_RUN_MINUTES } from "@/lib/db/constants";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { admitMutationBatch } from "@/lib/doc/mutationAdmission";
import type { Mutation } from "@/lib/doc/types";
import {
	type BlueprintDoc,
	type MediaAssetId,
	proseTemplateText,
	type Uuid,
} from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import { setupAppStateTestDb } from "./appStateTestDb";

// The fresh role read is the only auth dependency in the guarded path. Mock it
// so each test controls the role observed under the app transaction's locks.
const { projectRoleForInTransactionMock } = vi.hoisted(() => ({
	projectRoleForInTransactionMock:
		vi.fn<(_tx: unknown, u: string, o: string) => Promise<string | null>>(),
}));
vi.mock("@/lib/db/projectMembership", () => ({
	// Keep the out-of-transaction helper present for any incidental module
	// consumer; the guarded writer authorizes exclusively in-transaction.
	projectRoleFor: vi.fn(),
	projectRoleForInTransaction: projectRoleForInTransactionMock,
}));

const {
	appendSyntheticBatch,
	commitGuardedBatch: commitGuardedBatchOpaque,
	commitGuardedBatchInTransaction: commitGuardedBatchInTransactionOpaque,
	loadApp,
} = await import("../apps");
const commitGuardedBatch = (
	args: Omit<Parameters<typeof commitGuardedBatchOpaque>[0], "mutations"> & {
		mutations: unknown;
	},
) =>
	commitGuardedBatchOpaque({
		...args,
		mutations: admitMutationBatch(args.mutations),
	});
const commitGuardedBatchInTransaction = (
	tx: Parameters<typeof commitGuardedBatchInTransactionOpaque>[0],
	args: Omit<
		Parameters<typeof commitGuardedBatchInTransactionOpaque>[1],
		"mutations"
	> & { mutations: unknown },
) =>
	commitGuardedBatchInTransactionOpaque(tx, {
		...args,
		mutations: admitMutationBatch(args.mutations),
	});
const {
	AppProjectChangedError,
	CommitReauthError,
	BlueprintCommitRejectedError,
	MutationBatchIdCollisionError,
	RunHolderLostError,
} = await import("../commitGuard");
const { decomposeBlueprint } = await import("../blueprintRows");

const OWNER = "user-owner";
const MEMBER = "user-member";
const PROJECT = "project-1";
const HOLDER_NONCE = "00000000-0000-4000-8000-000000000001";

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
								label: proseText("Name"),
								caseWrite: {
									caseType: "patient",
									property: "case_name",
								},
							}),
							f({
								kind: "text",
								id: "village",
								label: proseText("Village"),
								caseWrite: {
									caseType: "patient",
									property: "village",
								},
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
					{ name: "case_name", label: proseText("Name") },
					{ name: "village", label: proseText("Village") },
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
	opts: { projectId: string; owner?: string } = { projectId: PROJECT },
): Promise<string> {
	const appId = crypto.randomUUID();
	const p = toPersistableDoc(doc);
	const formCount = p.moduleOrder.reduce(
		(s, m) => s + (p.formOrder[m]?.length ?? 0),
		0,
	);
	await h.withTransaction(async (tx) => {
		await tx
			.insertInto("apps")
			.values({
				id: appId,
				owner: opts.owner ?? OWNER,
				project_id: opts.projectId,
				app_name: p.appName,
				app_name_lower: p.appName.toLowerCase(),
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
			await tx
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
	});
	return appId;
}

/** Seed a `ready` image asset in a Project. */
async function seedReadyImage(
	projectId: string,
	assetId = testMediaAssetId(crypto.randomUUID()),
): Promise<MediaAssetId> {
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

function villageUuid(doc: BlueprintDoc): Uuid {
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
			patch: { label: proseText(label) },
		},
	];
}

function attachVillageLabelImage(
	doc: BlueprintDoc,
	assetId: MediaAssetId,
): Mutation[] {
	return [
		{
			kind: "setFieldMedia",
			fieldUuid: villageUuid(doc),
			slot: "label",
			media: { image: assetId },
		},
	];
}

/** The `mutation_seq` column (bigint → string) as a number. */
async function readSeq(appId: string): Promise<number> {
	const row = await h.readAppRow(appId);
	return Number(row?.mutation_seq);
}
/** All `app_changes` rows for an app, seq-ordered. */
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
		.selectFrom("app_changes")
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
	it("exercises the exact writer inside a caller-owned rollback transaction", async () => {
		const doc = minDoc();
		const appId = await seedApp(doc);
		const batchId = crypto.randomUUID();
		const rollback = new Error("intentional probe rollback");

		await expect(
			h
				.db()
				.transaction()
				.execute(async (tx) => {
					const result = await commitGuardedBatchInTransaction(tx, {
						appId,
						expectedProjectId: PROJECT,
						batchId,
						mutations: admitMutationBatch([
							{ kind: "setAppName", name: "Rollback probe" },
						]),
						actorUserId: OWNER,
						kind: "autosave",
					});
					expect(result).toMatchObject({ seq: 1, deduped: false });
					expect(
						await tx
							.selectFrom("app_changes")
							.select("batch_id")
							.where("app_id", "=", appId)
							.where("batch_id", "=", batchId)
							.executeTakeFirst(),
					).toEqual({ batch_id: batchId });
					throw rollback;
				}),
		).rejects.toBe(rollback);

		expect(await readSeq(appId)).toBe(0);
		expect(await readStream(appId)).toEqual([]);
	});

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
		expect(
			village &&
				"label" in village &&
				village.label !== undefined &&
				proseTemplateText(village.label),
		).toBe("Home village");

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

	it("freezes MCP and autosave writes while the accepted initial build owns the app", async () => {
		const doc = minDoc();
		const appId = await seedApp(doc);
		const buildRun = "active-build";
		await h
			.db()
			.updateTable("apps")
			.set({
				status: "generating",
				run_id: buildRun,
				run_holder_nonce: HOLDER_NONCE,
				res_period: "2026-08",
				res_reserved: 100,
				res_settled: false,
				res_user_id: OWNER,
				res_run_id: buildRun,
			})
			.where("id", "=", appId)
			.executeTakeFirstOrThrow();
		const before = await readRunFenceState(appId);

		for (const kind of ["mcp", "autosave"] as const) {
			await expect(
				commitGuardedBatch({
					appId,
					expectedProjectId: PROJECT,
					batchId: crypto.randomUUID(),
					...(kind === "mcp" && { runId: "external-mcp" }),
					mutations: renameVillageLabel(doc, `${kind} write`),
					actorUserId: OWNER,
					kind,
				}),
			).rejects.toThrow("reviewed initial build has not finished");
		}
		expect(await readRunFenceState(appId)).toEqual(before);
		expect(await readStream(appId)).toEqual([]);

		const committed = await commitGuardedBatch({
			appId,
			expectedProjectId: PROJECT,
			batchId: crypto.randomUUID(),
			runId: buildRun,
			chatRunHolder: {
				source: "chat",
				mode: "build",
				runId: buildRun,
				nonce: HOLDER_NONCE,
			},
			mutations: renameVillageLabel(doc, "Owned build write"),
			actorUserId: OWNER,
			kind: "chat",
		});

		expect(committed.seq).toBe(1);
		expect(await readStream(appId)).toHaveLength(1);
		expect(await readRunFenceState(appId)).toMatchObject({
			mutation_seq: "1",
			status: "generating",
			run_id: buildRun,
			res_run_id: buildRun,
		});
	});

	it("keeps a failed materialized initial build frozen after its live lease is gone", async () => {
		const doc = minDoc();
		const appId = await seedApp(doc);
		await h
			.db()
			.updateTable("apps")
			.set({ status: "error", error_type: "internal", run_id: "failed-build" })
			.where("id", "=", appId)
			.executeTakeFirstOrThrow();
		await h.seedDesignSession({
			mode: "build",
			project_id: PROJECT,
			owner_user_id: OWNER,
			proposed_app_id: appId,
			app_id: appId,
			state: "materialized",
		});

		await expect(
			commitGuardedBatch({
				appId,
				expectedProjectId: PROJECT,
				batchId: crypto.randomUUID(),
				runId: "external-mcp",
				mutations: renameVillageLabel(doc, "Post-failure edit"),
				actorUserId: OWNER,
				kind: "mcp",
			}),
		).rejects.toThrow("reviewed initial build has not finished");
		expect(await readSeq(appId)).toBe(0);
		expect(await readStream(appId)).toEqual([]);
	});

	it("keeps historical accepted-partial apps editable", async () => {
		const doc = minDoc();
		const appId = await seedApp(doc);
		const sessionId = await h.seedDesignSession({
			mode: "build",
			project_id: PROJECT,
			owner_user_id: OWNER,
			proposed_app_id: appId,
			app_id: appId,
			state: "materialized",
		});
		await h
			.db()
			.insertInto("design_orchestration_events")
			.values({
				design_session_id: sessionId,
				revision: 1,
				event_id: crypto.randomUUID(),
				predecessor_event_id: null,
				predecessor_digest: null,
				run_id: "historical-partial-run",
				holder_nonce_digest: "a".repeat(64),
				kind: "accepted-partial",
				payload: JSON.stringify({
					kind: "accepted-partial",
					appId,
					appSeq: 1,
				}),
			})
			.execute();

		await expect(
			commitGuardedBatch({
				appId,
				expectedProjectId: PROJECT,
				batchId: crypto.randomUUID(),
				mutations: renameVillageLabel(doc, "Editable historical app"),
				actorUserId: OWNER,
				kind: "autosave",
			}),
		).resolves.toMatchObject({ seq: 1 });
		expect(await readSeq(appId)).toBe(1);
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
		expect(
			village &&
				"label" in village &&
				village.label !== undefined &&
				proseTemplateText(village.label),
		).toBe("Reassembled");
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

		// A byte/identity-equivalent retry replays the latch: same seq, deduped,
		// no new write.
		const replay = await commitGuardedBatch({
			appId,
			expectedProjectId: PROJECT,
			batchId,
			mutations: renameVillageLabel(doc, "Home village"),
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
		expect(
			village &&
				"label" in village &&
				village.label !== undefined &&
				proseTemplateText(village.label),
		).toBe("Home village");
	});

	it("fences an organization-derived result before writing, while a committed retry remains idempotent", async () => {
		const doc = minDoc();
		const appId = await seedApp(doc);
		await h
			.db()
			.insertInto("app_organization_state")
			.values({ app_id: appId, revision: "2" })
			.execute();
		const batchId = crypto.randomUUID();
		const mutations = renameVillageLabel(doc, "Current organization guide");

		await expect(
			commitGuardedBatch({
				appId,
				expectedProjectId: PROJECT,
				expectedOrganizationRevision: "1",
				batchId,
				mutations,
				actorUserId: OWNER,
				kind: "autosave",
			}),
		).rejects.toBeInstanceOf(BlueprintCommitRejectedError);
		expect(await readSeq(appId)).toBe(0);
		expect(await readStream(appId)).toEqual([]);

		const committed = await commitGuardedBatch({
			appId,
			expectedProjectId: PROJECT,
			expectedOrganizationRevision: "2",
			batchId,
			mutations,
			actorUserId: OWNER,
			kind: "autosave",
		});
		expect(committed).toMatchObject({ seq: 1, deduped: false });

		// Once this exact batch committed, a lost-response retry returns that
		// success even if the external projection advanced afterwards.
		await h
			.db()
			.updateTable("app_organization_state")
			.set({ revision: "3" })
			.where("app_id", "=", appId)
			.execute();
		const replay = await commitGuardedBatch({
			appId,
			expectedProjectId: PROJECT,
			expectedOrganizationRevision: "2",
			batchId,
			mutations,
			actorUserId: OWNER,
			kind: "autosave",
		});
		expect(replay).toMatchObject({ seq: 1, deduped: true });
		expect(await readStream(appId)).toHaveLength(1);
	});

	it("rejects a reused batchId whose admitted content differs", async () => {
		const doc = minDoc();
		const appId = await seedApp(doc);
		const batchId = crypto.randomUUID();

		await commitGuardedBatch({
			appId,
			expectedProjectId: PROJECT,
			batchId,
			mutations: renameVillageLabel(doc, "Home village"),
			actorUserId: OWNER,
			kind: "autosave",
		});

		await expect(
			commitGuardedBatch({
				appId,
				expectedProjectId: PROJECT,
				batchId,
				mutations: renameVillageLabel(doc, "Different village"),
				actorUserId: OWNER,
				kind: "autosave",
			}),
		).rejects.toBeInstanceOf(MutationBatchIdCollisionError);
		expect(await readSeq(appId)).toBe(1);
		expect(await readStream(appId)).toHaveLength(1);
	});

	it.each([
		{
			label: "actor",
			retry: { actorUserId: MEMBER, kind: "mcp" as const, runId: "run-1" },
		},
		{
			label: "kind",
			retry: {
				actorUserId: OWNER,
				kind: "autosave" as const,
				runId: "run-1",
			},
		},
		{
			label: "run attribution",
			retry: { actorUserId: OWNER, kind: "mcp" as const, runId: "run-2" },
		},
	])(
		"rejects a reused batchId whose immutable $label differs",
		async ({ retry }) => {
			const doc = minDoc();
			const appId = await seedApp(doc);
			const batchId = crypto.randomUUID();
			const mutations = renameVillageLabel(doc, "Home village");

			await commitGuardedBatch({
				appId,
				expectedProjectId: PROJECT,
				batchId,
				runId: "run-1",
				mutations,
				actorUserId: OWNER,
				kind: "mcp",
			});

			await expect(
				commitGuardedBatch({
					appId,
					expectedProjectId: PROJECT,
					batchId,
					mutations,
					...retry,
				}),
			).rejects.toBeInstanceOf(MutationBatchIdCollisionError);
			expect(await readSeq(appId)).toBe(1);
			expect(await readStream(appId)).toHaveLength(1);
		},
	);

	it("treats key order, null prototypes, and acyclic sharing as one admitted retry", async () => {
		const doc = minDoc();
		const appId = await seedApp(doc);
		const batchId = crypto.randomUUID();
		const sharedLabel = proseText("Home village");
		const first = () =>
			Object.assign(Object.create(null), {
				patch: Object.assign(Object.create(null), { label: sharedLabel }),
				targetKind: "text",
				uuid: villageUuid(doc),
				kind: "updateField",
			});

		await commitGuardedBatch({
			appId,
			expectedProjectId: PROJECT,
			batchId,
			mutations: [first(), first()],
			actorUserId: OWNER,
			kind: "autosave",
		});
		const replay = await commitGuardedBatch({
			appId,
			expectedProjectId: PROJECT,
			batchId,
			mutations: [structuredClone(first()), structuredClone(first())],
			actorUserId: OWNER,
			kind: "autosave",
		});

		expect(replay.deduped).toBe(true);
		expect(replay.seq).toBe(1);
		expect(await readStream(appId)).toHaveLength(1);
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
				run_holder_nonce: HOLDER_NONCE,
			})
			.where("id", "=", appId)
			.execute();

		await commitGuardedBatch({
			appId,
			expectedProjectId: PROJECT,
			batchId: crypto.randomUUID(),
			runId: "e1",
			chatRunHolder: {
				source: "chat",
				mode: "edit",
				runId: "e1",
				nonce: HOLDER_NONCE,
			},
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
					nonce: HOLDER_NONCE,
				},
				mutations: renameVillageLabel(doc, "Stale build write"),
				actorUserId: OWNER,
				kind: "chat",
			}),
		).rejects.toBeInstanceOf(RunHolderLostError);

		expect(await readRunFenceState(appId)).toEqual(before);
		expect(await readStream(appId)).toEqual([]);
		const reloaded = await loadApp(appId);
		const village = Object.values(reloaded?.blueprint.fields ?? {}).find(
			(field) => field.id === "village",
		);
		expect(
			village &&
				"label" in village &&
				village.label !== undefined &&
				proseTemplateText(village.label),
		).toBe("Village");
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
					nonce: HOLDER_NONCE,
				},
				mutations: renameVillageLabel(doc, "Stale edit write"),
				actorUserId: OWNER,
				kind: "chat",
			}),
		).rejects.toBeInstanceOf(RunHolderLostError);

		expect(await readRunFenceState(appId)).toEqual(before);
		expect(await readStream(appId)).toEqual([]);
		const reloaded = await loadApp(appId);
		const village = Object.values(reloaded?.blueprint.fields ?? {}).find(
			(field) => field.id === "village",
		);
		expect(
			village &&
				"label" in village &&
				village.label !== undefined &&
				proseTemplateText(village.label),
		).toBe("Village");
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

	it("requires Project membership even when the actor is the app creator", async () => {
		const doc = minDoc();
		const appId = await seedApp(doc, { projectId: PROJECT, owner: OWNER });
		projectRoleForInTransactionMock.mockResolvedValue(null);

		await expect(
			commitGuardedBatch({
				appId,
				expectedProjectId: PROJECT,
				batchId: crypto.randomUUID(),
				mutations: renameVillageLabel(doc, "Creator edit"),
				actorUserId: OWNER,
				kind: "autosave",
			}),
		).rejects.toBeInstanceOf(CommitReauthError);
		expect(projectRoleForInTransactionMock).toHaveBeenCalledWith(
			expect.anything(),
			OWNER,
			PROJECT,
		);
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
		await h.withTransaction(async (tx) => {
			await tx
				.insertInto("app_changes")
				.values({
					app_id: appId,
					seq: 1,
					batch_id: `project-move:${appId}`,
					run_id: null,
					actor_id: MEMBER,
					kind: "project-move",
					mutations: "[]",
					from_project_id: PROJECT,
					to_project_id: "project-moved",
				})
				.execute();
			await tx
				.updateTable("apps")
				.set({ project_id: "project-moved", mutation_seq: 1 })
				.where("id", "=", appId)
				.execute();
		});

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
				uuid: testUuid("deleted-by-a-peer"),
				targetKind: "text",
				patch: { label: proseText("New label") },
			},
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
		expect(
			village &&
				"label" in village &&
				village.label !== undefined &&
				proseTemplateText(village.label),
		).toBe("Home village");
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
		});

		expect(result.seq).toBe(1);
		const village = Object.values(result.committedDoc.fields).find(
			(fl) => fl.id === "village",
		);
		expect(village && "label_media" in village && village.label_media).toEqual({
			image: assetId,
		});
		expect(
			await h
				.db()
				.selectFrom("media_asset_refs")
				.select(["project_id", "asset_id", "app_id"])
				.where("asset_id", "=", assetId)
				.where("app_id", "=", appId)
				.executeTakeFirst(),
		).toEqual({ project_id: PROJECT, asset_id: assetId, app_id: appId });
	});

	it("rejects a media attach whose asset was concurrently deleted (in-txn re-check)", async () => {
		const doc = minDoc();
		const appId = await seedApp(doc, { projectId: PROJECT });
		// The asset is GONE by the time the transaction reads the asset rows.
		const missingAssetId = testMediaAssetId(crypto.randomUUID());

		await expect(
			commitGuardedBatch({
				appId,
				expectedProjectId: PROJECT,
				batchId: crypto.randomUUID(),
				mutations: attachVillageLabelImage(doc, missingAssetId),
				actorUserId: OWNER,
				kind: "autosave",
			}),
		).rejects.toBeInstanceOf(BlueprintCommitRejectedError);
		expect(await readSeq(appId)).toBe(0);
	});

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

		// Blueprint migrations trigger reload, but durable history stores the real
		// deterministic delta rather than an empty whole-document sentinel.
		const stream = await readStream(appId);
		expect(stream).toHaveLength(1);
		expect(stream[0]).toMatchObject({
			seq: 1,
			mutations: [{ kind: "setAppName", name: "Migrated" }],
			kind: "blueprint-migration",
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
