/**
 * Behavioral tests for `editField`'s `help` text slot.
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

import { beforeEach, describe, expect, it, vi } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import type { BlueprintDoc, Field, Form, Module } from "@/lib/domain";
import { proseTemplateText, proseText } from "@/lib/domain/prose";
import {
	makeMcpTestContext,
	makeStubToolContext,
} from "../../__tests__/fixtures";
import { editFieldTool } from "../editField";

vi.mock("@/lib/db/apps", () => ({
	completeApp: vi.fn(() => Promise.resolve()),
}));
vi.mock("@/lib/db/applyBlueprintChange", () => ({
	applyBlueprintChange: vi.fn(async (args) => {
		const { commitApplyBlueprintChangeTestBatch } = await import(
			"@/lib/db/__tests__/applyBlueprintChangeTestWriter"
		);
		return commitApplyBlueprintChangeTestBatch(args);
	}),
}));

const MOD = testUuid("11111111-1111-1111-1111-111111111111");
const FORM = testUuid("22222222-2222-2222-2222-222222222222");
const FIELD = testUuid("33333333-3333-3333-3333-333333333333");
const COLUMN = testUuid("44444444-4444-4444-8444-444444444444");

/** Minimal doc with one input (`text`) field that supports `help`. */
function makeDoc(help?: string): BlueprintDoc {
	const mod: Module = { uuid: MOD, id: "patient", name: "Patient" };
	const form: Form = {
		uuid: FORM,
		id: "enroll",
		name: "Enroll",
		type: "survey",
	};
	const field: Field = {
		uuid: FIELD,
		id: "patient_name",
		kind: "text",
		label: proseText("Patient name"),
		...(help !== undefined && { help: proseText(help) }),
	} as Field;
	return {
		appId: "test-app",
		appName: "Clinic",
		connectType: null,
		caseTypes: null,
		modules: { [MOD]: mod },
		forms: { [FORM]: form },
		fields: { [FIELD]: field },
		moduleOrder: [MOD],
		formOrder: { [MOD]: [FORM] },
		fieldOrder: { [FORM]: [FIELD] },
		fieldParent: { [FIELD]: FORM },
	};
}

/** Read the `help` text off the field in a post-mutation doc. */
function helpOf(doc: BlueprintDoc): string | undefined {
	const field = doc.fields[FIELD];
	return field && "help" in field && field.help
		? proseTemplateText(field.help)
		: undefined;
}

const ADDRESS = { moduleUuid: MOD, formUuid: FORM, fieldUuid: FIELD };

beforeEach(() => {
	vi.clearAllMocks();
});

describe("editField — help text", () => {
	it("sets help text on the field", async () => {
		const { doc, ctx } = { doc: makeDoc(), ...makeStubToolContext() };
		const result = await editFieldTool.execute(
			{
				...ADDRESS,
				updates: {
					kind: "text",
					help: proseText("Enter the patient's full legal name."),
				},
			},
			ctx,
			doc,
		);

		expect(result.kind).toBe("mutate");
		expect(helpOf(result.newDoc)).toBe("Enter the patient's full legal name.");
	});

	it("KEEPS help text when the slot is left out of the patch", async () => {
		const { doc, ctx } = {
			doc: makeDoc("Existing help"),
			...makeStubToolContext(),
		};
		const result = await editFieldTool.execute(
			{
				...ADDRESS,
				updates: { kind: "text", label: proseText("Patient name") },
			},
			ctx,
			doc,
		);

		expect(helpOf(result.newDoc)).toBe("Existing help");
	});

	it("CLEARS help text when handed null — null removes, omission keeps", async () => {
		const { doc, ctx } = {
			doc: makeDoc("Existing help"),
			...makeStubToolContext(),
		};
		const result = await editFieldTool.execute(
			{
				...ADDRESS,
				updates: { kind: "text", help: null },
			},
			ctx,
			doc,
		);

		expect(helpOf(result.newDoc)).toBeUndefined();
	});
});

/* --- Rename identifier guard ----------------------------------------- */

const AGE = testUuid("66666666-6666-6666-6666-666666666666");

/** `makeDoc` plus a second top-level field `age`, so a rename of
 *  `patient_name` → `age` is a sibling-id conflict. */
function makeTwoFieldDoc(): BlueprintDoc {
	const doc = makeDoc();
	const age = {
		uuid: AGE,
		id: "age",
		kind: "int",
		label: proseText("Age"),
	} as Field;
	return {
		...doc,
		fields: { ...doc.fields, [AGE]: age },
		fieldOrder: { [FORM]: [FIELD, AGE] },
		fieldParent: { [FIELD]: FORM, [AGE]: FORM },
	};
}

describe("editField — rename identifier guard", () => {
	it("rejects a rename to a sibling-conflicting id and persists nothing", async () => {
		const { ctx } = makeStubToolContext();
		const recordSpy = vi.spyOn(ctx, "recordMutationStages");
		const result = await editFieldTool.execute(
			{
				...ADDRESS,
				updates: { kind: "text", id: "age" },
			},
			ctx,
			makeTwoFieldDoc(),
		);

		expect(result.result).toHaveProperty("error");
		expect((result.result as { error: string }).error).toContain('"age"');
		expect(result.mutations).toHaveLength(0);
		expect(recordSpy).not.toHaveBeenCalled();
		// Nothing persisted — the doc the SA holds is unchanged.
		expect(result.newDoc.fields[FIELD]?.id).toBe("patient_name");
	});

	it("rejects a rename to an XML-illegal id", async () => {
		const { ctx } = makeStubToolContext();
		const result = await editFieldTool.execute(
			{
				...ADDRESS,
				updates: { kind: "text", id: "patient name" },
			},
			ctx,
			makeTwoFieldDoc(),
		);

		expect((result.result as { error: string }).error).toContain(
			'"patient name"',
		);
	});

	it("rejects a rename into the reserved __nova_ namespace", async () => {
		const { ctx } = makeStubToolContext();
		const result = await editFieldTool.execute(
			{
				...ADDRESS,
				updates: { kind: "text", id: "__nova_count_x" },
			},
			ctx,
			makeTwoFieldDoc(),
		);

		expect((result.result as { error: string }).error).toContain("__nova_");
	});

	it("accepts a legal rename and persists it", async () => {
		const { ctx } = makeStubToolContext();
		const recordSpy = vi.spyOn(ctx, "recordMutationStages");
		const result = await editFieldTool.execute(
			{
				...ADDRESS,
				updates: { kind: "text", id: "full_name" },
			},
			ctx,
			makeTwoFieldDoc(),
		);

		expect(result.result).toHaveProperty("message");
		expect(result.newDoc.fields[FIELD]?.id).toBe("full_name");
		expect(recordSpy).toHaveBeenCalledTimes(1);
	});

	it("emits independent id and caseWrite changes together in one post-declaration updateField patch", async () => {
		const { ctx } = makeStubToolContext();
		const doc = makeDoc();
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
		const result = await editFieldTool.execute(
			{
				...ADDRESS,
				updates: {
					kind: "text",
					id: "household_name",
					caseWrite: { caseType: "household", property: "case_name" },
				},
			},
			ctx,
			doc,
		);

		if ("error" in result.result) throw new Error(result.result.error);
		expect(result.mutations).toEqual([
			{ kind: "declareCaseType", caseType: "household" },
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
		expect(
			result.mutations.some(
				(mutation) =>
					mutation.kind === "updateField" &&
					Object.hasOwn(mutation.patch, "id") &&
					Object.hasOwn(mutation.patch, "caseWrite"),
			),
		).toBe(true);
	});

	it("rejects the same conflicting rename through an McpContext (same guard, both surfaces)", async () => {
		const doc = makeTwoFieldDoc();
		const { ctx } = makeMcpTestContext({ initialDoc: doc });
		const recordSpy = vi.spyOn(ctx, "recordMutationStages");
		const result = await editFieldTool.execute(
			{
				...ADDRESS,
				updates: { kind: "text", id: "age" },
			},
			ctx,
			doc,
		);

		expect((result.result as { error: string }).error).toContain('"age"');
		expect(recordSpy).not.toHaveBeenCalled();
	});
});

/* --- Wholesale options replacement keeps identity --------------------- */

const SEL = testUuid("77777777-7777-7777-7777-777777777777");
const OPT_YES = testUuid("88888888-8888-8888-8888-888888888888");
const OPT_NO = testUuid("99999999-9999-9999-9999-999999999999");

/** `makeDoc` plus a single-select whose options already carry identity. */
function makeSelectDoc(): BlueprintDoc {
	const doc = makeDoc();
	const select = {
		uuid: SEL,
		id: "consent",
		kind: "single_select",
		label: proseText("Consent"),
		optionsSource: {
			kind: "inline",
			options: [
				{ label: proseText("Yes"), value: "yes", uuid: OPT_YES, order: "a1" },
				{ label: proseText("No"), value: "no", uuid: OPT_NO, order: "a2" },
			],
		},
	} as unknown as Field;
	return {
		...doc,
		fields: { ...doc.fields, [SEL]: select },
		fieldOrder: { [FORM]: [FIELD, SEL] },
		fieldParent: { [FIELD]: FORM, [SEL]: FORM },
	};
}

describe("editField — wholesale option-source replacement keeps identity", () => {
	it("carries surviving values' uuids forward and identifies every option", async () => {
		const { ctx } = makeStubToolContext();
		// The SA replaces the whole list and explicitly preserves the UUID of
		// "yes"; "no" is dropped and "maybe" receives a new UUID before commit.
		const result = await editFieldTool.execute(
			{
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
			},
			ctx,
			makeSelectDoc(),
		);

		expect(result.kind).toBe("mutate");
		const options = (
			result.newDoc.fields[SEL] as unknown as {
				optionsSource: {
					kind: "inline";
					options: Array<{
						label: ReturnType<typeof proseText>;
						value: string;
						uuid: string;
					}>;
				};
			}
		).optionsSource.options;
		expect(options).toHaveLength(2);
		// The explicitly addressed value keeps its identity — a peer's
		// concurrent granular edit addressed at OPT_YES stays valid.
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
		const { ctx, recordMutationStages } = makeStubToolContext();
		const result = await editFieldTool.execute(
			{
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
			},
			ctx,
			makeSelectDoc(),
		);

		expect("error" in result.result && result.result.error).toContain(FIELD);
		expect(result.mutations).toEqual([]);
		expect(recordMutationStages).not.toHaveBeenCalled();
	});
});
