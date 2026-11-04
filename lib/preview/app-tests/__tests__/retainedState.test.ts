// A checkpoint retained under an earlier session contract rehydrates into the
// current one. A session retained while claims were session state still
// carries its `claimedCaseIds`; a claim is now a claim row in the journey's
// namespace, so the stored list is read and dropped.

import { expect, it } from "vitest";
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
	expect(state.sessions.primary).toEqual(storedSession());
	expect(state.sessions.second).toEqual(storedSession());
	expect(state.sessions.second).not.toHaveProperty("claimedCaseIds");
});
