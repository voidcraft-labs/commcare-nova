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
	it("allows admin and owner — moving an app out is a governance act", () => {
		expect(canMoveAppsFrom("owner")).toBe(true);
		expect(canMoveAppsFrom("admin")).toBe(true);
	});

	it("denies viewer and editor", () => {
		expect(canMoveAppsFrom("viewer")).toBe(false);
		expect(canMoveAppsFrom("editor")).toBe(false);
	});

	it("handles a comma-joined role string", () => {
		expect(canMoveAppsFrom("editor,admin")).toBe(true);
	});
});

describe("eligibleMoveTargets", () => {
	const projects: ProjectSummary[] = [
		proj("active", "owner"),
		proj("shared-admin", "admin"),
		proj("shared-edit", "editor"),
		proj("shared-view", "viewer"),
		proj("personal", "owner", { personal: true }),
	];

	it("offers only Projects the user is admin/owner of, minus the active one", () => {
		const ids = eligibleMoveTargets(projects, "active", "owner")
			.map((t) => t.id)
			.sort();
		expect(ids).toEqual(["personal", "shared-admin"]);
	});

	it("excludes editor-only and viewer-only Projects (admin/owner destination bar)", () => {
		const ids = eligibleMoveTargets(projects, "active", "owner").map(
			(t) => t.id,
		);
		expect(ids).not.toContain("shared-edit");
		expect(ids).not.toContain("shared-view");
		expect(ids).not.toContain("active");
	});

	it("offers a personal-Project destination only when the source is owned", () => {
		// Source owned → may take the app private.
		expect(
			eligibleMoveTargets(projects, "active", "owner").map((t) => t.id),
		).toContain("personal");
		// Source merely admin → no pocketing into a personal Project.
		expect(
			eligibleMoveTargets(projects, "active", "admin").map((t) => t.id),
		).not.toContain("personal");
	});

	it("projects each target down to { id, name }", () => {
		const targets = eligibleMoveTargets(
			[proj("x", "admin", { name: "Team X" })],
			"active",
			"owner",
		);
		expect(targets).toEqual([{ id: "x", name: "Team X" }]);
	});

	it("is empty when no Project qualifies", () => {
		expect(
			eligibleMoveTargets(
				[proj("active", "owner"), proj("e", "editor")],
				"active",
				"owner",
			),
		).toEqual([]);
	});
});
