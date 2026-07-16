/**
 * `editField` kind-conversion behavior — the string-compatible tier.
 *
 * The conversion contract these tests pin:
 *
 *   - converting INTO a select kind requires `options` in the SAME call;
 *     they ride the `convertField` mutation itself (a post-convert patch
 *     can't help — the convert would already have no-opped), and are
 *     consumed there, never double-applied by the patch stage;
 *   - a seedless select conversion is refused with a message naming the
 *     same-call fix, persisting nothing;
 *   - text → hidden works when the same call provides the `calculate`
 *     (or the source carries a `default_value`), and is otherwise
 *     rejected by the commit gate's `HIDDEN_NO_VALUE` — with nothing
 *     persisted either way on failure;
 *   - the demotions (barcode → text, single_select → text) carry the
 *     survivable slots and drop the rest.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { backfillOrderKeys } from "@/lib/doc/order/backfill";
import type { BlueprintDoc, SelectOption } from "@/lib/domain";
import { makeStubToolContext } from "../../__tests__/fixtures";
import { editFieldTool } from "../editField";

vi.mock("@/lib/db/apps", () => ({
	completeApp: vi.fn(() => Promise.resolve()),
}));
vi.mock("@/lib/db/applyBlueprintChange", () => ({
	applyBlueprintChange: vi.fn(() => Promise.resolve({ seq: 0 })),
}));

function makeDoc(field: Parameters<typeof f>[0]): BlueprintDoc {
	const doc = buildDoc({
		modules: [
			{
				name: "Clinic",
				forms: [
					{
						name: "Encounter",
						type: "survey",
						fields: [f(field)],
					},
				],
			},
		],
	});
	backfillOrderKeys(doc);
	return doc;
}

function soleField(doc: BlueprintDoc, id: string) {
	const field = Object.values(doc.fields).find((fld) => fld.id === id);
	if (!field) throw new Error(`fixture field "${id}" missing`);
	return field;
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("editField — convert to single_select", () => {
	it("lands the conversion with same-call options riding the convertField mutation", async () => {
		const doc = makeDoc({
			id: "facility",
			kind: "text",
			label: "Specialist facility",
		});
		const { ctx } = makeStubToolContext();
		const result = await editFieldTool.execute(
			{
				moduleIndex: 0,
				formIndex: 0,
				fieldId: "facility",
				updates: {
					kind: "single_select",
					options: [
						{ value: "clinic_a", label: "Clinic A" },
						{ value: "clinic_b", label: "Clinic B" },
					],
				},
			},
			ctx,
			doc,
		);
		if ("error" in result.result) throw new Error(result.result.error);

		const after = result.newDoc.fields[soleField(doc, "facility").uuid];
		expect(after?.kind).toBe("single_select");
		const options = (after as { options?: SelectOption[] }).options ?? [];
		expect(options.map((o) => o.value)).toEqual(["clinic_a", "clinic_b"]);
		// Identity minted at the batch-building layer — every landed option
		// carries a uuid + order key, so the per-uuid option diff and a
		// peer's granular option edits address them immediately.
		for (const opt of options) {
			expect(opt.uuid).toBeTruthy();
			expect(opt.order).toBeTruthy();
		}

		// The options were CONSUMED into the convertField mutation — one
		// carrier, no second updateField application of the same list.
		const convertMuts = result.mutations.filter(
			(m) => m.kind === "convertField",
		);
		expect(convertMuts).toHaveLength(1);
		expect(
			convertMuts[0] && "options" in convertMuts[0]
				? convertMuts[0].options?.length
				: 0,
		).toBe(2);
		const optionPatches = result.mutations.filter(
			(m) => m.kind === "updateField" && "options" in m.patch,
		);
		expect(optionPatches).toHaveLength(0);
	});

	it("refuses a seedless select conversion, naming the same-call fix", async () => {
		const doc = makeDoc({ id: "facility", kind: "text", label: "Facility" });
		const { ctx, recordMutationStages } = makeStubToolContext();
		const result = await editFieldTool.execute(
			{
				moduleIndex: 0,
				formIndex: 0,
				fieldId: "facility",
				updates: { kind: "single_select" },
			},
			ctx,
			doc,
		);
		if (!("error" in result.result)) throw new Error("expected error");
		expect(result.result.error).toContain("options");
		expect(result.result.error).toContain("same call");
		expect(recordMutationStages).not.toHaveBeenCalled();
	});

	it("refuses a one-option seed (the select schemas need at least 2)", async () => {
		const doc = makeDoc({ id: "facility", kind: "text", label: "Facility" });
		const { ctx, recordMutationStages } = makeStubToolContext();
		const result = await editFieldTool.execute(
			{
				moduleIndex: 0,
				formIndex: 0,
				fieldId: "facility",
				updates: {
					kind: "single_select",
					options: [{ value: "only", label: "Only" }],
				},
			},
			ctx,
			doc,
		);
		if (!("error" in result.result)) throw new Error("expected error");
		expect(result.result.error).toContain("at least 2");
		expect(recordMutationStages).not.toHaveBeenCalled();
	});
});

describe("editField — convert to hidden", () => {
	it("lands text → hidden when the same call brings the calculate", async () => {
		const doc = makeDoc({
			id: "full_name",
			kind: "text",
			label: "Full name",
			hint: "first and last",
		});
		const { ctx } = makeStubToolContext();
		const result = await editFieldTool.execute(
			{
				moduleIndex: 0,
				formIndex: 0,
				fieldId: "full_name",
				updates: { kind: "hidden", calculate: 'concat("a", " ", "b")' },
			},
			ctx,
			doc,
		);
		if ("error" in result.result) throw new Error(result.result.error);
		const after = result.newDoc.fields[soleField(doc, "full_name").uuid];
		expect(after?.kind).toBe("hidden");
		expect((after as { calculate?: unknown }).calculate).toBeDefined();
		expect((after as { label?: unknown }).label).toBeUndefined();
		expect((after as { hint?: unknown }).hint).toBeUndefined();
	});

	it("gate-rejects text → hidden with neither calculate nor default_value, persisting nothing", async () => {
		const doc = makeDoc({ id: "full_name", kind: "text", label: "Full name" });
		const { ctx, recordMutationStages } = makeStubToolContext();
		const result = await editFieldTool.execute(
			{
				moduleIndex: 0,
				formIndex: 0,
				fieldId: "full_name",
				updates: { kind: "hidden" },
			},
			ctx,
			doc,
		);
		if (!("error" in result.result)) throw new Error("expected error");
		// The commit gate's HIDDEN_NO_VALUE finding carries the fix.
		expect(result.result.error).toMatch(/calculate|default_value/);
		expect(recordMutationStages).not.toHaveBeenCalled();
		expect(result.newDoc).toBe(doc);
	});

	it("lands text → hidden on a source default_value alone", async () => {
		const doc = makeDoc({
			id: "visit_stage",
			kind: "text",
			label: "Stage",
			default_value: '"intake"',
		});
		const { ctx } = makeStubToolContext();
		const result = await editFieldTool.execute(
			{
				moduleIndex: 0,
				formIndex: 0,
				fieldId: "visit_stage",
				updates: { kind: "hidden" },
			},
			ctx,
			doc,
		);
		if ("error" in result.result) throw new Error(result.result.error);
		const after = result.newDoc.fields[soleField(doc, "visit_stage").uuid];
		expect(after?.kind).toBe("hidden");
		expect((after as { default_value?: unknown }).default_value).toBeDefined();
	});
});

describe("editField — demotions", () => {
	it("barcode → text and text → barcode round-trip the shared slots", async () => {
		const doc = makeDoc({
			id: "sample_id",
			kind: "barcode",
			label: "Sample",
			hint: "scan the vial",
		});
		const { ctx } = makeStubToolContext();
		const result = await editFieldTool.execute(
			{
				moduleIndex: 0,
				formIndex: 0,
				fieldId: "sample_id",
				updates: { kind: "text" },
			},
			ctx,
			doc,
		);
		if ("error" in result.result) throw new Error(result.result.error);
		const after = result.newDoc.fields[soleField(doc, "sample_id").uuid];
		expect(after?.kind).toBe("text");
		expect((after as { hint?: string }).hint).toBe("scan the vial");
	});

	it("single_select → text drops the options and keeps the rest", async () => {
		const doc = makeDoc({
			id: "status",
			kind: "single_select",
			label: "Status",
			options: [
				{ value: "open", label: "Open" },
				{ value: "closed", label: "Closed" },
			],
		});
		const { ctx } = makeStubToolContext();
		const result = await editFieldTool.execute(
			{
				moduleIndex: 0,
				formIndex: 0,
				fieldId: "status",
				updates: { kind: "text" },
			},
			ctx,
			doc,
		);
		if ("error" in result.result) throw new Error(result.result.error);
		const after = result.newDoc.fields[soleField(doc, "status").uuid];
		expect(after?.kind).toBe("text");
		expect((after as { options?: unknown }).options).toBeUndefined();
		expect((after as { label?: string }).label).toBe("Status");
	});

	it("single ↔ multi conversions keep the existing verbatim-options path (no seed consumed)", async () => {
		const doc = makeDoc({
			id: "symptoms",
			kind: "single_select",
			label: "Symptoms",
			options: [
				{ value: "fever", label: "Fever" },
				{ value: "cough", label: "Cough" },
			],
		});
		const { ctx } = makeStubToolContext();
		const result = await editFieldTool.execute(
			{
				moduleIndex: 0,
				formIndex: 0,
				fieldId: "symptoms",
				updates: { kind: "multi_select" },
			},
			ctx,
			doc,
		);
		if ("error" in result.result) throw new Error(result.result.error);
		const after = result.newDoc.fields[soleField(doc, "symptoms").uuid];
		expect(after?.kind).toBe("multi_select");
		const convertMut = result.mutations.find((m) => m.kind === "convertField");
		expect(
			convertMut && "options" in convertMut ? convertMut.options : undefined,
		).toBeUndefined();
		expect(
			((after as { options?: SelectOption[] }).options ?? []).map(
				(o) => o.value,
			),
		).toEqual(["fever", "cough"]);
	});
});
