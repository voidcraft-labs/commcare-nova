// A checkpoint retained under an earlier session contract rehydrates into the
// current one, so a worker retained before claims existed can keep going.

import { expect, it } from "vitest";
import { restoreAppTestState } from "../retainedState";

const EMPTY_CASES = { rows: [], indices: [] };

function storedSession(extra: Record<string, unknown> = {}) {
	return {
		language: "en",
		personaUuid: null,
		screen: { kind: "home" },
		history: [],
		selections: {},
		deviceCases: EMPTY_CASES,
		...extra,
	};
}

it("reads a session retained before claims existed as one that claimed nothing", () => {
	const state = restoreAppTestState({
		primarySessionId: "primary",
		sessionOrder: ["primary", "second"],
		sessions: {
			primary: storedSession(),
			second: storedSession({ claimedCaseIds: ["case-1"] }),
		},
	});
	expect(state.sessions.primary?.claimedCaseIds).toEqual([]);
	expect(state.sessions.second?.claimedCaseIds).toEqual(["case-1"]);
});
