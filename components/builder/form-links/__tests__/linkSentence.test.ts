// components/builder/form-links/__tests__/linkSentence.test.ts
//
// The row sentence and the shared after-submit copy are projections: they
// read the stored link and the plan, and they spell every destination one
// way across every surface.

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { afterSubmitPlan } from "@/lib/doc/formLinkMutations";
import { type FormLink, formLinkDestination } from "@/lib/domain";
import {
	afterSubmitSummary,
	carriedAutomaticallyDetail,
	destinationLabel,
	destinationPhrase,
	fallbackChangedAnnouncement,
	nothingNeededCopy,
	pinsFallbackSentence,
	stopElseLinkQuestion,
} from "../afterSubmitCopy";
import {
	type LinkSentenceContext,
	linkLead,
	linkSentence,
	linkSentenceText,
} from "../linkSentence";
import { fixture, SOURCE, toCare, toNote, toVisit } from "./fixture";

const context: LinkSentenceContext = {
	destinationOf: (target) =>
		target.type === "form"
			? target.formUuid === testUuid("frm-visit")
				? { kind: "form", name: "Visit" }
				: undefined
			: { kind: "module", name: "Care" },
	conditionText: (link) =>
		link.condition === undefined ? "" : "#patient/mood = 'low'",
};

const link = (overrides: Partial<FormLink>): FormLink => ({
	uuid: testUuid("lnk"),
	target: toVisit,
	...overrides,
});

describe("linkSentence", () => {
	it("leads with where the person goes", () => {
		expect(linkLead(toVisit, context)).toBe("Go to “Visit”");
		expect(linkLead(toCare, context)).toBe("Open the “Care” form list");
	});

	it("says when a destination is gone rather than crashing the sentence", () => {
		expect(linkLead(toNote, context)).toBe(
			"Go to a form that is no longer in the app",
		);
	});

	it("reads the condition and the carried values as details", () => {
		const sentence = linkSentence(
			link({
				condition: { parts: [] },
				datums: [
					{ name: "case_id", xpath: { parts: [] } },
					{ name: "case_id_household", xpath: { parts: [] } },
				],
			}),
			context,
		);
		expect(sentence).toEqual({
			lead: "Go to “Visit”",
			details: [
				"When #patient/mood = 'low'",
				"Carries 2 values worked out here",
			],
		});
		expect(linkSentenceText(sentence)).toBe(
			"Go to “Visit”: When #patient/mood = 'low', Carries 2 values worked out here",
		);
	});

	it("has no details for a bare otherwise link", () => {
		expect(linkSentence(link({}), context)).toEqual({
			lead: "Go to “Visit”",
			details: [],
		});
	});
});

describe("after-submit copy", () => {
	it("spells the three destinations one way", () => {
		expect(destinationPhrase("app_home")).toBe("to the app home");
		expect(destinationPhrase("module")).toBe("to this module's form list");
		expect(destinationPhrase("previous")).toBe("back to the previous screen");
		expect(destinationLabel("app_home")).toBe("App home");
		expect(destinationLabel("module")).toBe("This module");
		expect(destinationLabel("previous")).toBe("Previous screen");
	});

	it("summarises a form with no links from its default", () => {
		const doc = fixture();
		const plan = afterSubmitPlan(doc, SOURCE);
		if (plan === undefined) throw new Error("no plan");
		expect(afterSubmitSummary(plan, (t) => formLinkDestination(doc, t))).toBe(
			"When this form is submitted, the person goes to the app home.",
		);
	});

	it("counts the conditional links and names the otherwise", () => {
		const conditionalOnly = fixture(
			[
				{ uuid: "l1", condition: "1 = 1", target: toNote },
				{ uuid: "l2", condition: "2 = 2", target: toVisit },
			],
			{ postSubmit: "previous" },
		);
		const plan1 = afterSubmitPlan(conditionalOnly, SOURCE);
		if (plan1 === undefined) throw new Error("no plan");
		expect(
			afterSubmitSummary(plan1, (t) => formLinkDestination(conditionalOnly, t)),
		).toBe(
			"This form checks 2 links first, and goes back to the previous screen when none of them match.",
		);
		const withElse = fixture([
			{ uuid: "l1", condition: "1 = 1", target: toNote },
			{ uuid: "else", target: toCare },
		]);
		const plan2 = afterSubmitPlan(withElse, SOURCE);
		if (plan2 === undefined) throw new Error("no plan");
		expect(
			afterSubmitSummary(plan2, (t) => formLinkDestination(withElse, t)),
		).toBe(
			"This form checks 1 link first, and otherwise goes to the “Care” form list.",
		);
	});

	it("announces a fallback change and a pinned fallback", () => {
		expect(fallbackChangedAnnouncement("module", context.destinationOf)).toBe(
			"Otherwise now goes to this module's form list.",
		);
		expect(
			fallbackChangedAnnouncement(
				{ kind: "else-link", target: toVisit },
				context.destinationOf,
			),
		).toBe("Otherwise now goes to “Visit”.");
		expect(pinsFallbackSentence("app_home")).toBe(
			"Otherwise now explicitly goes to the app home.",
		);
	});

	it("asks before a built-in destination replaces the otherwise link", () => {
		expect(stopElseLinkQuestion("Visit", "previous")).toBe(
			"Stop going to “Visit”? When nothing above matches, the form will go back to the previous screen instead. You can undo this.",
		);
	});

	it("names what travels automatically by its source", () => {
		expect(carriedAutomaticallyDetail("case_id")).toBe(
			"The case this form opened travels with the person.",
		);
		expect(carriedAutomaticallyDetail("case_id_new_patient_0")).toBe(
			"The case this form creates travels with the person.",
		);
		expect(nothingNeededCopy("module")).toContain(
			"picks a case when they arrive",
		);
		expect(nothingNeededCopy("form")).toContain("opens straight away");
	});
});
