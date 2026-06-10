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
import { makeMcpTestContext, makeTestContext } from "../../__tests__/fixtures";
import { editFieldTool } from "../editField";

vi.mock("@/lib/db/apps", () => ({
	updateApp: vi.fn(() => Promise.resolve()),
	updateAppForRun: vi.fn(() => Promise.resolve()),
	completeApp: vi.fn(() => Promise.resolve()),
}));
vi.mock("@/lib/db/applyBlueprintChange", () => ({
	applyBlueprintChange: vi.fn(() => Promise.resolve()),
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
		const { doc, ctx } = { doc: makeDoc(), ...makeTestContext() };
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

	it("clears help text when handed null", async () => {
		const { doc, ctx } = {
			doc: makeDoc("Existing help"),
			...makeTestContext(),
		};
		const result = await editFieldTool.execute(
			{
				moduleIndex: 0,
				formIndex: 0,
				fieldId: "patient_name",
				updates: { kind: "text", help: null },
			},
			ctx,
			doc,
		);

		expect(helpOf(result.newDoc)).toBeUndefined();
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
		const { ctx } = makeTestContext();
		const recordSpy = vi.spyOn(ctx, "recordMutations");
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
		const { ctx } = makeTestContext();
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
		const { ctx } = makeTestContext();
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
		const { ctx } = makeTestContext();
		const recordSpy = vi.spyOn(ctx, "recordMutations");
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
		const recordSpy = vi.spyOn(ctx, "recordMutations");
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
