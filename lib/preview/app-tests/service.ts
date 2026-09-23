import "server-only";
import { sql, type Transaction } from "kysely";
import type { Database } from "@/lib/case-store/sql/database";
import { resolveAuthorizedAppSnapshot } from "@/lib/db/appAccess";
import {
	type AppTestScope,
	advanceAppTestSession,
	createAppTestSession,
	readAppTestStartReceipt,
} from "@/lib/db/appTests";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import type { CaseDatabaseSnapshot } from "../engine/xpathInstances";
import { captureAppTestSnapshot } from "./capture";
import { withAppTestContext } from "./context";
import { advanceAppTest, observeAppTest } from "./run";
import { seedAppTest } from "./seed";
import {
	type AppTestSnapshot,
	type AppTestState,
	appTestActionSchema,
	appTestStartSchema,
} from "./types";

/** Stored checkpoints are server-produced, versioned by the session contract.
 * Rehydrate only database timestamps; user answers remain exact strings. */
function restoreState(value: Record<string, unknown>): AppTestState {
	const state = value as unknown as AppTestState;
	const restore = (snapshot: CaseDatabaseSnapshot): CaseDatabaseSnapshot => ({
		...snapshot,
		rows: snapshot.rows.map((row) => ({
			...row,
			opened_on: row.opened_on === null ? null : new Date(row.opened_on),
			modified_on: row.modified_on === null ? null : new Date(row.modified_on),
			closed_on: row.closed_on === null ? null : new Date(row.closed_on),
		})),
	});
	const screen = (entry: AppTestState["screen"]): AppTestState["screen"] =>
		entry.kind === "form"
			? { ...entry, entryCases: restore(entry.entryCases) }
			: entry;
	return {
		...state,
		deviceCases: restore(state.deviceCases),
		screen: screen(state.screen),
		history: state.history.map(screen),
	};
}

export async function startAppTest(
	scope: AppTestScope,
	args: { requestId: string; expectedBlueprintSeq: number; input: unknown },
) {
	const input = appTestStartSchema.parse(args.input);
	// The source revision is inferred at execution, not part of the author's
	// command. Recovery returns that command's original revision and receipt.
	const requestDigest = canonicalJsonDigest(input);
	const prior = await readAppTestStartReceipt({
		...scope,
		requestId: args.requestId,
		requestDigest,
	});
	if (prior) return prior;
	// Capture external read inputs before opening the test's transaction. Each
	// reader authorizes its scope; admission below rechecks membership and the
	// source revision. Holding a pool client while these readers open their own
	// transactions could exhaust the pool under concurrent starts.
	const authorized = await resolveAuthorizedAppSnapshot(
		scope.appId,
		scope.actorUserId,
		"view",
	);
	if (
		authorized.projectId !== scope.projectId ||
		authorized.baseSeq !== args.expectedBlueprintSeq
	)
		throw new Error(
			"The app changed. Read its current design before starting a test.",
		);
	const snapshot = await captureAppTestSnapshot(
		{ ...scope, role: authorized.role },
		authorized.app.blueprint,
		input,
	);
	return createAppTestSession({
		...scope,
		requestId: args.requestId,
		requestDigest,
		expectedBlueprintSeq: args.expectedBlueprintSeq,
		initialize: async (tx, source) => {
			const testScope = {
				...scope,
				testId: source.testId,
				blueprintSeq: source.blueprintSeq,
			};
			await seedAppTest(tx, testScope, snapshot, input);
			const suppliedRecords = new Map<string, number>();
			for (const record of input.scenario?.records ?? []) {
				suppliedRecords.set(
					record.caseType,
					(suppliedRecords.get(record.caseType) ?? 0) + 1,
				);
			}
			const initial: AppTestState = {
				personaUuid: null,
				screen: { kind: "home" },
				history: [],
				selections: {},
				deviceCases: { rows: [], indices: [] },
			};
			const observed = await withAppTestContext(
				tx as unknown as Transaction<Database>,
				testScope,
				snapshot,
				initial,
				async (context) => {
					const deviceCases = await context.store.readDeviceCaseDatabase({
						appId: scope.appId,
						restoreScope: context.restoreScope,
					});
					const result = await observeAppTest(context, scope, {
						...initial,
						deviceCases,
					});
					return {
						...result,
						observation: { ...result.observation, clock: context.clock },
					};
				},
			);
			return {
				snapshot: { ...snapshot },
				state: { ...observed.state },
				observation: {
					...observed.observation,
					purpose: input.purpose,
					suppliedRecords: Array.from(suppliedRecords, ([caseType, count]) => ({
						caseType,
						count,
					})),
					sourceRevision: source.blueprintSeq,
					lookupRevision: snapshot.lookup.projectRevision,
					organizationRevision: snapshot.organizationRevision,
					testPlaces: snapshot.testPlaceIds,
					testAssignments: snapshot.testAssignmentPersonaIds,
					boundary:
						"Disposable test records. Uses Preview and its Postgres submission path. No live case changes, media upload, device execution, or HQ synchronization. Test place assignments do not establish deployment readiness.",
				},
			};
		},
	});
}

export async function continueAppTest(
	scope: AppTestScope,
	args: {
		testId: string;
		requestId: string;
		expectedStep: number;
		action: unknown;
	},
) {
	const action = appTestActionSchema.parse(args.action);
	return advanceAppTestSession({
		...scope,
		testId: args.testId,
		requestId: args.requestId,
		requestDigest: canonicalJsonDigest({
			action,
			expectedStep: args.expectedStep,
		}),
		expectedStep: args.expectedStep,
		action,
		advance: async (tx, source) => {
			const snapshot = source.snapshot as unknown as AppTestSnapshot;
			const state = restoreState(source.state);
			const nextState: AppTestState =
				action.kind === "identity"
					? {
							...state,
							personaUuid: action.personaUuid,
							screen: { kind: "home" },
							history: [],
							selections: {},
							deviceCases: { rows: [], indices: [] },
						}
					: state;
			// A rejected action has a durable observation without partial effects.
			// In particular, a SQL rejection must be rolled back before saving it.
			await sql`SAVEPOINT app_test_action`.execute(tx);
			try {
				const observed = await withAppTestContext(
					tx as unknown as Transaction<Database>,
					{ ...scope, testId: args.testId, blueprintSeq: source.blueprintSeq },
					snapshot,
					nextState,
					async (context) => {
						const result =
							action.kind === "identity"
								? await observeAppTest(context, scope, {
										...nextState,
										deviceCases: await context.store.readDeviceCaseDatabase({
											appId: scope.appId,
											restoreScope: context.restoreScope,
										}),
									})
								: await advanceAppTest(
										context,
										{
											...scope,
											blueprintSeq: source.blueprintSeq,
											blueprintDigest: source.blueprintDigest,
											role: source.role,
										},
										nextState,
										action,
									);
						const count = await sql<{
							count: string;
						}>`SELECT count(*)::text AS count FROM cases WHERE app_id = ${scope.appId} AND project_id = ${scope.projectId}`.execute(
							tx,
						);
						if (
							Number(count.rows[0]?.count) > 2000 ||
							JSON.stringify(result.state).length > 16 * 1024 * 1024
						)
							throw new Error(
								"This test exceeded its record or state limit. Start a smaller journey.",
							);
						return {
							...result,
							observation: { ...result.observation, clock: context.clock },
						};
					},
				);
				await sql`RELEASE SAVEPOINT app_test_action`.execute(tx);
				return {
					state: { ...observed.state },
					observation: observed.observation,
				};
			} catch (error) {
				await sql`ROLLBACK TO SAVEPOINT app_test_action`.execute(tx);
				await sql`RELEASE SAVEPOINT app_test_action`.execute(tx);
				return {
					state: { ...state },
					observation: {
						action: action.kind,
						completed: false,
						error:
							error instanceof Error
								? error.message
								: "The test action could not be completed.",
					},
				};
			}
		},
	});
}
