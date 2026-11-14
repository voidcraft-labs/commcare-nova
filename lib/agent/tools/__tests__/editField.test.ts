/**
 * Actual schema-admitted editField calls through the canonical workspace with
 * a controlled host receipt. Tests authored field changes and refusal, not SQL
 * persistence or the external MCP transport.
 *
 * `help` is plain tap-to-expand guidance (distinct from its media
 * companion `help_media`, which the dedicated media tools own). It rides
 * the edit-patch schema's `scalarKeys` path — a schema addition without
 * the matching `editPatchToFieldPatch` `scalarKeys` entry would silently
 * drop the value with no signal, so these tests assert the handler wiring,
 * not just the schema shape:
 *
 *   1. `updates: { help: "..." }` lands `help` on the field.
 *   2. `updates: { help: null }` clears it (the edit path's null-clears
 *      convention).
 */

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import {
	type BlueprintDoc,
	type Field,
	fieldCaseWriteViews,
	type Uuid,
} from "@/lib/domain";
import {
	concat,
	literal,
	matchAll,
	term,
	today,
} from "@/lib/domain/expression";
import { proseTemplateText, proseText } from "@/lib/domain/prose";
import { expectAdmittedDoc } from "../../__tests__/admittedFixture";
import { makeAuthoringHarness } from "../../__tests__/authoringHarness";
import { makeToolWorkspaceHarness } from "../../__tests__/fixtures";
import { editFieldTool } from "../editField";

const MOD = testUuid("11111111-1111-1111-1111-111111111111");
const FORM = testUuid("22222222-2222-2222-2222-222222222222");
const FIELD = testUuid("33333333-3333-3333-3333-333333333333");
const COLUMN = testUuid("44444444-4444-4444-8444-444444444444");
const OWN = testUuid("editField-own-case");

/** Minimal doc with one input (`text`) field that supports `help`. */
function makeDoc(help?: string): BlueprintDoc {
	return expectAdmittedDoc(
		buildDoc({
			appName: "Clinic",
			modules: [
				{
					uuid: MOD,
					id: "patient",
					name: "Patient",
					forms: [
						{
							uuid: FORM,
							id: "enroll",
							name: "Enroll",
							type: "survey",
							fields: [
								f({
									uuid: FIELD,
									id: "patient_name",
									kind: "text",
									label: proseText("Patient name"),
									...(help !== undefined && { help: proseText(help) }),
								}),
							],
						},
					],
				},
			],
		}),
	);
}

/** Read the `help` text off the field in a post-mutation doc. */
function helpOf(doc: BlueprintDoc): string | undefined {
	const field = doc.fields[FIELD];
	return field && "help" in field && field.help
		? proseTemplateText(field.help)
		: undefined;
}

const ADDRESS = { moduleUuid: MOD, formUuid: FORM, fieldUuid: FIELD };

describe("editField — help text", () => {
	it("sets help text on the field", async () => {
		const h = makeToolWorkspaceHarness(expectAdmittedDoc(makeDoc()));
		const result = await h.runTool(editFieldTool, {
			...ADDRESS,
			updates: {
				kind: "text",
				help: proseText("Enter the patient's full legal name."),
			},
		});

		expect(result.kind).toBe("mutate");
		expect(helpOf(h.currentDoc())).toBe("Enter the patient's full legal name.");
	});

	it("KEEPS help text when the slot is left out of the patch", async () => {
		const h = makeToolWorkspaceHarness(makeDoc("Existing help"));
		await h.runTool(editFieldTool, {
			...ADDRESS,
			updates: { kind: "text", label: proseText("Patient name") },
		});

		expect(helpOf(h.currentDoc())).toBe("Existing help");
	});

	it("CLEARS help text when handed null — null removes, omission keeps", async () => {
		const h = makeToolWorkspaceHarness(makeDoc("Existing help"));
		await h.runTool(editFieldTool, {
			...ADDRESS,
			updates: { kind: "text", help: null },
		});

		expect(helpOf(h.currentDoc())).toBeUndefined();
	});
});

/* --- Rename identifier guard ----------------------------------------- */

const AGE = testUuid("66666666-6666-6666-6666-666666666666");

/** `makeDoc` plus a second top-level field `age`, so a rename of
 *  `patient_name` → `age` is a sibling-id conflict. */
function makeTwoFieldDoc(): BlueprintDoc {
	const doc = makeDoc();
	const age: Field = {
		uuid: AGE,
		id: "age",
		kind: "int",
		label: proseText("Age"),
	};
	return {
		...doc,
		fields: { ...doc.fields, [AGE]: age },
		fieldOrder: { [FORM]: [FIELD, AGE] },
		fieldParent: { [FIELD]: FORM, [AGE]: FORM },
	};
}

describe("editField — rename identifier guard", () => {
	it("rejects a rename to a sibling-conflicting id and persists nothing", async () => {
		const doc = makeTwoFieldDoc();
		const h = makeToolWorkspaceHarness(expectAdmittedDoc(doc));
		const result = await h.runTool(editFieldTool, {
			...ADDRESS,
			updates: { kind: "text", id: "age" },
		});

		expect(result.result).toHaveProperty("error");
		expect("error" in result.result && result.result.error).toContain('"age"');
		expect(result.mutations).toHaveLength(0);
		expect(h.recordMutationStages).not.toHaveBeenCalled();
		// Nothing persisted — the doc the SA holds is unchanged.
		expect(h.currentDoc().fields[FIELD]?.id).toBe("patient_name");
	});

	it("rejects a rename to an XML-illegal id", async () => {
		const h = makeToolWorkspaceHarness(expectAdmittedDoc(makeTwoFieldDoc()));
		const result = await h.runTool(editFieldTool, {
			...ADDRESS,
			updates: { kind: "text", id: "patient name" },
		});

		expect("error" in result.result && result.result.error).toContain(
			'"patient name"',
		);
	});

	it("accepts a rename to a name like one Nova generates, since Nova reserves none", async () => {
		const h = makeToolWorkspaceHarness(expectAdmittedDoc(makeTwoFieldDoc()));
		const result = await h.runTool(editFieldTool, {
			...ADDRESS,
			updates: { kind: "text", id: "nova_count_x" },
		});

		expect(result.result).not.toHaveProperty("error");
	});

	it("accepts a legal rename and persists it", async () => {
		const h = makeToolWorkspaceHarness(expectAdmittedDoc(makeTwoFieldDoc()));
		const result = await h.runTool(editFieldTool, {
			...ADDRESS,
			updates: { kind: "text", id: "full_name" },
		});

		expect(result.result).toHaveProperty("ok", true);
		expect(h.currentDoc().fields[FIELD]?.id).toBe("full_name");
		expect(h.recordMutationStages).toHaveBeenCalledTimes(1);
	});

	it("emits independent id and caseWrite changes together in one updateField patch", async () => {
		const doc = structuredClone(makeDoc());
		doc.caseTypes = [
			{
				name: "household",
				properties: [{ name: "case_name", label: proseText("Name") }],
			},
		];
		doc.modules[MOD] = {
			...doc.modules[MOD],
			caseType: "household",
			caseListConfig: {
				columns: [
					{
						uuid: COLUMN,
						kind: "plain",
						field: "case_name",
						header: "Name",
					},
				],
				listColumnOrder: [COLUMN],
				detailColumnOrder: [COLUMN],
				searchInputs: [],
			},
		};
		doc.forms[FORM] = {
			...doc.forms[FORM],
			type: "followup",
			caseOperations: [{ uuid: OWN, id: "household", action: "own" }],
		};
		const h = makeToolWorkspaceHarness(expectAdmittedDoc(doc));
		const result = await h.runTool(editFieldTool, {
			...ADDRESS,
			updates: {
				kind: "text",
				id: "household_name",
				caseWrite: { caseType: "household", property: "case_name" },
			},
		});

		if ("error" in result.result) throw new Error(result.result.error);
		// The id is the question's own slot; where its answer saves is the
		// form's own case, which takes the answer as its name.
		expect(result.mutations).toContainEqual(
			expect.objectContaining({
				kind: "updateField",
				uuid: FIELD,
				patch: expect.objectContaining({ id: "household_name" }),
			}),
		);
		expectAdmittedDoc(h.currentDoc());
		expect(h.currentDoc().fields[FIELD]).toMatchObject({
			id: "household_name",
		});
		expect(h.currentDoc().forms[FORM].caseOperations?.[0]).toMatchObject({
			uuid: OWN,
			name: { kind: "term", term: { kind: "field", uuid: FIELD } },
		});
		expect(fieldCaseWriteViews(h.currentDoc(), FIELD)).toEqual([
			expect.objectContaining({
				caseType: "household",
				property: "case_name",
				destination: "own",
			}),
		]);
	});
});

/* --- A question saving to several places ------------------------------ */

describe("editField: caseWrite on a question saving to several places", () => {
	/** A follow-up whose own case saves the answer to two properties. */
	function twoPlacesDoc(): BlueprintDoc {
		const doc = structuredClone(makeDoc());
		doc.caseTypes = [
			{
				name: "household",
				properties: [
					{ name: "case_name", label: proseText("Name") },
					{ name: "head", label: proseText("Head") },
					{ name: "contact", label: proseText("Contact") },
					{ name: "other", label: proseText("Other") },
				],
			},
		];
		doc.modules[MOD] = {
			...doc.modules[MOD],
			caseType: "household",
			caseListConfig: {
				columns: [
					{ uuid: COLUMN, kind: "plain", field: "case_name", header: "Name" },
				],
				listColumnOrder: [COLUMN],
				detailColumnOrder: [COLUMN],
				searchInputs: [],
			},
		};
		const answer = {
			kind: "term",
			term: { kind: "field", uuid: FIELD },
		} as const;
		doc.forms[FORM] = {
			...doc.forms[FORM],
			type: "followup",
			caseOperations: [
				{
					uuid: OWN,
					id: "household",
					action: "own",
					writes: [
						{ property: "head", value: answer },
						{ property: "contact", value: answer },
					],
				},
			],
		};
		return expectAdmittedDoc(doc);
	}

	it("refuses one destination for every place and stages nothing", async () => {
		const doc = twoPlacesDoc();
		const h = makeToolWorkspaceHarness(doc);
		const result = await h.runTool(editFieldTool, {
			...ADDRESS,
			updates: {
				kind: "text",
				caseWrite: { caseType: "household", property: "other" },
			},
		});

		expect(result.result).toHaveProperty("error");
		expect(result.mutations).toEqual([]);
		expect(h.recordMutationStages).not.toHaveBeenCalled();
		expect(h.currentDoc()).toEqual(doc);
	});

	it("stops every place with null", async () => {
		const h = makeToolWorkspaceHarness(twoPlacesDoc());
		const result = await h.runTool(editFieldTool, {
			...ADDRESS,
			updates: { kind: "text", caseWrite: null },
		});

		if ("error" in result.result) throw new Error(result.result.error);
		expectAdmittedDoc(h.currentDoc());
		expect(fieldCaseWriteViews(h.currentDoc(), FIELD)).toEqual([]);
	});
});

/* --- A capture's case write is its file's link ------------------------ */

const PHOTO = testUuid("55555555-5555-4555-8555-555555555555");

/** A follow-up form on `household` whose second question is an image. */
function makeCaptureDoc(): BlueprintDoc {
	const doc = structuredClone(makeDoc());
	doc.caseTypes = [
		{
			name: "household",
			properties: [
				{ name: "case_name", label: proseText("Name") },
				{ name: "photo", label: proseText("Photo") },
			],
		},
	];
	doc.modules[MOD] = {
		...doc.modules[MOD],
		caseType: "household",
		caseListConfig: {
			columns: [
				{ uuid: COLUMN, kind: "plain", field: "case_name", header: "Name" },
			],
			listColumnOrder: [COLUMN],
			detailColumnOrder: [COLUMN],
			searchInputs: [],
		},
	};
	doc.forms[FORM] = {
		...doc.forms[FORM],
		type: "followup",
		caseOperations: [{ uuid: OWN, id: "household", action: "own" }],
	};
	const photo: Field = {
		uuid: PHOTO,
		id: "photo",
		kind: "image",
		label: proseText("Photo"),
	};
	return expectAdmittedDoc({
		...doc,
		fields: { ...doc.fields, [PHOTO]: photo },
		fieldOrder: { [FORM]: [FIELD, PHOTO] },
		fieldParent: { [FIELD]: FORM, [PHOTO]: FORM },
	});
}

describe("editField: a capture's case write", () => {
	const PHOTO_ADDRESS = { moduleUuid: MOD, formUuid: FORM, fieldUuid: PHOTO };

	it("refuses a `mode` on the write, since a capture always saves its file's link", () => {
		const parsed = editFieldTool.inputSchema.safeParse({
			...PHOTO_ADDRESS,
			updates: {
				kind: "image",
				caseWrite: { caseType: "household", property: "photo", mode: "url" },
			},
		});
		expect(parsed.success).toBe(false);
		expect(parsed.error?.issues).toContainEqual(
			expect.objectContaining({
				code: "unrecognized_keys",
				keys: ["mode"],
				path: ["updates", "caseWrite"],
			}),
		);
	});

	it("saves the plain destination on a capture as the link to its file", async () => {
		const h = makeToolWorkspaceHarness(makeCaptureDoc());
		const result = await h.runTool(editFieldTool, {
			...PHOTO_ADDRESS,
			updates: {
				kind: "image",
				caseWrite: { caseType: "household", property: "photo" },
			},
		});

		if ("error" in result.result) throw new Error(result.result.error);
		expectAdmittedDoc(h.currentDoc());
		expect(fieldCaseWriteViews(h.currentDoc(), PHOTO)).toEqual([
			expect.objectContaining({
				caseType: "household",
				property: "photo",
				link: true,
			}),
		]);
	});
});

/* --- Wholesale options replacement keeps identity --------------------- */

const SEL = testUuid("77777777-7777-7777-7777-777777777777");
const OPT_YES = testUuid("88888888-8888-8888-8888-888888888888");
const OPT_NO = testUuid("99999999-9999-9999-9999-999999999999");

/** `makeDoc` plus a single-select whose options already carry identity. */
function makeSelectDoc(): BlueprintDoc {
	const doc = makeDoc();
	const select: Field = {
		uuid: SEL,
		id: "consent",
		kind: "single_select",
		label: proseText("Consent"),
		optionsSource: {
			kind: "inline",
			options: [
				{ label: proseText("Yes"), value: "yes", uuid: OPT_YES },
				{ label: proseText("No"), value: "no", uuid: OPT_NO },
			],
		},
	};
	return {
		...doc,
		fields: { ...doc.fields, [SEL]: select },
		fieldOrder: { [FORM]: [FIELD, SEL] },
		fieldParent: { [FIELD]: FORM, [SEL]: FORM },
	};
}

describe("editField — wholesale option-source replacement keeps identity", () => {
	it("carries surviving values' uuids forward and identifies every option", async () => {
		const h = makeToolWorkspaceHarness(expectAdmittedDoc(makeSelectDoc()));
		// The SA replaces the whole list and explicitly preserves the UUID of
		// "yes"; "no" is dropped and "maybe" receives a new UUID before commit.
		const result = await h.runTool(editFieldTool, {
			moduleUuid: MOD,
			formUuid: FORM,
			fieldUuid: SEL,
			updates: {
				kind: "single_select",
				optionsSource: {
					kind: "inline",
					options: [
						{
							optionUuid: OPT_YES,
							label: proseText("Yes, agreed"),
							value: "yes",
						},
						{ label: proseText("Maybe"), value: "maybe" },
					],
				},
			},
		});

		expect(result.kind).toBe("mutate");
		expectAdmittedDoc(h.currentDoc());
		const field = h.currentDoc().fields[SEL];
		if (
			field?.kind !== "single_select" ||
			field.optionsSource.kind !== "inline"
		)
			throw new Error("expected inline select");
		const options = field.optionsSource.options;
		expect(options).toHaveLength(2);
		// The explicitly addressed value keeps its identity.
		expect(options[0]).toMatchObject({
			label: proseText("Yes, agreed"),
			value: "yes",
		});
		expect(options[0]?.uuid).toBe(OPT_YES);
		// The new option receives identity before the replacement commits.
		expect(options[1]?.uuid).toBeDefined();
		expect(options[1]?.uuid).not.toBe(OPT_NO);
		for (const opt of options) {
			expect(opt.uuid).toBeDefined();
		}
		if (!("options" in result.result) || result.result.options === undefined) {
			throw new Error("expected inline-option identity receipt");
		}
		expect(result.result.options).toEqual(
			options.map((option) => ({
				uuid: option.uuid,
				value: option.value,
			})),
		);
	});

	it("rejects an option UUID owned by another authored object before commit", async () => {
		const h = makeToolWorkspaceHarness(expectAdmittedDoc(makeSelectDoc()));
		const result = await h.runTool(editFieldTool, {
			moduleUuid: MOD,
			formUuid: FORM,
			fieldUuid: SEL,
			updates: {
				kind: "single_select",
				optionsSource: {
					kind: "inline",
					options: [
						{
							optionUuid: FIELD,
							label: proseText("Captured"),
							value: "captured",
						},
						{ label: proseText("Safe"), value: "safe" },
					],
				},
			},
		});

		expect("error" in result.result && result.result.error).toContain(FIELD);
		expect(result.mutations).toEqual([]);
		expect(h.recordMutationStages).not.toHaveBeenCalled();
	});
});

/* --- Hidden value sources: exactly one of calculate / default_value ---- */

const HIDDEN = testUuid("77777777-7777-7777-7777-777777777777");

/** `makeDoc` plus a top-level field with the given spec (a hidden field with
 *  one value slot, or a text field carrying a `default_value`). */
function makeValueSourceDoc(spec: Parameters<typeof f>[0]): BlueprintDoc {
	return expectAdmittedDoc(
		buildDoc({
			appName: "Clinic",
			modules: [
				{
					uuid: MOD,
					id: "patient",
					name: "Patient",
					forms: [
						{
							uuid: FORM,
							id: "enroll",
							name: "Enroll",
							type: "survey",
							fields: [
								f({
									uuid: FIELD,
									id: "patient_name",
									kind: "text",
									label: proseText("Patient name"),
								}),
								f({ ...spec, uuid: HIDDEN }),
							],
						},
					],
				},
			],
		}),
	);
}

function valueSlotsOf(doc: BlueprintDoc): {
	kind: string | undefined;
	calculate: boolean;
	default_value: boolean;
} {
	const field = doc.fields[HIDDEN];
	return {
		kind: field?.kind,
		calculate: field !== undefined && "calculate" in field,
		default_value: field !== undefined && "default_value" in field,
	};
}

const HIDDEN_ADDRESS = { moduleUuid: MOD, formUuid: FORM, fieldUuid: HIDDEN };

describe("editField — a hidden field carries one value source", () => {
	it("setting calculate on a default-only hidden field clears the default in the same patch and says so", async () => {
		const h = makeToolWorkspaceHarness(
			makeValueSourceDoc({
				id: "stamp",
				kind: "hidden",
				default_value: "today()",
			}),
		);
		const result = await h.runTool(editFieldTool, {
			...HIDDEN_ADDRESS,
			updates: {
				kind: "hidden",
				calculate: concat(term(literal("a")), term(literal("b"))),
			},
		});
		if ("error" in result.result) throw new Error(result.result.error);
		expectAdmittedDoc(h.currentDoc());
		expect(valueSlotsOf(h.currentDoc())).toEqual({
			kind: "hidden",
			calculate: true,
			default_value: false,
		});
		expect(result.result).toMatchObject({
			ok: true,
			valueSource: { set: "calculate", cleared: "default_value" },
		});
		// ONE staged commit: the clear rides the same updateField patch.
		expect(h.recordMutationStages).toHaveBeenCalledTimes(1);
	});

	it("setting default_value on a calculate-only hidden field clears the calculate and says so", async () => {
		const h = makeToolWorkspaceHarness(
			makeValueSourceDoc({
				id: "stamp",
				kind: "hidden",
				calculate: "#form/patient_name",
			}),
		);
		const result = await h.runTool(editFieldTool, {
			...HIDDEN_ADDRESS,
			updates: { kind: "hidden", default_value: today() },
		});
		if ("error" in result.result) throw new Error(result.result.error);
		expectAdmittedDoc(h.currentDoc());
		expect(valueSlotsOf(h.currentDoc())).toEqual({
			kind: "hidden",
			calculate: false,
			default_value: true,
		});
		expect(result.result).toMatchObject({
			ok: true,
			valueSource: { set: "default_value", cleared: "calculate" },
		});
	});

	it("converting text with a default to hidden while setting calculate lands calculate alone", async () => {
		// The conversion carries the source's `default_value` across; without
		// the normalization this one call would leave both slots on the field.
		const h = makeToolWorkspaceHarness(
			makeValueSourceDoc({
				id: "stage",
				kind: "text",
				label: proseText("Stage"),
				default_value: '"intake"',
			}),
		);
		const result = await h.runTool(editFieldTool, {
			...HIDDEN_ADDRESS,
			updates: {
				kind: "hidden",
				calculate: concat(term(literal("a")), term(literal("b"))),
			},
		});
		if ("error" in result.result) throw new Error(result.result.error);
		expectAdmittedDoc(h.currentDoc());
		expect(valueSlotsOf(h.currentDoc())).toEqual({
			kind: "hidden",
			calculate: true,
			default_value: false,
		});
		expect(result.result).toMatchObject({
			ok: true,
			valueSource: { set: "calculate", cleared: "default_value" },
		});
	});

	it("an explicit same-call default_value: null is honored as the one clear, not doubled", async () => {
		const h = makeToolWorkspaceHarness(
			makeValueSourceDoc({
				id: "stamp",
				kind: "hidden",
				default_value: "today()",
			}),
		);
		const result = await h.runTool(editFieldTool, {
			...HIDDEN_ADDRESS,
			updates: {
				kind: "hidden",
				calculate: concat(term(literal("a")), term(literal("b"))),
				default_value: null,
			},
		});
		if ("error" in result.result) throw new Error(result.result.error);
		expectAdmittedDoc(h.currentDoc());
		expect(valueSlotsOf(h.currentDoc())).toEqual({
			kind: "hidden",
			calculate: true,
			default_value: false,
		});
		expect(result.result).toHaveProperty("ok", true);
		// The caller stated the clear; the result adds no inferred side effect.
		expect(result.result).not.toHaveProperty("valueSource");
	});

	it("leaves the held slot alone when the patch touches neither value source", async () => {
		const h = makeToolWorkspaceHarness(
			makeValueSourceDoc({
				id: "stamp",
				kind: "hidden",
				default_value: "today()",
			}),
		);
		const result = await h.runTool(editFieldTool, {
			...HIDDEN_ADDRESS,
			updates: { kind: "hidden", relevant: matchAll() },
		});
		if ("error" in result.result) throw new Error(result.result.error);
		expect(valueSlotsOf(h.currentDoc())).toEqual({
			kind: "hidden",
			calculate: false,
			default_value: true,
		});
		expect(result.result).not.toHaveProperty("valueSource");
	});
});

it("changes repeat modes without replacing its children or retaining the old mode's configuration", async () => {
	const doc = expectAdmittedDoc(
		buildDoc({
			modules: [
				{
					uuid: MOD,
					id: "delivery",
					name: "Delivery",
					forms: [
						{
							uuid: FORM,
							id: "parcels",
							name: "Parcels",
							type: "survey",
							fields: [
								f({
									uuid: FIELD,
									id: "parcels",
									kind: "repeat",
									label: proseText("Parcels"),
									repeat_mode: "count_bound",
									repeat_count: term(literal(2)),
									children: [
										f({
											uuid: AGE,
											id: "quantity",
											kind: "int",
											label: proseText("Quantity"),
										}),
									],
								}),
							],
						},
					],
				},
			],
		}),
	);
	const h = makeToolWorkspaceHarness(doc);
	const child = doc.fields[AGE];
	for (const repeat of [
		{ mode: "user_controlled" as const },
		{ mode: "count_bound" as const, count: term(literal(3)) },
		{ mode: "query_bound" as const, ids_query: term(literal("")) },
		{ mode: "user_controlled" as const },
	]) {
		const result = await h.runTool(editFieldTool, {
			...ADDRESS,
			updates: { kind: "repeat", repeat },
		});
		expect(result.result).not.toHaveProperty("error");
		const current = h.currentDoc();
		expect(current.fields[FIELD]).toMatchObject({
			uuid: FIELD,
			repeat_mode: repeat.mode,
		});
		expect(current.fields[AGE]).toEqual(child);
		expect(current.fieldOrder[FIELD]).toEqual([AGE]);
		if (repeat.mode !== "count_bound")
			expect(current.fields[FIELD]).not.toHaveProperty("repeat_count");
		if (repeat.mode !== "query_bound")
			expect(current.fields[FIELD]).not.toHaveProperty("data_source");
	}
});

/* --- Saving to a case above, only a changed answer, and display flags -- */

const HH_MOD = testUuid("editField-households");
const HH_VISIT = testUuid("editField-household-visit");
const HH_REGISTER = testUuid("editField-household-register");
const VISIT_NOTE = testUuid("editField-visit-village-note");
const VISIT_HIDDEN = testUuid("editField-visit-hidden");
const VISIT_GROUP = testUuid("editField-visit-group");
const VISIT_TEXT = testUuid("editField-visit-text");
const REG_NAME = testUuid("editField-register-name");
const REG_NOTE = testUuid("editField-register-village-note");

/** A household follow-up and registration; a household's parent is a
 *  village, whose `village_note` a question can save through `parent`. */
function makeHouseholdDoc(): BlueprintDoc {
	return expectAdmittedDoc(
		buildDoc({
			appName: "Villages",
			caseTypes: [
				{
					name: "village",
					properties: [{ name: "village_note", label: "Village note" }],
				},
				{
					name: "household",
					parent_type: "village",
					relationship: "child",
					properties: [{ name: "note", label: "Note" }],
				},
			],
			modules: [
				{
					uuid: HH_MOD,
					name: "Households",
					caseType: "household",
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
					forms: [
						{
							uuid: HH_VISIT,
							name: "Visit",
							type: "followup",
							fields: [
								f({ uuid: VISIT_NOTE, kind: "text", id: "village_note" }),
								f({ uuid: VISIT_HIDDEN, kind: "hidden", id: "stamp" }),
								f({
									uuid: VISIT_GROUP,
									kind: "group",
									id: "details",
									label: proseText("Details"),
									fieldList: true,
									children: [
										f({ uuid: VISIT_TEXT, kind: "text", id: "remark" }),
									],
								}),
							],
						},
						{
							uuid: HH_REGISTER,
							name: "Register",
							type: "registration",
							fields: [
								f({
									uuid: REG_NAME,
									kind: "text",
									id: "hh_name",
									caseWrite: { caseType: "household", property: "case_name" },
								}),
								f({ uuid: REG_NOTE, kind: "text", id: "reg_note" }),
							],
						},
					],
				},
			],
		}),
	);
}

const visitAddress = (fieldUuid: Uuid) => ({
	moduleUuid: HH_MOD,
	formUuid: HH_VISIT,
	fieldUuid,
});

/** The own arm's writes of a form, as the document holds them. */
function ownWritesOf(doc: BlueprintDoc, formUuid: Uuid) {
	const own = doc.forms[formUuid]?.caseOperations?.find(
		(operation) => operation.action === "own",
	);
	if (own === undefined) throw new Error("expected the form's own case");
	return own.writes ?? [];
}

describe("editField: caseWrite's via and onlyIfChanged", () => {
	it("saves through via to the case above the form's case", async () => {
		const h = makeToolWorkspaceHarness(makeHouseholdDoc());
		const result = await h.runTool(editFieldTool, {
			...visitAddress(VISIT_NOTE),
			updates: {
				kind: "text",
				caseWrite: {
					caseType: "village",
					property: "village_note",
					via: [{ identifier: "parent" }],
				},
			},
		});

		if ("error" in result.result) throw new Error(result.result.error);
		expectAdmittedDoc(h.currentDoc());
		expect(ownWritesOf(h.currentDoc(), HH_VISIT)).toEqual([
			expect.objectContaining({
				property: "village_note",
				value: { kind: "term", term: { kind: "field", uuid: VISIT_NOTE } },
				via: [{ identifier: "parent" }],
			}),
		]);
		expect(fieldCaseWriteViews(h.currentDoc(), VISIT_NOTE)).toEqual([
			expect.objectContaining({ caseType: "village", destination: "ancestor" }),
		]);
	});

	it("saves only a changed answer on a follow-up", async () => {
		const h = makeToolWorkspaceHarness(makeHouseholdDoc());
		const result = await h.runTool(editFieldTool, {
			...visitAddress(VISIT_NOTE),
			updates: {
				kind: "text",
				caseWrite: {
					caseType: "household",
					property: "note",
					onlyIfChanged: true,
				},
			},
		});

		if ("error" in result.result) throw new Error(result.result.error);
		expectAdmittedDoc(h.currentDoc());
		expect(ownWritesOf(h.currentDoc(), HH_VISIT)).toEqual([
			expect.objectContaining({ property: "note", onlyIfChanged: true }),
		]);
	});

	// The planner admits the write, and the commit gate refuses it: a
	// registration's case has no link to a case above while the form is open.
	it("refuses a via on a registration and stages nothing", async () => {
		const doc = makeHouseholdDoc();
		const h = makeToolWorkspaceHarness(doc);
		const result = await h.runTool(editFieldTool, {
			moduleUuid: HH_MOD,
			formUuid: HH_REGISTER,
			fieldUuid: REG_NOTE,
			updates: {
				kind: "text",
				caseWrite: {
					caseType: "village",
					property: "village_note",
					via: [{ identifier: "parent" }],
				},
			},
		});

		expect(result.result).toHaveProperty("error");
		expect(result.mutations).toEqual([]);
		expect(h.recordMutationStages).not.toHaveBeenCalled();
		expect(h.currentDoc()).toEqual(doc);
	});
});

describe("editField: field_list and plain_label", () => {
	it("refuses plain_label on a hidden field and field_list on a text field", () => {
		const hidden = editFieldTool.inputSchema.safeParse({
			...visitAddress(VISIT_HIDDEN),
			updates: { kind: "hidden", plain_label: true },
		});
		expect(hidden.success).toBe(false);
		expect(hidden.error?.issues).toContainEqual(
			expect.objectContaining({ path: ["updates", "plain_label"] }),
		);

		const text = editFieldTool.inputSchema.safeParse({
			...visitAddress(VISIT_TEXT),
			updates: { kind: "text", field_list: false },
		});
		expect(text.success).toBe(false);
		expect(text.error?.issues).toContainEqual(
			expect.objectContaining({ path: ["updates", "field_list"] }),
		);
	});

	it("clears a group's one screen with null", async () => {
		const doc = makeHouseholdDoc();
		expect(doc.fields[VISIT_GROUP]).toMatchObject({ fieldList: true });
		const h = makeToolWorkspaceHarness(doc);
		const result = await h.runTool(editFieldTool, {
			...visitAddress(VISIT_GROUP),
			updates: { kind: "group", field_list: null },
		});

		if ("error" in result.result) throw new Error(result.result.error);
		expectAdmittedDoc(h.currentDoc());
		expect(h.currentDoc().fields[VISIT_GROUP]).not.toHaveProperty("fieldList");
	});

	it("shows a label exactly as typed with plain_label true, and returns it to Markdown with false", async () => {
		const h = makeToolWorkspaceHarness(makeHouseholdDoc());
		const set = await h.runTool(editFieldTool, {
			...visitAddress(VISIT_TEXT),
			updates: { kind: "text", plain_label: true },
		});
		if ("error" in set.result) throw new Error(set.result.error);
		expectAdmittedDoc(h.currentDoc());
		expect(h.currentDoc().fields[VISIT_TEXT]).toMatchObject({
			plainLabel: true,
		});

		const cleared = await h.runTool(editFieldTool, {
			...visitAddress(VISIT_TEXT),
			updates: { kind: "text", plain_label: false },
		});
		if ("error" in cleared.result) throw new Error(cleared.result.error);
		expect(h.currentDoc().fields[VISIT_TEXT]).not.toHaveProperty("plainLabel");
	});
});

describe("editField: a number keypad and a help text shown as typed", () => {
	it("sets and clears keypad and plain_help, and a read sent back keeps both", async () => {
		const h = makeAuthoringHarness({}, makeHouseholdDoc());
		const address = visitAddress(VISIT_TEXT);
		const set = await h.call("editField", {
			...address,
			updates: {
				kind: "text",
				keypad: "numbers",
				help: "Use *short* words",
				plain_help: true,
			},
		});
		expect(set).toMatchObject({ ok: true });
		expect(h.currentDoc().fields[VISIT_TEXT]).toMatchObject({
			keypad: "numbers",
			plainHelp: true,
		});

		const read = (await h.call("getField", address)) as {
			field: Record<string, unknown>;
		};
		expect(read.field).toMatchObject({ keypad: "numbers", plain_help: true });
		expect(read.field).not.toHaveProperty("plainHelp");
		const resent = await h.call("editField", {
			...address,
			updates: {
				kind: "text",
				keypad: read.field.keypad,
				plain_help: read.field.plain_help,
			},
		});
		expect(resent).toMatchObject({ ok: true });
		expect(h.currentDoc().fields[VISIT_TEXT]).toMatchObject({
			keypad: "numbers",
			plainHelp: true,
		});

		const cleared = await h.call("editField", {
			...address,
			updates: { kind: "text", keypad: null, plain_help: false },
		});
		expect(cleared).toMatchObject({ ok: true });
		expect(h.currentDoc().fields[VISIT_TEXT]).not.toHaveProperty("keypad");
		expect(h.currentDoc().fields[VISIT_TEXT]).not.toHaveProperty("plainHelp");
	});
});

describe("editField: a choice shown as typed survives a read and edit", () => {
	it("reads plain_label on the choice and keeps plainLabel when the read is sent back", async () => {
		const base = makeSelectDoc();
		const select = base.fields[SEL];
		if (
			select?.kind !== "single_select" ||
			select.optionsSource.kind !== "inline"
		)
			throw new Error("expected inline select");
		const doc = expectAdmittedDoc({
			...base,
			fields: {
				...base.fields,
				[SEL]: {
					...select,
					optionsSource: {
						kind: "inline",
						options: select.optionsSource.options.map((option) =>
							option.uuid === OPT_YES
								? { ...option, plainLabel: true as const }
								: option,
						),
					},
				},
			},
		});
		const h = makeAuthoringHarness({}, doc);
		const address = { moduleUuid: MOD, formUuid: FORM, fieldUuid: SEL };
		const read = (await h.call("getField", address)) as {
			field: { optionsSource: { options: Record<string, unknown>[] } };
		};
		expect(read.field.optionsSource.options).toEqual([
			expect.objectContaining({ optionUuid: OPT_YES, plain_label: true }),
			expect.not.objectContaining({ plain_label: expect.anything() }),
		]);

		const result = await h.call("editField", {
			...address,
			updates: {
				kind: "single_select",
				optionsSource: read.field.optionsSource,
			},
		});

		expect(result).toMatchObject({ ok: true });
		const after = h.currentDoc().fields[SEL];
		if (
			after?.kind !== "single_select" ||
			after.optionsSource.kind !== "inline"
		)
			throw new Error("expected inline select");
		expect(after.optionsSource.options).toEqual([
			expect.objectContaining({ uuid: OPT_YES, plainLabel: true }),
			expect.not.objectContaining({ plainLabel: true }),
		]);
	});
});
