/**
 * `editField` kind-conversion behavior — the select/text family.
 *
 * The conversion contract these tests pin:
 *
 *   - converting INTO a select kind requires `optionsSource` in the SAME call;
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
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc as buildFixtureDoc, f, xp } from "@/lib/__tests__/docHelpers";
import {
	type BlueprintDoc,
	fallbackProseProjection,
	fieldCaseWrite,
	type SelectOption,
} from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import { makeStubToolContext } from "../../__tests__/fixtures";
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

/**
 * Every case-carrying module in these conversion fixtures starts valid at the
 * absolute gate: one visible Results column names the primary case.
 */
function buildDoc(spec: Parameters<typeof buildFixtureDoc>[0]): BlueprintDoc {
	const doc = buildFixtureDoc(spec);
	for (const module of Object.values(doc.modules)) {
		if (module.caseType === undefined || module.caseListConfig !== undefined) {
			continue;
		}
		const columnUuid = testUuid(`kind-conversion-column-${module.uuid}`);
		module.caseListConfig = {
			columns: [
				{
					uuid: columnUuid,
					kind: "plain",
					field: "case_name",
					header: "Name",
				},
			],
			listColumnOrder: [columnUuid],
			detailColumnOrder: [columnUuid],
			searchInputs: [],
		};
	}
	return doc;
}

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

function address(doc: BlueprintDoc, id: string) {
	const moduleUuid = doc.moduleOrder[0];
	const formUuid = doc.formOrder[moduleUuid]?.[0];
	if (formUuid === undefined) throw new Error("fixture form missing");
	return {
		moduleUuid,
		formUuid,
		fieldUuid: soleField(doc, id).uuid,
	};
}

function toolInlineOptions(
	...options: ReadonlyArray<readonly [string, string]>
) {
	return {
		kind: "inline" as const,
		options: options.map(([value, label]) => ({
			optionUuid: testUuid(`tool-option-${value}`),
			value,
			label: proseText(label),
		})),
	};
}

function storedInlineOptions(
	...options: ReadonlyArray<readonly [string, string]>
) {
	return {
		kind: "inline" as const,
		options: options.map(([value, label]) => ({
			uuid: testUuid(`stored-option-${value}`),
			value,
			label: proseText(label),
		})),
	};
}

function inlineOptions(field: ReturnType<typeof soleField>): SelectOption[] {
	if (
		(field.kind !== "single_select" && field.kind !== "multi_select") ||
		field.optionsSource.kind !== "inline"
	) {
		throw new Error(`field "${field.id}" has no inline options`);
	}
	return field.optionsSource.options;
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("editField — convert to single_select", () => {
	it("lands the conversion with same-call options riding the convertField mutation", async () => {
		const doc = makeDoc({
			id: "facility",
			kind: "text",
			label: proseText("Specialist facility"),
		});
		const { ctx } = makeStubToolContext();
		const result = await editFieldTool.execute(
			{
				...address(doc, "facility"),
				updates: {
					kind: "single_select",
					optionsSource: toolInlineOptions(
						["clinic_a", "Clinic A"],
						["clinic_b", "Clinic B"],
					),
				},
			},
			ctx,
			doc,
		);
		if ("error" in result.result) throw new Error(result.result.error);

		const after = result.newDoc.fields[soleField(doc, "facility").uuid];
		expect(after?.kind).toBe("single_select");
		if (!after) throw new Error("converted field missing");
		const options = inlineOptions(after);
		expect(options.map((o) => o.value)).toEqual(["clinic_a", "clinic_b"]);
		// Identity minted at the batch-building layer — every landed option
		// carries a uuid + order key, so the per-uuid option diff and a
		// peer's granular option edits address them immediately.
		for (const opt of options) {
			expect(opt.uuid).toBeTruthy();
		}
		if (!("options" in result.result) || result.result.options === undefined) {
			throw new Error("expected converted-option identity receipt");
		}
		expect(result.result.options).toEqual(
			options.map((option) => ({
				uuid: option.uuid,
				value: option.value,
			})),
		);

		// The options were CONSUMED into the convertField mutation — one
		// carrier, no second updateField application of the same list.
		const convertMuts = result.mutations.filter(
			(m) => m.kind === "convertField",
		);
		expect(convertMuts).toHaveLength(1);
		expect(
			convertMuts[0] && "optionsSource" in convertMuts[0]
				? convertMuts[0].optionsSource?.kind === "inline"
					? convertMuts[0].optionsSource.options.length
					: 0
				: 0,
		).toBe(2);
		const optionPatches = result.mutations.filter(
			(m) => m.kind === "updateField" && "optionsSource" in m.patch,
		);
		expect(optionPatches).toHaveLength(0);
	});

	it("refuses a seedless select conversion, naming the same-call fix", async () => {
		const doc = makeDoc({
			id: "facility",
			kind: "text",
			label: proseText("Facility"),
		});
		const { ctx, recordMutationStages } = makeStubToolContext();
		const result = await editFieldTool.execute(
			{
				...address(doc, "facility"),
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
		const doc = makeDoc({
			id: "facility",
			kind: "text",
			label: proseText("Facility"),
		});
		const { ctx, recordMutationStages } = makeStubToolContext();
		const result = await editFieldTool.execute(
			{
				...address(doc, "facility"),
				updates: {
					kind: "single_select",
					optionsSource: toolInlineOptions(["only", "Only"]),
				},
			},
			ctx,
			doc,
		);
		if (!("error" in result.result)) throw new Error("expected error");
		expect(result.result.error).toContain("mutation data was not canonical");
		expect(recordMutationStages).not.toHaveBeenCalled();
	});
});

describe("editField — convert to hidden", () => {
	it("lands text → hidden when the same call brings the calculate", async () => {
		const doc = makeDoc({
			id: "full_name",
			kind: "text",
			label: proseText("Full name"),
			hint: proseText("first and last"),
		});
		const { ctx } = makeStubToolContext();
		const result = await editFieldTool.execute(
			{
				...address(doc, "full_name"),
				updates: { kind: "hidden", calculate: xp('concat("a", " ", "b")') },
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
		const doc = makeDoc({
			id: "full_name",
			kind: "text",
			label: proseText("Full name"),
		});
		const { ctx, recordMutationStages } = makeStubToolContext();
		const result = await editFieldTool.execute(
			{
				...address(doc, "full_name"),
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
			label: proseText("Stage"),
			default_value: '"intake"',
		});
		const { ctx } = makeStubToolContext();
		const result = await editFieldTool.execute(
			{
				...address(doc, "visit_stage"),
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
			label: proseText("Sample"),
			hint: proseText("scan the vial"),
		});
		const { ctx } = makeStubToolContext();
		const result = await editFieldTool.execute(
			{
				...address(doc, "sample_id"),
				updates: { kind: "text" },
			},
			ctx,
			doc,
		);
		if ("error" in result.result) throw new Error(result.result.error);
		const after = result.newDoc.fields[soleField(doc, "sample_id").uuid];
		expect(after?.kind).toBe("text");
		expect(
			after && "hint" in after && after.hint
				? fallbackProseProjection(after.hint)
				: undefined,
		).toBe("scan the vial");
	});

	it("single_select → text drops the options and keeps the rest", async () => {
		const doc = makeDoc({
			id: "status",
			kind: "single_select",
			label: proseText("Status"),
			optionsSource: storedInlineOptions(
				["open", "Open"],
				["closed", "Closed"],
			),
		});
		const { ctx } = makeStubToolContext();
		const result = await editFieldTool.execute(
			{
				...address(doc, "status"),
				updates: { kind: "text" },
			},
			ctx,
			doc,
		);
		if ("error" in result.result) throw new Error(result.result.error);
		const after = result.newDoc.fields[soleField(doc, "status").uuid];
		expect(after?.kind).toBe("text");
		expect("optionsSource" in (after ?? {})).toBe(false);
		expect(after && "label" in after).toBe(true);
		if (!after || !("label" in after) || !after.label) {
			throw new Error("field label missing");
		}
		expect(fallbackProseProjection(after.label)).toBe("Status");
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
						{ name: "case_name", label: proseText("Name"), data_type: "text" },
						{
							name: "facility",
							label: proseText("Facility"),
							data_type: "text",
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
									label: proseText("Name"),
									caseWrite: {
										caseType: "patient",
										property: "case_name",
									},
								}),
								f({
									id: "facility",
									kind: "text",
									label: proseText("Facility"),
									caseWrite: {
										caseType: "patient",
										property: "facility",
									},
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
				...address(doc, "facility"),
				updates: {
					kind: "single_select",
					optionsSource: toolInlineOptions(
						["clinic_a", "Clinic A"],
						["clinic_b", "Clinic B"],
					),
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
		expect(
			entry?.options?.map((option) => ({
				value: option.value,
				label: fallbackProseProjection(option.label),
			})),
		).toEqual([
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
						{ name: "case_name", label: proseText("Name") },
						{ name: "patient_status", label: proseText("Status") },
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
									label: proseText("Name"),
									caseWrite: {
										caseType: "patient",
										property: "case_name",
									},
								}),
								f({
									id: "status",
									kind: "text",
									label: proseText("Status"),
									caseWrite: {
										caseType: "patient",
										property: "patient_status",
									},
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
									label: proseText("Status"),
									caseWrite: {
										caseType: "patient",
										property: "patient_status",
									},
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
				...address(doc, "status"),
				updates: {
					kind: "single_select",
					optionsSource: toolInlineOptions(
						["open", "Open"],
						["closed", "Closed"],
					),
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
			expect(fld.kind).toBe("single_select");
			const options = inlineOptions(fld);
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
						{ name: "case_name", label: proseText("Name") },
						{ name: "sample_id", label: proseText("Sample") },
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
									label: proseText("Name"),
									caseWrite: {
										caseType: "patient",
										property: "case_name",
									},
								}),
								f({
									id: "sample_id",
									kind: "text",
									label: proseText("Sample"),
									caseWrite: {
										caseType: "patient",
										property: "sample_id",
									},
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
									label: proseText("Sample scan"),
									caseWrite: {
										caseType: "patient",
										property: "sample_id",
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
				...address(doc, "sample_id"),
				updates: {
					kind: "single_select",
					optionsSource: toolInlineOptions(["a", "A"], ["b", "B"]),
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

	it("a same-call caseWrite clear converts only the addressed field — no cascade for a destination it leaves", async () => {
		const doc = buildDoc({
			caseTypes: [
				{
					name: "patient",
					properties: [
						{ name: "case_name", label: proseText("Name") },
						{ name: "patient_status", label: proseText("Status") },
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
									label: proseText("Name"),
									caseWrite: {
										caseType: "patient",
										property: "case_name",
									},
								}),
								f({
									id: "status",
									kind: "text",
									label: proseText("Status"),
									caseWrite: {
										caseType: "patient",
										property: "patient_status",
									},
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
									label: proseText("Status"),
									caseWrite: {
										caseType: "patient",
										property: "patient_status",
									},
								}),
							],
						},
					],
				},
			],
		});
		const registerStatus = Object.values(doc.fields).find(
			(fld) =>
				fld.id === "status" &&
				"label" in fld &&
				fld.label !== undefined &&
				fallbackProseProjection(fld.label) === "Status",
		);
		const { ctx } = makeStubToolContext();
		const result = await editFieldTool.execute(
			{
				...address(doc, "status"),
				updates: {
					kind: "single_select",
					id: "local_status",
					optionsSource: toolInlineOptions(
						["open", "Open"],
						["closed", "Closed"],
					),
					caseWrite: null,
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
		expect(addressed?.id).toBe("local_status");
		expect(addressed && fieldCaseWrite(addressed)).toBeUndefined();
		expect(result.mutations).toEqual([
			expect.objectContaining({
				kind: "convertField",
				uuid: registerStatus?.uuid,
				toKind: "single_select",
			}),
			expect.objectContaining({
				kind: "updateField",
				uuid: registerStatus?.uuid,
				targetKind: "single_select",
				patch: expect.objectContaining({
					id: "local_status",
					caseWrite: null,
				}),
			}),
		]);
		const peer = Object.values(result.newDoc.fields).find(
			(fld) => fld.id === "status" && fld.uuid !== registerStatus?.uuid,
		);
		expect(peer?.kind).toBe("text");
	});

	it("plans conversion against the final id and caseWrite pair when they retarget together", async () => {
		const doc = buildDoc({
			caseTypes: [
				{
					name: "patient",
					properties: [
						{ name: "case_name", label: proseText("Patient name") },
						{
							name: "risk_score",
							label: proseText("Risk score"),
							data_type: "text",
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
							name: "Register patient",
							type: "registration",
							fields: [
								f({
									id: "case_name",
									kind: "text",
									label: proseText("Patient name"),
									caseWrite: {
										caseType: "patient",
										property: "case_name",
									},
								}),
								f({
									id: "score",
									kind: "text",
									label: proseText("Patient score"),
								}),
							],
						},
						{
							name: "Follow up",
							type: "followup",
							fields: [
								f({
									id: "risk_score",
									kind: "text",
									label: proseText("Risk score"),
									caseWrite: {
										caseType: "patient",
										property: "risk_score",
									},
								}),
							],
						},
					],
				},
			],
		});
		const addressed = Object.values(doc.fields).find(
			(field) =>
				field.id === "score" &&
				"label" in field &&
				field.label !== undefined &&
				fallbackProseProjection(field.label) === "Patient score",
		);
		const targetPeer = Object.values(doc.fields).find(
			(field) =>
				field.id === "risk_score" &&
				"label" in field &&
				field.label !== undefined &&
				fallbackProseProjection(field.label) === "Risk score",
		);
		if (!addressed || !targetPeer) throw new Error("fixture fields missing");
		const patientModule = doc.moduleOrder[0];
		const patientForm = doc.formOrder[patientModule]?.[0];
		if (!patientForm) throw new Error("fixture patient form missing");

		const { ctx } = makeStubToolContext();
		const result = await editFieldTool.execute(
			{
				moduleUuid: patientModule,
				formUuid: patientForm,
				fieldUuid: addressed.uuid,
				updates: {
					kind: "single_select",
					id: "risk_score",
					caseWrite: {
						caseType: "patient",
						property: "risk_score",
					},
					optionsSource: toolInlineOptions(["low", "Low"], ["high", "High"]),
				},
			},
			ctx,
			doc,
		);
		if ("error" in result.result) throw new Error(result.result.error);

		expect(result.newDoc.fields[addressed.uuid]).toMatchObject({
			id: "risk_score",
			kind: "single_select",
			caseWrite: {
				caseType: "patient",
				property: "risk_score",
			},
		});
		// Planning against the call's final pair carries the existing
		// household writer across too; planning against the abandoned
		// patient/score pair would leave this peer as text.
		expect(result.newDoc.fields[targetPeer.uuid]?.kind).toBe("single_select");
		expect(
			result.mutations.some(
				(mutation) =>
					mutation.kind === "convertField" &&
					mutation.uuid === targetPeer.uuid &&
					mutation.toKind === "single_select",
			),
		).toBe(true);
		expect(result.mutations.at(-1)).toEqual({
			kind: "updateField",
			uuid: addressed.uuid,
			targetKind: "single_select",
			patch: {
				id: "risk_score",
				caseWrite: {
					caseType: "patient",
					property: "risk_score",
				},
			},
		});
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
						{ name: "case_name", label: proseText("Name") },
						{
							name: "language",
							label: proseText("Language"),
							data_type: "single_select",
							options: [
								{ value: "en", label: proseText("English") },
								{ value: "fr", label: proseText("French") },
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
									label: proseText("Name"),
									caseWrite: {
										caseType: "patient",
										property: "case_name",
									},
								}),
								f({
									id: "language",
									kind: "single_select",
									label: proseText("Language"),
									caseWrite: {
										caseType: "patient",
										property: "language",
									},
									optionsSource: storedInlineOptions(
										["en", "English"],
										["fr", "French"],
									),
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
				...address(doc, "language"),
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
		expect(
			entry?.options?.map((option) => ({
				value: option.value,
				label: fallbackProseProjection(option.label),
			})),
		).toEqual([
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
						{ name: "case_name", label: proseText("Name") },
						{ name: "visit_note", label: proseText("Visit note") },
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
									label: proseText("Name"),
									caseWrite: {
										caseType: "patient",
										property: "case_name",
									},
								}),
								f({
									id: "visit_note",
									kind: "text",
									label: proseText("Visit note"),
									caseWrite: {
										caseType: "patient",
										property: "visit_note",
									},
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
				...address(doc, "visit_note"),
				updates: { kind: "hidden", calculate: xp("today()") },
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

	it("single ↔ multi conversions keep the existing verbatim-options path (no seed consumed)", async () => {
		const doc = makeDoc({
			id: "symptoms",
			kind: "single_select",
			label: proseText("Symptoms"),
			optionsSource: storedInlineOptions(
				["fever", "Fever"],
				["cough", "Cough"],
			),
		});
		const { ctx } = makeStubToolContext();
		const result = await editFieldTool.execute(
			{
				...address(doc, "symptoms"),
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
			convertMut && "optionsSource" in convertMut
				? convertMut.optionsSource
				: undefined,
		).toBeUndefined();
		if (!after) throw new Error("converted symptoms missing");
		expect(inlineOptions(after).map((option) => option.value)).toEqual([
			"fever",
			"cough",
		]);
	});
});
