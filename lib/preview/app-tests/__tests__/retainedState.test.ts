// A checkpoint retained under an earlier session contract rehydrates into the
// current one. A session retained while claims were session state still
// carries its `claimedCaseIds`; a claim is now a claim row in the journey's
// namespace, so the stored list is read and dropped. A session retained
// before after-submit stacks existed has none pending.

import { expect, it } from "vitest";
import { EMPTY_AFTER_SUBMIT_STACK } from "../../afterSubmitStack";
import { restoreAppTestState } from "../retainedState";

const EMPTY_CASES = { rows: [], indices: [] };

function storedSession(extra: Record<string, unknown> = {}) {
	return {
		language: "en",
		platform: "web-apps",
		androidDeviceId: "install",
		personaUuid: null,
		screen: { kind: "home" },
		history: [],
		selections: {},
		deviceCases: EMPTY_CASES,
		...extra,
	};
}

it("rehydrates a session that stored claimed case ids without them", () => {
	const state = restoreAppTestState({
		primarySessionId: "primary",
		sessionOrder: ["primary", "second"],
		sessions: {
			primary: storedSession(),
			second: storedSession({ claimedCaseIds: ["case-1"] }),
		},
	});
	const restored = {
		...storedSession(),
		afterSubmitStack: EMPTY_AFTER_SUBMIT_STACK,
	};
	expect(state.sessions.primary).toEqual(restored);
	expect(state.sessions.second).toEqual(restored);
	expect(state.sessions.second).not.toHaveProperty("claimedCaseIds");
});

it("rehydrates the device world a pending frame back to the preceding task carries", () => {
	const row = {
		case_id: "case-1",
		app_id: "app",
		case_type: "visit",
		owner_id: "worker",
		status: "open",
		opened_on: "2026-08-01T00:00:00.000Z",
		modified_on: "2026-08-02T00:00:00.000Z",
		closed_on: null,
		case_name: "Visit",
		external_id: null,
		parent_case_id: null,
		properties: {},
	};
	const state = restoreAppTestState({
		primarySessionId: "primary",
		sessionOrder: ["primary"],
		sessions: {
			primary: storedSession({
				afterSubmitStack: {
					pending: [
						{
							route: {
								route: {
									kind: "previous-task",
									task: {
										destination: { kind: "home" },
										selections: {},
										caseDatabase: { rows: [row], indices: [] },
									},
								},
								selections: {},
							},
							landing: [],
						},
					],
					snapshot: [],
				},
			}),
		},
	});
	const frame = state.sessions.primary.afterSubmitStack.pending[0]?.route;
	if (frame?.route.kind !== "previous-task")
		throw new Error("Expected the pending previous task to survive.");
	expect(frame.route.task.caseDatabase.rows[0]?.opened_on).toEqual(
		new Date("2026-08-01T00:00:00.000Z"),
	);
	expect(state.sessions.primary.afterSubmitStack.snapshot).toEqual([]);
});
