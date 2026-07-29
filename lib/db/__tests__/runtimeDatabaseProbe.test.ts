import { describe, expect, it } from "vitest";
import { chooseRuntimeProbeCandidate } from "../runtimeDatabaseProbe";

describe("chooseRuntimeProbeCandidate", () => {
	it("chooses an existing membership with edit authority", () => {
		expect(
			chooseRuntimeProbeCandidate([
				{
					app_id: "viewer-app",
					project_id: "project-a",
					user_id: "viewer-user",
					role: "viewer",
				},
				{
					app_id: "editor-app",
					project_id: "project-b",
					user_id: "editor-user",
					role: "editor",
				},
			]),
		).toEqual({
			app_id: "editor-app",
			project_id: "project-b",
			user_id: "editor-user",
			role: "editor",
		});
	});

	it("fails closed when no existing membership can exercise a write", () => {
		expect(() =>
			chooseRuntimeProbeCandidate([
				{
					app_id: "viewer-app",
					project_id: "project-a",
					user_id: "viewer-user",
					role: "viewer",
				},
			]),
		).toThrow("requires an existing editable Project app membership");
	});
});
