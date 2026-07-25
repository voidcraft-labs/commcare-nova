// Pure tests for the Project-move policy shared by the action, orchestrator,
// and placement UI.

import { describe, expect, it } from "vitest";
import {
	CROSS_PROJECT_MOVE_DISCLOSURE,
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
	it("discloses what travels with the app before the move runs", () => {
		expect(CROSS_PROJECT_MOVE_DISCLOSURE).toContain("chat history");
		expect(CROSS_PROJECT_MOVE_DISCLOSURE).toContain("case data");
	});
});
