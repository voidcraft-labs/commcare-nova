import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig } from "@/lib/__tests__/docHelpers";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { createBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { withChoicePreservation } from "@/lib/doc/kindConversionCascade";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { applyMutations } from "@/lib/doc/mutations";
import { buildReferenceIndex } from "@/lib/doc/referenceIndex";
import { createBlueprintDocStore } from "@/lib/doc/store";
import type { Mutation } from "@/lib/doc/types";
import {
	type BlueprintDoc,
	collectTranslationUnits,
	expressionSlotValues,
	type ProseTemplate,
	type TranslationUnitId,
} from "@/lib/domain";
import { eq, literal, term } from "@/lib/domain/expression/builders";
import type { Choice } from "@/lib/domain/expression/types";
import { walkExpression } from "@/lib/domain/expression/walk";
import { toastStore } from "@/lib/ui/toastStore";
import { assertAdmittedDoc } from "./admittedDoc";

const MODULE = testUuid("preserve-module");
const FORM = testUuid("preserve-form");
const NEXT = testUuid("preserve-next-form");
const SELECT = testUuid("preserve-select");
const READER = testUuid("preserve-reader");
const YES = testUuid("preserve-yes");
const NO = testUuid("preserve-no");
const OP = testUuid("preserve-operation");
const choice: Choice = { kind: "choice", field: SELECT, options: [YES] };
const condition = eq(choice, literal("yes"));

function fixture(): BlueprintDoc {
	return buildDoc({
		caseTypes: [
			{ name: "patient", properties: [{ name: "note", label: "Note" }] },
		],
		modules: [
			{
				uuid: MODULE,
				name: "Patients",
				caseType: "patient",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						uuid: FORM,
						name: "Review",
						type: "followup",
						fields: [
							{
								uuid: SELECT,
								kind: "single_select",
								id: "status",
								options: [
									{ uuid: YES, value: "yes", label: "Yes" },
									{ uuid: NO, value: "no", label: "No" },
								],
							},
							{
								uuid: READER,
								kind: "text",
								id: "note",
								default_value: term(choice),
								relevant: condition,
							},
						],
					},
					{
						uuid: NEXT,
						name: "Next",
						type: "survey",
						fields: [{ kind: "text", id: "details" }],
					},
				],
			},
		],
	});
}
function change(doc: BlueprintDoc, authored: Mutation[]) {
	const planned = withChoicePreservation(doc, authored);
	const next = produce(doc, (draft) => {
		applyMutations(draft, planned.mutations);
	});
	return { ...planned, next };
}
const convert: Mutation = {
	kind: "convertField",
	uuid: SELECT,
	toKind: "text",
};

function choices(doc: BlueprintDoc) {
	let count = 0;
	for (const [entity, values] of [
		["field", doc.fields],
		["form", doc.forms],
		["module", doc.modules],
	] as const) {
		for (const owner of Object.values(values)) {
			for (const { expression } of expressionSlotValues(doc, {
				entity,
				uuid: owner.uuid,
			})) {
				walkExpression(expression, {
					visitTerm: (node) => {
						if (node.kind === "choice") count++;
					},
				});
			}
		}
	}
	return count;
}

const OTHER = testUuid("preserve-other-select");
const OTHER_OPTION = testUuid("preserve-other-option");
const keptCondition = eq(literal("yes"), literal("yes"));

function shown(lead: string): ProseTemplate {
	return {
		parts: [
			{ kind: "text", text: lead },
			{ kind: "value", expression: condition },
		],
	};
}

/** The fixture with a choice read in calculated values of text: the reader's
 *  label, a choice label of another select, and a current Spanish
 *  translation of the reader's label. */
function choiceReadingTexts() {
	const doc = produce(fixture(), (draft) => {
		applyMutations(draft, [
			{
				kind: "updateField",
				uuid: READER,
				targetKind: "text",
				patch: { label: shown("Status ") },
			},
			{
				kind: "addField",
				parentUuid: FORM,
				field: {
					uuid: OTHER,
					id: "follow_up",
					kind: "single_select",
					label: { parts: [{ kind: "text", text: "Follow up" }] },
					optionsSource: {
						kind: "inline",
						options: [
							{ uuid: OTHER_OPTION, value: "soon", label: shown("Soon ") },
						],
					},
				},
			},
			{ kind: "addLanguage", language: { language: "spa" }, wireCode: "es" },
		]);
	});
	const unit = collectTranslationUnits(doc).find(
		(each) =>
			each.role === "field-label" &&
			each.owner.kind === "field" &&
			each.owner.fieldUuid === READER,
	);
	if (unit === undefined) throw new Error("The label has no translation unit.");
	const translated = produce(doc, (draft) => {
		applyMutations(draft, [
			{
				kind: "setTranslation",
				language: "spa",
				unitId: unit.id,
				entry: {
					value: {
						parts: [
							{ kind: "value", expression: condition },
							{ kind: "text", text: " estado" },
						],
					},
					sourceFingerprint: unit.sourceFingerprint,
					origin: "human",
					review: "reviewed",
					translatedFrom: "eng",
				},
			},
		]);
	});
	assertAdmittedDoc(translated);
	return { translated, unit };
}

/** Every choice read of `choiceReadingTexts` is its value, in the source
 *  text and in the Spanish translation, which stays current. */
function expectTextChoicesKept(doc: BlueprintDoc, unitId: TranslationUnitId) {
	expect(choices(doc)).toBe(0);
	expect(doc.fields[READER]).toMatchObject({
		label: {
			parts: [
				{ kind: "text", text: "Status " },
				{ kind: "value", expression: keptCondition },
			],
		},
	});
	expect(doc.fields[OTHER]).toMatchObject({
		optionsSource: {
			options: [
				{
					label: {
						parts: [{}, { kind: "value", expression: keptCondition }],
					},
				},
			],
		},
	});
	// The translation still holds the label's calculated value, so it stays
	// current rather than falling back to the source text.
	const after = collectTranslationUnits(doc).find((each) => each.id === unitId);
	const entry = doc.localization?.translations.spa?.[unitId];
	expect(entry?.sourceFingerprint).toBe(after?.sourceFingerprint);
	expect(entry).toMatchObject({
		review: "reviewed",
		value: {
			parts: [
				{ kind: "value", expression: keptCondition },
				{ kind: "text", text: " estado" },
			],
		},
	});
}

describe("choice preservation during field edits", () => {
	it("keeps surviving values when an inline select becomes text, through the real commit gate", () => {
		const doc = fixture();
		assertAdmittedDoc(doc);
		const planned = withChoicePreservation(doc, [convert]);
		expect(planned.preservedChoiceCount).toBe(2);
		const verdict = mutationCommitVerdict(
			doc,
			planned.mutations,
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		expect(verdict.ok ? [] : verdict.findings).toEqual([]);
		expect(choices(verdict.nextDoc)).toBe(0);
		expect(verdict.nextDoc.fields[READER]).toMatchObject({
			default_value: term(literal("yes")),
			relevant: eq(literal("yes"), literal("yes")),
		});
	});

	it("rewrites admitted field, operation, and Connect carriers", () => {
		const doc = fixture();
		doc.forms[FORM].caseOperations = [
			// The form's own case change stays first.
			...(doc.forms[FORM].caseOperations ?? []),
			{
				uuid: OP,
				id: "save_note",
				action: "update",
				caseType: "patient",
				target: { kind: "session" },
				condition,
				writes: [{ property: "note", value: term(choice), condition }],
			},
		];
		doc.connectType = "deliver";
		// A Connect app runs on Android alone.
		doc.appSettings = { ...doc.appSettings, runsOnlyOn: "android" };
		doc.forms[FORM].connect = {
			deliver_unit: {
				id: "visit",
				name: "Visit",
				entity_id: term(choice),
				entity_name: term(choice),
			},
		};
		doc.refIndex = buildReferenceIndex(doc);
		assertAdmittedDoc(doc);
		const before = choices(doc);
		const planned = change(doc, [convert]);
		expect(before).toBe(7);
		expect(planned.preservedChoiceCount).toBe(before);
		expect(choices(planned.next)).toBe(0);
		const admitted = mutationCommitVerdict(
			doc,
			planned.mutations,
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		expect(admitted.ok ? [] : admitted.findings).toEqual([]);
		expect(
			planned.next.forms[FORM].caseOperations?.find(
				(operation) => operation.uuid === OP,
			)?.writes?.[0],
		).toMatchObject({ property: "note", value: term(literal("yes")) });
	});

	it("rewrites a form's close condition", () => {
		const closeForm = testUuid("preserve-close-form");
		const doc = buildDoc({
			caseTypes: [{ name: "patient", properties: [] }],
			modules: [
				{
					uuid: MODULE,
					name: "Patients",
					caseType: "patient",
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
					forms: [
						{
							uuid: closeForm,
							name: "Discharge",
							type: "close",
							closeCondition: condition,
							fields: [
								{
									uuid: SELECT,
									kind: "single_select",
									id: "status",
									options: [
										{ uuid: YES, value: "yes", label: "Yes" },
										{ uuid: NO, value: "no", label: "No" },
									],
								},
							],
						},
					],
				},
			],
		});
		assertAdmittedDoc(doc);
		const planned = withChoicePreservation(doc, [convert]);
		expect(planned.preservedChoiceCount).toBe(1);
		const verdict = mutationCommitVerdict(
			doc,
			planned.mutations,
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		expect(verdict.ok ? [] : verdict.findings).toEqual([]);
		if (!verdict.ok) return;
		expect(verdict.nextDoc.forms[closeForm]?.closeCondition).toEqual(
			eq(literal("yes"), literal("yes")),
		);
	});

	it("respects a formula replaced in the same batch and preserves a newly authored reader", () => {
		const doc = fixture();
		const added = testUuid("preserve-new-reader");
		const planned = change(doc, [
			convert,
			{
				kind: "updateField",
				uuid: READER,
				targetKind: "text",
				patch: {
					default_value: term(literal("replacement")),
					relevant: undefined,
				},
			},
			{
				kind: "addField",
				parentUuid: FORM,
				field: {
					uuid: added,
					id: "new_note",
					kind: "text",
					label: { parts: [{ kind: "text", text: "New note" }] },
					default_value: term(choice),
				},
			},
		]);
		expect(planned.preservedChoiceCount).toBe(1);
		expect(planned.next.fields[READER]).toMatchObject({
			default_value: term(literal("replacement")),
		});
		expect(planned.next.fields[added]).toMatchObject({
			default_value: term(literal("yes")),
		});
	});

	it("preserves an offered choice when an inline source becomes case-backed", () => {
		const doc = fixture();
		const planned = withChoicePreservation(doc, [
			{
				kind: "updateField",
				uuid: SELECT,
				targetKind: "single_select",
				patch: {
					optionsSource: {
						kind: "cases",
						caseType: "patient",
						labelProperty: "case_name",
					},
				},
			},
		]);
		const verdict = mutationCommitVerdict(
			doc,
			planned.mutations,
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		expect(verdict.ok ? [] : verdict.findings).toEqual([]);
		expect(planned.preservedChoiceCount).toBe(2);
		expect(choices(verdict.nextDoc)).toBe(0);
	});

	it("keeps a choice a calculated value in text reads, in a label, a choice label and the label's current translation", () => {
		// A label, hint, help text, validation message or choice label holds
		// form logic in its calculated values, and the commit gate checks them
		// as it checks a condition: a choice left naming a select with no inline
		// choices would refuse the whole conversion.
		const { translated, unit } = choiceReadingTexts();

		const planned = withChoicePreservation(translated, [convert]);
		expect(planned.preservedChoiceCount).toBe(4);
		const verdict = mutationCommitVerdict(
			translated,
			planned.mutations,
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		expect(verdict.ok ? [] : verdict.findings).toEqual([]);
		if (!verdict.ok) return;
		expectTextChoicesKept(verdict.nextDoc, unit.id);
	});

	it("keeps them in the source text while the builder shows the worker a translation", () => {
		// Under the Spanish lens an edit of a label's wording goes to the
		// Spanish translation. Keeping a choice as its value changes no wording,
		// so the English label and choice label are rewritten in place and the
		// Spanish translation is rewritten with them and stays current.
		const { translated, unit } = choiceReadingTexts();
		const store = createBlueprintDocStore();
		store.getState().load(translated);
		store.getState().startTracking();
		const api = createBlueprintMutations(store, {
			canEdit: true,
			authoringLanguage: "spa",
			lookupCommitState: {
				kind: "unmanaged",
				lookupContext: LOOKUP_CONTEXT_UNAVAILABLE,
			},
		});
		try {
			expect(api.inline.convertField(SELECT, "text")).toEqual({ ok: true });
			expectTextChoicesKept(store.getState(), unit.id);
		} finally {
			toastStore.clear();
		}
	});

	it("leaves inline-source changes and field deletion to their ordinary admission rules", () => {
		const doc = fixture();
		const select = doc.fields[SELECT];
		if (select.kind !== "single_select")
			throw new Error("Fixture requires a select");
		const same = change(doc, [
			{
				kind: "updateField",
				uuid: SELECT,
				targetKind: "single_select",
				patch: { optionsSource: select.optionsSource },
			},
		]);
		expect(same.preservedChoiceCount).toBe(0);
		expect(choices(same.next)).toBe(2);
		const deletion = change(doc, [{ kind: "removeField", uuid: SELECT }]);
		expect(deletion.preservedChoiceCount).toBe(0);
	});
});
