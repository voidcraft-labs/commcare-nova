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
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import { ownRecordValue } from "@/lib/domain";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import type { CaseDatabaseSnapshot } from "../engine/xpathInstances";
import { appTestExpectationMismatch, bindAppTestAction } from "./addresses";
import { captureAppTestSnapshot } from "./capture";
import { appTestLanguage, withAppTestContext } from "./context";
import { AppTestActionError, expectedAppTestRefusal } from "./errors";
import { advanceAppTest, observeAppTest } from "./run";
import { seedAppTest } from "./seed";
import {
	type AppTestAction,
	type AppTestSessionState,
	type AppTestSnapshot,
	type AppTestState,
	appTestActionItemSchema,
	appTestActionsSchema,
	appTestAuthoredActionSchema,
	appTestStartSchema,
} from "./types";

/** Stored checkpoints are server-produced, versioned by the session contract.
 * Rehydrate only database timestamps; user answers remain exact strings. */
function restoreSession(state: AppTestSessionState): AppTestSessionState {
	const restore = (snapshot: CaseDatabaseSnapshot): CaseDatabaseSnapshot => ({
		...snapshot,
		rows: snapshot.rows.map((row) => ({
			...row,
			opened_on: row.opened_on === null ? null : new Date(row.opened_on),
			modified_on: row.modified_on === null ? null : new Date(row.modified_on),
			closed_on: row.closed_on === null ? null : new Date(row.closed_on),
		})),
	});
	const screen = (
		entry: AppTestSessionState["screen"],
	): AppTestSessionState["screen"] =>
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

function restoreState(value: Record<string, unknown>): AppTestState {
	const state = value as unknown as AppTestState;
	if (
		typeof state.primarySessionId !== "string" ||
		!Array.isArray(state.sessionOrder) ||
		!state.sessions ||
		!Object.hasOwn(state.sessions, state.primarySessionId)
	)
		throw new AppTestActionError(
			"Retained worker sessions are unavailable. You can finish this test without a session ID and start a new test.",
		);
	return {
		primarySessionId: state.primarySessionId,
		sessionOrder: state.sessionOrder,
		sessions: Object.fromEntries(
			Object.entries(state.sessions).map(([id, session]) => [
				id,
				restoreSession(session),
			]),
		),
	};
}

function sessionObservation(state: AppTestState, sessionId: string) {
	const session = ownRecordValue(state.sessions, sessionId);
	return {
		sessionId,
		primarySessionId: state.primarySessionId,
		sessions: state.sessionOrder.map((id) => {
			const session = ownRecordValue(state.sessions, id);
			if (!session) throw new Error("A retained worker session is missing.");
			return {
				id,
				personaUuid: session.personaUuid,
				language: session.language,
				screen: session.screen.kind,
				...(session.screen.kind === "form"
					? { formUuid: session.screen.formUuid }
					: {}),
			};
		}),
		recordSources: {
			listsAndDetails: "current-isolated-store",
			openForm:
				session?.screen.kind === "form"
					? "retained-entry-snapshot"
					: "not-open",
			submission: "Preview/Postgres-current-isolated-store",
		},
	};
}

function assertStateLimit(state: AppTestState) {
	if (Buffer.byteLength(JSON.stringify(state)) > 16 * 1024 * 1024)
		throw new AppTestActionError(
			"This test exceeded its combined session state limit. You can start a smaller journey.",
		);
}

async function assertRecordLimit(
	tx: Transaction<Database>,
	scope: AppTestScope,
) {
	const count = await sql<{
		count: string;
	}>`SELECT count(*)::text AS count FROM cases WHERE app_id = ${scope.appId} AND project_id = ${scope.projectId}`.execute(
		tx,
	);
	if (Number(count.rows[0]?.count) > 2000)
		throw new AppTestActionError(
			"This test exceeded its record limit. You can start a smaller journey.",
		);
}

export async function startAppTest(
	scope: AppTestScope,
	args: { requestId: string; expectedBlueprintSeq: number; input: unknown },
) {
	const input = appTestStartSchema.parse(args.input);
	const sessionInputs = input.sessions ?? [
		{ id: "default", personaUuid: null, language: input.language },
	];
	if (
		new Set(sessionInputs.map((session) => session.id)).size !==
		sessionInputs.length
	)
		throw new AppTestActionError(
			"Each worker session needs a unique test-local ID.",
		);
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
			const doc = hydratePersistedBlueprint(snapshot.blueprint);
			const sessions: Record<string, AppTestSessionState> = {};
			let primaryObservation: Record<string, unknown> = {};
			for (const sessionInput of sessionInputs) {
				const initial: AppTestSessionState = {
					language: appTestLanguage(
						snapshot,
						sessionInput.language ?? input.language,
					),
					personaUuid: null,
					screen: { kind: "home" },
					history: [],
					selections: {},
					deviceCases: { rows: [], indices: [] },
				};
				const identity = bindAppTestAction(doc, initial, {
					kind: "identity",
					personaUuid: sessionInput.personaUuid ?? null,
				});
				if (identity.kind !== "identity")
					throw new Error("Expected a worker identity.");
				initial.personaUuid = identity.personaUuid;
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
						await assertRecordLimit(
							tx as unknown as Transaction<Database>,
							scope,
						);
						return {
							...result,
							observation: { ...result.observation, clock: context.clock },
						};
					},
				);
				sessions[sessionInput.id] = observed.state;
				if (sessionInput.id === sessionInputs[0].id)
					primaryObservation = observed.observation;
			}
			const state: AppTestState = {
				primarySessionId: sessionInputs[0].id,
				sessionOrder: sessionInputs.map((session) => session.id),
				sessions,
			};
			assertStateLimit(state);
			return {
				snapshot: { ...snapshot },
				state: { ...state },
				observation: {
					...primaryObservation,
					...sessionObservation(state, state.primarySessionId),
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
		action?: unknown;
		actions?: unknown;
		legacyAction?: (snapshot: AppTestSnapshot) => Promise<AppTestAction>;
	},
) {
	if ((args.action === undefined) === (args.actions === undefined))
		throw new AppTestActionError("Supply either action or actions.");
	const action =
		args.action === undefined
			? undefined
			: appTestAuthoredActionSchema.parse(args.action);
	const actions =
		args.actions === undefined
			? undefined
			: appTestActionsSchema.parse(args.actions);
	const legacyAction = args.legacyAction;
	return advanceAppTestSession({
		...scope,
		testId: args.testId,
		requestId: args.requestId,
		// Bind the authored bytes, not names resolved against a later screen/source.
		requestDigest: canonicalJsonDigest({
			...(action ? { action } : { actions }),
			expectedStep: args.expectedStep,
		}),
		expectedStep: args.expectedStep,
		legacyRequestDigest:
			action && legacyAction
				? async (snapshot) =>
						canonicalJsonDigest({
							action: await legacyAction(
								snapshot as unknown as AppTestSnapshot,
							),
							expectedStep: args.expectedStep,
						})
				: undefined,
		action,
		actions,
		advance: async (tx, source, item) => {
			const snapshot = source.snapshot as unknown as AppTestSnapshot;
			const doc = hydratePersistedBlueprint(snapshot.blueprint);
			const retained = restoreState(source.state);
			const authored = appTestActionItemSchema.parse(item);
			await sql`SAVEPOINT app_test_action`.execute(tx);
			try {
				const sessionId = authored.sessionId ?? retained.primarySessionId;
				const state = ownRecordValue(retained.sessions, sessionId);
				if (!state)
					throw new AppTestActionError(
						`Worker session ${sessionId} is not part of this test.`,
					);
				if (authored.action.kind === "finish") {
					await sql`RELEASE SAVEPOINT app_test_action`.execute(tx);
					return {
						state: {},
						observation: { ended: true, sessionId },
						finished: true,
					};
				}
				const bound = bindAppTestAction(doc, state, authored.action);
				const nextState: AppTestSessionState =
					bound.kind === "identity"
						? {
								...state,
								personaUuid: bound.personaUuid,
								screen: { kind: "home" },
								history: [],
								selections: {},
								deviceCases: { rows: [], indices: [] },
							}
						: bound.kind === "language"
							? {
									...state,
									language: appTestLanguage(snapshot, bound.language),
								}
							: state;
				const observed = await withAppTestContext(
					tx as unknown as Transaction<Database>,
					{ ...scope, testId: args.testId, blueprintSeq: source.blueprintSeq },
					snapshot,
					nextState,
					async (context) => {
						const result =
							bound.kind === "identity"
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
										bound,
									);
						await assertRecordLimit(
							tx as unknown as Transaction<Database>,
							scope,
						);
						return {
							...result,
							observation: { ...result.observation, clock: context.clock },
						};
					},
				);
				const nextRetained: AppTestState = {
					...retained,
					sessions: { ...retained.sessions, [sessionId]: observed.state },
				};
				assertStateLimit(nextRetained);
				// A guard is an observation AFTER the action, including any successful
				// submission. A mismatch never undoes what the worker already completed.
				let mismatch: string | undefined;
				try {
					mismatch = appTestExpectationMismatch(
						doc,
						observed.state,
						observed.observation,
						authored.expect,
					);
				} catch (error) {
					if (!expectedAppTestRefusal(error)) throw error;
					mismatch = error.message;
				}
				const observation: Record<string, unknown> = observed.observation;
				const refused =
					observation.completed === false ||
					observation.savedInTest === false ||
					observation.screen === "after-submit";
				const stopReason =
					mismatch ??
					(refused
						? "The action could not reach its requested result. Inspect this observation before continuing."
						: undefined);
				await sql`RELEASE SAVEPOINT app_test_action`.execute(tx);
				return {
					state: { ...nextRetained },
					observation: {
						...observed.observation,
						...sessionObservation(nextRetained, sessionId),
						...(mismatch
							? { expectationMet: false, expectationError: mismatch }
							: {}),
					},
					stopReason,
				};
			} catch (error) {
				if (!expectedAppTestRefusal(error)) throw error;
				await sql`ROLLBACK TO SAVEPOINT app_test_action`.execute(tx);
				await sql`RELEASE SAVEPOINT app_test_action`.execute(tx);
				return {
					state: { ...retained },
					observation: {
						...sessionObservation(
							retained,
							authored.sessionId ?? retained.primarySessionId,
						),
						action: authored.action.kind,
						completed: false,
						error: error.message,
					},
					stopReason: error.message,
				};
			}
		},
	});
}
