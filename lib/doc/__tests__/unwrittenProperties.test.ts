import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	buildDoc,
	caseListConfig,
	type FieldSpec,
	f,
	type ModuleSpec,
} from "@/lib/__tests__/docHelpers";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { planFieldCaseWrite } from "@/lib/doc/fieldCaseWriteMutations";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import {
	eq,
	isBlank,
	literal,
	prop,
	term,
} from "@/lib/domain/expression/builders";
import { proseText } from "@/lib/domain/prose";
import {
	describeUnwrittenProperty,
	unwrittenProperties,
	unwrittenPropertiesReadBy,
	unwrittenPropertyCards,
} from "../unwrittenProperties";
import { assertAdmittedDoc } from "./admittedDoc";

const MODULE = testUuid("orders-module");
const FORM = testUuid("medication-form");
const FIELD = testUuid("medication-field");
const STATUS = {
	kind: "case-ref" as const,
	caseType: "medication_order",
	property: "order_status",
};
const BLANK = isBlank(prop("medication_order", "order_status"));

/** The fixture explicitly supplies a complete followup workflow and catalog. */
function orderDoc(
	fields: FieldSpec[] = [
		f({
			uuid: FIELD,
			id: "med_given",
			kind: "text",
			label: "Medication given",
			relevant: "#medication_order/order_status = 'delivered'",
		}),
	],
	modulePatch: Partial<ModuleSpec> = {},
) {
	const doc = buildDoc({
		caseTypes: [
			{
				name: "medication_order",
				properties: [
					{ name: "order_status", label: proseText("Order status") },
					{ name: "status", label: proseText("Status") },
					{ name: "max_dose", label: proseText("Max dose"), data_type: "int" },
				],
			},
		],
		modules: [
			{
				uuid: MODULE,
				name: "Orders",
				caseType: "medication_order",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						uuid: FORM,
						name: "Administer Medication",
						type: "followup",
						fields,
					},
				],
				...modulePatch,
			},
		],
	});
	assertAdmittedDoc(doc);
	return doc;
}

describe("unwritten property derivation", () => {
	it.each([
		[
			"relevant",
			f({
				kind: "text",
				id: "value",
				label: "Value",
				relevant: "#medication_order/order_status = 'delivered'",
			}),
			"order_status",
		],
		[
			"validate",
			f({
				kind: "int",
				id: "dose",
				label: "Dose",
				validate: ". < #medication_order/max_dose",
				validate_msg: "Use a smaller dose.",
			}),
			"max_dose",
		],
		[
			"calculate",
			f({
				kind: "hidden",
				id: "status_copy",
				calculate: "#medication_order/order_status",
			}),
			"order_status",
		],
	] as const)("counts a field's %s read", (slot, field, property) => {
		const doc = orderDoc([field]);
		expect(unwrittenProperties(doc)).toEqual([
			{
				caseType: "medication_order",
				property,
				reads: [
					{ carrier: Object.values(doc.fields)[0].uuid, entity: "field", slot },
				],
			},
		]);
	});
	it("collects display, filter, search and field reads in one property entry", () => {
		const doc = orderDoc(undefined, {
			caseListConfig: {
				...caseListConfig([{ field: "order_status", header: "Status" }]),
				filter: BLANK,
				searchInputs: [
					{
						uuid: testUuid("status-input"),
						kind: "simple",
						name: "order_status",
						label: "Status",
						type: "text",
						property: "order_status",
					},
				],
			},
		});
		const entries = unwrittenProperties(doc);
		expect(entries).toHaveLength(1);
		expect(entries[0].reads.map((read) => read.slot).sort()).toEqual([
			"case_list_column_field",
			"case_list_filter",
			"relevant",
			"search_input_property",
		]);
		expect(describeUnwrittenProperty(doc, entries[0])).toContain(
			'the case-list filter on module "Orders"',
		);
		expect(unwrittenPropertyCards(doc)[0].reads).toEqual(
			expect.arrayContaining([
				"a Cases available condition in module “Orders”",
				"a search field in module “Orders”",
			]),
		);
	});
	it("counts an after-submit link condition", () => {
		const doc = orderDoc([], {
			forms: [
				{
					uuid: FORM,
					name: "Administer Medication",
					type: "followup",
					fields: [f({ kind: "text", id: "note", label: "Note" })],
					formLinks: [
						{
							condition: "#medication_order/order_status = 'delivered'",
							target: { type: "module", moduleUuid: MODULE },
						},
					],
				},
			],
		});
		expect(unwrittenProperties(doc)).toEqual([
			{
				caseType: "medication_order",
				property: "order_status",
				reads: [{ carrier: FORM, entity: "form", slot: "form_link_condition" }],
			},
		]);
	});
	it("supports a case-list-only app without any forms", () => {
		const doc = orderDoc([], {
			caseListMenuItem: {},
			forms: [],
			caseListConfig: {
				...caseListConfig([{ field: "order_status", header: "Status" }]),
				filter: BLANK,
			},
		});
		expect(unwrittenProperties(doc)[0]).toMatchObject({
			property: "order_status",
			reads: [
				{ carrier: MODULE, entity: "module", slot: "case_list_column_field" },
				{ carrier: MODULE, entity: "module", slot: "case_list_filter" },
			],
		});
	});
	it("omits unread declarations and implicit runtime values", () => {
		const doc = orderDoc([
			f({
				kind: "text",
				id: "note",
				label: "Note",
				relevant: "#medication_order/status = 'open'",
			}),
		]);
		expect(unwrittenProperties(doc)).toEqual([]);
	});
	it("excludes a historical unknown reference from the informational catalog", () => {
		const doc = orderDoc();
		const field = doc.fields[FIELD];
		if (field.kind !== "text") throw new Error("Expected text fixture");
		field.relevant = eq(
			{
				kind: "form-case",
				caseType: "medication_order",
				property: "ghost_prop",
			},
			literal("delivered"),
		);
		// This intentionally invalid import is refused by the gate; the optional
		// informational projection must not invent a catalog entry for it.
		expect(mutationCommitVerdict(doc, [], LOOKUP_CONTEXT_UNAVAILABLE).ok).toBe(
			false,
		);
		expect(unwrittenProperties(doc)).toEqual([]);
	});
	it("updates cached results when a real field writer is added and cleared", () => {
		const doc = orderDoc();
		const before = unwrittenProperties(doc);
		expect(before).toHaveLength(1);
		expect(unwrittenProperties(doc)).toBe(before);
		const saved = planFieldCaseWrite(doc, FIELD, {
			caseType: "medication_order",
			property: "order_status",
		});
		if (!saved.ok) throw new Error(saved.message);
		const verdict = mutationCommitVerdict(
			doc,
			saved.mutations,
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		expect(verdict.ok ? [] : verdict.findings).toEqual([]);
		expect(unwrittenProperties(verdict.nextDoc)).toEqual([]);
		expect(unwrittenPropertyCards(verdict.nextDoc)).toEqual([]);
		expect(unwrittenProperties(doc)).toBe(before);
		const stopped = planFieldCaseWrite(verdict.nextDoc, FIELD, null);
		if (!stopped.ok) throw new Error(stopped.message);
		const cleared = mutationCommitVerdict(
			verdict.nextDoc,
			stopped.mutations,
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		expect(cleared.ok ? [] : cleared.findings).toEqual([]);
		// Stopping the save keeps the starting value it was born with (the
		// case's current value), so the question now reads the property twice.
		expect(saved.notes).toEqual(["Opens with the case's current value."]);
		expect(unwrittenProperties(cleared.nextDoc)).toEqual([
			{
				...before[0],
				reads: [
					{ carrier: FIELD, entity: "field", slot: "default_value" },
					...(before[0]?.reads ?? []),
				],
			},
		]);
	});
	it("counts explicit case-operation writes as in-app writers", () => {
		const doc = orderDoc();
		const verdict = mutationCommitVerdict(
			doc,
			[
				{
					kind: "updateForm",
					uuid: FORM,
					patch: {},
					caseOperationChange: {
						operation: "add",
						value: {
							uuid: testUuid("write-status"),
							id: "write_status",
							action: "update",
							caseType: "medication_order",
							target: { kind: "session" },
							writes: [
								{ property: "order_status", value: term(literal("delivered")) },
							],
						},
					},
				},
			],
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		expect(verdict.ok ? [] : verdict.findings).toEqual([]);
		expect(unwrittenProperties(verdict.nextDoc)).toEqual([]);
	});
	it("filters by exact carrier identity and names the reading surface", () => {
		const doc = orderDoc();
		const entries = unwrittenProperties(doc);
		expect(unwrittenPropertiesReadBy(doc, new Set([FIELD]))).toEqual(entries);
		expect(
			unwrittenPropertiesReadBy(doc, new Set([testUuid("absent")])),
		).toEqual([]);
		expect(describeUnwrittenProperty(doc, entries[0])).toBe(
			'`order_status` (case type `medication_order`). Read by the visibility of "med_given" in form "Administer Medication"',
		);
	});
	it("deduplicates two display slots on one field in the displayed cards", () => {
		const doc = orderDoc([
			f({
				uuid: FIELD,
				kind: "text",
				id: "status",
				label: { parts: [STATUS] },
				hint: { parts: [STATUS] },
			}),
		]);
		expect(unwrittenProperties(doc)[0].reads).toHaveLength(2);
		const cards = unwrittenPropertyCards(doc);
		expect(cards[0].reads).toEqual([
			"the display text of “status” in form “Administer Medication”",
		]);
		expect(unwrittenPropertyCards(doc)).toBe(cards);
	});
});
