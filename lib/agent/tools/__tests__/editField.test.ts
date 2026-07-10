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
import {
	asUuid,
	type BlueprintDoc,
	type Field,
	type Form,
	type Module,
} from "@/lib/domain";
import {
	makeMcpTestContext,
	makeStubToolContext,
} from "../../__tests__/fixtures";
import { editFieldTool } from "../editField";

vi.mock("@/lib/db/apps", () => ({
	completeApp: vi.fn(() => Promise.resolve()),
}));
vi.mock("@/lib/db/applyBlueprintChange", () => ({
	applyBlueprintChange: vi.fn(() => Promise.resolve({ seq: 0 })),
}));

const MOD = asUuid("11111111-1111-1111-1111-111111111111");
const FORM = asUuid("22222222-2222-2222-2222-222222222222");
const FIELD = asUuid("33333333-3333-3333-3333-333333333333");

/** Minimal doc with one input (`text`) field that supports `help`. */
function makeDoc(help?: string): BlueprintDoc {
	const mod: Module = { uuid: MOD, id: "patient", name: "Patient" };
	const form: Form = {
		uuid: FORM,
		id: "enroll",
		name: "Enroll",
		type: "registration",
	};
	const field: Field = {
		uuid: FIELD,
		id: "patient_name",
		kind: "text",
		label: "Patient name",
		...(help !== undefined && { help }),
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
	return field && "help" in field ? field.help : undefined;
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("editField — help text", () => {
	it("sets help text on the field", async () => {
		const { doc, ctx } = { doc: makeDoc(), ...makeStubToolContext() };
		const result = await editFieldTool.execute(
			{
				moduleIndex: 0,
				formIndex: 0,
				fieldId: "patient_name",
				updates: { kind: "text", help: "Enter the patient's full legal name." },
			},
			ctx,
			doc,
		);

		expect(result.kind).toBe("mutate");
		expect(helpOf(result.newDoc)).toBe("Enter the patient's full legal name.");
	});

	it("KEEPS help text when handed null — the wire forces every key, so null must read as untouched", async () => {
		const { doc, ctx } = {
			doc: makeDoc("Existing help"),
			...makeStubToolContext(),
		};
		const result = await editFieldTool.execute(
			{
				moduleIndex: 0,
				formIndex: 0,
				fieldId: "patient_name",
				updates: { kind: "text", label: "Patient name", help: null },
			},
			ctx,
			doc,
		);

		expect(helpOf(result.newDoc)).toBe("Existing help");
	});

	it('clears help text via clear: ["help"] — the explicit removal path', async () => {
		const { doc, ctx } = {
			doc: makeDoc("Existing help"),
			...makeStubToolContext(),
		};
		const result = await editFieldTool.execute(
			{
				moduleIndex: 0,
				formIndex: 0,
				fieldId: "patient_name",
				updates: { kind: "text" },
				clear: ["help"],
			},
			ctx,
			doc,
		);

		expect(helpOf(result.newDoc)).toBeUndefined();
	});

	it("rejects a slot both set and cleared in one call", async () => {
		const { doc, ctx } = {
			doc: makeDoc("Existing help"),
			...makeStubToolContext(),
		};
		const result = await editFieldTool.execute(
			{
				moduleIndex: 0,
				formIndex: 0,
				fieldId: "patient_name",
				updates: { kind: "text", help: "New help" },
				clear: ["help"],
			},
			ctx,
			doc,
		);

		expect(result.result).toMatchObject({
			error: expect.stringContaining("both set"),
		});
		expect(helpOf(result.newDoc)).toBe("Existing help");
	});
});

/* --- Rename identifier guard ----------------------------------------- */

const AGE = asUuid("66666666-6666-6666-6666-666666666666");

/** `makeDoc` plus a second top-level field `age`, so a rename of
 *  `patient_name` → `age` is a sibling-id conflict. */
function makeTwoFieldDoc(): BlueprintDoc {
	const doc = makeDoc();
	const age = { uuid: AGE, id: "age", kind: "int", label: "Age" } as Field;
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
				moduleIndex: 0,
				formIndex: 0,
				fieldId: "patient_name",
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
				moduleIndex: 0,
				formIndex: 0,
				fieldId: "patient_name",
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
				moduleIndex: 0,
				formIndex: 0,
				fieldId: "patient_name",
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
				moduleIndex: 0,
				formIndex: 0,
				fieldId: "patient_name",
				updates: { kind: "text", id: "full_name" },
			},
			ctx,
			makeTwoFieldDoc(),
		);

		expect(result.result).toHaveProperty("message");
		expect(result.newDoc.fields[FIELD]?.id).toBe("full_name");
		expect(recordSpy).toHaveBeenCalledTimes(1);
	});

	it("rejects the same conflicting rename through an McpContext (same guard, both surfaces)", async () => {
		const { ctx } = makeMcpTestContext();
		const recordSpy = vi.spyOn(ctx, "recordMutationStages");
		const result = await editFieldTool.execute(
			{
				moduleIndex: 0,
				formIndex: 0,
				fieldId: "patient_name",
				updates: { kind: "text", id: "age" },
			},
			ctx,
			makeTwoFieldDoc(),
		);

		expect((result.result as { error: string }).error).toContain('"age"');
		expect(recordSpy).not.toHaveBeenCalled();
	});
});

/* --- Wholesale options replacement keeps identity --------------------- */

const SEL = asUuid("77777777-7777-7777-7777-777777777777");
const OPT_YES = asUuid("88888888-8888-8888-8888-888888888888");
const OPT_NO = asUuid("99999999-9999-9999-9999-999999999999");

/** `makeDoc` plus a single-select whose options already carry identity. */
function makeSelectDoc(): BlueprintDoc {
	const doc = makeDoc();
	const select = {
		uuid: SEL,
		id: "consent",
		kind: "single_select",
		label: "Consent",
		options: [
			{ label: "Yes", value: "yes", uuid: OPT_YES, order: "a1" },
			{ label: "No", value: "no", uuid: OPT_NO, order: "a2" },
		],
	} as unknown as Field;
	return {
		...doc,
		fields: { ...doc.fields, [SEL]: select },
		fieldOrder: { [FORM]: [FIELD, SEL] },
		fieldParent: { [FIELD]: FORM, [SEL]: FORM },
	};
}

describe("editField — wholesale options replacement keeps identity", () => {
	it("carries surviving values' uuids forward and keys every option", async () => {
		const { ctx } = makeStubToolContext();
		// The SA replaces the whole list (its wire carries NO uuid/order):
		// "yes" survives with a new label, "no" is dropped, "maybe" is new.
		const result = await editFieldTool.execute(
			{
				moduleIndex: 0,
				formIndex: 0,
				fieldId: "consent",
				updates: {
					kind: "single_select",
					options: [
						{ label: "Yes, agreed", value: "yes" },
						{ label: "Maybe", value: "maybe" },
					],
				},
			},
			ctx,
			makeSelectDoc(),
		);

		expect(result.kind).toBe("mutate");
		const options = (
			result.newDoc.fields[SEL] as unknown as {
				options: Array<{
					label: string;
					value: string;
					uuid?: string;
					order?: string;
				}>;
			}
		).options;
		expect(options).toHaveLength(2);
		// The surviving value keeps its identity — a peer's concurrent granular
		// edit addressed at OPT_YES stays valid, and this tab's own next builder
		// edit to it is visible to the per-uuid option diff.
		expect(options[0]).toMatchObject({ label: "Yes, agreed", value: "yes" });
		expect(options[0]?.uuid).toBe(OPT_YES);
		// The new option minted a fresh uuid; EVERY option carries an order key
		// (a uuid-less/key-less option committed mid-session is invisible to the
		// per-uuid diff until a reload's backfill — the silent-loss class).
		expect(options[1]?.uuid).toBeDefined();
		expect(options[1]?.uuid).not.toBe(OPT_NO);
		for (const opt of options) {
			expect(opt.uuid).toBeDefined();
			expect(opt.order).toBeDefined();
		}
		// The SA's list order is authoritative: fresh ascending keys.
		expect(String(options[0]?.order) < String(options[1]?.order)).toBe(true);
	});
});
