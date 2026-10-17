// Exercises SELECT_OPTION_LABEL_EMPTY through the complete validation runner,
// over each arm of a select's choice source. Refused candidates bypass
// construction admission; an admitted neighbor also passes the persisted
// schema and the commit gate.

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, type FieldSpec, f } from "@/lib/__tests__/docHelpers";
import { expectAdmittedDoc } from "@/lib/agent/__tests__/admittedFixture";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import {
	asMediaAssetId,
	type BlueprintDoc,
	collectTranslationUnits,
	type Media,
	makeTranslationUnitId,
	proseText,
} from "@/lib/domain";
import { runValidation } from "../runner";

const CODE = "SELECT_OPTION_LABEL_EMPTY";
const FIELD_SPEC_UUID = "label-select";
const FIELD = testUuid(FIELD_SPEC_UUID);
const BLANK = testUuid("label-option-blank");
const IMAGE = asMediaAssetId("01992000-0000-7000-8000-0000000000f1");

function select(options: {
	readonly blankLabel?: string;
	readonly media?: Media;
}): FieldSpec {
	return f({
		uuid: FIELD_SPEC_UUID,
		kind: "single_select",
		id: "village",
		label: proseText("Village"),
		optionsSource: {
			kind: "inline",
			options: [
				{
					uuid: testUuid("label-option-named"),
					value: "north",
					label: proseText("North"),
				},
				{
					uuid: BLANK,
					value: "south",
					label: proseText(options.blankLabel ?? ""),
					...(options.media !== undefined && { media: options.media }),
				},
			],
		},
	});
}

function survey(field: FieldSpec, caseAware = false): BlueprintDoc {
	return buildDoc({
		appName: "Choices",
		...(caseAware && {
			caseTypes: [
				{
					name: "household",
					properties: [{ name: "case_name", label: "Name" }],
				},
			],
		}),
		modules: [
			{
				name: "Visits",
				...(caseAware && { caseType: "household" }),
				forms: [{ name: "Visit", type: "survey", fields: [field] }],
			},
		],
	});
}

function labelFindings(doc: BlueprintDoc) {
	return runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter(
		(finding) => finding.code === CODE,
	);
}

/** Give the blank option a Spanish label beside its blank English one. */
function translateBlankOption(doc: BlueprintDoc, text: string): void {
	const unit = collectTranslationUnits(doc).find(
		(candidate) =>
			candidate.id === makeTranslationUnitId("field", FIELD, "option", BLANK),
	);
	if (unit === undefined) throw new Error("No unit for the blank option");
	doc.localization = {
		sourceLanguage: "eng",
		defaultLanguage: "eng",
		languageOrder: ["eng", "spa"],
		wireCodes: { eng: "en", spa: "es" },
		translations: {
			spa: {
				[unit.id]: {
					value: proseText(text),
					sourceFingerprint: unit.sourceFingerprint,
					origin: "human",
					review: "reviewed",
					translatedFrom: "eng",
				},
			},
		},
	};
}

describe("SELECT_OPTION_LABEL_EMPTY", () => {
	it("refuses a written choice with no label in any language and no media, naming it", () => {
		const findings = labelFindings(survey(select({})));
		expect(findings).toHaveLength(1);
		const [finding] = findings;
		expect(finding?.scope).toBe("field");
		expect(finding?.location).toMatchObject({
			fieldUuid: FIELD,
			fieldId: "village",
			formName: "Visit",
		});
		expect(finding?.details).toEqual({
			optionUuid: BLANK,
			optionValue: "south",
			optionPosition: "2",
		});
		expect(finding?.message).toBe(
			'Option 2 of field "village" in "Visit" has no label in any language and no image, audio or video. A worker would see an empty choice, and CommCare HQ\'s form builder cannot keep one. Give the choice a label, or attach media to it.',
		);
	});

	it("refuses a choice whose every translation is blank too", () => {
		const doc = survey(select({}));
		translateBlankOption(doc, "");
		expect(labelFindings(doc)).toHaveLength(1);
	});

	it("admits a choice labelled in one language only", () => {
		const doc = survey(select({}));
		translateBlankOption(doc, "Sur");
		expect(labelFindings(doc)).toEqual([]);
		expectAdmittedDoc(doc);
	});

	it("admits a choice with media and no label", () => {
		for (const media of [
			{ image: IMAGE },
			{ audio: IMAGE },
			{ video: IMAGE },
		] satisfies Media[]) {
			expect(labelFindings(survey(select({ media })))).toEqual([]);
		}
	});

	it("reads nothing of a select whose choices come from a lookup table or the worker's cases", () => {
		const lookup = f({
			uuid: FIELD_SPEC_UUID,
			kind: "single_select",
			id: "village",
			label: proseText("Village"),
			optionsSource: {
				kind: "lookup",
				tableId: "018f3e8a-7b2c-7def-8abc-1234567890ab",
				valueColumnId: "018f3e8a-7b2c-7def-8abc-1234567890ad",
				labelColumnId: "018f3e8a-7b2c-7def-8abc-1234567890ae",
			},
		});
		const cases = f({
			uuid: FIELD_SPEC_UUID,
			kind: "single_select",
			id: "village",
			label: proseText("Village"),
			optionsSource: {
				kind: "cases",
				caseType: "household",
				labelProperty: "case_name",
			},
		});
		expect(labelFindings(survey(lookup))).toEqual([]);
		expect(labelFindings(survey(cases, true))).toEqual([]);
	});
});
