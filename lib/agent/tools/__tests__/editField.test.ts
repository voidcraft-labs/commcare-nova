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
import { buildDoc, f, xp } from "@/lib/__tests__/docHelpers";
import type { BlueprintDoc, Field } from "@/lib/domain";
import { proseTemplateText, proseText } from "@/lib/domain/prose";
import { expectAdmittedDoc } from "../../__tests__/admittedFixture";
import { makeToolWorkspaceHarness } from "../../__tests__/fixtures";
import { editFieldTool } from "../editField";

const MOD = testUuid("11111111-1111-1111-1111-111111111111");
const FORM = testUuid("22222222-2222-2222-2222-222222222222");
const FIELD = testUuid("33333333-3333-3333-3333-333333333333");
const COLUMN = testUuid("44444444-4444-4444-8444-444444444444");

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

	it("rejects a rename into the reserved __nova_ namespace", async () => {
		const h = makeToolWorkspaceHarness(expectAdmittedDoc(makeTwoFieldDoc()));
		const result = await h.runTool(editFieldTool, {
			...ADDRESS,
			updates: { kind: "text", id: "__nova_count_x" },
		});

		expect("error" in result.result && result.result.error).toContain(
			"__nova_",
		);
	});

	it("accepts a legal rename and persists it", async () => {
		const h = makeToolWorkspaceHarness(expectAdmittedDoc(makeTwoFieldDoc()));
		const result = await h.runTool(editFieldTool, {
			...ADDRESS,
			updates: { kind: "text", id: "full_name" },
		});

		expect(result.result).toHaveProperty("message");
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
		expect(result.mutations).toEqual([
			{
				kind: "updateField",
				uuid: FIELD,
				targetKind: "text",
				patch: {
					id: "household_name",
					caseWrite: { caseType: "household", property: "case_name" },
				},
			},
		]);
		expectAdmittedDoc(h.currentDoc());
		expect(h.currentDoc().fields[FIELD]).toMatchObject({
			id: "household_name",
			caseWrite: { caseType: "household", property: "case_name" },
		});
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
			updates: { kind: "hidden", calculate: xp("concat('a', 'b')") },
		});
		if ("error" in result.result) throw new Error(result.result.error);
		expectAdmittedDoc(h.currentDoc());
		expect(valueSlotsOf(h.currentDoc())).toEqual({
			kind: "hidden",
			calculate: true,
			default_value: false,
		});
		expect(result.result.message).toContain(
			"Changed: calculate, default_value (cleared).",
		);
		expect(result.result.message).toContain(
			"Set calculate and cleared default_value",
		);
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
			updates: { kind: "hidden", default_value: xp("today()") },
		});
		if ("error" in result.result) throw new Error(result.result.error);
		expectAdmittedDoc(h.currentDoc());
		expect(valueSlotsOf(h.currentDoc())).toEqual({
			kind: "hidden",
			calculate: false,
			default_value: true,
		});
		expect(result.result.message).toContain(
			"Changed: default_value, calculate (cleared).",
		);
		expect(result.result.message).toContain(
			"Set default_value and cleared calculate",
		);
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
			updates: { kind: "hidden", calculate: xp("concat('a', 'b')") },
		});
		if ("error" in result.result) throw new Error(result.result.error);
		expectAdmittedDoc(h.currentDoc());
		expect(valueSlotsOf(h.currentDoc())).toEqual({
			kind: "hidden",
			calculate: true,
			default_value: false,
		});
		expect(result.result.message).toContain("default_value (cleared)");
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
				calculate: xp("concat('a', 'b')"),
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
		expect(result.result.message).toContain(
			"Changed: calculate, default_value (cleared).",
		);
		// The caller stated the clear; the tool adds no second note for it.
		expect(result.result.message).not.toContain("Set calculate and cleared");
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
			updates: { kind: "hidden", relevant: xp("true()") },
		});
		if ("error" in result.result) throw new Error(result.result.error);
		expect(valueSlotsOf(h.currentDoc())).toEqual({
			kind: "hidden",
			calculate: false,
			default_value: true,
		});
		expect(result.result.message).not.toContain("cleared");
	});
});
