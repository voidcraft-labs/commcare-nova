/**
 * The unwritten-property derivation (`lib/doc/unwrittenProperties.ts`).
 *
 * The rule these tests pin: a DECLARED catalog property appears iff
 * anything reads it from any registry slot — a field's expression, a
 * case-list column or filter, a form link — while no field writes it,
 * standard properties and `case_id` excluded. It is an informational
 * fact (where does this data come from?), so there is no severity
 * filter: display and data-flow reads count exactly like gates.
 */

import { describe, expect, it } from "vitest";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import type { CaseType, Module, Uuid } from "@/lib/domain";
import { asUuid } from "@/lib/domain";
import {
	describeUnwrittenProperty,
	unwrittenProperties,
	unwrittenPropertiesReadBy,
	unwrittenPropertyCards,
} from "../unwrittenProperties";

/** The medication_order catalog with `order_status` declared. */
const ORDER_CATALOG: CaseType[] = [
	{
		name: "medication_order",
		properties: [{ name: "order_status", label: "Order status" }],
	},
];

/** An `is-blank(order_status)` predicate — the smallest property-
 *  reading Predicate node. */
const ORDER_STATUS_IS_BLANK: NonNullable<Module["caseListConfig"]>["filter"] = {
	kind: "is-blank",
	left: {
		kind: "term",
		term: {
			kind: "prop",
			caseType: "medication_order",
			property: "order_status",
		},
	},
};

/** A followup form whose field's visibility reads `order_status`,
 *  which nothing writes. */
function readingDoc() {
	return buildDoc({
		caseTypes: ORDER_CATALOG,
		modules: [
			{
				name: "Orders",
				caseType: "medication_order",
				forms: [
					{
						name: "Administer Medication",
						type: "followup",
						fields: [
							f({
								id: "med_given",
								kind: "text",
								relevant: "#medication_order/order_status = 'delivered'",
							}),
						],
					},
				],
			},
		],
	});
}

describe("unwrittenProperties — reads that count", () => {
	it("a field's visibility expression", () => {
		const entries = unwrittenProperties(readingDoc());
		expect(entries).toHaveLength(1);
		const entry = entries[0];
		expect(entry.caseType).toBe("medication_order");
		expect(entry.property).toBe("order_status");
		expect(entry.reads).toEqual([
			expect.objectContaining({ entity: "field", slot: "relevant" }),
		]);
	});

	it("a field's validation expression", () => {
		const doc = buildDoc({
			caseTypes: [
				{
					name: "medication_order",
					properties: [{ name: "max_dose", label: "Max dose" }],
				},
			],
			modules: [
				{
					name: "Orders",
					caseType: "medication_order",
					forms: [
						{
							name: "Administer Medication",
							type: "followup",
							fields: [
								f({
									id: "dose",
									kind: "int",
									validate: ". < #medication_order/max_dose",
								}),
							],
						},
					],
				},
			],
		});
		const entries = unwrittenProperties(doc);
		expect(entries).toHaveLength(1);
		expect(entries[0].property).toBe("max_dose");
		expect(entries[0].reads[0].slot).toBe("validate");
	});

	it("a hidden calculate — data-flow reads count too", () => {
		const doc = buildDoc({
			caseTypes: ORDER_CATALOG,
			modules: [
				{
					name: "Orders",
					caseType: "medication_order",
					forms: [
						{
							name: "Administer Medication",
							type: "followup",
							fields: [
								f({
									id: "status_copy",
									kind: "hidden",
									calculate: "#medication_order/order_status",
								}),
							],
						},
					],
				},
			],
		});
		const entries = unwrittenProperties(doc);
		expect(entries).toHaveLength(1);
		expect(entries[0].reads[0].slot).toBe("calculate");
	});

	it("a display column — display reads count too", () => {
		const doc = buildDoc({
			caseTypes: ORDER_CATALOG,
			modules: [
				{
					name: "Orders",
					caseType: "medication_order",
					caseListOnly: true,
					caseListConfig: caseListConfig([
						{ field: "order_status", header: "Status" },
					]),
				},
			],
		});
		const entries = unwrittenProperties(doc);
		expect(entries).toHaveLength(1);
		expect(entries[0].reads).toEqual([
			expect.objectContaining({
				entity: "module",
				slot: "case_list_column_field",
			}),
		]);
	});

	it("a case-list filter (module carrier)", () => {
		const doc = buildDoc({
			caseTypes: ORDER_CATALOG,
			modules: [
				{
					name: "Orders",
					caseType: "medication_order",
					caseListOnly: true,
					caseListConfig: {
						...caseListConfig([{ field: "case_name", header: "Name" }]),
						filter: ORDER_STATUS_IS_BLANK,
					},
				},
			],
		});
		const entries = unwrittenProperties(doc);
		expect(entries).toHaveLength(1);
		expect(entries[0].reads).toEqual([
			expect.objectContaining({ entity: "module", slot: "case_list_filter" }),
		]);
	});

	it("a form-link condition (form carrier)", () => {
		const moduleUuid = asUuid("mod-link-target");
		const doc = buildDoc({
			caseTypes: ORDER_CATALOG,
			modules: [
				{
					uuid: moduleUuid,
					name: "Orders",
					caseType: "medication_order",
					forms: [
						{
							name: "Administer Medication",
							type: "followup",
							fields: [f({ id: "note", kind: "text" })],
							formLinks: [
								{
									condition: "#medication_order/order_status = 'delivered'",
									target: { type: "module", moduleUuid },
								},
							],
						},
					],
				},
			],
		});
		const entries = unwrittenProperties(doc);
		expect(entries).toHaveLength(1);
		expect(entries[0].reads).toEqual([
			expect.objectContaining({ entity: "form", slot: "form_link_condition" }),
		]);
	});

	it("collects every read of one property into one entry", () => {
		const doc = buildDoc({
			caseTypes: ORDER_CATALOG,
			modules: [
				{
					name: "Orders",
					caseType: "medication_order",
					caseListConfig: {
						...caseListConfig([{ field: "order_status", header: "Status" }]),
						filter: ORDER_STATUS_IS_BLANK,
					},
					forms: [
						{
							name: "Administer Medication",
							type: "followup",
							fields: [
								f({
									id: "med_given",
									kind: "text",
									relevant: "#medication_order/order_status = 'delivered'",
								}),
							],
						},
					],
				},
			],
		});
		const entries = unwrittenProperties(doc);
		expect(entries).toHaveLength(1);
		expect(entries[0].reads.map((r) => r.slot).sort()).toEqual([
			"case_list_column_field",
			"case_list_filter",
			"relevant",
		]);
	});
});

describe("unwrittenProperties — when it stays empty", () => {
	it("a writer anywhere in the app removes the entry", () => {
		const doc = buildDoc({
			caseTypes: ORDER_CATALOG,
			modules: [
				{
					name: "Orders",
					caseType: "medication_order",
					forms: [
						{
							name: "Administer Medication",
							type: "followup",
							fields: [
								f({
									id: "med_given",
									kind: "text",
									relevant: "#medication_order/order_status = 'delivered'",
								}),
							],
						},
						{
							name: "Pharmacy Fulfillment",
							type: "followup",
							fields: [
								f({
									id: "order_status",
									kind: "text",
									case_property_on: "medication_order",
								}),
							],
						},
					],
				},
			],
		});
		expect(unwrittenProperties(doc)).toHaveLength(0);
	});

	it("a declared property nothing reads doesn't appear", () => {
		const doc = buildDoc({
			caseTypes: ORDER_CATALOG,
			modules: [
				{
					name: "Orders",
					caseType: "medication_order",
					forms: [
						{
							name: "Administer Medication",
							type: "followup",
							fields: [f({ id: "note", kind: "text" })],
						},
					],
				},
			],
		});
		expect(unwrittenProperties(doc)).toHaveLength(0);
	});

	it("standard properties are exempt — the runtime writes them", () => {
		const doc = buildDoc({
			caseTypes: [
				{
					name: "medication_order",
					properties: [{ name: "status", label: "Status" }],
				},
			],
			modules: [
				{
					name: "Orders",
					caseType: "medication_order",
					forms: [
						{
							name: "Administer Medication",
							type: "followup",
							fields: [
								f({
									id: "med_given",
									kind: "text",
									relevant: "#medication_order/status = 'open'",
								}),
							],
						},
					],
				},
			],
		});
		expect(unwrittenProperties(doc)).toHaveLength(0);
	});

	it("a read of an UNDECLARED property doesn't appear (informational-honest direction)", () => {
		const doc = buildDoc({
			caseTypes: ORDER_CATALOG,
			modules: [
				{
					name: "Orders",
					caseType: "medication_order",
					forms: [
						{
							name: "Administer Medication",
							type: "followup",
							fields: [
								f({
									id: "med_given",
									kind: "text",
									relevant: "#medication_order/ghost_prop = 'x'",
								}),
							],
						},
					],
				},
			],
		});
		expect(unwrittenProperties(doc)).toHaveLength(0);
	});
});

describe("carrier lookup + rendering", () => {
	it("unwrittenPropertiesReadBy filters to the given carriers' reads", () => {
		const doc = readingDoc();
		const [entry] = unwrittenProperties(doc);
		const carrier = entry.reads[0].carrier as Uuid;
		expect(unwrittenPropertiesReadBy(doc, new Set([carrier]))).toEqual([entry]);
		expect(unwrittenPropertiesReadBy(doc, new Set(["not-a-carrier"]))).toEqual(
			[],
		);
	});

	it("describeUnwrittenProperty names the property, its type, and the read surface", () => {
		const doc = readingDoc();
		const [entry] = unwrittenProperties(doc);
		const text = describeUnwrittenProperty(doc, entry);
		expect(text).toContain("`order_status`");
		expect(text).toContain("`medication_order`");
		expect(text).toContain('the visibility of "med_given"');
		expect(text).toContain('in form "Administer Medication"');
	});

	it("unwrittenPropertyCards pre-renders reads and dedupes repeats", () => {
		const doc = readingDoc();
		const cards = unwrittenPropertyCards(doc);
		expect(cards).toHaveLength(1);
		expect(cards[0].property).toBe("order_status");
		expect(cards[0].reads).toEqual([
			"the visibility of “med_given” in form “Administer Medication”",
		]);
	});

	it("the two audiences fork on the case-workspace vocabulary", () => {
		// One property read by a Cases available condition and a search
		// field: the SA reminder names the tool surface's nouns, the
		// dialog names the workspace's.
		const doc = buildDoc({
			caseTypes: ORDER_CATALOG,
			modules: [
				{
					name: "Orders",
					caseType: "medication_order",
					caseListOnly: true,
					caseListConfig: {
						...caseListConfig([{ field: "case_name", header: "Name" }]),
						filter: ORDER_STATUS_IS_BLANK,
						searchInputs: [
							{
								uuid: asUuid("si-status"),
								kind: "simple",
								name: "order_status",
								label: "Status",
								type: "text",
								property: "order_status",
							},
						],
					},
				},
			],
		});
		const [entry] = unwrittenProperties(doc);
		const agentText = describeUnwrittenProperty(doc, entry);
		expect(agentText).toContain('the case-list filter on module "Orders"');
		expect(agentText).toContain('a search input of module "Orders"');
		const [card] = unwrittenPropertyCards(doc);
		expect(card.reads).toEqual(
			expect.arrayContaining([
				"a Cases available condition in module “Orders”",
				"a search field in module “Orders”",
			]),
		);
	});

	it("both derivations are memoized per doc reference", () => {
		const doc = readingDoc();
		expect(unwrittenProperties(doc)).toBe(unwrittenProperties(doc));
		expect(unwrittenPropertyCards(doc)).toBe(unwrittenPropertyCards(doc));
	});
});
