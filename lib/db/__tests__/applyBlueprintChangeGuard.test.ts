/**
 * The guarded `applyBlueprintChange` wiring around the one Blueprint-commit
 * chokepoint, `commitGuardedBatch`. This file mocks the writer and case-schema
 * store to pin the boundary composition:
 *
 *   1. Every persist threads the unified writer's args verbatim — `batchId`,
 *      `kind`, `runId` (when present), `actorUserId` (the caller's `userId`),
 *      and the guard's `mutations`.
 *   2. The result surfaces `seq` + the writer's hydrated `committedDoc`.
 *   3. Idempotency and fresh authorization remain inside the guarded writer;
 *      this boundary has no actor-free latch shortcut.
 *   4. Explicit rename storage admission runs from the writer's `beforeWrite`
 *      hook and maps occupancy to the standard commit rejection.
 *
 * The deep read-evaluate-write behavior the writer itself owns (re-apply on the
 * FRESH stored doc, the concurrent-delete guard, the fresh-doc re-verdict, the
 * per-commit reauth, and canonical document hydration) is exercised against a REAL
 * Postgres transaction in `commitGuardedBatchTransactions.postgres.test.ts`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { CasePropertyRenameStorageConflictError } from "@/lib/case-store";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { admitMutationBatch } from "@/lib/doc/mutationAdmission";
import type { Mutation } from "@/lib/doc/types";
import { type BlueprintDoc, fieldCaseWrite } from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import { applyBlueprintChange as applyBlueprintChangeOpaque } from "../applyBlueprintChange";
import {
	BlueprintCommitRejectedError,
	CommitReauthError,
} from "../commitGuard";

const PROJECT_ID = "project-test";

const { commitGuardedBatchMock } = vi.hoisted(() => ({
	commitGuardedBatchMock: vi.fn(),
}));

const applyBlueprintChange = (
	args: Omit<Parameters<typeof applyBlueprintChangeOpaque>[0], "guard"> & {
		guard: Omit<
			Parameters<typeof applyBlueprintChangeOpaque>[0]["guard"],
			"mutations"
		> & { mutations: unknown };
	},
) =>
	applyBlueprintChangeOpaque({
		...args,
		guard: {
			...args.guard,
			mutations: admitMutationBatch(args.guard.mutations),
		},
	});

const {
	applySchemaChangeMock,
	applyCasePropertyRenamePhaseAMock,
	retireSchemasPhaseAMock,
	completeRetirementMock,
	drainPendingIndexConvergenceMock,
	drainRetiredIndexConvergenceMock,
	withSchemaContextMock,
	withProjectContextMock,
} = vi.hoisted(() => ({
	applySchemaChangeMock: vi.fn(),
	applyCasePropertyRenamePhaseAMock: vi.fn(),
	retireSchemasPhaseAMock: vi.fn(),
	completeRetirementMock: vi.fn(),
	drainPendingIndexConvergenceMock: vi.fn(),
	drainRetiredIndexConvergenceMock: vi.fn(),
	withSchemaContextMock: vi.fn(),
	withProjectContextMock: vi.fn(),
}));

vi.mock("@/lib/db/apps", () => ({
	commitGuardedBatch: commitGuardedBatchMock,
}));

vi.mock("@/lib/case-store", async () => {
	const actual = (await vi.importActual("@/lib/case-store")) as Record<
		string,
		unknown
	>;
	return {
		...actual,
		withSchemaContext: withSchemaContextMock,
		withProjectContext: withProjectContextMock,
	};
});

function addHouseholdBatch(): Mutation[] {
	return [
		{ kind: "declareCaseType", caseType: "household" },
		{
			kind: "addCaseProperty",
			caseType: "household",
			property: { name: "case_name", label: proseText("N") },
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

function mockGuardedCommit(
	result: {
		seq: number;
		committedDoc: BlueprintDoc;
		deduped: boolean;
	},
	freshDoc: BlueprintDoc = result.committedDoc,
): void {
	commitGuardedBatchMock.mockImplementationOnce(async (_args, hooks) => {
		if (!result.deduped) {
			await hooks?.beforeWrite?.({
				tx: {},
				freshDoc,
				nextDoc: result.committedDoc,
				seq: result.seq,
			});
		}
		return result;
	});
}

/** The per-worker store `sweepCommittedUsercaseRows` binds, one per worker. */
const usercaseStoreMock = {
	query: vi.fn(),
	insert: vi.fn(),
	update: vi.fn(),
	close: vi.fn(),
};

beforeEach(() => {
	vi.clearAllMocks();
	// Every sync returns the empty report by default — the boundary aggregates
	// `parkedIds` etc. off every return, so the mock must honor the
	// `MigrationReport` contract; per-test overrides replace this.
	applySchemaChangeMock.mockResolvedValue({
		migrated: 0,
		reshaped: 0,
		retyped: 0,
		restored: 0,
		skipped: 0,
		parkedIds: [],
		failureReasons: [],
	});
	completeRetirementMock.mockResolvedValue(undefined);
	drainPendingIndexConvergenceMock.mockResolvedValue(undefined);
	drainRetiredIndexConvergenceMock.mockResolvedValue(undefined);
	retireSchemasPhaseAMock.mockResolvedValue({
		caseTypes: ["patient"],
		completeAfterCommit: completeRetirementMock,
	});
	usercaseStoreMock.query.mockResolvedValue([]);
	usercaseStoreMock.insert.mockResolvedValue(undefined);
	usercaseStoreMock.update.mockResolvedValue(undefined);
	usercaseStoreMock.close.mockResolvedValue(undefined);
	withProjectContextMock.mockResolvedValue(usercaseStoreMock);
	withSchemaContextMock.mockResolvedValue({
		applySchemaChange: applySchemaChangeMock,
		applyCasePropertyRenamePhaseA: applyCasePropertyRenamePhaseAMock,
		retireSchemasPhaseA: retireSchemasPhaseAMock,
		drainPendingIndexConvergence: drainPendingIndexConvergenceMock,
		drainRetiredIndexConvergence: drainRetiredIndexConvergenceMock,
	});
});

describe("applyBlueprintChange — routes the guard through commitGuardedBatch", () => {
	it("threads batchId + kind + runId + actorUserId + mutations to the writer and returns its seq + committedDoc", async () => {
		const fresh = minDoc();
		const committed: BlueprintDoc = { ...fresh, appName: "Renamed" };
		mockGuardedCommit({
			seq: 7,
			committedDoc: committed,
			deduped: false,
		});

		const mutations: Mutation[] = [{ kind: "setAppName", name: "Renamed" }];
		const result = await applyBlueprintChange({
			appId: "app-1",
			userId: "user-1",
			expectedProjectId: PROJECT_ID,
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
		// The boundary surfaces the writer's committed seq + hydrated doc.
		expect(result.seq).toBe(7);
		expect(result.committedDoc).toBe(committed);
	});

	it("propagates a BlueprintCommitRejectedError from the writer (nothing swallowed)", async () => {
		commitGuardedBatchMock.mockRejectedValue(
			new BlueprintCommitRejectedError("removed by someone else"),
		);

		await expect(
			applyBlueprintChange({
				appId: "app-1",
				userId: "user-1",
				expectedProjectId: PROJECT_ID,
				batchId: "batch-uuid-2",
				kind: "autosave",
				guard: {
					mutations: [{ kind: "setAppName", name: "Renamed" } as Mutation],
				},
			}),
		).rejects.toBeInstanceOf(BlueprintCommitRejectedError);
	});

	it("maps authoritative rename occupancy to the standard commit rejection", async () => {
		const fresh = minDoc();
		applyCasePropertyRenamePhaseAMock.mockRejectedValueOnce(
			new CasePropertyRenameStorageConflictError(
				"patient",
				"hamlet",
				"parked-value",
			),
		);
		commitGuardedBatchMock.mockImplementationOnce(
			async (
				_args,
				hooks: { beforeWrite?: (context: unknown) => Promise<void> },
			) => {
				await hooks.beforeWrite?.({
					tx: {},
					freshDoc: fresh,
					nextDoc: fresh,
					seq: 1,
					casePropertyRenamePlan: {
						entries: [
							{
								caseType: "patient",
								from: "village",
								to: "hamlet",
							},
						],
					},
				});
				throw new Error("unreachable");
			},
		);

		await expect(
			applyBlueprintChange({
				appId: "app-1",
				userId: "user-1",
				expectedProjectId: PROJECT_ID,
				batchId: "batch-rename-conflict",
				kind: "autosave",
				guard: {
					mutations: [
						{
							kind: "renameCaseProperties",
							renames: [
								{
									caseType: "patient",
									from: "village",
									to: "hamlet",
								},
							],
						},
					],
				},
			}),
		).rejects.toThrow(
			'Saved parked data now occupies "hamlet" on "patient". Review the rename conflicts and try again.',
		);
	});

	it("propagates a terminal CommitReauthError from the writer", async () => {
		commitGuardedBatchMock.mockRejectedValue(
			new CommitReauthError("You no longer have edit access."),
		);

		await expect(
			applyBlueprintChange({
				appId: "app-1",
				userId: "user-1",
				expectedProjectId: PROJECT_ID,
				batchId: "batch-uuid-3",
				kind: "autosave",
				guard: {
					mutations: [{ kind: "setAppName", name: "Renamed" } as Mutation],
				},
			}),
		).rejects.toBeInstanceOf(CommitReauthError);
	});

	it("lets the guarded latch admit an exact retry after a peer removed its original target", async () => {
		const current = minDoc("Current after peer delete");
		const missingTarget = testUuid("00000000-0000-4000-8000-000000000099");
		commitGuardedBatchMock.mockResolvedValue({
			seq: 4,
			committedDoc: current,
			deduped: true,
		});

		const result = await applyBlueprintChange({
			appId: "app-1",
			userId: "user-1",
			expectedProjectId: PROJECT_ID,
			batchId: "exact-retry-after-delete",
			kind: "autosave",
			guard: {
				mutations: [
					{
						kind: "updateField",
						uuid: missingTarget,
						targetKind: "text",
						patch: { label: proseText("Already committed") },
					},
				],
			},
		});

		expect(result).toMatchObject({ seq: 4, committedDoc: current });
		expect(withSchemaContextMock).not.toHaveBeenCalled();
	});
});

describe("applyBlueprintChange — derived schema materialization", () => {
	it("retires a removed case type inside the guarded Blueprint transaction", async () => {
		const prior = minDoc();
		const committed = {
			...prior,
			caseTypes: [],
			modules: {},
			forms: {},
			fields: {},
			moduleOrder: [],
			formOrder: {},
			fieldOrder: {},
			fieldParent: {},
		} satisfies BlueprintDoc;
		const tx = {};
		commitGuardedBatchMock.mockImplementationOnce(async (_args, hooks) => {
			await hooks?.beforeWrite?.({
				tx,
				freshDoc: prior,
				nextDoc: committed,
				seq: 11,
			});
			expect(completeRetirementMock).not.toHaveBeenCalled();
			return { seq: 11, committedDoc: committed, deduped: false };
		});

		const result = await applyBlueprintChange({
			appId: "app-1",
			userId: "user-1",
			expectedProjectId: PROJECT_ID,
			batchId: "retire-patient",
			kind: "autosave",
			guard: {
				mutations: [{ kind: "retireCaseType", caseType: "patient" }],
			},
		});

		expect(retireSchemasPhaseAMock).toHaveBeenCalledTimes(1);
		const [retirementTx, retirementArgs] =
			retireSchemasPhaseAMock.mock.calls[0] ?? [];
		expect(retirementTx).toBe(tx);
		expect(retirementArgs).toMatchObject({
			appId: "app-1",
			desiredSeq: 11,
			caseTypes: ["patient"],
		});
		expect(retirementArgs.fallbackCaseTypeSchemas.has("patient")).toBe(true);
		expect(completeRetirementMock).toHaveBeenCalledTimes(1);
		expect(applySchemaChangeMock).not.toHaveBeenCalled();
		expect(result).toEqual({ seq: 11, committedDoc: committed });
	});

	it("retries durable retirement index work on an exact dedup", async () => {
		const prior = minDoc();
		const committed = {
			...prior,
			caseTypes: [],
			modules: {},
			forms: {},
			fields: {},
			moduleOrder: [],
			formOrder: {},
			fieldOrder: {},
			fieldParent: {},
		} satisfies BlueprintDoc;
		commitGuardedBatchMock.mockResolvedValue({
			seq: 11,
			committedDoc: committed,
			deduped: true,
		});

		await applyBlueprintChange({
			appId: "app-1",
			userId: "user-1",
			expectedProjectId: PROJECT_ID,
			batchId: "retire-patient-retry",
			kind: "autosave",
			guard: {
				mutations: [{ kind: "retireCaseType", caseType: "patient" }],
			},
		});

		expect(retireSchemasPhaseAMock).not.toHaveBeenCalled();
		expect(drainPendingIndexConvergenceMock).not.toHaveBeenCalled();
		expect(drainRetiredIndexConvergenceMock).toHaveBeenCalledWith({
			appId: "app-1",
			caseTypes: ["patient"],
		});
	});

	it("classifies a queued field conversion from the peer-retargeted writer destination", async () => {
		const fieldUuid = testUuid("peer-retargeted-writer");
		const writerDoc = (
			kind: "text" | "int",
			caseType: "patient" | "visit",
			property: "a" | "b",
		): BlueprintDoc =>
			buildDoc({
				appName: "Fresh",
				caseTypes: [
					{
						name: "patient",
						properties:
							caseType === "patient"
								? [{ name: "a", label: proseText("A") }]
								: [],
					},
					{
						name: "visit",
						properties:
							caseType === "visit"
								? [{ name: "b", label: proseText("B") }]
								: [],
					},
				],
				modules: [
					{
						name: "Cases",
						caseType,
						forms: [
							{
								name: "Update",
								type: "followup",
								fields: [
									f({
										uuid: fieldUuid,
										kind,
										id: "answer",
										label: proseText("Answer"),
										caseWrite: { caseType, property },
									}),
								],
							},
						],
					},
				],
			});

		// The conversion was queued when this writer still targeted patient.a.
		const queuedAgainst = writerDoc("text", "patient", "a");
		expect(fieldCaseWrite(queuedAgainst.fields[fieldUuid])).toEqual({
			caseType: "patient",
			property: "a",
		});

		// A peer retargeted the same UUID to visit.b before our writer acquired
		// the app lock. The guarded writer replays convertField on this fresh doc.
		const fresh = writerDoc("text", "visit", "b");
		const committed = writerDoc("int", "visit", "b");
		mockGuardedCommit(
			{ seq: 8, committedDoc: committed, deduped: false },
			fresh,
		);

		await applyBlueprintChange({
			appId: "app-1",
			userId: "user-1",
			expectedProjectId: PROJECT_ID,
			batchId: "fresh-classification",
			kind: "autosave",
			guard: {
				mutations: [{ kind: "convertField", uuid: fieldUuid, toKind: "int" }],
			},
		});

		expect(applySchemaChangeMock).toHaveBeenCalledTimes(1);
		expect(applySchemaChangeMock.mock.calls[0]?.[0]).toMatchObject({
			appId: "app-1",
			caseType: "visit",
			syncedSeq: 8,
		});
		expect(applySchemaChangeMock).not.toHaveBeenCalledWith(
			expect.objectContaining({ caseType: "patient" }),
		);
	});

	it("post-commit-sweeps every touched case type against the COMMITTED doc at the committed seq", async () => {
		// An additive case-type addition rides the post-commit derived-schema
		// sweep; only explicit rename row movement belongs in `beforeWrite`.
		const prior = minDoc();
		const prospective = structuredClone(toPersistableDoc(prior));
		prospective.caseTypes = [
			...(prospective.caseTypes ?? []),
			{
				name: "household",
				properties: [{ name: "case_name", label: proseText("N") }],
			},
		];
		// The committed doc carries BOTH types — the sweep re-derives its schema.
		const committed = structuredClone(prospective) as unknown as BlueprintDoc;
		mockGuardedCommit(
			{
				seq: 9,
				committedDoc: committed,
				deduped: false,
			},
			prior,
		);
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
			expectedProjectId: PROJECT_ID,
			batchId: "batch-uuid-sweep",
			kind: "autosave",
			guard: {
				mutations: addHouseholdBatch(),
			},
		});

		// One post-commit sweep of the added `household` type at
		// `syncedSeq = 9` off the committed doc.
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
				{
					name: "household",
					properties: [{ name: "case_name", label: proseText("N") }],
				},
			];
			const committed = structuredClone(prospective) as unknown as BlueprintDoc;
			mockGuardedCommit(
				{
					seq: 3,
					committedDoc: committed,
					deduped: false,
				},
				prior,
			);
			// The sweep throws — it must NOT propagate.
			applySchemaChangeMock.mockRejectedValue(sweepError);

			const result = await applyBlueprintChange({
				appId: "app-1",
				userId: "user-1",
				expectedProjectId: PROJECT_ID,
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

	it("skips Postgres entirely for a non-case-type batch", async () => {
		const fresh = minDoc();
		mockGuardedCommit({
			seq: 2,
			committedDoc: fresh,
			deduped: false,
		});

		await applyBlueprintChange({
			appId: "app-1",
			userId: "user-1",
			expectedProjectId: PROJECT_ID,
			batchId: "batch-uuid-5",
			kind: "autosave",
			guard: {
				mutations: [{ kind: "setAppName", name: "Renamed" } as Mutation],
			},
		});

		expect(commitGuardedBatchMock).toHaveBeenCalledTimes(1);
		expect(withSchemaContextMock).not.toHaveBeenCalled();
		// No Phase-1 admission on the fast path; the guarded commit is the gate.
		expect(commitGuardedBatchMock).toHaveBeenCalledTimes(1);
	});

	it("uses the guarded writer as the sole authorization owner on the additive path", async () => {
		// An additive case-type addition touches Postgres only AFTER the commit
		// (the sweep), so the guarded commit is the one authorization owner.
		const prior = minDoc();
		const prospective = structuredClone(toPersistableDoc(prior));
		prospective.caseTypes = [
			...(prospective.caseTypes ?? []),
			{
				name: "household",
				properties: [{ name: "case_name", label: proseText("N") }],
			},
		];
		mockGuardedCommit(
			{
				seq: 9,
				committedDoc: structuredClone(prospective) as unknown as BlueprintDoc,
				deduped: false,
			},
			prior,
		);
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
			expectedProjectId: PROJECT_ID,
			batchId: "batch-additive-noreauth",
			kind: "autosave",
			guard: { mutations: addHouseholdBatch() },
		});

		expect(commitGuardedBatchMock).toHaveBeenCalledTimes(1);
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
			{
				name: "household",
				properties: [{ name: "case_name", label: proseText("N") }],
			},
		];
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
			expectedProjectId: PROJECT_ID,
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

describe("applyBlueprintChange — the worker's own case follows the commit", () => {
	const WORKER_A = "1a2b3c4d-0000-4000-8000-00000000000a";
	const WORKER_B = "1a2b3c4d-0000-4000-8000-00000000000b";

	/** A document carrying nothing but personas — the sweep reads no more. */
	function withPersonas(
		personas: ReadonlyArray<{ uuid: string; name: string }>,
	): BlueprintDoc {
		return {
			...toPersistableDoc(minDoc()),
			personas: Object.fromEntries(
				personas.map((persona) => [persona.uuid, persona]),
			),
			personaOrder: personas.map((persona) => persona.uuid),
			userProperties: {},
			userTypes: {},
		} as unknown as BlueprintDoc;
	}

	/** Drive one commit whose fresh doc is `prior` and result is `next`. */
	async function commit(prior: BlueprintDoc, next: BlueprintDoc) {
		commitGuardedBatchMock.mockImplementationOnce(async (_args, hooks) => {
			await hooks?.beforeWrite?.({
				tx: {},
				freshDoc: prior,
				nextDoc: next,
				seq: 7,
			});
			return { seq: 7, committedDoc: next, deduped: false };
		});
		return applyBlueprintChange({
			appId: "app-1",
			userId: "user-1",
			expectedProjectId: PROJECT_ID,
			batchId: "batch-usercase",
			kind: "autosave",
			guard: { mutations: addHouseholdBatch() },
		});
	}

	it("closes a removed worker's case and leaves every other worker alone", async () => {
		// Closed, never deleted: HQ's own deactivation path closes the usercase
		// and leaves the cases that worker owned open
		// (`sync_usercase.py::_get_sync_usercase_helper`), and it is the same
		// preserve-the-rows policy every other Nova removal follows. The only
		// row named here is the departing worker's own.
		await commit(
			withPersonas([
				{ uuid: WORKER_A, name: "Amara" },
				{ uuid: WORKER_B, name: "Bilal" },
			]),
			withPersonas([{ uuid: WORKER_B, name: "Bilal" }]),
		);

		expect(usercaseStoreMock.close).toHaveBeenCalledTimes(1);
		expect(usercaseStoreMock.close).toHaveBeenCalledWith({
			appId: "app-1",
			caseId: WORKER_A,
		});
		// Bilal is unchanged, so nothing about him is read or written either.
		expect(usercaseStoreMock.query).not.toHaveBeenCalled();
	});

	it("binds the close to the departing worker's own identity", async () => {
		// `CaseInsert` carries no `owner_id` — the store stamps it from the
		// identity it is bound to — so the sweep takes one store per worker. A
		// shared store would stamp every worker's case with whoever happened to
		// come first, putting it outside its own worker's restore.
		await commit(
			withPersonas([{ uuid: WORKER_A, name: "Amara" }]),
			withPersonas([]),
		);

		expect(withProjectContextMock).toHaveBeenCalledWith(
			PROJECT_ID,
			"user-1",
			WORKER_A,
		);
	});

	it("costs no database work at all when a commit touches no worker", async () => {
		// THE point of `workersNeedingUsercaseSync` being pure. A field edit is
		// the overwhelmingly common commit and fires on every autosave; one read
		// per persona there would be a real cost for nothing.
		const unchanged = withPersonas([
			{ uuid: WORKER_A, name: "Amara" },
			{ uuid: WORKER_B, name: "Bilal" },
		]);
		await commit(unchanged, structuredClone(unchanged));

		expect(withProjectContextMock).not.toHaveBeenCalled();
		expect(usercaseStoreMock.query).not.toHaveBeenCalled();
		expect(usercaseStoreMock.close).not.toHaveBeenCalled();
	});

	it("re-syncs only the worker a rename actually changed", async () => {
		await commit(
			withPersonas([
				{ uuid: WORKER_A, name: "Amara" },
				{ uuid: WORKER_B, name: "Bilal" },
			]),
			withPersonas([
				{ uuid: WORKER_A, name: "Amara Sow" },
				{ uuid: WORKER_B, name: "Bilal" },
			]),
		);

		expect(withProjectContextMock).toHaveBeenCalledTimes(1);
		expect(withProjectContextMock).toHaveBeenCalledWith(
			PROJECT_ID,
			"user-1",
			WORKER_A,
		);
		expect(usercaseStoreMock.close).not.toHaveBeenCalled();
	});

	it("lets a commit stand when the worker's case cannot be written", async () => {
		// Best-effort, and swallowed exactly like the schema sweep: this runs on
		// the already-committed autosave thread, so a blip must not fail a
		// commit that has landed. A missed row self-heals — the preview creates
		// one when it resolves a persona without it.
		usercaseStoreMock.query.mockRejectedValue(new Error("connection reset"));

		const result = await commit(
			withPersonas([]),
			withPersonas([{ uuid: WORKER_A, name: "Amara" }]),
		);

		expect(result.seq).toBe(7);
	});
});
