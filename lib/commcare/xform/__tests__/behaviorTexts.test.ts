/**
 * A form behavior is held by the identity of a question or choice text: the
 * XForm writes that text once under its pragma id and every sharing slot
 * points at it, and the gate refuses a setting HQ's build would lose, the
 * one `XForm.normalize_itext` merges into an equal text whose id sorts
 * before it (`corehq/apps/app_manager/xform.py::normalize_itext`, groups
 * sorted by id, the first kept).
 */
import type { Element } from "domhandler";
import { isTag } from "domhandler";
import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { userFacingError } from "@/lib/doc/userFacingErrors";
import {
	type BehaviorText,
	type BlueprintDoc,
	type FormBehaviorRole,
	proseText,
	type Uuid,
} from "@/lib/domain";
import { runValidation } from "../../validator/runner";
import { validateXForm } from "../../validator/xformOracle";
import { parseXml } from "../../xmlParse";
import { parser } from "../../xpath";
import { formBehaviorTextSentence } from "../behaviorTextCopy";
import {
	formBehaviorTextChoices,
	formBehaviorTextIssue,
} from "../behaviorTexts";
import { buildXForm } from "../builder";

/** A survey of the given questions, each `[id, label]`, the first a choice
 *  question with options `yes` and `no`. */
function survey(questions: readonly (readonly [string, string])[]): {
	doc: BlueprintDoc;
	form: Uuid;
	fields: Uuid[];
} {
	const doc = buildDoc({
		appName: "Visits",
		modules: [
			{
				name: "Visits",
				forms: [
					{
						name: "Visit",
						type: "survey",
						fields: questions.map(([id, label], index) =>
							index === 0
								? f({
										kind: "single_select",
										id,
										label: proseText(label),
										options: [
											{ value: "yes", label: proseText("Yes") },
											{ value: "no", label: proseText("No") },
										],
									})
								: f({ kind: "text", id, label: proseText(label) }),
						),
					},
				],
			},
		],
	});
	const form = doc.formOrder[doc.moduleOrder[0]][0];
	return { doc, form, fields: [...doc.fieldOrder[form]] };
}

function withBehavior(
	doc: BlueprintDoc,
	form: Uuid,
	role: FormBehaviorRole,
	text: BehaviorText,
): BlueprintDoc {
	return {
		...doc,
		forms: { ...doc.forms, [form]: { ...doc.forms[form], [role]: text } },
	};
}

const label = (field: Uuid) => ({ field, role: "field-label" as const });

/** The form's XForm, held to the XForm oracle, as its itext ids (one per
 *  language each) and the itext id each control text reads. */
function xform(
	doc: BlueprintDoc,
	form: Uuid,
): { texts: string[]; reads: string[] } {
	const xml = buildXForm(doc, form, { xmlns: "urn:form-behavior" });
	expect(validateXForm(xml, "Visit", "Visits")).toEqual([]);
	const texts: string[] = [];
	const reads: string[] = [];
	const walk = (element: Element) => {
		if (element.name === "text" && element.attribs.id !== undefined)
			texts.push(element.attribs.id);
		const ref = element.attribs.ref;
		if (element.name !== "bind" && ref !== undefined) {
			const tree = parser.parse(ref);
			tree.iterate({
				enter(node) {
					if (node.name !== "Invoke") return;
					const name = node.node.getChild("FunctionName");
					if (name === null || ref.slice(name.from, name.to) !== "jr:itext")
						return;
					const literal = node.node
						.getChild("ArgumentList")
						?.getChild("StringLiteral");
					if (literal) reads.push(ref.slice(literal.from + 1, literal.to - 1));
				},
			});
		}
		for (const child of element.children.filter(isTag)) walk(child);
	};
	for (const child of parseXml(xml).children.filter(isTag)) walk(child);
	return { texts, reads };
}

const count = (values: readonly string[], value: string) =>
	values.filter((item) => item === value).length;

describe("the XForm a form behavior writes", () => {
	it("writes the carrier's text once under the pragma id and points every sharing slot at it", () => {
		const { doc, form, fields } = survey([
			["consent", "Consent"],
			["visit", "Visit today"],
			["again", "Visit today"],
		]);
		const held = withBehavior(doc, form, "automaticSubmissionText", {
			carrier: label(fields[1]),
			alsoUsedBy: [label(fields[2])],
		});
		expect(formBehaviorTextIssue(held, form)).toBeUndefined();
		const { texts, reads } = xform(held, form);
		expect(count(texts, "Pragma-Submit-Automatically")).toBe(1);
		expect(count(reads, "Pragma-Submit-Automatically")).toBe(2);
		expect(texts).not.toContain("visit-label");
		expect(texts).not.toContain("again-label");
		expect(reads).toContain("consent-label");
	});

	it("moves a choice's text to the pragma id and keeps its sibling's", () => {
		const { doc, form, fields } = survey([["consent", "Consent"]]);
		const field = doc.fields[fields[0]];
		if (
			field.kind !== "single_select" ||
			field.optionsSource?.kind !== "inline"
		)
			throw new Error("The choice question is missing.");
		const option = field.optionsSource.options[0].uuid;
		const held = withBehavior(doc, form, "skipAutomaticSyncText", {
			carrier: { field: fields[0], option, role: "select-option-label" },
		});
		expect(formBehaviorTextIssue(held, form)).toBeUndefined();
		const { texts, reads } = xform(held, form);
		expect(count(texts, "Pragma-Suppress-Autosync")).toBe(1);
		expect(reads).toContain("Pragma-Suppress-Autosync");
		expect(texts).not.toContain("consent-opt0-label");
		expect(reads).toContain("consent-opt1-label");
	});
});

describe("the gate on a form behavior", () => {
	it("refuses a setting an earlier equal text would absorb, and holds it once the texts differ", () => {
		// `Name-label` sorts before `Pragma-…` (an uppercase N before P), so
		// HQ's build keeps `Name-label` and drops the pragma id.
		const { doc, form, fields } = survey([
			["consent", "Consent"],
			["Name", "Visit today"],
			["visit", "Visit today"],
		]);
		const held = withBehavior(doc, form, "automaticSubmissionText", {
			carrier: label(fields[2]),
		});
		const issue = formBehaviorTextIssue(held, form);
		if (issue === undefined) throw new Error("The merge went unnoticed.");
		expect(issue).toMatchObject({
			reason: "merged-away",
			role: "automaticSubmissionText",
		});
		const findings = runValidation(held, LOOKUP_CONTEXT_UNAVAILABLE).filter(
			(finding) => finding.code === "FORM_BEHAVIOR_TEXT_INVALID",
		);
		expect(findings).toHaveLength(1);
		expect(userFacingError(findings[0])).toBe(formBehaviorTextSentence(issue));
		expect(userFacingError(findings[0])).toContain(
			"loses automatic submission",
		);

		const distinct = {
			...held,
			fields: {
				...held.fields,
				[fields[1]]: { ...held.fields[fields[1]], label: proseText("Name") },
			},
		} as BlueprintDoc;
		expect(formBehaviorTextIssue(distinct, form)).toBeUndefined();
	});

	it("keeps a later equal text from absorbing the setting", () => {
		// `visit-label` sorts after `Pragma-…`, so the pragma id survives the merge.
		const { doc, form, fields } = survey([
			["consent", "Consent"],
			["visit", "Visit today"],
			["Arrival", "Visit today"],
		]);
		expect(
			formBehaviorTextIssue(
				withBehavior(doc, form, "automaticSubmissionText", {
					carrier: label(fields[2]),
				}),
				form,
			),
		).toBeUndefined();
	});

	it("refuses two settings on equal texts, where the earlier pragma id absorbs the later one", () => {
		const { doc, form, fields } = survey([
			["consent", "Consent"],
			["first", "Ready"],
			["second", "Ready"],
		]);
		const both = withBehavior(
			withBehavior(doc, form, "automaticSubmissionText", {
				carrier: label(fields[1]),
			}),
			form,
			"skipAutomaticSyncText",
			{ carrier: label(fields[2]) },
		);
		// `Pragma-Submit-Automatically` sorts before `Pragma-Suppress-Autosync`.
		expect(formBehaviorTextIssue(both, form)).toMatchObject({
			reason: "merged-away",
			role: "skipAutomaticSyncText",
		});
	});

	it("refuses one text holding two settings, and a shared slot whose text differs", () => {
		const { doc, form, fields } = survey([
			["consent", "Consent"],
			["visit", "Visit today"],
			["again", "Visit again"],
		]);
		const twice = withBehavior(
			withBehavior(doc, form, "automaticSubmissionText", {
				carrier: label(fields[1]),
			}),
			form,
			"validateChangedAnswersText",
			{ carrier: label(fields[1]) },
		);
		expect(formBehaviorTextIssue(twice, form)).toMatchObject({
			reason: "held-by-another",
			role: "validateChangedAnswersText",
			heldBy: "automaticSubmissionText",
		});
		const differs = withBehavior(doc, form, "automaticSubmissionText", {
			carrier: label(fields[1]),
			alsoUsedBy: [label(fields[2])],
		});
		expect(formBehaviorTextIssue(differs, form)).toMatchObject({
			reason: "shared-text-differs",
		});
	});

	it("refuses a setting whose text the form no longer writes", () => {
		const { doc, form, fields } = survey([
			["consent", "Consent"],
			["visit", ""],
		]);
		expect(
			formBehaviorTextIssue(
				withBehavior(doc, form, "automaticSubmissionText", {
					carrier: label(fields[1]),
				}),
				form,
			),
		).toMatchObject({ reason: "text-missing" });
	});
});

describe("the texts a form offers its behaviors", () => {
	it("lists question and choice texts, marking which are question labels", () => {
		const { doc, form, fields } = survey([
			["consent", "Consent"],
			["visit", "Visit today"],
		]);
		const choices = formBehaviorTextChoices(doc, form);
		expect(
			choices.map((choice) => [choice.label, choice.questionLabel]),
		).toEqual([
			["Consent · label of consent", true],
			["Yes · choice of consent", false],
			["No · choice of consent", false],
			["Visit today · label of visit", true],
		]);
		expect(choices[3].unit).toEqual(label(fields[1]));
	});
});
