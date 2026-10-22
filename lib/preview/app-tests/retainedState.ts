// lib/preview/app-tests/retainedState.ts
//
// Rehydrating a retained app-test checkpoint from its stored JSON.

import type { CaseDatabaseSnapshot } from "../engine/xpathInstances";
import { AppTestActionError } from "./errors";
import type { AppTestSessionState, AppTestState } from "./types";

/** A session as a checkpoint stores it: one retained before claims existed
 *  has no `claimedCaseIds`. */
type StoredAppTestSession = Omit<AppTestSessionState, "claimedCaseIds"> & {
	readonly claimedCaseIds?: readonly string[];
};

/** Stored checkpoints are server-produced, versioned by the session contract.
 * Rehydrate only database timestamps and fields a later contract added; user
 * answers remain exact strings. */
function restoreSession(state: StoredAppTestSession): AppTestSessionState {
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
	return {
		...state,
		// A session retained before claims existed has claimed nothing.
		claimedCaseIds: state.claimedCaseIds ?? [],
		deviceCases: restore(state.deviceCases),
		screen: screen(state.screen),
		history: state.history.map(screen),
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
