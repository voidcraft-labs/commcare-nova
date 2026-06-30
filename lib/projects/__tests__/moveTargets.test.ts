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

	it("offers every Project the user is admin/owner of, minus the active one", () => {
		// The owner-protection refinement (source owner must be in the destination)
		// is the page's job — this is the membership-only candidate list, so the
		// personal Project is included here regardless of source role.
		const ids = eligibleMoveTargets(projects, "active")
			.map((t) => t.id)
			.sort();
		expect(ids).toEqual(["personal", "shared-admin"]);
	});

	it("excludes editor-only and viewer-only Projects (admin/owner destination bar)", () => {
		const ids = eligibleMoveTargets(projects, "active").map((t) => t.id);
		expect(ids).not.toContain("shared-edit");
		expect(ids).not.toContain("shared-view");
		expect(ids).not.toContain("active");
	});

	it("projects each target down to { id, name }", () => {
		const targets = eligibleMoveTargets(
			[proj("x", "admin", { name: "Team X" })],
			"active",
		);
		expect(targets).toEqual([{ id: "x", name: "Team X" }]);
	});

	it("is empty when no Project qualifies", () => {
		expect(
			eligibleMoveTargets(
				[proj("active", "owner"), proj("e", "editor")],
				"active",
			),
		).toEqual([]);
	});
});
