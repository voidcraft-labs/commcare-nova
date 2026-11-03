// e2e/lib/formLinkSeeds.test.ts
//
// The after-submit journeys read facts about their seeded documents: that
// each is a valid app, that each already holds after-submit in the shape
// Nova stores now (so the cutover's map leaves it unchanged), and that the
// destinations the form-links smoke authors in the builder are ones the
// planners and the commit gate admit. A failure here names the fixture
// instead of surfacing as a Playwright timeout.

import { describe, expect, it } from "vitest";
import { runValidation } from "@/lib/commcare/validator/runner";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import {
	afterSubmitPlan,
	type FormLinkCommitPlan,
	planFormLinkAdd,
} from "@/lib/doc/formLinkMutations";
import { mapFormLinkSemantics } from "@/lib/doc/formLinkSemanticsMap";
import { formLinkTargetChoices } from "@/lib/doc/formLinkTargetChoices";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { mutationSchema } from "@/lib/doc/types";
import { asUuid, type BlueprintDoc } from "@/lib/domain";
import { eq, literal } from "@/lib/domain/expression/builders";
import { buildDeepLinksBlueprint } from "./deepLinksSeed";
import { buildFormLinksBlueprint, FORM_LINKS_SEED } from "./formLinksSeed";
import {
	buildPreviousTaskBlueprint,
	PREVIOUS_TASK_SEED,
} from "./previousTaskSeed";

const SEEDS: ReadonlyArray<readonly [string, BlueprintDoc]> = [
	["form links", buildFormLinksBlueprint("form-links-app")],
	["previous task", buildPreviousTaskBlueprint("previous-task-app")],
	["deep links", buildDeepLinksBlueprint("deep-links-app")],
];

function commit(doc: BlueprintDoc, plan: FormLinkCommitPlan): BlueprintDoc {
	if (!plan.ok) throw new Error(`refused: ${JSON.stringify(plan.reason)}`);
	const verdict = mutationCommitVerdict(
		doc,
		plan.mutations.map((mutation) =>
			mutationSchema.parse(JSON.parse(JSON.stringify(mutation))),
		),
		LOOKUP_CONTEXT_UNAVAILABLE,
	);
	if (!verdict.ok) {
		throw new Error(
			`gate refused: ${verdict.findings.map((finding) => finding.code).join(", ")}`,
		);
	}
	return verdict.nextDoc;
}

describe("the after-submit smoke fixtures", () => {
	it.each(SEEDS)("the %s seed installs a valid app", (_name, doc) => {
		expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
	});

	it.each(SEEDS)(
		"the %s seed already holds after-submit as Nova stores it",
		(_name, doc) => {
			expect(mapFormLinkSemantics(doc).changes).toEqual([]);
		},
	);

	it("gives Previous task's conditional destination the Previous screen as its otherwise", () => {
		const doc = buildPreviousTaskBlueprint("previous-task-app");
		const update = doc.forms[PREVIOUS_TASK_SEED.formsFirst.formUuid];
		expect(update?.postSubmit).toBeUndefined();
		expect(update?.otherwise).toEqual({
			kind: "destination",
			destination: "previous",
		});
	});

	it("admits the two destinations the form-links smoke authors, in that order", () => {
		const { visit, followUp, moduleUuid } = FORM_LINKS_SEED;
		const start = buildFormLinksBlueprint("form-links-app");

		const choices = formLinkTargetChoices(start, visit.formUuid);
		expect(choices.thisForm.verdict.ok).toBe(true);
		const followUpChoice = choices.menus
			.find((menu) => menu.uuid === moduleUuid)
			?.forms.find((form) => form.uuid === followUp.formUuid);
		expect(followUpChoice?.verdict.ok).toBe(true);

		// "Go somewhere every time" → Follow-up replaces the stored app home.
		const everyTime = asUuid("0b1c2d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e");
		const withFollowUp = commit(
			start,
			planFormLinkAdd(start, visit.formUuid, {
				uuid: everyTime,
				target: { type: "form", moduleUuid, formUuid: followUp.formUuid },
			}),
		);
		expect(withFollowUp.forms[visit.formUuid]?.postSubmit).toBeUndefined();
		expect(
			afterSubmitPlan(withFollowUp, visit.formUuid)?.otherwiseOffered,
		).toBe(false);

		// "Go somewhere when a condition is true" → Start this form again,
		// under the note the form writes.
		const conditional = asUuid("1c2d3e4f-5a6b-4c7d-9e8f-0a1b2c3d4e5f");
		const both = commit(
			withFollowUp,
			planFormLinkAdd(withFollowUp, visit.formUuid, {
				uuid: conditional,
				condition: eq(
					{
						kind: "form-case",
						caseType: FORM_LINKS_SEED.caseType,
						property: FORM_LINKS_SEED.property,
					},
					literal(FORM_LINKS_SEED.linkingNote),
				),
				target: { type: "this-form" },
			}),
		);
		const plan = afterSubmitPlan(both, visit.formUuid);
		expect(plan?.destinations.map((link) => link.uuid)).toEqual([
			everyTime,
			conditional,
		]);
		expect(plan?.otherwiseOffered).toBe(true);
		expect(runValidation(both, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
	});

	it("sends Follow-up to the app home, so a destination waiting beneath it opens next", () => {
		const doc = buildFormLinksBlueprint("form-links-app");
		expect(doc.forms[FORM_LINKS_SEED.followUp.formUuid]?.postSubmit).toBe(
			"app_home",
		);
	});
});
