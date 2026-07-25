// Pure tests for the Project-move policy shared by the action, orchestrator,
// and placement UI.

import { describe, expect, it } from "vitest";
import {
	appProjectMovePolicy,
	CROSS_PROJECT_MOVE_DISCLOSURE,
	CROSS_PROJECT_MOVE_UNAVAILABLE_CODE,
	CROSS_PROJECT_MOVE_UNAVAILABLE_MESSAGE,
	canManageAppPlacement,
} from "../moveTargets";

describe("canManageAppPlacement", () => {
	it("allows admin and owner — moving an app out is a governance act", () => {
		expect(canManageAppPlacement("owner")).toBe(true);
		expect(canManageAppPlacement("admin")).toBe(true);
	});

	it("denies viewer and editor", () => {
		expect(canManageAppPlacement("viewer")).toBe(false);
		expect(canManageAppPlacement("editor")).toBe(false);
	});

	it("handles a comma-joined role string", () => {
		expect(canManageAppPlacement("editor,admin")).toBe(true);
	});
});

describe("appProjectMovePolicy", () => {
	it("keeps the exact same-Project call as the recovery path either way", () => {
		for (const movesEnabled of [true, false]) {
			expect(
				appProjectMovePolicy("project-a", "project-a", movesEnabled),
			).toEqual({ kind: "same_project_recovery" });
		}
	});

	it("admits a true cross-Project request once the switch is on", () => {
		expect(appProjectMovePolicy("project-a", "project-b", true)).toEqual({
			kind: "cross_project_move",
		});
	});

	it("blocks a cross-Project request with the stable public code while off", () => {
		expect(appProjectMovePolicy("project-a", "project-b", false)).toEqual({
			kind: "cross_project_blocked",
			code: CROSS_PROJECT_MOVE_UNAVAILABLE_CODE,
			message: CROSS_PROJECT_MOVE_UNAVAILABLE_MESSAGE,
		});
		expect(CROSS_PROJECT_MOVE_UNAVAILABLE_MESSAGE).toContain(
			"shared data will stay in the current Project",
		);
	});

	it("discloses what travels with the app before the move runs", () => {
		expect(CROSS_PROJECT_MOVE_DISCLOSURE).toContain("chat history");
		expect(CROSS_PROJECT_MOVE_DISCLOSURE).toContain("case data");
	});
});
