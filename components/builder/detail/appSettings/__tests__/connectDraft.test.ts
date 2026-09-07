/**
 * Round-trip law for the Connect editor's draft model: an EXISTING block
 * survives `configToDraft` → `draftToConfig` without losing its ids or its
 * advanced XPath slots (`user_score`, `entity_id`, `entity_name`). Dropping
 * an expression is data loss; re-deriving an id churns Connect's Postgres
 * slug. The XPath buffers are TEXT (printed on seed, parsed on commit), so
 * the test drives the print/parse boundary explicitly. Pure functions, no
 * React: mounts nothing.
 */
import { describe, expect, it } from "vitest";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import { assertAdmittedDoc } from "@/lib/doc/__tests__/admittedDoc";
import { parseXPathForForm, printXPathInDoc } from "@/lib/doc/expressionText";
import type { ConnectConfig } from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import {
	configToDraft,
	draftToConfig,
	EMPTY_DRAFT,
	parseTimeEstimate,
} from "../connectDraft";

/** A print/parse pair that must never run: proves a config with no XPath
 *  never touches the expression boundary. */
const noExpr = (): never => {
	throw new Error(
		"expression boundary must not run for a config with no XPath",
	);
};
const derivedId = (kind: string) => `derived_${kind}`;
const doc = buildDoc({
	appName: "Connect draft",
	modules: [
		{
			name: "Forms",
			forms: [
				{
					name: "Visit",
					type: "survey",
					fields: ["score", "client_id", "client_name", "quiz_total"].map(
						(id) => ({ kind: "text" as const, id, label: proseText(id) }),
					),
				},
			],
		},
	],
});
assertAdmittedDoc(doc);
const formUuid = doc.formOrder[doc.moduleOrder[0]][0];
const parse = (text: string) => parseXPathForForm(doc, formUuid, text);
const print = (expression: Parameters<typeof printXPathInDoc>[1]) =>
	printXPathInDoc(doc, expression);

describe("Connect draft round-trip", () => {
	it("uses positive whole hours with a one-hour new-module default", () => {
		expect(EMPTY_DRAFT.learnTimeEstimate).toBe("1");
		expect(parseTimeEstimate("1")).toBe(1);
		expect(parseTimeEstimate("1.5")).toBeNull();
		expect(parseTimeEstimate("0")).toBeNull();
	});

	it("refuses a whole-hour buffer beyond the persistable integer range before finalization", () => {
		expect(parseTimeEstimate("9007199254740992")).toBeNull();
		expect(parseTimeEstimate("1e100")).toBeNull();
		expect(parseTimeEstimate("9007199254740991")).toBe(9007199254740991);
	});

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

		const round = draftToConfig(
			configToDraft(config, noExpr),
			"learn",
			noExpr,
			derivedId,
		);

		expect(round).toStrictEqual(config);
	});

	it("prints an existing user_score into its buffer and parses it back", () => {
		const score = parse("#form/score");
		const config: ConnectConfig = {
			assessment: { id: "quiz", user_score: score },
		};

		const draft = configToDraft(config, print);
		expect(draft.userScoreText).toBe("#form/score");

		const round = draftToConfig(draft, "learn", parse, derivedId);
		expect(round.assessment).toStrictEqual({ id: "quiz", user_score: score });
	});

	it("round-trips deliver ids and the entity_id / entity_name buffers", () => {
		const entityId = parse("#form/client_id");
		const entityName = parse("#form/client_name");
		const config: ConnectConfig = {
			deliver_unit: {
				id: "home_visit",
				name: "Home Visit",
				entity_id: entityId,
				entity_name: entityName,
			},
			task: { id: "followup", name: "Follow up", description: "Revisit" },
		};

		const draft = configToDraft(config, print);
		expect(draft.entityIdText).toBe("#form/client_id");
		expect(draft.entityNameText).toBe("#form/client_name");

		const round = draftToConfig(draft, "deliver", parse, derivedId);
		expect(round).toStrictEqual(config);
	});

	it("assigns a blank draft id before constructing the final config", () => {
		const draft = { ...EMPTY_DRAFT, deliverOn: true, deliverName: "New Visit" };
		const round = draftToConfig(draft, "deliver", noExpr, derivedId);
		expect(round.deliver_unit).toStrictEqual({
			id: "derived_deliver_unit",
			name: "New Visit",
		});
	});

	it("does not sanitize an explicit invalid id behind the validity guard", () => {
		const draft = {
			...EMPTY_DRAFT,
			deliverOn: true,
			deliverId: " visit ",
			deliverName: "New Visit",
		};
		expect(
			draftToConfig(draft, "deliver", noExpr, derivedId).deliver_unit?.id,
		).toBe(" visit ");
	});

	it("seeds an absent XPath slot's buffer with the actual default, then drops it on commit", () => {
		// The editor shows the real default so the user sees what runs; a buffer
		// left at the default stays absent (the single wire-emit default applies),
		// and the parse boundary is never touched.
		const draft = configToDraft(
			{ deliver_unit: { id: "v", name: "Visit" } },
			noExpr,
		);
		expect(draft.entityIdText).toBe("concat(#user/username, '-', today())");
		expect(draft.entityNameText).toBe("#user/username");

		const assessment = configToDraft({ assessment: { id: "q" } }, noExpr);
		expect(assessment.userScoreText).toBe("100");

		expect(
			draftToConfig(draft, "deliver", noExpr, derivedId).deliver_unit,
		).toStrictEqual({
			id: "v",
			name: "Visit",
		});
	});

	it("stores an XPath buffer the user changed away from the default", () => {
		const override = parse("#form/quiz_total");
		const draft = {
			...EMPTY_DRAFT,
			assessmentOn: true,
			assessmentId: "q",
			userScoreText: "#form/quiz_total",
		};
		const round = draftToConfig(draft, "learn", parse, derivedId);
		expect(round.assessment).toStrictEqual({ id: "q", user_score: override });
	});
});
