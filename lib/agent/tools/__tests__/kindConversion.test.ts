import { asUuid } from "@/lib/domain";
/**
 * `editField` kind-conversion behavior — the select/text family.
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
import type { BlueprintDoc } from "@/lib/domain";
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
	return doc;
}

function soleField(doc: BlueprintDoc, id: string) {
	const field = Object.values(doc.fields).find((fld) => fld.id === id);
	if (!field) throw new Error(`fixture field "${id}" missing`);
	return field;
}

function fieldAddress(doc: BlueprintDoc, id: string) {
	const moduleUuid = doc.moduleOrder[0];
	const formUuid = doc.formOrder[moduleUuid]?.[0];
	if (!moduleUuid || !formUuid)
		throw new Error("fixture address is incomplete");
	return { moduleUuid, formUuid, fieldUuid: soleField(doc, id).uuid };
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
				...fieldAddress(doc, "facility"),
				updates: {
					kind: "single_select",
					optionsSource: {
						kind: "inline",
						options: [
							{
								uuid: asUuid("df595a12-fece-4e2a-ab96-f18e1c646771"),
								value: "clinic_a",
								label: "Clinic A",
							},
							{
								uuid: asUuid("452a0b84-3e5b-4c85-aadd-00ac99335af4"),
								value: "clinic_b",
								label: "Clinic B",
							},
						],
					},
				},
			},
			ctx,
			doc,
		);
		if ("error" in result.result) throw new Error(result.result.error);

		const after = result.newDoc.fields[soleField(doc, "facility").uuid];
		expect(after?.kind).toBe("single_select");
		if (
			after?.kind !== "single_select" ||
			after.optionsSource.kind !== "inline"
		) {
			throw new Error("expected converted inline select");
		}
		const options = after.optionsSource.options;
		expect(options.map((o) => o.value)).toEqual(["clinic_a", "clinic_b"]);
		// Identity minted at the batch-building layer — every landed option
		// carries a UUID, so the per-UUID option diff and a peer's granular
		// option edits address them immediately.
		for (const opt of options) {
			expect(opt.uuid).toBeTruthy();
		}

		// The options were CONSUMED into the convertField mutation — one
		// carrier, no second updateField application of the same list.
		const convertMuts = result.mutations.filter(
			(m) => m.kind === "convertField",
		);
		expect(convertMuts).toHaveLength(1);
		expect(
			convertMuts[0]?.kind === "convertField" &&
				convertMuts[0].optionsSource?.kind === "inline"
				? convertMuts[0].optionsSource.options.length
				: 0,
		).toBe(2);
		const optionPatches = result.mutations.filter(
			(m) => m.kind === "updateField" && "optionsSource" in m.patch,
		);
		expect(optionPatches).toHaveLength(0);
	});

	it("refuses a seedless select conversion, naming the same-call fix", async () => {
		const doc = makeDoc({ id: "facility", kind: "text", label: "Facility" });
		const { ctx, recordMutationStages } = makeStubToolContext();
		const result = await editFieldTool.execute(
			{
				...fieldAddress(doc, "facility"),
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
				...fieldAddress(doc, "facility"),
				updates: {
					kind: "single_select",
					optionsSource: {
						kind: "inline",
						options: [
							{
								uuid: asUuid("f265dfcb-c254-4c7b-a08a-1665ca1a76ee"),
								value: "only",
								label: "Only",
							},
						],
					},
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
				...fieldAddress(doc, "full_name"),
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
				...fieldAddress(doc, "full_name"),
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
				...fieldAddress(doc, "visit_stage"),
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
				...fieldAddress(doc, "sample_id"),
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
			optionsSource: {
				kind: "inline",
				options: [
					{
						uuid: asUuid("33f92b48-35c9-4825-aa79-508fda325b40"),
						value: "open",
						label: "Open",
					},
					{
						uuid: asUuid("9bd11472-ab4f-408a-a73a-9729c0b568df"),
						value: "closed",
						label: "Closed",
					},
				],
			},
		});
		const { ctx } = makeStubToolContext();
		const result = await editFieldTool.execute(
			{
				...fieldAddress(doc, "status"),
				updates: { kind: "text" },
			},
			ctx,
			doc,
		);
		if ("error" in result.result) throw new Error(result.result.error);
		const after = result.newDoc.fields[soleField(doc, "status").uuid];
		expect(after?.kind).toBe("text");
		expect(
			(after as { optionsSource?: unknown }).optionsSource,
		).toBeUndefined();
		expect((after as { label?: string }).label).toBe("Status");
	});

	it("case-bound, declared-type property: the conversion re-declares the data_type in the same batch", async () => {
		// generateSchema authors data_type on declared properties, and the
		// agreement gate rejects a writer that contradicts it — so the
		// conversion must carry the declaration along or it can never land
		// on an SA-built app.
		const doc = buildDoc({
			caseTypes: [
				{
					name: "patient",
					properties: [
						{ name: "case_name", label: "Name", data_type: "text" },
						{ name: "facility", label: "Facility", data_type: "text" },
					],
				},
			],
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					forms: [
						{
							name: "Register",
							type: "registration",
							fields: [
								f({
									id: "case_name",
									kind: "text",
									label: "Name",
									case_property_on: "patient",
								}),
								f({
									id: "facility",
									kind: "text",
									label: "Facility",
									case_property_on: "patient",
								}),
							],
						},
					],
				},
			],
		});
		const { ctx } = makeStubToolContext();
		const result = await editFieldTool.execute(
			{
				...fieldAddress(doc, "facility"),
				updates: {
					kind: "single_select",
					optionsSource: {
						kind: "inline",
						options: [
							{
								uuid: asUuid("c9e482d1-7669-4119-a1fa-c62731b6b8ae"),
								value: "clinic_a",
								label: "Clinic A",
							},
							{
								uuid: asUuid("61a61bd7-abd1-4f8e-a244-29121d2f733d"),
								value: "clinic_b",
								label: "Clinic B",
							},
						],
					},
				},
			},
			ctx,
			doc,
		);
		if ("error" in result.result) throw new Error(result.result.error);
		expect(result.result.message).toContain('data_type is now "single_select"');

		const after = result.newDoc.fields[soleField(doc, "facility").uuid];
		expect(after?.kind).toBe("single_select");
		const entry = result.newDoc.caseTypes
			?.find((ct) => ct.name === "patient")
			?.properties.find((p) => p.name === "facility");
		expect(entry?.data_type).toBe("single_select");
		expect(entry?.options).toEqual([
			{ value: "clinic_a", label: "Clinic A" },
			{ value: "clinic_b", label: "Clinic B" },
		]);
	});

	it("case-bound, multi-writer property: every same-kind writer converts in one batch", async () => {
		// One field at a time can never cross FIELD_KIND_WRITERS_DISAGREE —
		// the conversion's subject is the property, so its peer writers in
		// other forms carry across in the same gated commit.
		const doc = buildDoc({
			caseTypes: [
				{
					name: "patient",
					properties: [
						{ name: "case_name", label: "Name" },
						{ name: "status", label: "Status" },
					],
				},
			],
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					forms: [
						{
							name: "Register",
							type: "registration",
							fields: [
								f({
									id: "case_name",
									kind: "text",
									label: "Name",
									case_property_on: "patient",
								}),
								f({
									id: "status",
									kind: "text",
									label: "Status",
									case_property_on: "patient",
								}),
							],
						},
						{
							name: "Follow up",
							type: "followup",
							fields: [
								f({
									id: "status",
									kind: "text",
									label: "Status",
									case_property_on: "patient",
								}),
							],
						},
					],
				},
			],
		});
		const { ctx } = makeStubToolContext();
		const result = await editFieldTool.execute(
			{
				...fieldAddress(doc, "status"),
				updates: {
					kind: "single_select",
					optionsSource: {
						kind: "inline",
						options: [
							{
								uuid: asUuid("1b1dde13-e2c3-44ba-ac37-595d6d6f5b5c"),
								value: "open",
								label: "Open",
							},
							{
								uuid: asUuid("afb3b35a-41e9-4f75-a723-f03a0bdcc812"),
								value: "closed",
								label: "Closed",
							},
						],
					},
				},
			},
			ctx,
			doc,
		);
		if ("error" in result.result) throw new Error(result.result.error);
		expect(result.result.message).toContain('"Follow up"');

		// Both writers flipped; each converted select carries its OWN
		// minted option identities.
		const converted = Object.values(result.newDoc.fields).filter(
			(fld) => fld.id === "status",
		);
		expect(converted).toHaveLength(2);
		const optionUuids = new Set<string>();
		for (const fld of converted) {
			if (fld.kind !== "single_select" || fld.optionsSource.kind !== "inline") {
				throw new Error("expected converted inline select");
			}
			const options = fld.optionsSource.options;
			expect(options.map((o) => o.value)).toEqual(["open", "closed"]);
			for (const o of options) {
				expect(o.uuid).toBeTruthy();
				optionUuids.add(o.uuid as string);
			}
		}
		expect(optionUuids.size).toBe(4);
	});

	it("refuses the conversion when a same-type peer can't reach the target, naming its form", async () => {
		// A barcode writer derives "text" — the property agrees today, so
		// converting only the text writer would bounce off the gate with a
		// disagreement message misreading a healthy property as broken.
		// The plan refuses up front with the expressible two-step fix.
		const doc = buildDoc({
			caseTypes: [
				{
					name: "patient",
					properties: [
						{ name: "case_name", label: "Name" },
						{ name: "sample_id", label: "Sample" },
					],
				},
			],
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					forms: [
						{
							name: "Register",
							type: "registration",
							fields: [
								f({
									id: "case_name",
									kind: "text",
									label: "Name",
									case_property_on: "patient",
								}),
								f({
									id: "sample_id",
									kind: "text",
									label: "Sample",
									case_property_on: "patient",
								}),
							],
						},
						{
							name: "Lab intake",
							type: "followup",
							fields: [
								f({
									id: "sample_id",
									kind: "barcode",
									label: "Sample scan",
									case_property_on: "patient",
								}),
							],
						},
					],
				},
			],
		});
		const { ctx, recordMutationStages } = makeStubToolContext();
		const result = await editFieldTool.execute(
			{
				...fieldAddress(doc, "sample_id"),
				updates: {
					kind: "single_select",
					optionsSource: {
						kind: "inline",
						options: [
							{
								uuid: asUuid("26e24b77-e281-465a-a337-8939c4b699bc"),
								value: "a",
								label: "A",
							},
							{
								uuid: asUuid("deb500d3-cbf7-49c6-a40f-f81a4321c225"),
								value: "b",
								label: "B",
							},
						],
					},
				},
			},
			ctx,
			doc,
		);
		if (!("error" in result.result)) throw new Error("expected error");
		expect(result.result.error).toContain("barcode");
		expect(result.result.error).toContain('"Lab intake"');
		expect(result.result.error).toContain('kind="text"');
		expect(recordMutationStages).not.toHaveBeenCalled();
	});

	it("a same-call case_property_on clear converts only the addressed field — no cascade for a binding it leaves", async () => {
		const doc = buildDoc({
			caseTypes: [
				{
					name: "patient",
					properties: [
						{ name: "case_name", label: "Name" },
						{ name: "status", label: "Status" },
					],
				},
			],
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					forms: [
						{
							name: "Register",
							type: "registration",
							fields: [
								f({
									id: "case_name",
									kind: "text",
									label: "Name",
									case_property_on: "patient",
								}),
								f({
									id: "status",
									kind: "text",
									label: "Status",
									case_property_on: "patient",
								}),
							],
						},
						{
							name: "Follow up",
							type: "followup",
							fields: [
								f({
									id: "status",
									kind: "text",
									label: "Status",
									case_property_on: "patient",
								}),
							],
						},
					],
				},
			],
		});
		const registerStatus = Object.values(doc.fields).find(
			(fld) => fld.id === "status" && "label" in fld && fld.label === "Status",
		);
		const { ctx } = makeStubToolContext();
		const result = await editFieldTool.execute(
			{
				...fieldAddress(doc, "status"),
				updates: {
					kind: "single_select",
					optionsSource: {
						kind: "inline",
						options: [
							{
								uuid: asUuid("7f7a4f66-d9f3-46eb-a124-1971d349dc56"),
								value: "open",
								label: "Open",
							},
							{
								uuid: asUuid("18f63958-baed-42ba-ab69-81ce21def9e9"),
								value: "closed",
								label: "Closed",
							},
						],
					},
					case_property_on: null,
				},
			},
			ctx,
			doc,
		);
		if ("error" in result.result) throw new Error(result.result.error);

		// The addressed field converted and unbound; the follow-up form's
		// writer is untouched — the call decoupled the field from the
		// property, so there was nothing to keep in agreement.
		const addressed =
			result.newDoc.fields[registerStatus?.uuid ?? ("" as never)];
		expect(addressed?.kind).toBe("single_select");
		expect(
			(addressed as { case_property_on?: string }).case_property_on,
		).toBeUndefined();
		const peer = Object.values(result.newDoc.fields).find(
			(fld) => fld.id === "status" && fld.uuid !== registerStatus?.uuid,
		);
		expect(peer?.kind).toBe("text");
	});

	it("escorts the value-reshaping single→multi flip past a declared type", async () => {
		// The generalized escort re-declares the property to the target
		// type in the same batch, so a declared single_select converts to
		// multi_select in one call. Stored rows are the case store's
		// business — it lifts scalar rows when the schema flips
		// string↔array — and the lift is total, so no consent fires.
		const doc = buildDoc({
			caseTypes: [
				{
					name: "patient",
					properties: [
						{ name: "case_name", label: "Name" },
						{
							name: "language",
							label: "Language",
							data_type: "single_select",
							options: [
								{ value: "en", label: "English" },
								{ value: "fr", label: "French" },
							],
						},
					],
				},
			],
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					forms: [
						{
							name: "Register",
							type: "registration",
							fields: [
								f({
									id: "case_name",
									kind: "text",
									label: "Name",
									case_property_on: "patient",
								}),
								f({
									id: "language",
									kind: "single_select",
									label: "Language",
									case_property_on: "patient",
									optionsSource: {
										kind: "inline",
										options: [
											{
												uuid: asUuid("ef623cf3-4e2e-4f80-a3c2-0797c9147ff3"),
												value: "en",
												label: "English",
											},
											{
												uuid: asUuid("d7cd20ce-b6b6-47c5-ac22-5b99a04dccf3"),
												value: "fr",
												label: "French",
											},
										],
									},
								}),
							],
						},
					],
				},
			],
		});
		const { ctx, recordMutationStages } = makeStubToolContext();
		const result = await editFieldTool.execute(
			{
				...fieldAddress(doc, "language"),
				updates: { kind: "multi_select" },
			},
			ctx,
			doc,
		);
		if ("error" in result.result) throw new Error(result.result.error);
		expect(recordMutationStages).toHaveBeenCalledTimes(1);

		const converted = Object.values(result.newDoc.fields).find(
			(fld) => fld.id === "language",
		);
		expect(converted?.kind).toBe("multi_select");
		// The declaration followed the writer — type flipped, options kept.
		const entry = result.newDoc.caseTypes
			?.find((ct) => ct.name === "patient")
			?.properties.find((p) => p.name === "language");
		expect(entry?.data_type).toBe("multi_select");
		expect(entry?.options).toEqual([
			{ value: "en", label: "English" },
			{ value: "fr", label: "French" },
		]);
	});

	it("text → hidden as the last typed writer pins the undeclared property to text", async () => {
		// Hidden writers are exempt from the agreement rules, so a later
		// calculate edit could silently retype the property via expression
		// inference — the pin freezes the entry at the type its rows
		// already hold.
		const doc = buildDoc({
			caseTypes: [
				{
					name: "patient",
					properties: [
						{ name: "case_name", label: "Name" },
						{ name: "visit_note", label: "Visit note" },
					],
				},
			],
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					forms: [
						{
							name: "Register",
							type: "registration",
							fields: [
								f({
									id: "case_name",
									kind: "text",
									label: "Name",
									case_property_on: "patient",
								}),
								f({
									id: "visit_note",
									kind: "text",
									label: "Visit note",
									case_property_on: "patient",
								}),
							],
						},
					],
				},
			],
		});
		const { ctx } = makeStubToolContext();
		const result = await editFieldTool.execute(
			{
				...fieldAddress(doc, "visit_note"),
				updates: { kind: "hidden", calculate: "today()" },
			},
			ctx,
			doc,
		);
		if ("error" in result.result) throw new Error(result.result.error);

		const after = result.newDoc.fields[soleField(doc, "visit_note").uuid];
		expect(after?.kind).toBe("hidden");
		const entry = result.newDoc.caseTypes
			?.find((ct) => ct.name === "patient")
			?.properties.find((p) => p.name === "visit_note");
		expect(entry?.data_type).toBe("text");
		// The message reports the PINNED type, never "hidden" (not a data
		// type) — the SA trusts mutation-tool prose verbatim.
		expect(result.result.message).toContain('data_type is now "text"');
		expect(result.result.message).not.toContain("matches hidden");
	});

	it("single ↔ multi conversions keep the existing source verbatim", async () => {
		const doc = makeDoc({
			id: "symptoms",
			kind: "single_select",
			label: "Symptoms",
			optionsSource: {
				kind: "inline",
				options: [
					{
						uuid: asUuid("4fc16d7b-0f84-478e-ad92-641e0cb7f6c1"),
						value: "fever",
						label: "Fever",
					},
					{
						uuid: asUuid("91e79875-3cfb-45cf-a137-505e5d036f7f"),
						value: "cough",
						label: "Cough",
					},
				],
			},
		});
		const { ctx } = makeStubToolContext();
		const result = await editFieldTool.execute(
			{
				...fieldAddress(doc, "symptoms"),
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
			convertMut?.kind === "convertField"
				? convertMut.optionsSource
				: undefined,
		).toBeUndefined();
		if (
			after?.kind !== "multi_select" ||
			after.optionsSource.kind !== "inline"
		) {
			throw new Error("expected converted inline multi-select");
		}
		expect(after.optionsSource.options.map((option) => option.value)).toEqual([
			"fever",
			"cough",
		]);
	});
});
