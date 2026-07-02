/**
 * The unified guarded writer against the Firestore emulator — the P3 chokepoint
 * every blueprint commit (chat, MCP, auto-save, the cross-Project move) shares.
 *
 * What this pins against a REAL Firestore transaction (the mocked-transaction
 * unit test in `applyBlueprintChangeGuard.test.ts` can't):
 *
 *   - One transaction advances `mutation_seq`, appends `acceptedMutations/{seq}`
 *     (the delta), and writes the `batchDedup/{batchId}` latch atomically.
 *   - `mutation_seq` is a LITERAL `(fresh + 1)` read inside the closure (so a run
 *     of serial commits produces gap-free seqs, each re-reading the prior's
 *     advanced value — the same read a transaction retry performs).
 *   - A re-commit of the same `batchId` is idempotent — returns the prior
 *     seq/basis, writes NOTHING, and does zero downstream work.
 *   - Per-commit reauth: a non-member is denied with `CommitReauthError`; a
 *     null-`project_id` app defers to the owner (owner ok, non-owner denied);
 *     a concurrent `project_id` move rejects with `BlueprintCommitRejectedError`.
 *   - `appendSyntheticBatchTx` upholds the identical seq+stream coupling on a
 *     PASSED Firestore client (the migration twin).
 *
 * The `auth_member` role read (`projectRoleFor`, normally Postgres) is mocked —
 * the emulator harness has no Postgres. The reauth LOGIC (`role === null`
 * denies, a role with `edit` passes, the owner fallback, the concurrent-move
 * split) is what these tests exercise; the Postgres read itself is covered by
 * the `auth_member` integration suites.
 *
 * Auto-skipped when `FIRESTORE_EMULATOR_HOST` is unset; run via
 * `npm run test:integration`.
 */

import { Timestamp } from "@google-cloud/firestore";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildDoc, caseListConfig, f, xp } from "@/lib/__tests__/docHelpers";
import { MAX_RUN_MINUTES } from "@/lib/db/constants";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import type { Mutation } from "@/lib/doc/types";
import type { BlueprintDoc } from "@/lib/domain";

// The role read is the only Postgres dependency in the guarded path. Mock it so
// each test controls the actor's role (or null = non-member); the reauth LOGIC
// downstream of it is the real code under test.
const { projectRoleForMock } = vi.hoisted(() => ({
	projectRoleForMock: vi.fn<(u: string, o: string) => Promise<string | null>>(),
}));
vi.mock("@/lib/db/projectMembership", () => ({
	projectRoleFor: projectRoleForMock,
}));

const {
	appendSyntheticBatchTx,
	commitGuardedBatch,
	createApp,
	CommitReauthError,
	BlueprintCommitRejectedError,
} = await import("../apps").then(async (apps) => {
	const guard = await import("../commitGuard");
	return {
		appendSyntheticBatchTx: apps.appendSyntheticBatchTx,
		commitGuardedBatch: apps.commitGuardedBatch,
		createApp: apps.createApp,
		CommitReauthError: guard.CommitReauthError,
		BlueprintCommitRejectedError: guard.BlueprintCommitRejectedError,
	};
});
const { docs, getDb } = await import("../firestore");
const { createReadyAsset } = await import("../mediaAssets");

const emulatorAvailable = Boolean(process.env.FIRESTORE_EMULATOR_HOST);

const OWNER = "user-owner";
const MEMBER = "user-member";
const PROJECT = "project-1";

const createdAppIds: string[] = [];
const createdAssetIds: string[] = [];

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

/** Seed a stored app doc at `mutation_seq: 0` with the given blueprint +
 *  tenancy, returning its id. Uses `createApp` (a full, converter-parseable
 *  `AppDoc` with server timestamps — the guarded writer reads via the typed
 *  converter, which rejects a partial doc) then raw-updates the blueprint +
 *  owner/project so each test controls the tenancy axis it exercises. */
async function seedApp(
	doc: BlueprintDoc,
	opts: { projectId: string | null; owner?: string } = { projectId: PROJECT },
): Promise<string> {
	const owner = opts.owner ?? OWNER;
	const appId = await createApp(owner, opts.projectId ?? PROJECT, "run-seed", {
		status: "complete",
	});
	createdAppIds.push(appId);
	await getDb()
		.collection("apps")
		.doc(appId)
		.update({
			owner,
			project_id: opts.projectId,
			app_name: doc.appName,
			blueprint: toPersistableDoc(doc),
			mutation_seq: 0,
		});
	return appId;
}

/** Find the `village` field's uuid on a `minDoc`. */
function villageUuid(doc: BlueprintDoc): string {
	const field = Object.values(doc.fields).find((fl) => fl.id === "village");
	if (!field) throw new Error("village field missing from fixture");
	return field.uuid;
}

beforeEach(() => {
	createdAppIds.length = 0;
	createdAssetIds.length = 0;
	projectRoleForMock.mockReset();
	// Default: the actor is an editor of the app's Project.
	projectRoleForMock.mockResolvedValue("editor");
});

afterEach(async () => {
	// Purge the app doc AND its subcollections (the emulator doesn't cascade).
	await Promise.all(
		createdAppIds.map(async (id) => {
			const ref = getDb().collection("apps").doc(id);
			for (const sub of ["acceptedMutations", "batchDedup", "presence"]) {
				const snap = await ref.collection(sub).get();
				await Promise.all(snap.docs.map((d) => d.ref.delete()));
			}
			await ref.delete();
		}),
	);
	await Promise.all(
		createdAssetIds.map((id) =>
			getDb().collection("mediaAssets").doc(id).delete(),
		),
	);
});

/** Seed a `ready` image asset in a Project and track it for teardown. */
async function seedReadyImage(projectId: string): Promise<string> {
	const { assetId } = await createReadyAsset({
		owner: OWNER,
		project_id: projectId,
		contentHash: "a".repeat(64),
		mimeType: "image/png",
		kind: "image",
		extension: ".png",
		sizeBytes: 1024,
		gcsObjectKey: `projects/${projectId}/${"a".repeat(64)}.png`,
		originalFilename: "icon.png",
		dimensions: { width: 64, height: 64 },
	});
	createdAssetIds.push(assetId);
	return assetId;
}

/** Attach an image asset to the village field's `label` slot. */
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

/** A rename-the-village-label batch — verdict-clean, targets a live field. */
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

describe.skipIf(!emulatorAvailable)(
	"commitGuardedBatch (Firestore emulator)",
	() => {
		it("advances mutation_seq + appends acceptedMutations/{seq} + writes batchDedup in ONE transaction", async () => {
			const doc = minDoc();
			const appId = await seedApp(doc);
			const batchId = crypto.randomUUID();
			const mutations = renameVillageLabel(doc, "Home village");

			const result = await commitGuardedBatch({
				appId,
				batchId,
				runId: "run-1",
				mutations,
				actorUserId: OWNER,
				kind: "chat",
			});

			// Literal first seq.
			expect(result.seq).toBe(1);
			expect(result.deduped).toBe(false);

			// The app doc advanced its counter + committed the edit.
			const appSnap = await docs.appRaw(appId).get();
			const appData = appSnap.data() as {
				mutation_seq: number;
				blueprint_token: string;
				blueprint: { fields: Record<string, { id: string; label?: string }> };
			};
			expect(appData.mutation_seq).toBe(1);
			expect(appData.blueprint_token).toBe(result.basisToken);
			const persistedVillage = Object.values(appData.blueprint.fields).find(
				(fl) => fl.id === "village",
			);
			expect(persistedVillage?.label).toBe("Home village");

			// The durable stream entry carries the delta + attribution.
			const streamSnap = await docs.acceptedMutation(appId, 1).get();
			expect(streamSnap.exists).toBe(true);
			const stream = streamSnap.data();
			expect(stream?.seq).toBe(1);
			expect(stream?.batchId).toBe(batchId);
			expect(stream?.runId).toBe("run-1");
			expect(stream?.actorId).toBe(OWNER);
			expect(stream?.kind).toBe("chat");
			expect(stream?.mutations).toHaveLength(1);

			// The idempotency latch records the seq + basis.
			const latchSnap = await docs.batchDedup(appId, batchId).get();
			expect(latchSnap.exists).toBe(true);
			expect(latchSnap.data()?.seq).toBe(1);
			expect(latchSnap.data()?.basisToken).toBe(result.basisToken);
		});

		it("refreshes the EDIT run_lock lease on a commit by the lock-holding run (a live long edit isn't barged)", async () => {
			// A live edit can run longer than the fixed MAX_RUN_MINUTES
			// lease; each `commitGuardedBatch` from the run holding the lock must push
			// `run_lock.expireAt` out (the run-lock analogue of a build advancing
			// `updated_at`), so a co-member never sees the lease lapse and barge a
			// live edit. Seed a near-expiry lock for run "e1", commit as "e1", and
			// confirm the lease jumped to ~now + MAX_RUN_MINUTES.
			const doc = minDoc();
			const appId = await seedApp(doc);
			const nearExpiry = Timestamp.fromMillis(Date.now() + 60_000); // ~1 min
			await docs.appRaw(appId).set(
				{
					run_lock: { runId: "e1", actorUserId: OWNER, expireAt: nearExpiry },
				},
				{ merge: true },
			);

			await commitGuardedBatch({
				appId,
				batchId: crypto.randomUUID(),
				runId: "e1",
				mutations: renameVillageLabel(doc, "Lease refresh"),
				actorUserId: OWNER,
				kind: "chat",
			});

			const lock = (await docs.appRaw(appId).get()).data()?.run_lock as {
				runId: string;
				expireAt: Timestamp;
			};
			// Lock identity preserved; lease pushed out well past the near-expiry.
			expect(lock.runId).toBe("e1");
			expect(lock.expireAt.toDate().getTime()).toBeGreaterThan(
				Date.now() + (MAX_RUN_MINUTES - 2) * 60_000,
			);
		});

		it("does NOT refresh the run_lock lease on a commit by a DIFFERENT run", async () => {
			// The refresh fires only when THIS commit's runId owns the lock — a
			// commit from another run (or a build) must leave the lease alone, so a
			// hard-killed edit's lock still lapses in ~MAX_RUN_MINUTES.
			const doc = minDoc();
			const appId = await seedApp(doc);
			const nearExpiry = Timestamp.fromMillis(Date.now() + 60_000);
			await docs.appRaw(appId).set(
				{
					run_lock: { runId: "e1", actorUserId: OWNER, expireAt: nearExpiry },
				},
				{ merge: true },
			);

			// A commit tagged with a DIFFERENT runId.
			await commitGuardedBatch({
				appId,
				batchId: crypto.randomUUID(),
				runId: "other-run",
				mutations: renameVillageLabel(doc, "Other run edit"),
				actorUserId: OWNER,
				kind: "chat",
			});

			const lock = (await docs.appRaw(appId).get()).data()?.run_lock as {
				expireAt: Timestamp;
			};
			// The lease was NOT extended — still the near-expiry we seeded.
			expect(lock.expireAt.toDate().getTime()).toBeLessThan(
				Date.now() + 5 * 60_000,
			);
		});

		it("produces gap-free seqs across a run of serial commits (each re-reads the advanced seq)", async () => {
			const doc = minDoc();
			const appId = await seedApp(doc);

			// Each iteration proves the literal-seq compute end-to-end against REAL
			// Firestore: the closure reads `fresh.mutation_seq` and writes
			// `(fresh + 1)`, so every commit re-reads the value the PRIOR commit
			// advanced. That is the SAME in-closure read a transaction RETRY performs
			// (the SDK re-runs the whole closure, re-fetching `fresh`), so the
			// recompute-on-retry is structurally the same read exercised here — the
			// abort-driven concurrent race is NOT re-tested against the emulator,
			// whose `ReactiveLockManager` livelocks even 2-way single-doc contention
			// (documented in `credits.integration.test.ts`) and so cannot model the
			// clean abort-and-retry the assertion needs. `credits.test.ts` drives that
			// abort-retry closure deterministically for the reservation path.
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

			// Exactly 4 stream entries, seqs 1..4 with no gap.
			const streamSnap = await getDb()
				.collection("apps")
				.doc(appId)
				.collection("acceptedMutations")
				.orderBy("seq")
				.get();
			expect(streamSnap.docs.map((d) => d.data().seq)).toEqual([1, 2, 3, 4]);
			const appData = (await docs.appRaw(appId).get()).data();
			expect(appData?.mutation_seq).toBe(4);
		});

		// NOTE — the abort-RETRY recompute is proven in the UNIT suite
		// (`commitGuardedBatch.test.ts`: "re-reads the ADVANCED mutation_seq on a
		// retry"), which drives the REAL closure twice with an advanced `mutation_seq`
		// between invocations — mutation-tested (fail-before/pass-after) against a
		// cached-seq regression. It is NOT re-tested here as a concurrent emulator race:
		// the Firestore EMULATOR's `ReactiveLockManager` LIVELOCKS even 2-way single-doc
		// contention (each txn holds a read lock while awaiting the other's write lock,
		// churning "lock timeout → ABORTED → retry" until the test times out —
		// documented at length in `credits.integration.test.ts`), so it cannot model
		// production's clean abort-and-retry and the assertion is guaranteed-flaky
		// against it, not a Nova bug. The SERIAL gap-free test above additionally proves
		// the literal-seq compute end-to-end against real Firestore.

		it("is idempotent on a re-committed batchId — returns the prior seq/basis and writes nothing", async () => {
			const doc = minDoc();
			const appId = await seedApp(doc);
			const batchId = crypto.randomUUID();
			const mutations = renameVillageLabel(doc, "Home village");

			const first = await commitGuardedBatch({
				appId,
				batchId,
				mutations,
				actorUserId: OWNER,
				kind: "chat",
			});
			expect(first.deduped).toBe(false);
			expect(first.seq).toBe(1);

			// A second commit of the SAME batchId — even carrying different
			// mutations — replays the latch: same seq/basis, deduped, no new write.
			const replay = await commitGuardedBatch({
				appId,
				batchId,
				mutations: renameVillageLabel(doc, "IGNORED — dedup replay"),
				actorUserId: OWNER,
				kind: "chat",
			});
			expect(replay.deduped).toBe(true);
			expect(replay.seq).toBe(first.seq);
			expect(replay.basisToken).toBe(first.basisToken);

			// The counter did NOT advance and only ONE stream entry exists — the
			// replay wrote nothing.
			const appData = (await docs.appRaw(appId).get()).data();
			expect(appData?.mutation_seq).toBe(1);
			const streamSnap = await getDb()
				.collection("apps")
				.doc(appId)
				.collection("acceptedMutations")
				.get();
			expect(streamSnap.size).toBe(1);
			// The replay returned the CURRENT committed doc (first edit), not the
			// ignored second batch.
			const village = Object.values(replay.committedDoc.fields).find(
				(fl) => fl.id === "village",
			);
			expect(village && "label" in village && village.label).toBe(
				"Home village",
			);
		});

		it("denies a non-member with a terminal CommitReauthError (nothing written)", async () => {
			const doc = minDoc();
			const appId = await seedApp(doc, { projectId: PROJECT });
			// The actor is not a member of the app's Project.
			projectRoleForMock.mockResolvedValue(null);

			await expect(
				commitGuardedBatch({
					appId,
					batchId: crypto.randomUUID(),
					mutations: renameVillageLabel(doc, "Home village"),
					actorUserId: MEMBER,
					kind: "autosave",
				}),
			).rejects.toBeInstanceOf(CommitReauthError);

			// Nothing advanced.
			const appData = (await docs.appRaw(appId).get()).data();
			expect(appData?.mutation_seq).toBe(0);
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

			// Owner path: succeeds via the in-txn owner fallback — the auth read is
			// never consulted for a null-project app.
			const ok = await commitGuardedBatch({
				appId,
				batchId: crypto.randomUUID(),
				mutations: renameVillageLabel(doc, "Home village"),
				actorUserId: OWNER,
				kind: "autosave",
			});
			expect(ok.seq).toBe(1);
			expect(projectRoleForMock).not.toHaveBeenCalled();

			// Non-owner path: the in-txn owner mismatch is terminal.
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
			// The pre-txn reauth resolves the actor's role against the ORIGINAL
			// PROJECT; a concurrent move then flips the stored project_id BEFORE
			// the transaction reads the fresh doc, so it no longer matches the
			// reauthed project. Drive that interleaving by flipping `project_id`
			// from inside the (mocked) pre-txn role read — which runs AFTER
			// `loadAppProjectId` resolved PROJECT and BEFORE the transaction.
			projectRoleForMock.mockImplementationOnce(async () => {
				await docs.appRaw(appId).update({ project_id: "project-moved" });
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

			// Nothing committed — the app is untouched at seq 0 (project stays moved).
			const appData = (await docs.appRaw(appId).get()).data();
			expect(appData?.mutation_seq).toBe(0);
		});

		it("preauthorized: skips the pre-txn role read but still commits, and the in-txn project-match uses the passed projectId", async () => {
			// The migration saga already resolved + reauthed, so it passes
			// `preauthorized: { projectId }`. `commitGuardedBatch` must NOT re-run
			// the pre-txn `projectRoleFor` role read — yet the commit still lands
			// and the in-txn concurrent-move check compares against the passed
			// projectId.
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
			// The pre-txn role read was skipped entirely — the saga already did it.
			expect(projectRoleForMock).not.toHaveBeenCalled();
		});

		it("preauthorized: a concurrent move away from the passed projectId still rejects (in-txn gate authoritative)", async () => {
			// Even with the pre-txn role read skipped, the in-txn project-match
			// against the PASSED projectId still fires — a concurrent move to a
			// different Project mid-window rejects (retryable).
			const doc = minDoc();
			const appId = await seedApp(doc, { projectId: PROJECT });
			// Flip the stored project away before the commit's transaction reads it.
			await docs.appRaw(appId).update({ project_id: "project-moved" });

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
			// A field uuid absent from the stored doc — a peer deleted the field
			// this edit targets. The reducer is total (would silently no-op), so
			// the concurrent-delete guard is what surfaces the conflict.
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

			const appData = (await docs.appRaw(appId).get()).data();
			expect(appData?.mutation_seq).toBe(0);
		});

		it("rejects a batch the fresh-doc verdict rejects with BlueprintCommitRejectedError", async () => {
			const doc = minDoc();
			const appId = await seedApp(doc);
			// An unparseable XPath — a soundness finding the fresh-doc re-verdict
			// rejects.
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
			const appData = (await docs.appRaw(appId).get()).data();
			expect(appData?.mutation_seq).toBe(0);
		});

		it("re-applies the batch onto the FRESH stored doc, preserving a concurrent commit", async () => {
			const doc = minDoc("Original");
			const appId = await seedApp(doc);

			// A concurrent writer renamed the app AFTER we captured `doc` — commit
			// that rename first (advancing to seq 1).
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

			// The concurrent rename SURVIVES (the recompute builds on the fresh
			// doc) AND our edit landed on top.
			expect(result.committedDoc.appName).toBe("Renamed Concurrently");
			const village = Object.values(result.committedDoc.fields).find(
				(fl) => fl.id === "village",
			);
			expect(village && "label" in village && village.label).toBe(
				"Home village",
			);
		});

		it("commits a media attach when the asset is present + ready inside the transaction", async () => {
			const doc = minDoc();
			const appId = await seedApp(doc, { projectId: PROJECT });
			// A ready image in the app's Project — the expectation is satisfiable.
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
			// The attach landed on the field's label slot.
			const village = Object.values(result.committedDoc.fields).find(
				(fl) => fl.id === "village",
			);
			expect(
				village && "label_media" in village && village.label_media,
			).toEqual({ image: assetId });
		});

		it("rejects a media attach whose asset was concurrently deleted (in-txn re-check)", async () => {
			const doc = minDoc();
			const appId = await seedApp(doc, { projectId: PROJECT });
			// The asset is GONE by the time the transaction reads the asset rows —
			// a peer deleted it between the pre-commit verdict and this commit.
			// `getAssetsInTransaction` finds no row → `describeMediaExpectationFailures`
			// reports it → the guarded commit rejects. This is the in-txn re-check
			// that both chat (P3) and MCP route media attaches through.
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

			// Nothing committed — the app stays at seq 0, no dangling ref persisted.
			const appData = (await docs.appRaw(appId).get()).data();
			expect(appData?.mutation_seq).toBe(0);
		});
	},
);

describe.skipIf(!emulatorAvailable)(
	"appendSyntheticBatchTx (Firestore emulator)",
	() => {
		it("advances mutation_seq + writes a reload-sentinel stream entry + dedup latch atomically on a passed client", async () => {
			const doc = minDoc();
			const appId = await seedApp(doc);
			const migrated = { ...doc, appName: "Migrated" };

			// The migration twin builds ALL refs from the PASSED client (here the
			// same `getDb()` singleton the emulator binds).
			await appendSyntheticBatchTx(getDb(), appId, toPersistableDoc(migrated));

			const appData = (await docs.appRaw(appId).get()).data() as {
				mutation_seq: number;
				blueprint: { appName: string };
			};
			expect(appData.mutation_seq).toBe(1);
			expect(appData.blueprint.appName).toBe("Migrated");

			// The stream entry is a RELOAD SENTINEL: empty mutations, migration kind.
			const streamSnap = await docs.acceptedMutation(appId, 1).get();
			expect(streamSnap.exists).toBe(true);
			const stream = streamSnap.data();
			expect(stream?.seq).toBe(1);
			expect(stream?.mutations).toEqual([]);
			expect(stream?.kind).toBe("migration");
			expect(stream?.actorId).toBe("migration");

			// A dedup latch exists for the synthetic batchId (recovering clients
			// can't replay an empty batch, so they reload the snapshot).
			const latchSnap = await getDb()
				.collection("apps")
				.doc(appId)
				.collection("batchDedup")
				.get();
			expect(latchSnap.size).toBe(1);
			expect(latchSnap.docs[0]?.data().seq).toBe(1);
		});
	},
);
