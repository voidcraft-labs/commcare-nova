// lib/preview/app-tests/retainedState.ts
//
// Rehydrating a retained app-test checkpoint from its stored JSON.

import { EMPTY_AFTER_SUBMIT_STACK } from "../afterSubmitStack";
import type { CaseDatabaseSnapshot } from "../engine/xpathInstances";
import { AppTestActionError } from "./errors";
import type {
	AppTestAfterSubmitRoute,
	AppTestSessionState,
	AppTestState,
} from "./types";

/** A session as a checkpoint stores it: one retained while claims were
 *  session state may still carry `claimedCaseIds`. A claim is now a claim row
 *  in the journey's namespace, so the list is read and dropped. One retained
 *  before after-submit stacks existed has no `afterSubmitStack`. */
type StoredAppTestSession = Omit<AppTestSessionState, "afterSubmitStack"> & {
	readonly claimedCaseIds?: readonly string[];
	readonly afterSubmitStack?: AppTestSessionState["afterSubmitStack"];
};

/** Stored checkpoints are server-produced, versioned by the session contract.
 * Rehydrate only database timestamps and fields a later contract added; user
 * answers remain exact strings. */
function restoreSession({
	claimedCaseIds: _sessionClaims,
	afterSubmitStack,
	...state
}: StoredAppTestSession): AppTestSessionState {
	const restore = (snapshot: CaseDatabaseSnapshot): CaseDatabaseSnapshot => ({
		...snapshot,
		rows: snapshot.rows.map((row) => ({
			...row,
			opened_on: row.opened_on === null ? null : new Date(row.opened_on),
			modified_on: row.modified_on === null ? null : new Date(row.modified_on),
			closed_on: row.closed_on === null ? null : new Date(row.closed_on),
		})),
	});
	const restoreTask = <
		T extends Extract<
			AppTestSessionState["screen"],
			{ kind: "menu" | "records" }
		>,
	>(
		entry: T,
	): T =>
		entry.taskCases === undefined
			? entry
			: { ...entry, taskCases: restore(entry.taskCases) };
	const screen = (
		entry: AppTestSessionState["screen"],
	): AppTestSessionState["screen"] =>
		entry.kind === "form"
			? { ...entry, entryCases: restore(entry.entryCases) }
			: entry.kind === "details"
				? { ...entry, source: restoreTask(entry.source) }
				: entry.kind === "menu" || entry.kind === "records"
					? restoreTask(entry)
					: entry;
	/* A pending frame back to the preceding task carries the device world
	 * that task returns to. */
	const restoreFrame = (
		frame: AppTestAfterSubmitRoute,
	): AppTestAfterSubmitRoute =>
		frame.route.kind === "previous-task"
			? {
					...frame,
					route: {
						...frame.route,
						task: {
							...frame.route.task,
							caseDatabase: restore(frame.route.task.caseDatabase),
						},
					},
				}
			: frame;
	return {
		...state,
		deviceCases: restore(state.deviceCases),
		screen: screen(state.screen),
		history: state.history.map(screen),
		// A session retained before after-submit stacks existed has none pending.
		afterSubmitStack:
			afterSubmitStack === undefined
				? EMPTY_AFTER_SUBMIT_STACK
				: {
						...afterSubmitStack,
						pending: afterSubmitStack.pending.map((pending) => ({
							...pending,
							route: restoreFrame(pending.route),
						})),
					},
	};
}

/** The retained worker sessions of a stored checkpoint, ready to advance. */
export function restoreAppTestState(
	value: Record<string, unknown>,
): AppTestState {
	const state = value as unknown as Omit<AppTestState, "sessions"> & {
		sessions: Record<string, StoredAppTestSession>;
	};
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
