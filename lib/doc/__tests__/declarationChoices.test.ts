/**
 * Every declaration a document's content runs on, and the one to propose.
 *
 * Contract: `planDeclarationChoices` offers each of both platforms, Android
 * only and Web Apps only that runs the content, and, where the document holds
 * a date-and-time question that splits, both and Web Apps only with the split,
 * but never a split choice whose unsplit twin runs nor Web Apps only with the
 * split where both with the split runs. Every choice's batch passes the commit
 * gate over its document. The proposal follows HQ's Web App setting: with it
 * off, Android only where it runs; with it on, the first choice that keeps Web
 * Apps, so an app whose only gap in Web Apps is its date-and-time questions is
 * proposed the split, never Android only. Content no choice runs gives every
 * blocking use with the platform that cannot run it, and the question whose
 * split is refused. Over the fuzz documents, every choice leaves no
 * unavailable use and the one declaration `planContentDeclaration` gives is
 * among the choices.
 */

import * as fc from "fast-check";
import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { blueprintDocArbitrary } from "@/lib/commcare/__tests__/xformDocArbitrary";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { applyMutations } from "@/lib/doc/mutations";
import {
	type DeclarationChoice,
	planContentDeclaration,
	planDeclarationChoices,
} from "@/lib/doc/platformDeclaration";
import {
	type BlueprintDoc,
	PLATFORMS,
	type Platform,
	type Uuid,
	unavailableUses,
} from "@/lib/domain";
import {
	FIXTURE_FORM,
	FIXTURE_MODULE,
	PLATFORM_FEATURE_FIXTURES,
} from "@/lib/domain/__tests__/platformFeatureFixtures";

function undeclared(doc: BlueprintDoc): BlueprintDoc {
	return produce(doc, (draft) => {
		delete draft.appSettings.runsOnlyOn;
	});
}

const fixture = (feature: keyof typeof PLATFORM_FEATURE_FIXTURES) =>
	undeclared(PLATFORM_FEATURE_FIXTURES[feature].with());

function firstQuestion(doc: BlueprintDoc): Uuid {
	const question = doc.fieldOrder[FIXTURE_FORM]?.[0];
	if (question === undefined)
		throw new Error("The fixture's form holds no question.");
	return question;
}

/** The fixture's first question turned into a date-and-time question. */
function withDatetimeQuestion(doc: BlueprintDoc): BlueprintDoc {
	const question = firstQuestion(doc);
	return produce(doc, (draft) => {
		const field = draft.fields[question];
		if (field === undefined) throw new Error("No question.");
		draft.fields[question] = { ...field, kind: "datetime" } as typeof field;
	});
}

function withFormsReadSearch(doc: BlueprintDoc): BlueprintDoc {
	return produce(doc, (draft) => {
		const module = draft.modules[FIXTURE_MODULE];
		if (module === undefined) throw new Error("No fixture module.");
		module.caseSearchConfig = { formsReadSearch: true };
	});
}

/** The question's own rule reads it through a filter, which refuses its split. */
function withSelfReadThroughAFilter(doc: BlueprintDoc): BlueprintDoc {
	const question = firstQuestion(doc);
	const self = { kind: "field", uuid: question, spelling: "relative" } as const;
	return produce(doc, (draft) => {
		const field = draft.fields[question] as Record<string, unknown>;
		field.validate = {
			kind: "neq",
			left: {
				kind: "term",
				term: {
					...self,
					filters: [
						{
							step: { kind: "field", uuid: question },
							where: [
								{
									kind: "neq",
									left: { kind: "term", term: self },
									right: { kind: "term", term: { kind: "literal", value: "" } },
								},
							],
						},
					],
				},
			},
			right: { kind: "term", term: { kind: "literal", value: "" } },
		};
	});
}

/** A choice as the test names it. */
function named(choice: DeclarationChoice): string {
	const where = choice.runsOnlyOn ?? "both";
	return choice.split ? `${where} with the split` : where;
}

function declaredPlatforms(choice: DeclarationChoice): readonly Platform[] {
	return choice.runsOnlyOn === undefined ? PLATFORMS : [choice.runsOnlyOn];
}

function applied(doc: BlueprintDoc, choice: DeclarationChoice): BlueprintDoc {
	return produce(structuredClone(doc), (draft) => {
		applyMutations(draft, choice.mutations);
	});
}

function plan(doc: BlueprintDoc, webAppsOnInHq: boolean) {
	const choices = planDeclarationChoices(doc, { webAppsOnInHq });
	if (choices.kind !== "choices")
		throw new Error("Expected the content to run on some declaration.");
	return {
		...choices,
		names: choices.choices.map(named),
		proposal: named(choices.choices[choices.proposed] as DeclarationChoice),
	};
}

/** Every choice's batch passes the gate over the document. */
function expectAdmitted(
	doc: BlueprintDoc,
	choices: readonly DeclarationChoice[],
) {
	for (const choice of choices) {
		if (choice.mutations.length === 0) continue;
		const verdict = mutationCommitVerdict(
			doc,
			choice.mutations,
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		expect(verdict.ok ? [] : verdict.findings, named(choice)).toEqual([]);
	}
}

describe("planDeclarationChoices over production documents", () => {
	it("offers only Android for a grouped body field marked to show only on Android", () => {
		const doc = fixture("raw-grouped-tile-body-field");
		const choices = plan(doc, false);
		expect(choices.names).toEqual(["android"]);
		expect(choices.proposal).toBe("android");
		expectAdmitted(doc, choices.choices);
	});
	it("offers every declaration for content that runs everywhere, proposing both where HQ serves Web Apps", () => {
		const doc = fixture("search");
		const on = plan(doc, true);
		expect(on.names).toEqual(["both", "android", "web-apps"]);
		expect(on).toMatchObject({
			proposal: "both",
			narrowedByHq: false,
			keepsWebApps: false,
		});
		const off = plan(doc, false);
		expect(off).toMatchObject({
			proposal: "android",
			narrowedByHq: true,
			keepsWebApps: false,
		});
		expectAdmitted(doc, on.choices);
	});

	it("keeps Web Apps through the split where HQ serves it, for an app whose only gap is its date-and-time questions", () => {
		const doc = fixture("datetime-question");
		const on = plan(doc, true);
		expect(on.names).toEqual(["android", "both with the split"]);
		expect(on).toMatchObject({
			proposal: "both with the split",
			keepsWebApps: true,
			narrowedByHq: false,
		});
		const off = plan(doc, false);
		expect(off).toMatchObject({
			proposal: "android",
			keepsWebApps: false,
			narrowedByHq: false,
		});
		expectAdmitted(doc, on.choices);
		const split = on.choices[1] as DeclarationChoice;
		expect(split.splits).toHaveLength(1);
		expect(split.mutations[0]).not.toMatchObject({ kind: "setAppSettings" });
	});

	it("offers Web Apps only with the split where Android cannot run another use", () => {
		const doc = withDatetimeQuestion(fixture("forms-read-search"));
		for (const webAppsOnInHq of [true, false]) {
			const choices = plan(doc, webAppsOnInHq);
			expect(choices.names).toEqual(["web-apps with the split"]);
			expect(choices).toMatchObject({
				proposal: "web-apps with the split",
				narrowedByHq: false,
				keepsWebApps: false,
			});
			expect(choices.choices[0]?.mutations[0]).toEqual({
				kind: "setAppSettings",
				settings: { runsOnlyOn: "web-apps" },
			});
			expectAdmitted(doc, choices.choices);
		}
	});

	it("offers nothing for uses neither platform runs, naming each with its platform", () => {
		const doc = withFormsReadSearch(fixture("case-list-here"));
		for (const webAppsOnInHq of [true, false]) {
			const choices = planDeclarationChoices(doc, { webAppsOnInHq });
			expect(choices.kind).toBe("none");
			if (choices.kind !== "none") return;
			expect(
				choices.blocking.map(({ use, platform }) => [use.feature, platform]),
			).toEqual([
				["forms-read-search", "android"],
				["case-list-here", "web-apps"],
			]);
			expect(choices.splitRefused).toBeUndefined();
		}
	});

	it("names the question whose refused split is why nothing runs", () => {
		const doc = withSelfReadThroughAFilter(
			withDatetimeQuestion(fixture("forms-read-search")),
		);
		for (const webAppsOnInHq of [true, false]) {
			const choices = planDeclarationChoices(doc, { webAppsOnInHq });
			expect(choices).toMatchObject({
				kind: "none",
				splitRefused: firstQuestion(doc),
			});
		}
	});

	it("leaves the document it is given as it came", () => {
		const doc = structuredClone(fixture("datetime-question"));
		planDeclarationChoices(doc, { webAppsOnInHq: true });
		expect(Object.isFrozen(doc.fields)).toBe(false);
	});
});

describe("planDeclarationChoices over the fuzz documents", () => {
	it("offers only choices that run, among them the one planContentDeclaration gives", () => {
		const docs = fc.sample(blueprintDocArbitrary, {
			seed: 20261113,
			numRuns: 25,
		});
		for (const sample of docs) {
			const doc = undeclared(sample);
			const content = planContentDeclaration(doc);
			for (const webAppsOnInHq of [true, false]) {
				const choices = planDeclarationChoices(doc, { webAppsOnInHq });
				expect(choices.kind).toBe("choices");
				if (choices.kind !== "choices") continue;
				for (const choice of choices.choices)
					expect(
						unavailableUses(applied(doc, choice), declaredPlatforms(choice)),
						named(choice),
					).toEqual([]);
				if (content.kind !== "declared") continue;
				expect(
					choices.choices.some(
						(choice) =>
							choice.runsOnlyOn === content.runsOnlyOn &&
							choice.split === content.splits.length > 0,
					),
				).toBe(true);
			}
		}
	});
});
