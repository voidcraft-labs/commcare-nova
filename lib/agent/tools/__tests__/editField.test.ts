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
import { makeTestContext } from "../../__tests__/fixtures";
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
