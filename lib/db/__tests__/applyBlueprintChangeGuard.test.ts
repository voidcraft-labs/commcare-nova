/**
 * The guarded commit path of `applyBlueprintChange` — the cross-store saga's
 * wiring around the ONE blueprint-commit chokepoint, `commitGuardedBatch` (in
 * `apps.ts`). This file mocks `commitGuardedBatch` + `loadApp` and pins the
 * saga's composition:
 *
 *   1. Every persist threads the unified writer's args verbatim — `batchId`,
 *      `kind`, `runId` (when present), `actorUserId` (the caller's `userId`),
 *      the guard's `mutations`, and any `mediaExpectations`.
 *   2. The result surfaces `seq` + the writer's hydrated `committedDoc`.
 *   3. A top-level `batchId` dedup hit (the `accepted_mutations (app_id, batch_id)`
 *      latch already exists) short-circuits the WHOLE saga — no Postgres schema
 *      work, no `loadApp`, no commit — returning the recorded `{ seq }` with no
 *      `committedDoc`.
 *   4. A rejection from the writer (`BlueprintCommitRejectedError` /
 *      `CommitReauthError`) propagates and, after the Postgres phase ran,
 *      compensates the case-store work.
 *
 * The deep read-evaluate-write behavior the writer itself owns (re-apply on the
 * FRESH stored doc, the concurrent-delete guard, the fresh-doc re-verdict, the
 * per-commit reauth, the legacy-doc hydration) is exercised against a REAL
 * Postgres transaction in `commitGuardedBatch.integration.test.ts`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import type { Mutation } from "@/lib/doc/types";
import type { BlueprintDoc } from "@/lib/domain";
import { applyBlueprintChange } from "../applyBlueprintChange";
import {
	BlueprintCommitRejectedError,
	CommitReauthError,
} from "../commitGuard";

const { loadAppMock, loadAppProjectIdMock, commitGuardedBatchMock } =
	vi.hoisted(() => ({
		loadAppMock: vi.fn(),
		loadAppProjectIdMock: vi.fn(),
		commitGuardedBatchMock: vi.fn(),
	}));

const unparkValuesMock = vi.fn(async () => ({ restored: 0, kept: 0 }));
const { applySchemaChangeMock, dropSchemaMock, withSchemaContextMock } =
	vi.hoisted(() => ({
		applySchemaChangeMock: vi.fn(),
		dropSchemaMock: vi.fn(),
		withSchemaContextMock: vi.fn(),
	}));

const { reauthorizeActorForCommitMock } = vi.hoisted(() => ({
	reauthorizeActorForCommitMock: vi.fn(),
}));

// The top-level dedup pre-check reads the `accepted_mutations (app_id, batch_id)`
// latch via `getAppDb()`. `latchRowMock` scripts that single-row read: `undefined`
// = no prior latch (proceed), `{ seq }` = a dedup hit.
const { latchRowMock } = vi.hoisted(() => ({
	latchRowMock: vi.fn(),
}));

vi.mock("@/lib/db/apps", () => ({
	loadApp: loadAppMock,
	loadAppProjectId: loadAppProjectIdMock,
	commitGuardedBatch: commitGuardedBatchMock,
}));

// The pre-DDL reauth is the shared `reauthorizeActorForCommit`; mock it so the
// saga's authorization gate is a controllable seam (its own throw-behavior is
// pinned in `commitGuard`'s tests). The real error classes stay real for the
// propagation assertions below.
vi.mock("@/lib/db/commitGuard", async () => {
	const actual = (await vi.importActual("@/lib/db/commitGuard")) as Record<
		string,
		unknown
	>;
	return {
		...actual,
		reauthorizeActorForCommit: reauthorizeActorForCommitMock,
	};
});

// The top-level dedup read is `getAppDb().selectFrom("accepted_mutations")…
// .executeTakeFirst()`. Mock `getAppDb` to return a chainable stub whose terminal
// `executeTakeFirst` resolves `latchRowMock()`, so the non-transactional latch
// read is controllable without a live database. (`applyBlueprintChange` imports
// only `getAppDb` from `./pg`; the rest of the module's pg surface stays real.)
vi.mock("@/lib/db/pg", async () => {
	const actual = (await vi.importActual("@/lib/db/pg")) as Record<
		string,
		unknown
	>;
	const chain: Record<string, unknown> = {};
	chain.selectFrom = () => chain;
	chain.select = () => chain;
	chain.where = () => chain;
	chain.executeTakeFirst = () => latchRowMock();
	return { ...actual, getAppDb: async () => chain };
});

vi.mock("@/lib/case-store", async () => {
	const actual = (await vi.importActual("@/lib/case-store")) as Record<
		string,
		unknown
	>;
	return {
		...actual,
		withSchemaContext: withSchemaContextMock,
	};
});

/**
 * A real rename batch for `minDoc`'s case-bound `village` field. The
 * saga replays it onto the prior to derive the prospective, and the
 * classifier proves the village→hamlet rename from the two snapshots
 * (field-uuid evidence) — the migration-bearing path with no hint
 * mechanism involved.
 */
function renameVillageBatch(doc: BlueprintDoc): Mutation[] {
	const field = Object.values(doc.fields).find((fl) => fl.id === "village");
	if (field === undefined) {
		throw new Error("fixture is missing the case-bound `village` field");
	}
	return [{ kind: "renameField", uuid: field.uuid, newId: "hamlet" }];
}

/** Valid one-module registration doc writing two case properties. */
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

beforeEach(() => {
	vi.clearAllMocks();
	loadAppMock.mockImplementation(async () => null);
	// A null-project app: `reauthorizeActorForCommit(null, …)` is a no-op, and
	// the in-txn owner check lives in `commitGuardedBatch` (mocked away here).
	loadAppProjectIdMock.mockResolvedValue(null);
	reauthorizeActorForCommitMock.mockResolvedValue(undefined);
	// Default: no prior dedup latch — the saga proceeds to the guarded commit.
	latchRowMock.mockResolvedValue(undefined);
	// Every sync returns the empty report by default — the saga aggregates
	// `parkedIds` etc. off every return, so the mock must honor the
	// `MigrationReport` contract; per-test overrides replace this.
	applySchemaChangeMock.mockResolvedValue({
		migrated: 0,
		reshaped: 0,
		retyped: 0,
		skipped: 0,
		parkedIds: [],
		failureReasons: [],
	});
	withSchemaContextMock.mockResolvedValue({
		applySchemaChange: applySchemaChangeMock,
		dropSchema: dropSchemaMock,
		unparkValues: unparkValuesMock,
	});
});

describe("applyBlueprintChange — routes the guard through commitGuardedBatch", () => {
	it("threads batchId + kind + runId + actorUserId + mutations to the writer and returns its seq + committedDoc", async () => {
		const fresh = minDoc();
		const committed: BlueprintDoc = { ...fresh, appName: "Renamed" };
		commitGuardedBatchMock.mockResolvedValue({
			seq: 7,
			committedDoc: committed,
			deduped: false,
		});
		loadAppMock.mockResolvedValue({ blueprint: toPersistableDoc(fresh) });

		const mutations: Mutation[] = [{ kind: "setAppName", name: "Renamed" }];
		const result = await applyBlueprintChange({
			appId: "app-1",
			userId: "user-1",
			prospective: toPersistableDoc(fresh),
			runId: "run-1",
			batchId: "batch-uuid-1",
			kind: "mcp",
			guard: { mutations },
		});

		expect(commitGuardedBatchMock).toHaveBeenCalledTimes(1);
		const args = commitGuardedBatchMock.mock.calls[0]?.[0];
		expect(args).toMatchObject({
			appId: "app-1",
			batchId: "batch-uuid-1",
			runId: "run-1",
			actorUserId: "user-1",
			kind: "mcp",
			mutations,
		});
		// The saga surfaces the writer's committed seq + hydrated doc.
		expect(result.seq).toBe(7);
		expect(result.committedDoc).toBe(committed);
	});

	it("passes mediaExpectations through to the writer for a media-attaching batch", async () => {
		const fresh = minDoc();
		commitGuardedBatchMock.mockResolvedValue({
			seq: 1,
			committedDoc: fresh,
			deduped: false,
		});
		loadAppMock.mockResolvedValue({ blueprint: toPersistableDoc(fresh) });

		await applyBlueprintChange({
			appId: "app-1",
			userId: "user-1",
			prospective: toPersistableDoc(fresh),
			batchId: "batch-uuid-media",
			kind: "autosave",
			guard: {
				mutations: [{ kind: "setAppLogo", logo: "asset-live" } as Mutation],
				mediaExpectations: [
					{ assetId: "asset-live", kind: "image", slot: "the app logo" },
				],
			},
		});

		const args = commitGuardedBatchMock.mock.calls[0]?.[0];
		expect(args?.mediaExpectations).toEqual([
			{ assetId: "asset-live", kind: "image", slot: "the app logo" },
		]);
		// An autosave omits runId entirely (not `undefined`).
		expect("runId" in (args ?? {})).toBe(false);
	});

	it("propagates a BlueprintCommitRejectedError from the writer (nothing swallowed)", async () => {
		const fresh = minDoc();
		loadAppMock.mockResolvedValue({ blueprint: toPersistableDoc(fresh) });
		commitGuardedBatchMock.mockRejectedValue(
			new BlueprintCommitRejectedError("removed by someone else"),
		);

		await expect(
			applyBlueprintChange({
				appId: "app-1",
				userId: "user-1",
				priorBlueprint: toPersistableDoc(fresh),
				batchId: "batch-uuid-2",
				kind: "autosave",
				guard: {
					mutations: [{ kind: "setAppName", name: "Renamed" } as Mutation],
				},
			}),
		).rejects.toBeInstanceOf(BlueprintCommitRejectedError);
	});

	it("propagates a terminal CommitReauthError from the writer", async () => {
		const fresh = minDoc();
		loadAppMock.mockResolvedValue({ blueprint: toPersistableDoc(fresh) });
		commitGuardedBatchMock.mockRejectedValue(
			new CommitReauthError("You no longer have edit access."),
		);

		await expect(
			applyBlueprintChange({
				appId: "app-1",
				userId: "user-1",
				priorBlueprint: toPersistableDoc(fresh),
				batchId: "batch-uuid-3",
				kind: "autosave",
				guard: {
					mutations: [{ kind: "setAppName", name: "Renamed" } as Mutation],
				},
			}),
		).rejects.toBeInstanceOf(CommitReauthError);
	});
});

describe("applyBlueprintChange — top-level batchId dedup", () => {
	it("short-circuits the whole saga on a pre-existing latch, doing zero commit / loadApp / Postgres work", async () => {
		latchRowMock.mockResolvedValue({ seq: 42 });

		const result = await applyBlueprintChange({
			appId: "app-1",
			userId: "user-1",
			prospective: toPersistableDoc(minDoc()),
			batchId: "already-committed",
			kind: "mcp",
			guard: {
				mutations: [{ kind: "setAppName", name: "Renamed" } as Mutation],
			},
		});

		// The recorded seq comes straight off the latch — no committedDoc.
		expect(result).toEqual({ seq: 42 });
		expect(result.committedDoc).toBeUndefined();
		// Nothing downstream ran — not even the pre-DDL reauth.
		expect(commitGuardedBatchMock).not.toHaveBeenCalled();
		expect(loadAppMock).not.toHaveBeenCalled();
		expect(loadAppProjectIdMock).not.toHaveBeenCalled();
		expect(reauthorizeActorForCommitMock).not.toHaveBeenCalled();
		expect(withSchemaContextMock).not.toHaveBeenCalled();
	});
});

describe("applyBlueprintChange — reauth before any Postgres DDL", () => {
	it("rejects a deauth'd caller BEFORE the migration-bearing Phase-1 DDL runs", async () => {
		const prior = minDoc();
		loadAppMock.mockResolvedValue({ blueprint: toPersistableDoc(prior) });
		loadAppProjectIdMock.mockResolvedValue("proj-1");
		// The shared reauth throws for a member who lost edit access.
		reauthorizeActorForCommitMock.mockRejectedValue(
			new CommitReauthError("You no longer have edit access."),
		);

		await expect(
			applyBlueprintChange({
				appId: "app-1",
				userId: "user-1",
				priorBlueprint: toPersistableDoc(prior),
				// The rename batch would otherwise drive Phase-1 DDL — the
				// reauth must fire first so no `case_type_schemas` mutation
				// happens.
				batchId: "batch-reauth",
				kind: "autosave",
				guard: {
					mutations: renameVillageBatch(prior),
				},
			}),
		).rejects.toBeInstanceOf(CommitReauthError);

		// The reauth resolved the Project and rejected before any store work.
		expect(loadAppProjectIdMock).toHaveBeenCalledWith("app-1");
		expect(reauthorizeActorForCommitMock).toHaveBeenCalledWith(
			"proj-1",
			"user-1",
		);
		expect(applySchemaChangeMock).not.toHaveBeenCalled();
		expect(commitGuardedBatchMock).not.toHaveBeenCalled();
	});
});

describe("applyBlueprintChange — Postgres saga around the guarded commit", () => {
	it("compensates a MIGRATION-BEARING entry via applySchemaChange(prior) when the commit rejects", async () => {
		const prior = minDoc();
		// A rename batch drives the ONE migration-bearing Phase-1 call against the
		// existing `patient` type. When the writer then rejects, the saga
		// compensates by re-syncing the type from the CURRENT committed doc (a
		// fresh `loadApp`, here the same `prior`) — no `change`, no `dropSchema`
		// (the case-type-addition arm is gone; migration entries target an
		// existing type).
		loadAppMock.mockResolvedValue({ blueprint: toPersistableDoc(prior) });
		// The forward apply PARKS one value (a merge-conflict discard); the
		// compensation must un-park exactly that id after the re-sync.
		applySchemaChangeMock
			.mockResolvedValueOnce({
				migrated: 1,
				reshaped: 0,
				retyped: 0,
				restored: 0,
				skipped: 0,
				parkedIds: ["park-entry-1"],
				failureReasons: ["rename village→hamlet set aside a value"],
			})
			.mockResolvedValue({
				migrated: 0,
				reshaped: 0,
				retyped: 0,
				restored: 0,
				skipped: 0,
				parkedIds: [],
				failureReasons: [],
			});
		commitGuardedBatchMock.mockRejectedValue(
			new BlueprintCommitRejectedError("rejected against the fresh doc"),
		);

		await expect(
			applyBlueprintChange({
				appId: "app-1",
				userId: "user-1",
				priorBlueprint: toPersistableDoc(prior),
				runId: "run-1",
				batchId: "batch-uuid-4",
				kind: "mcp",
				guard: {
					mutations: renameVillageBatch(prior),
				},
			}),
		).rejects.toBeInstanceOf(BlueprintCommitRejectedError);

		// Phase 1 forward-applied the rename `change`; the rejection
		// compensated it with the INVERSE rename (row values return to the
		// restored key) followed by a schema-sync-only re-derive of the
		// prior. No `dropSchema` anywhere.
		const forward = applySchemaChangeMock.mock.calls[0]?.[0];
		expect(forward).toMatchObject({
			appId: "app-1",
			caseType: "patient",
			change: {
				kind: "rename",
				renames: [{ from: "village", to: "hamlet" }],
			},
		});
		const inversion = applySchemaChangeMock.mock.calls[1]?.[0];
		expect(inversion).toMatchObject({
			appId: "app-1",
			caseType: "patient",
			change: {
				kind: "rename",
				renames: [{ from: "hamlet", to: "village" }],
			},
		});
		const compensation = applySchemaChangeMock.mock.calls[2]?.[0];
		expect(compensation).toMatchObject({ appId: "app-1", caseType: "patient" });
		expect(compensation.change).toBeUndefined();
		expect(dropSchemaMock).not.toHaveBeenCalled();
		// The forward apply's parked value un-parks LAST — after the re-sync
		// restored the schema state it was valid under.
		expect(unparkValuesMock).toHaveBeenCalledTimes(1);
		expect(unparkValuesMock).toHaveBeenCalledWith({
			appId: "app-1",
			ids: ["park-entry-1"],
		});
		const unparkOrder = unparkValuesMock.mock.invocationCallOrder[0] ?? 0;
		const resyncOrder =
			applySchemaChangeMock.mock.invocationCallOrder[2] ?? Number.MAX_VALUE;
		expect(unparkOrder).toBeGreaterThan(resyncOrder);
	});

	it("compensates a migration entry whose forward apply THREW (Phase-A-committed-Phase-B-failed shape)", async () => {
		// `applySchemaChange` is two-phase; an entry whose Phase A committed and
		// whose Phase B then threw exits the forward loop un-recorded, yet its
		// schema DID change. Compensate must still reconcile it — the fix
		// iterates ALL migration entries, not just the ones that fully returned.
		// Model that here: the FORWARD `applySchemaChange` throws, and
		// compensate's re-sync (the 2nd call, no `change`) must still fire for
		// the type.
		const prior = minDoc();
		loadAppMock.mockResolvedValue({
			blueprint: toPersistableDoc(prior),
			mutation_seq: 4,
		});
		applySchemaChangeMock
			// Forward apply throws (Phase B failed after Phase A committed).
			.mockRejectedValueOnce(new Error("phase B index DDL failed"))
			// Compensate's re-sync succeeds.
			.mockResolvedValueOnce({
				migrated: 0,
				reshaped: 0,
				retyped: 0,
				restored: 0,
				parkedIds: [],
				skipped: 0,
				failureReasons: [],
			});

		await expect(
			applyBlueprintChange({
				appId: "app-1",
				userId: "user-1",
				priorBlueprint: toPersistableDoc(prior),
				batchId: "batch-phaseB-fail",
				kind: "autosave",
				guard: { mutations: renameVillageBatch(prior) },
			}),
		).rejects.toThrow("phase B index DDL failed");

		// TWO calls: the forward (threw) + the compensating re-sync — compensate
		// did NOT skip the type just because the forward never "succeeded".
		// THREE calls: the forward (threw) + the compensating inverse
		// rename + the seq-guarded additive re-sync. The inverse is a
		// harmless zero-row no-op when the forward's Phase A rolled back.
		expect(applySchemaChangeMock).toHaveBeenCalledTimes(3);
		const inversion = applySchemaChangeMock.mock.calls[1]?.[0];
		expect(inversion).toMatchObject({
			appId: "app-1",
			caseType: "patient",
			change: {
				kind: "rename",
				renames: [{ from: "hamlet", to: "village" }],
			},
		});
		const compensation = applySchemaChangeMock.mock.calls[2]?.[0];
		expect(compensation).toMatchObject({
			appId: "app-1",
			caseType: "patient",
			syncedSeq: 4,
		});
		expect(compensation.change).toBeUndefined();
		// The forward failed BEFORE the commit — never reached.
		expect(commitGuardedBatchMock).not.toHaveBeenCalled();
	});

	it("post-commit-sweeps every touched case type against the COMMITTED doc at the committed seq", async () => {
		// An additive case-type addition — no `change` hint, so it does NOT run
		// Phase-1 Postgres-first. It rides the post-commit sweep instead.
		const prior = minDoc();
		const prospective = structuredClone(toPersistableDoc(prior));
		prospective.caseTypes = [
			...(prospective.caseTypes ?? []),
			{ name: "household", properties: [{ name: "case_name", label: "N" }] },
		];
		loadAppMock.mockResolvedValue({ blueprint: toPersistableDoc(prior) });
		// The committed doc carries BOTH types — the sweep re-derives its schema.
		const committed = structuredClone(prospective) as unknown as BlueprintDoc;
		commitGuardedBatchMock.mockResolvedValue({
			seq: 9,
			committedDoc: committed,
			deduped: false,
		});
		applySchemaChangeMock.mockResolvedValue({
			migrated: 0,
			reshaped: 0,
			retyped: 0,
			restored: 0,
			skipped: 0,
			parkedIds: [],
			failureReasons: [],
		});

		await applyBlueprintChange({
			appId: "app-1",
			userId: "user-1",
			prospective,
			batchId: "batch-uuid-sweep",
			kind: "autosave",
			guard: {
				mutations: [{ kind: "setAppName", name: "x" } as Mutation],
			},
		});

		// No Phase-1 forward apply (additive), then ONE post-commit sweep of the
		// added `household` type at `syncedSeq = 9` off the committed doc.
		expect(applySchemaChangeMock).toHaveBeenCalledTimes(1);
		expect(applySchemaChangeMock.mock.calls[0]?.[0]).toMatchObject({
			appId: "app-1",
			caseType: "household",
			syncedSeq: 9,
		});
	});

	it.each([
		["deterministic (error-logged)", new Error("unschemable property")],
		[
			"transient (warn-logged)",
			Object.assign(new Error("blip"), { code: "ECONNRESET" }),
		],
	])(
		"never rethrows a post-commit sweep failure — %s — the commit result still returns",
		async (_label, sweepError) => {
			// The commit already landed, so a sweep fault is never a 500 whatever
			// its class; the severity split (deterministic → `error`, transient →
			// `warn`) is a Sentry-visibility decision, not a control-flow one.
			const prior = minDoc();
			const prospective = structuredClone(toPersistableDoc(prior));
			prospective.caseTypes = [
				...(prospective.caseTypes ?? []),
				{ name: "household", properties: [{ name: "case_name", label: "N" }] },
			];
			loadAppMock.mockResolvedValue({ blueprint: toPersistableDoc(prior) });
			const committed = structuredClone(prospective) as unknown as BlueprintDoc;
			commitGuardedBatchMock.mockResolvedValue({
				seq: 3,
				committedDoc: committed,
				deduped: false,
			});
			// The sweep throws — it must NOT propagate.
			applySchemaChangeMock.mockRejectedValue(sweepError);

			const result = await applyBlueprintChange({
				appId: "app-1",
				userId: "user-1",
				prospective,
				batchId: `batch-uuid-sweepfail-${_label}`,
				kind: "autosave",
				guard: {
					mutations: [{ kind: "setAppName", name: "x" } as Mutation],
				},
			});

			expect(result.seq).toBe(3);
			expect(result.committedDoc).toBe(committed);
		},
	);

	it("skips Postgres entirely for a non-case-type batch (fast path) — and runs NO saga-level reauth", async () => {
		const fresh = minDoc();
		commitGuardedBatchMock.mockResolvedValue({
			seq: 2,
			committedDoc: fresh,
			deduped: false,
		});
		loadAppMock.mockResolvedValue({ blueprint: toPersistableDoc(fresh) });

		await applyBlueprintChange({
			appId: "app-1",
			userId: "user-1",
			prospective: toPersistableDoc(fresh),
			batchId: "batch-uuid-5",
			kind: "autosave",
			guard: {
				mutations: [{ kind: "setAppName", name: "Renamed" } as Mutation],
			},
		});

		expect(commitGuardedBatchMock).toHaveBeenCalledTimes(1);
		expect(withSchemaContextMock).not.toHaveBeenCalled();
		// No pre-DDL reauth on the fast path — `commitGuardedBatch`'s own reauth
		// is the single gate (no Phase-1 DDL to protect), so the saga doesn't
		// pay a second `loadAppProjectId` + `reauthorizeActorForCommit`.
		expect(loadAppProjectIdMock).not.toHaveBeenCalled();
		expect(reauthorizeActorForCommitMock).not.toHaveBeenCalled();
	});

	it("runs NO saga-level reauth on the ADDITIVE (post-commit-sweep) path", async () => {
		// An additive case-type addition touches Postgres only AFTER the commit
		// (the sweep), so there's no pre-commit DDL to protect — the saga must
		// not double the reauth here either.
		const prior = minDoc();
		const prospective = structuredClone(toPersistableDoc(prior));
		prospective.caseTypes = [
			...(prospective.caseTypes ?? []),
			{ name: "household", properties: [{ name: "case_name", label: "N" }] },
		];
		loadAppMock.mockResolvedValue({ blueprint: toPersistableDoc(prior) });
		commitGuardedBatchMock.mockResolvedValue({
			seq: 9,
			committedDoc: structuredClone(prospective) as unknown as BlueprintDoc,
			deduped: false,
		});
		applySchemaChangeMock.mockResolvedValue({
			migrated: 0,
			reshaped: 0,
			retyped: 0,
			restored: 0,
			skipped: 0,
			parkedIds: [],
			failureReasons: [],
		});

		await applyBlueprintChange({
			appId: "app-1",
			userId: "user-1",
			prospective,
			batchId: "batch-additive-noreauth",
			kind: "autosave",
			guard: { mutations: [{ kind: "setAppName", name: "x" } as Mutation] },
		});

		expect(loadAppProjectIdMock).not.toHaveBeenCalled();
		expect(reauthorizeActorForCommitMock).not.toHaveBeenCalled();
	});

	it("reauths BEFORE any applySchemaChange on the migration-bearing path", async () => {
		// The migration path DOES reauth (it runs pre-commit Phase-1 DDL) — and
		// the reauth must resolve before the FIRST `applySchemaChange`, or a
		// deauth'd caller could mutate `case_type_schemas`.
		const order: string[] = [];
		const prior = minDoc();
		loadAppMock.mockResolvedValue({ blueprint: toPersistableDoc(prior) });
		loadAppProjectIdMock.mockImplementation(async () => {
			order.push("loadAppProjectId");
			return "proj-1";
		});
		reauthorizeActorForCommitMock.mockImplementation(async () => {
			order.push("reauth");
		});
		applySchemaChangeMock.mockImplementation(async () => {
			order.push("applySchemaChange");
			return {
				migrated: 0,
				reshaped: 0,
				retyped: 0,
				restored: 0,
				skipped: 0,
				parkedIds: [],
				failureReasons: [],
			};
		});
		commitGuardedBatchMock.mockImplementation(async () => {
			order.push("commit");
			return {
				seq: 5,
				committedDoc: toPersistableDoc(prior) as unknown as BlueprintDoc,
				deduped: false,
			};
		});

		await applyBlueprintChange({
			appId: "app-1",
			userId: "user-1",
			priorBlueprint: toPersistableDoc(prior),
			batchId: "batch-order",
			kind: "autosave",
			guard: { mutations: renameVillageBatch(prior) },
		});

		// Reauth (loadAppProjectId → reauth) precedes the first applySchemaChange.
		expect(order[0]).toBe("loadAppProjectId");
		expect(order[1]).toBe("reauth");
		expect(order.indexOf("reauth")).toBeLessThan(
			order.indexOf("applySchemaChange"),
		);
		// [c5] the resolved projectId is threaded into commitGuardedBatch as
		// `preauthorized`, and resolved EXACTLY ONCE (the saga's, not doubled by
		// the commit) — so the commit skips its own redundant resolve + reauth.
		expect(loadAppProjectIdMock).toHaveBeenCalledTimes(1);
		expect(commitGuardedBatchMock.mock.calls[0]?.[0]).toMatchObject({
			preauthorized: { projectId: "proj-1" },
			// The migrated pairs ride into the commit's rename gate, which
			// re-proves them against the FRESH doc pair in-transaction.
			renameExpectations: [
				{ caseType: "patient", from: "village", to: "hamlet" },
			],
		});
	});

	it("skips the sweep on an IN-transaction dedup (deduped: true) — no clobbering with the stale seq/doc pair", async () => {
		// `commitGuardedBatch`'s in-txn dedup returns the ORIGINAL `seq` with the
		// CURRENT (peer-advanced) `committedDoc` — an inconsistent pair. The
		// sweep MUST be skipped (it already ran at the original commit); syncing
		// the newer schema at the stale seq would let a later stale-seq sweep
		// pass the monotone gate and drop a peer's property.
		const prior = minDoc();
		const prospective = structuredClone(toPersistableDoc(prior));
		prospective.caseTypes = [
			...(prospective.caseTypes ?? []),
			{ name: "household", properties: [{ name: "case_name", label: "N" }] },
		];
		loadAppMock.mockResolvedValue({ blueprint: toPersistableDoc(prior) });
		commitGuardedBatchMock.mockResolvedValue({
			seq: 4, // the ORIGINAL commit seq
			committedDoc: structuredClone(prospective) as unknown as BlueprintDoc,
			deduped: true, // in-txn dedup hit
		});
		applySchemaChangeMock.mockResolvedValue({
			migrated: 0,
			reshaped: 0,
			retyped: 0,
			restored: 0,
			skipped: 0,
			parkedIds: [],
			failureReasons: [],
		});

		const result = await applyBlueprintChange({
			appId: "app-1",
			userId: "user-1",
			prospective,
			batchId: "batch-intxn-dedup",
			kind: "autosave",
			guard: { mutations: [{ kind: "setAppName", name: "x" } as Mutation] },
		});

		// The commit result surfaces (with its committedDoc), but the sweep was
		// skipped entirely.
		expect(result.seq).toBe(4);
		expect(applySchemaChangeMock).not.toHaveBeenCalled();
	});
});
