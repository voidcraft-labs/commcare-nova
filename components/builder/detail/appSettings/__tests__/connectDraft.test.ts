/**
 * Round-trip law for the Connect manager's draft model: editing an
 * EXISTING block through `configToDraft` → `draftToConfig` must preserve
 * the fields the manager doesn't expose — sub-config ids and the advanced
 * XPath slots (`user_score`, `entity_id`, `entity_name`). Dropping an
 * expression is data loss; re-deriving an id churns Connect's Postgres
 * slug. Pure functions, no React — mounts nothing.
 */
import { describe, expect, it } from "vitest";
import { xp } from "@/lib/__tests__/docHelpers";
import type { ConnectConfig } from "@/lib/domain";
import { configToDraft, draftToConfig } from "../ConnectEnableDialog";

/** A parser that must never run: a preserved expression is already an AST,
 *  so the round-trip can't go through text. */
const noParse = (): never => {
	throw new Error(
		"parseExpr must not run when a preserved expression round-trips",
	);
};

describe("Connect manager draft round-trip", () => {
	it("preserves learn ids and the assessment user_score", () => {
		const config: ConnectConfig = {
			learn_module: {
				id: "intro_module",
				name: "Intro",
				description: "Getting started",
				time_estimate: 7,
			},
			assessment: { id: "intro_quiz", user_score: xp("#form/score") },
		};

		const round = draftToConfig(configToDraft(config), "learn", noParse);

		expect(round).toEqual(config);
	});

	it("preserves deliver ids and the entity_id / entity_name XPaths", () => {
		const config: ConnectConfig = {
			deliver_unit: {
				id: "home_visit",
				name: "Home Visit",
				entity_id: xp("#form/client_id"),
				entity_name: xp("#form/client_name"),
			},
			task: { id: "followup", name: "Follow up", description: "Revisit" },
		};

		const round = draftToConfig(configToDraft(config), "deliver", noParse);

		expect(round).toEqual(config);
	});

	it("keeps the id + advanced slots when the manager edits only the name", () => {
		const config: ConnectConfig = {
			deliver_unit: {
				id: "home_visit",
				name: "Home Visit",
				entity_id: xp("#form/client_id"),
			},
		};

		// Simulate a manager edit: rename the deliver unit, touch nothing else.
		const edited = { ...configToDraft(config), deliverName: "Field Visit" };
		const round = draftToConfig(edited, "deliver", noParse);

		expect(round.deliver_unit).toEqual({
			id: "home_visit",
			name: "Field Visit",
			entity_id: xp("#form/client_id"),
		});
	});

	it("leaves a fresh draft id-less so the commit path autofills", () => {
		// A form the manager turns on for the first time carries no id — the
		// store's dedupe/autofill assigns one, same as the agent path.
		const config: ConnectConfig = {
			deliver_unit: { name: "New Visit" },
		};
		const round = draftToConfig(configToDraft(config), "deliver", noParse);
		expect(round.deliver_unit?.id).toBeUndefined();
		expect(round.deliver_unit?.name).toBe("New Visit");
	});
});
