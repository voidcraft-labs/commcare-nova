// components/builder/form-links/__tests__/linkSentence.test.ts
//
// The row sentence and the shared after-submit copy are projections: they
// read the stored link and the plan, and they spell every destination one
// way across every surface.

import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { projectFormExpression } from "@/lib/doc/expressionText";
import { afterSubmitPlan } from "@/lib/doc/formLinkMutations";
import { formLinkTargetVisibility } from "@/lib/doc/hooks/useFormLinkFacts";
import {
	type BlueprintDoc,
	type FormLink,
	formLinkDestination,
	guardedLinkDatums,
} from "@/lib/domain";
import {
	eq,
	literal,
	sessionUser,
	term,
} from "@/lib/domain/expression/builders";
import { PLATFORMS, type Platform } from "@/lib/domain/platforms";
import {
	afterSubmitSummary,
	carriedAutomaticallyDetail,
	commitReportSentences,
	destinationDetail,
	destinationLabel,
	destinationPhrase,
	hasEveryTimeDestination,
	hiddenTargetLine,
	nothingNeededCopy,
	otherwiseChangedAnnouncement,
	otherwiseSentence,
	otherwiseSubtitle,
	postSubmitChangedAnnouncement,
	postSubmitSentence,
} from "../afterSubmitCopy";
import {
	EVERY_TIME_LINE,
	HELD_CASE_LINE,
	type LinkSentenceContext,
	linkLead,
	linkSentence,
	linkSentenceText,
} from "../linkSentence";
import {
	CARE,
	fixture,
	HOUSEHOLDS,
	SOURCE,
	toCare,
	toInspect,
	toNote,
	toVisit,
	VISIT,
} from "./fixture";

/** The document-backed context `useLinkSentenceContext` builds, over `doc`. */
function contextOver(doc: BlueprintDoc): LinkSentenceContext {
	return {
		destinationOf: (target) => formLinkDestination(doc, SOURCE, target),
		conditionText: (link) =>
			link.condition === undefined
				? ""
				: projectFormExpression(
						produce(doc, (draft) => {
							draft.forms[SOURCE].formLinks = [
								{
									uuid: link.uuid,
									target: link.target,
									condition: link.condition,
								},
							];
						}),
						{
							entity: "form",
							uuid: SOURCE,
							slot: "form_link_condition",
							member: { linkUuid: link.uuid },
						},
						link.condition,
						"unavailable",
					).text,
		carriesHeldCase: (link) => guardedLinkDatums(doc, SOURCE, link).length > 0,
	};
}

const context = contextOver(fixture());

const link = (overrides: Partial<FormLink>): FormLink => ({
	uuid: testUuid("lnk"),
	target: toVisit,
	...overrides,
});

describe("linkSentence", () => {
	it("leads with where the person goes", () => {
		expect(linkLead(toVisit, context)).toBe("Go to “Visit”");
		expect(linkLead(toCare, context)).toBe("Open the “Care” form list");
		expect(linkLead({ type: "this-form" }, context)).toBe(
			"Start this form again",
		);
	});

	it("says when a destination is gone rather than crashing the sentence", () => {
		expect(
			linkLead(
				{ type: "form", moduleUuid: CARE, formUuid: testUuid("gone") },
				context,
			),
		).toBe("Go to a form that is no longer in the app");
	});

	it("reads a destination with no condition as running every time", () => {
		expect(linkSentence(link({}), context)).toEqual({
			lead: "Go to “Visit”",
			details: [EVERY_TIME_LINE],
		});
		expect(EVERY_TIME_LINE).toBe("Every time");
	});

	it("reads the condition, then the carried values", () => {
		const sentence = linkSentence(
			link({
				condition: eq(
					{ kind: "form-case", caseType: "patient", property: "mood" },
					literal("low"),
				),
			}),
			context,
		);
		expect(sentence).toEqual({
			lead: "Go to “Visit”",
			details: ["When #patient/mood = 'low'"],
		});
		expect(linkSentenceText(sentence)).toBe(
			"Go to “Visit”: When #patient/mood = 'low'",
		);
	});

	it("adds the held-case line for a destination that carries a case, in place of Every time", () => {
		const carrying = link({
			target: toInspect,
			datums: [
				{
					name: { kind: "selected-case", module: HOUSEHOLDS },
					xpath: term(literal("external-case")),
				},
			],
		});
		expect(context.carriesHeldCase(carrying)).toBe(true);
		expect(linkSentence(carrying, context).details).toEqual([
			HELD_CASE_LINE,
			"Carries 1 value worked out here",
		]);
		expect(HELD_CASE_LINE).toBe(
			"When the case it carries is on the worker's device",
		);
		const conditional = {
			...carrying,
			condition: eq(literal(1), literal(1)),
		};
		expect(linkSentence(conditional, context).details).toEqual([
			"When 1 = 1",
			HELD_CASE_LINE,
			"Carries 1 value worked out here",
		]);
	});

	it("gives the otherwise link no when of its own", () => {
		expect(linkSentence(link({}), context, "otherwise")).toEqual({
			lead: "Go to “Visit”",
			details: [],
		});
	});
});

describe("after-submit copy", () => {
	it("spells the five destinations one way", () => {
		expect(destinationPhrase("app_home")).toBe("to the app home");
		expect(destinationPhrase("firstMenu")).toBe("to the app's first menu");
		expect(destinationPhrase("module")).toBe("to this module's form list");
		expect(destinationPhrase("parentMenu")).toBe("to the parent module");
		expect(destinationPhrase("previous")).toBe("back to the previous screen");
		expect(destinationLabel("app_home")).toBe("App home");
		expect(destinationLabel("firstMenu")).toBe("First menu");
		expect(destinationLabel("module")).toBe("This module");
		expect(destinationLabel("parentMenu", "Mothers")).toBe(
			"Parent module: Mothers",
		);
		expect(destinationLabel("previous")).toBe("Previous screen");
		expect(destinationDetail("firstMenu")).toBe(
			"Opens the app's first menu, which lists its modules",
		);
		expect(destinationDetail("parentMenu")).toBe(
			"Back to the parent module, with its selection kept",
		);
	});

	it("reads an absent Otherwise as the app home", () => {
		expect(otherwiseSentence(undefined, context.destinationOf)).toBe(
			"Otherwise, back to the app home",
		);
		expect(
			otherwiseSentence(
				{ kind: "destination", destination: "module" },
				context.destinationOf,
			),
		).toBe("Otherwise, to this module's form list");
		expect(
			otherwiseSentence(
				{ kind: "link", uuid: testUuid("o"), target: toCare },
				context.destinationOf,
			),
		).toBe("Otherwise, to the “Care” form list");
		expect(
			otherwiseSentence(
				{ kind: "link", uuid: testUuid("o"), target: { type: "this-form" } },
				context.destinationOf,
			),
		).toBe("Otherwise, to this form again");
	});

	it("says the Otherwise opens first only while a destination runs every time", () => {
		expect(otherwiseSubtitle(false)).toBe(
			"When no destination with a condition or a carried case runs.",
		);
		expect(otherwiseSubtitle(true)).toBe(
			"When no destination with a condition or a carried case runs. It opens before any destination that runs every time.",
		);
		const mixed = fixture([
			{ uuid: "l1", condition: "1 = 1", target: toNote },
			{ uuid: "l2", target: toVisit },
		]);
		const conditionalOnly = fixture([
			{ uuid: "l1", condition: "1 = 1", target: toNote },
		]);
		const planOf = (doc: BlueprintDoc) => {
			const plan = afterSubmitPlan(doc, SOURCE);
			if (plan === undefined) throw new Error("no plan");
			return plan;
		};
		expect(hasEveryTimeDestination(planOf(mixed))).toBe(true);
		expect(hasEveryTimeDestination(planOf(conditionalOnly))).toBe(false);
	});

	it("summarises a form without destinations from its default", () => {
		const doc = fixture();
		const plan = afterSubmitPlan(doc, SOURCE);
		if (plan === undefined) throw new Error("no plan");
		expect(afterSubmitSummary(plan, contextOver(doc).destinationOf)).toEqual({
			lead: "Goes to the app home",
			otherwise: undefined,
		});
		expect(postSubmitSentence("module")).toBe(
			"After submit, the form goes to this module's form list",
		);
	});

	it("summarises one destination, several, and the Otherwise beside them", () => {
		const one = fixture([{ uuid: "l1", target: toVisit }]);
		const onePlan = afterSubmitPlan(one, SOURCE);
		if (onePlan === undefined) throw new Error("no plan");
		expect(afterSubmitSummary(onePlan, contextOver(one).destinationOf)).toEqual(
			{
				lead: "Opens “Visit”",
				otherwise: undefined,
			},
		);
		const several = produce(
			fixture([
				{ uuid: "l1", condition: "1 = 1", target: toNote },
				{ uuid: "l2", target: toCare },
			]),
			(draft) => {
				draft.forms[SOURCE].otherwise = {
					kind: "destination",
					destination: "module",
				};
			},
		);
		const severalPlan = afterSubmitPlan(several, SOURCE);
		if (severalPlan === undefined) throw new Error("no plan");
		expect(
			afterSubmitSummary(severalPlan, contextOver(several).destinationOf),
		).toEqual({
			lead: "Runs 2 destinations in order",
			otherwise: "Otherwise, to this module's form list",
		});
		const offered = fixture([
			{ uuid: "l1", condition: "1 = 1", target: { type: "this-form" } },
		]);
		const offeredPlan = afterSubmitPlan(offered, SOURCE);
		if (offeredPlan === undefined) throw new Error("no plan");
		expect(
			afterSubmitSummary(offeredPlan, contextOver(offered).destinationOf),
		).toEqual({
			lead: "Opens this form again",
			otherwise: "Otherwise, back to the app home",
		});
	});

	it("announces what changed", () => {
		expect(
			otherwiseChangedAnnouncement(
				{ kind: "destination", destination: "previous" },
				context.destinationOf,
			),
		).toBe("Otherwise now goes back to the previous screen.");
		expect(otherwiseChangedAnnouncement(null, context.destinationOf)).toBe(
			"Otherwise now goes back to the app home.",
		);
		expect(postSubmitChangedAnnouncement("firstMenu")).toBe(
			"After submit, this form now goes to the app's first menu.",
		);
	});

	it("speaks each commit report as its toast sentence", () => {
		expect(commitReportSentences({})).toEqual([]);
		expect(commitReportSentences({ movedToOtherwise: "module" })).toEqual([
			"Where this form went after submit is now its Otherwise.",
		]);
		expect(
			commitReportSentences({
				droppedOtherwise: { kind: "destination", destination: "module" },
			}),
		).toEqual([
			"This form's Otherwise is gone, because every destination now runs each time.",
		]);
		expect(commitReportSentences({ otherwiseToPostSubmit: "module" })).toEqual([
			"This form's Otherwise is now where it goes after submit.",
		]);
		expect(
			commitReportSentences({ otherwiseToDestination: testUuid("o") }),
		).toEqual(["This form's Otherwise is now where it goes after submit."]);
		expect(commitReportSentences({ droppedPostSubmit: "previous" })).toEqual([
			"This form no longer goes back to the previous screen after submit, because its destinations say where it goes now.",
		]);
		expect(commitReportSentences({ droppedDatums: ["case_id"] })).toEqual([
			"The values it carried were removed, because the new destination doesn't read them.",
		]);
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

describe("the line under a link whose target some worker may not see", () => {
	const supervisor = eq(sessionUser("role"), literal("supervisor"));
	const linkTo = (target: FormLink["target"]): FormLink => ({
		uuid: testUuid("lnk-hidden"),
		target,
	});

	it("says nothing for a target nothing hides", () => {
		const doc = fixture();
		expect(
			hiddenTargetLine(
				formLinkTargetVisibility(doc, SOURCE, linkTo(toVisit)),
				false,
				PLATFORMS,
			),
		).toBeUndefined();
		expect(
			hiddenTargetLine(
				formLinkTargetVisibility(doc, SOURCE, linkTo(toCare)),
				false,
				PLATFORMS,
			),
		).toBeUndefined();
	});

	it("says what each platform does for a target form or module whose display condition is false", () => {
		const doc = fixture();
		doc.forms[VISIT].displayCondition = supervisor;
		doc.modules[CARE].displayCondition = supervisor;
		expect(
			hiddenTargetLine(
				formLinkTargetVisibility(doc, SOURCE, linkTo(toVisit)),
				false,
				PLATFORMS,
			),
		).toBe(
			"When this form's display condition is false for a worker, Android still opens it after submit, and Web Apps opens the module that holds it instead.",
		);
		expect(
			hiddenTargetLine(
				formLinkTargetVisibility(doc, SOURCE, linkTo(toCare)),
				false,
				PLATFORMS,
			),
		).toBe(
			"When this module's display condition is false for a worker, Android opens it with nothing in it, and Web Apps opens the app's first screen instead.",
		);
	});

	it("says what each platform does for a target form off the menu, and for one inside a module off the menu", () => {
		const doc = fixture();
		doc.forms[VISIT].hiddenFromMenu = true;
		expect(
			hiddenTargetLine(
				formLinkTargetVisibility(doc, SOURCE, linkTo(toVisit)),
				false,
				PLATFORMS,
			),
		).toBe(
			"This form is off the menu. Android still opens it after submit, and Web Apps opens the module that holds it instead.",
		);
		expect(
			hiddenTargetLine(
				formLinkTargetVisibility(doc, SOURCE, linkTo(toVisit)),
				true,
				PLATFORMS,
			),
		).toBe(
			"This form's module is off the menu. Android still opens the form after submit, and Web Apps opens the app's first screen instead.",
		);
	});

	it("says only what the platforms the app runs on do", () => {
		const hidden = fixture();
		hidden.forms[VISIT].displayCondition = supervisor;
		hidden.modules[CARE].displayCondition = supervisor;
		const formLine = (platforms: readonly Platform[]) =>
			hiddenTargetLine(
				formLinkTargetVisibility(hidden, SOURCE, linkTo(toVisit)),
				false,
				platforms,
			);
		const moduleLine = (platforms: readonly Platform[]) =>
			hiddenTargetLine(
				formLinkTargetVisibility(hidden, SOURCE, linkTo(toCare)),
				false,
				platforms,
			);
		expect(formLine(["android"])).toBe(
			"When this form's display condition is false for a worker, Android still opens it after submit.",
		);
		expect(formLine(["web-apps"])).toBe(
			"When this form's display condition is false for a worker, Web Apps opens the module that holds it instead.",
		);
		expect(moduleLine(["android"])).toBe(
			"When this module's display condition is false for a worker, Android opens it with nothing in it.",
		);
		expect(moduleLine(["web-apps"])).toBe(
			"When this module's display condition is false for a worker, Web Apps opens the app's first screen instead.",
		);

		const offMenu = fixture();
		offMenu.forms[VISIT].hiddenFromMenu = true;
		const offLine = (inside: boolean, platforms: readonly Platform[]) =>
			hiddenTargetLine(
				formLinkTargetVisibility(offMenu, SOURCE, linkTo(toVisit)),
				inside,
				platforms,
			);
		expect(offLine(true, ["android"])).toBe(
			"This form's module is off the menu. Android still opens the form after submit.",
		);
		expect(offLine(true, ["web-apps"])).toBe(
			"This form's module is off the menu. Web Apps opens the app's first screen instead.",
		);
		expect(offLine(false, ["android"])).toBe(
			"This form is off the menu. Android still opens it after submit.",
		);
		expect(offLine(false, ["web-apps"])).toBe(
			"This form is off the menu. Web Apps opens the module that holds it instead.",
		);
	});
});
