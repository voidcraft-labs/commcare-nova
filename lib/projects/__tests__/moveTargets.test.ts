// Pure tests for the temporary S01 Project-move policy shared by the action,
// orchestrator, and informational UI.

import { describe, expect, it } from "vitest";
import {
	appProjectMovePolicy,
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
	it("keeps the exact same-Project call as the recovery path", () => {
		expect(appProjectMovePolicy("project-a", "project-a")).toEqual({
			kind: "same_project_recovery",
		});
	});

	it("blocks every true cross-Project request with the stable public code", () => {
		expect(appProjectMovePolicy("project-a", "project-b")).toEqual({
			kind: "cross_project_blocked",
			code: CROSS_PROJECT_MOVE_UNAVAILABLE_CODE,
			message: CROSS_PROJECT_MOVE_UNAVAILABLE_MESSAGE,
		});
		expect(CROSS_PROJECT_MOVE_UNAVAILABLE_MESSAGE).toContain(
			"shared data will stay in the current Project",
		);
	});
});
