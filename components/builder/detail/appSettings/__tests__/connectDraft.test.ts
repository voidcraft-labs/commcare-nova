/**
 * Round-trip law for the Connect editor's draft model: an EXISTING block
 * survives `configToDraft` → `draftToConfig` without losing its ids or its
 * advanced XPath slots (`user_score`, `entity_id`, `entity_name`). Dropping
 * an expression is data loss; re-deriving an id churns Connect's Postgres
 * slug. The XPath buffers are TEXT (printed on seed, parsed on commit), so
 * the test drives the print/parse boundary explicitly. Pure functions, no
 * React — mounts nothing.
 */
import { describe, expect, it } from "vitest";
import { xp } from "@/lib/__tests__/docHelpers";
import {
	DEFAULT_ASSESSMENT_USER_SCORE,
	DEFAULT_DELIVER_ENTITY_ID,
	DEFAULT_DELIVER_ENTITY_NAME,
} from "@/lib/doc/connectConfig";
import type { ConnectConfig } from "@/lib/domain";
import {
	configToDraft,
	draftToConfig,
	EMPTY_DRAFT,
} from "../ConnectEnableDialog";

/** A print/parse pair that must never run — proves a config with no XPath
 *  never touches the expression boundary. */
const noExpr = (): never => {
	throw new Error(
		"expression boundary must not run for a config with no XPath",
	);
};

describe("Connect draft round-trip", () => {
	it("preserves ids + core content for a config with no XPath", () => {
		const config: ConnectConfig = {
			learn_module: {
				id: "intro_module",
				name: "Intro",
				description: "Getting started",
				time_estimate: 7,
			},
			assessment: { id: "intro_quiz" },
		};

		const round = draftToConfig(configToDraft(config, noExpr), "learn", noExpr);

		expect(round).toEqual(config);
	});

	it("prints an existing user_score into its buffer and parses it back", () => {
		const score = xp("#form/score");
		const config: ConnectConfig = {
			assessment: { id: "quiz", user_score: score },
		};

		const draft = configToDraft(config, () => "#form/score");
		expect(draft.userScoreText).toBe("#form/score");

		const round = draftToConfig(draft, "learn", () => score);
		expect(round.assessment).toEqual({ id: "quiz", user_score: score });
	});

	it("round-trips deliver ids and the entity_id / entity_name buffers", () => {
		const entityId = xp("#form/client_id");
		const entityName = xp("#form/client_name");
		const config: ConnectConfig = {
			deliver_unit: {
				id: "home_visit",
				name: "Home Visit",
				entity_id: entityId,
				entity_name: entityName,
			},
			task: { id: "followup", name: "Follow up", description: "Revisit" },
		};

		const draft = configToDraft(config, (e) =>
			e === entityId ? "#form/client_id" : "#form/client_name",
		);
		expect(draft.entityIdText).toBe("#form/client_id");
		expect(draft.entityNameText).toBe("#form/client_name");

		const round = draftToConfig(draft, "deliver", (t) =>
			t === "#form/client_id" ? entityId : entityName,
		);
		expect(round).toEqual(config);
	});

	it("leaves a blank id and blank XPath out (autofill / wire default)", () => {
		// A freshly turned-on sub-config carries no id and no entity XPath —
		// the commit autofills the id and the wire layer defaults the rest.
		const draft = { ...EMPTY_DRAFT, deliverOn: true, deliverName: "New Visit" };
		const round = draftToConfig(draft, "deliver", noExpr);
		expect(round.deliver_unit).toEqual({ name: "New Visit" });
	});

	it("seeds an absent XPath slot's buffer with the actual default, then drops it on commit", () => {
		// The editor shows the real default so the user sees what runs; a buffer
		// left at the default stays absent (the single wire-emit default applies),
		// and the parse boundary is never touched.
		const draft = configToDraft(
			{ deliver_unit: { id: "v", name: "Visit" } },
			noExpr,
		);
		expect(draft.entityIdText).toBe(DEFAULT_DELIVER_ENTITY_ID);
		expect(draft.entityNameText).toBe(DEFAULT_DELIVER_ENTITY_NAME);

		const assessment = configToDraft({ assessment: { id: "q" } }, noExpr);
		expect(assessment.userScoreText).toBe(DEFAULT_ASSESSMENT_USER_SCORE);

		expect(draftToConfig(draft, "deliver", noExpr).deliver_unit).toEqual({
			id: "v",
			name: "Visit",
		});
	});

	it("stores an XPath buffer the user changed away from the default", () => {
		const override = xp("#form/quiz_total");
		const draft = {
			...EMPTY_DRAFT,
			assessmentOn: true,
			assessmentId: "q",
			userScoreText: "#form/quiz_total",
		};
		const round = draftToConfig(draft, "learn", () => override);
		expect(round.assessment).toEqual({ id: "q", user_score: override });
	});
});
