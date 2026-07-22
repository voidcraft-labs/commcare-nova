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
	RunHolderLostError,
} from "../commitGuard";

const { loadAppMock, commitGuardedBatchMock, authorizedSideEffectMock } =
	vi.hoisted(() => ({
		loadAppMock: vi.fn(),
		commitGuardedBatchMock: vi.fn(),
		authorizedSideEffectMock: vi.fn(),
	}));

const unparkValuesMock = vi.fn(async () => ({ restored: 0, kept: 0 }));
const {
	applySchemaChangeMock,
	applySchemaChangePhaseAMock,
	completeAfterCommitMock,
	dropSchemaMock,
	withSchemaContextMock,
} = vi.hoisted(() => ({
	applySchemaChangeMock: vi.fn(),
	applySchemaChangePhaseAMock: vi.fn(),
	completeAfterCommitMock: vi.fn(),
	dropSchemaMock: vi.fn(),
	withSchemaContextMock: vi.fn(),
}));

// The top-level dedup pre-check reads the `accepted_mutations (app_id, batch_id)`
// latch via `getAppDb()`. `latchRowMock` scripts that single-row read: `undefined`
// = no prior latch (proceed), `{ seq }` = a dedup hit.
const { latchRowMock } = vi.hoisted(() => ({
	latchRowMock: vi.fn(),
}));

vi.mock("@/lib/db/apps", () => ({
	loadApp: loadAppMock,
	commitGuardedBatch: commitGuardedBatchMock,
	withAuthorizedAppEditSideEffect: authorizedSideEffectMock,
}));

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

function addHouseholdBatch(): Mutation[] {
	return [
		{ kind: "declareCaseType", caseType: "household" },
		{
			kind: "addCaseProperty",
			caseType: "household",
			property: { name: "case_name", label: "N" },
		},
	];
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
	authorizedSideEffectMock.mockImplementation(
		async (
			_appId: string,
			_userId: string,
			expectedProjectId: string | null,
			_chatRunHolder: unknown,
			effect: (
				tx: never,
				scope: { projectId: string | null },
			) => Promise<unknown>,
		) => ({
			projectId: expectedProjectId,
			value: await effect({} as never, { projectId: expectedProjectId }),
		}),
	);
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
	completeAfterCommitMock.mockResolvedValue(undefined);
	applySchemaChangePhaseAMock.mockImplementation(async (_tx, args) => ({
		report: await applySchemaChangeMock(args),
		completeAfterCommit: completeAfterCommitMock,
	}));
	withSchemaContextMock.mockResolvedValue({
		applySchemaChange: applySchemaChangeMock,
		applySchemaChangePhaseA: applySchemaChangePhaseAMock,
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
			expectedProjectId: null,
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
			expectedProjectId: null,
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
				expectedProjectId: null,
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
				expectedProjectId: null,
				priorBlueprint: toPersistableDoc(fresh),
				batchId: "batch-uuid-3",
				kind: "autosave",
				guard: {
					mutations: [{ kind: "setAppName", name: "Renamed" } as Mutation],
				},
			}),
		).rejects.toBeInstanceOf(CommitReauthError);
	});

	it("rejects reducer-minted identity after a latch miss but before projection, schema work, or commit", async () => {
		const prior = minDoc();
		const target = Object.values(prior.fields)[0];
		if (target === undefined) throw new Error("fixture has no field");

		await expect(
			applyBlueprintChange({
				appId: "app-1",
				userId: "user-1",
				expectedProjectId: null,
				prospective: toPersistableDoc(prior),
				batchId: "raw-duplicate",
				kind: "autosave",
				guard: {
					mutations: [{ kind: "duplicateField", uuid: target.uuid }],
				},
			}),
		).rejects.toBeInstanceOf(BlueprintCommitRejectedError);

		expect(latchRowMock).toHaveBeenCalledTimes(1);
		expect(loadAppMock).not.toHaveBeenCalled();
		expect(withSchemaContextMock).not.toHaveBeenCalled();
		expect(commitGuardedBatchMock).not.toHaveBeenCalled();
	});
});

describe("applyBlueprintChange — top-level batchId dedup", () => {
	it("short-circuits an admission-invalid payload on a pre-existing latch without validating or applying it", async () => {
		latchRowMock.mockResolvedValue({ seq: 42 });
		const prior = minDoc();
		const target = Object.values(prior.fields)[0];
		if (target === undefined) throw new Error("fixture has no field");

		const result = await applyBlueprintChange({
			appId: "app-1",
			userId: "user-1",
			expectedProjectId: null,
			prospective: toPersistableDoc(prior),
			batchId: "already-committed",
			kind: "mcp",
			guard: {
				mutations: [{ kind: "duplicateField", uuid: target.uuid }],
			},
		});

		// The recorded seq comes straight off the latch — no committedDoc.
		expect(result).toEqual({ seq: 42 });
		expect(result.committedDoc).toBeUndefined();
		// Nothing downstream ran — not even the app-locked Phase-1 admission.
		expect(commitGuardedBatchMock).not.toHaveBeenCalled();
		expect(loadAppMock).not.toHaveBeenCalled();
		expect(authorizedSideEffectMock).not.toHaveBeenCalled();
		expect(withSchemaContextMock).not.toHaveBeenCalled();
	});
});

describe("applyBlueprintChange — locked admission before any Postgres DDL", () => {
	it("rejects a deauth'd caller BEFORE the migration-bearing Phase-1 DDL runs", async () => {
		const prior = minDoc();
		loadAppMock.mockResolvedValue({ blueprint: toPersistableDoc(prior) });
		authorizedSideEffectMock.mockRejectedValue(
			new CommitReauthError("You no longer have edit access."),
		);

		await expect(
			applyBlueprintChange({
				appId: "app-1",
				userId: "user-1",
				expectedProjectId: null,
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

		expect(authorizedSideEffectMock).toHaveBeenCalledWith(
			"app-1",
			"user-1",
			null,
			undefined,
			expect.any(Function),
		);
		expect(applySchemaChangeMock).not.toHaveBeenCalled();
		expect(applySchemaChangePhaseAMock).not.toHaveBeenCalled();
		expect(dropSchemaMock).not.toHaveBeenCalled();
		expect(unparkValuesMock).not.toHaveBeenCalled();
		expect(commitGuardedBatchMock).not.toHaveBeenCalled();
	});

	it("threads exact chat holder authority into migration admission and stops before Phase A when stale", async () => {
		const prior = minDoc();
		const chatRunHolder = {
			source: "chat" as const,
			mode: "build" as const,
			runId: "stale-build",
			nonce: "00000000-0000-4000-8000-000000000001",
		};
		loadAppMock.mockResolvedValue({ blueprint: toPersistableDoc(prior) });
		authorizedSideEffectMock.mockRejectedValue(
			new RunHolderLostError("superseded"),
		);

		await expect(
			applyBlueprintChange({
				appId: "app-1",
				userId: "user-1",
				expectedProjectId: null,
				priorBlueprint: toPersistableDoc(prior),
				runId: chatRunHolder.runId,
				chatRunHolder,
				batchId: "batch-stale-holder",
				kind: "chat",
				guard: { mutations: renameVillageBatch(prior) },
			}),
		).rejects.toBeInstanceOf(RunHolderLostError);

		expect(authorizedSideEffectMock).toHaveBeenCalledWith(
			"app-1",
			"user-1",
			null,
			chatRunHolder,
			expect.any(Function),
		);
		expect(applySchemaChangePhaseAMock).not.toHaveBeenCalled();
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
				expectedProjectId: null,
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

	it("compensates a migration entry whose post-commit Phase B fails", async () => {
		// The shared authorization + Phase-A transaction has committed before
		// concurrent-index Phase B runs. A Phase-B failure therefore must retain
		// the recorded report and compensate the durable schema/data work.
		const prior = minDoc();
		loadAppMock.mockResolvedValue({
			blueprint: toPersistableDoc(prior),
			mutation_seq: 4,
		});
		applySchemaChangeMock
			// Phase A succeeds and commits before Phase B fails.
			.mockResolvedValueOnce({
				migrated: 1,
				reshaped: 0,
				retyped: 0,
				restored: 0,
				parkedIds: [],
				skipped: 0,
				failureReasons: [],
			})
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
		completeAfterCommitMock.mockRejectedValueOnce(
			new Error("phase B index DDL failed"),
		);

		await expect(
			applyBlueprintChange({
				appId: "app-1",
				userId: "user-1",
				expectedProjectId: null,
				priorBlueprint: toPersistableDoc(prior),
				batchId: "batch-phaseB-fail",
				kind: "autosave",
				guard: { mutations: renameVillageBatch(prior) },
			}),
		).rejects.toThrow("phase B index DDL failed");

		// Three schema operations: committed Phase A (through the test adapter),
		// then the compensating inverse rename and seq-guarded additive re-sync.
		expect(applySchemaChangeMock).toHaveBeenCalledTimes(3);
		expect(completeAfterCommitMock).toHaveBeenCalledTimes(1);
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
			expectedProjectId: null,
			prospective,
			batchId: "batch-uuid-sweep",
			kind: "autosave",
			guard: {
				mutations: addHouseholdBatch(),
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
				expectedProjectId: null,
				prospective,
				batchId: `batch-uuid-sweepfail-${_label}`,
				kind: "autosave",
				guard: {
					mutations: addHouseholdBatch(),
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
			expectedProjectId: null,
			prospective: toPersistableDoc(fresh),
			batchId: "batch-uuid-5",
			kind: "autosave",
			guard: {
				mutations: [{ kind: "setAppName", name: "Renamed" } as Mutation],
			},
		});

		expect(commitGuardedBatchMock).toHaveBeenCalledTimes(1);
		expect(withSchemaContextMock).not.toHaveBeenCalled();
		// No Phase-1 admission on the fast path; the guarded commit is the gate.
		expect(authorizedSideEffectMock).not.toHaveBeenCalled();
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
			expectedProjectId: null,
			prospective,
			batchId: "batch-additive-noreauth",
			kind: "autosave",
			guard: { mutations: addHouseholdBatch() },
		});

		expect(authorizedSideEffectMock).not.toHaveBeenCalled();
	});

	it("commits locked Phase A before post-commit Phase B and the blueprint", async () => {
		const order: string[] = [];
		const prior = minDoc();
		const chatRunHolder = {
			source: "chat" as const,
			mode: "edit" as const,
			runId: "edit-run-1",
			nonce: "00000000-0000-4000-8000-000000000001",
		};
		loadAppMock.mockResolvedValue({ blueprint: toPersistableDoc(prior) });
		authorizedSideEffectMock.mockImplementation(
			async (
				_appId: string,
				_userId: string,
				expectedProjectId: string,
				observedChatRunHolder: unknown,
				effect: (tx: never, scope: { projectId: string }) => Promise<unknown>,
			) => {
				order.push("admission:start");
				expect(expectedProjectId).toBe("proj-1");
				expect(observedChatRunHolder).toEqual(chatRunHolder);
				const value = await effect({} as never, { projectId: "proj-1" });
				order.push("admission:end");
				return { projectId: "proj-1", value };
			},
		);
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
		completeAfterCommitMock.mockImplementation(async () => {
			order.push("phaseB");
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
			expectedProjectId: "proj-1",
			priorBlueprint: toPersistableDoc(prior),
			runId: chatRunHolder.runId,
			chatRunHolder,
			batchId: "batch-order",
			kind: "chat",
			guard: { mutations: renameVillageBatch(prior) },
		});

		expect(order[0]).toBe("admission:start");
		expect(order.indexOf("admission:start")).toBeLessThan(
			order.indexOf("applySchemaChange"),
		);
		expect(order.indexOf("applySchemaChange")).toBeLessThan(
			order.indexOf("admission:end"),
		);
		expect(order.indexOf("admission:end")).toBeLessThan(
			order.indexOf("phaseB"),
		);
		expect(order.indexOf("phaseB")).toBeLessThan(order.indexOf("commit"));
		expect(commitGuardedBatchMock.mock.calls[0]?.[0]).toMatchObject({
			expectedProjectId: "proj-1",
			runId: chatRunHolder.runId,
			chatRunHolder,
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
			expectedProjectId: null,
			prospective,
			batchId: "batch-intxn-dedup",
			kind: "autosave",
			guard: { mutations: addHouseholdBatch() },
		});

		// The commit result surfaces (with its committedDoc), but the sweep was
		// skipped entirely.
		expect(result.seq).toBe(4);
		expect(applySchemaChangeMock).not.toHaveBeenCalled();
	});
});
