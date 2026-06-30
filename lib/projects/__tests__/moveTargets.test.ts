// Pure tests for the home-page "Move to Project" eligibility rules — who may
// move an app out of a Project, and which Projects it may move into.

import { describe, expect, it } from "vitest";
import type { ProjectSummary } from "../membership";
import { canMoveAppsFrom, eligibleMoveTargets } from "../moveTargets";

function proj(
	id: string,
	role: string,
	opts: { name?: string; personal?: boolean } = {},
): ProjectSummary {
	return {
		id,
		name: opts.name ?? `Project ${id}`,
		slug: id,
		role,
		personal: opts.personal ?? false,
	};
}

describe("canMoveAppsFrom", () => {
	it("allows only the owner — moving an app out is owner-reserved", () => {
		expect(canMoveAppsFrom("owner")).toBe(true);
	});

	it("denies viewer, editor, and admin", () => {
		expect(canMoveAppsFrom("viewer")).toBe(false);
		expect(canMoveAppsFrom("editor")).toBe(false);
		// An admin manages members but can't relocate (and thus strip the owner
		// from) a shared app.
		expect(canMoveAppsFrom("admin")).toBe(false);
	});

	it("handles a comma-joined role string", () => {
		expect(canMoveAppsFrom("admin,owner")).toBe(true);
	});
});

describe("eligibleMoveTargets", () => {
	const projects: ProjectSummary[] = [
		proj("active", "owner"),
		proj("shared-edit", "editor"),
		proj("shared-admin", "admin"),
		proj("shared-view", "viewer"),
		proj("personal", "owner", { personal: true }),
	];

	it("includes every Project the user can build in (editor+), minus the active one", () => {
		const ids = eligibleMoveTargets(projects, "active")
			.map((t) => t.id)
			.sort();
		expect(ids).toEqual(["personal", "shared-admin", "shared-edit"]);
	});

	it("excludes viewer-only Projects and the active Project", () => {
		const ids = eligibleMoveTargets(projects, "active").map((t) => t.id);
		expect(ids).not.toContain("shared-view");
		expect(ids).not.toContain("active");
	});

	it("includes the personal Project as a destination (the un-share path)", () => {
		const ids = eligibleMoveTargets(projects, "shared-admin").map((t) => t.id);
		expect(ids).toContain("personal");
	});

	it("projects each target down to { id, name }", () => {
		const targets = eligibleMoveTargets(
			[proj("x", "editor", { name: "Team X" })],
			"active",
		);
		expect(targets).toEqual([{ id: "x", name: "Team X" }]);
	});

	it("is empty when no Project qualifies", () => {
		expect(
			eligibleMoveTargets(
				[proj("active", "owner"), proj("v", "viewer")],
				"active",
			),
		).toEqual([]);
	});
});
