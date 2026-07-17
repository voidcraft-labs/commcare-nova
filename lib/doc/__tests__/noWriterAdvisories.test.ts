/**
 * The no-writer advisory derivation (`lib/doc/noWriterAdvisories.ts`).
 *
 * The rule these tests pin: a DECLARED catalog property draws exactly
 * one advisory iff a GATE slot reads it (field relevance/validation, a
 * form link condition, the case-list filter, the search-button
 * condition), no field writes it, it isn't a CommCare standard
 * property, and it isn't declared `external`. Data-flow and display
 * reads (calculates, case-list columns) never fire it, and the delta
 * renderer reports only what a change INTRODUCED.
 */

import { describe, expect, it } from "vitest";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import type { CaseType, Module, Uuid } from "@/lib/domain";
import { asUuid } from "@/lib/domain";
import {
	describeIntroducedAdvisories,
	describeNoWriterAdvisory,
	noWriterAdvisories,
	noWriterAdvisoriesByCarrier,
} from "../noWriterAdvisories";

/** The medication_order catalog with `order_status` declared —
 *  optionally marked external. */
function orderCatalog(external?: { note?: string }): CaseType[] {
	return [
		{
			name: "medication_order",
			properties: [
				{
					name: "order_status",
					label: "Order status",
					...(external !== undefined && { external }),
				},
			],
		},
	];
}

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

/** The July-9 shape: a followup form whose field's visibility gates on
 *  `order_status`, which nothing writes. */
function gatedDoc(external?: { note?: string }) {
	return buildDoc({
		caseTypes: orderCatalog(external),
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

describe("noWriterAdvisories — when it fires", () => {
	it("flags a relevance gate on a declared property nothing writes", () => {
		const doc = gatedDoc();
		const advisories = noWriterAdvisories(doc);
		expect(advisories).toHaveLength(1);
		const advisory = advisories[0];
		expect(advisory.caseType).toBe("medication_order");
		expect(advisory.property).toBe("order_status");
		expect(advisory.reads).toHaveLength(1);
		expect(advisory.reads[0].entity).toBe("field");
		expect(advisory.reads[0].slot).toBe("relevant");
	});

	it("flags a validation gate", () => {
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
		const advisories = noWriterAdvisories(doc);
		expect(advisories).toHaveLength(1);
		expect(advisories[0].property).toBe("max_dose");
		expect(advisories[0].reads[0].slot).toBe("validate");
	});

	it("flags a case-list filter read (module carrier)", () => {
		const doc = buildDoc({
			caseTypes: orderCatalog(),
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
		const advisories = noWriterAdvisories(doc);
		expect(advisories).toHaveLength(1);
		expect(advisories[0].reads).toEqual([
			expect.objectContaining({ entity: "module", slot: "case_list_filter" }),
		]);
	});

	it("flags a search-button display condition read", () => {
		const doc = buildDoc({
			caseTypes: orderCatalog(),
			modules: [
				{
					name: "Orders",
					caseType: "medication_order",
					caseListOnly: true,
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
					caseSearchConfig: {
						searchButtonDisplayCondition: ORDER_STATUS_IS_BLANK,
					},
				},
			],
		});
		const advisories = noWriterAdvisories(doc);
		expect(advisories).toHaveLength(1);
		expect(advisories[0].reads[0].slot).toBe("search_button_display_condition");
	});

	it("flags a form-link condition read (form carrier)", () => {
		const moduleUuid = asUuid("mod-link-target");
		const doc = buildDoc({
			caseTypes: orderCatalog(),
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
		const advisories = noWriterAdvisories(doc);
		expect(advisories).toHaveLength(1);
		expect(advisories[0].reads).toEqual([
			expect.objectContaining({ entity: "form", slot: "form_link_condition" }),
		]);
	});

	it("collects every gate read of one property into one advisory", () => {
		const base = gatedDoc();
		const doc = buildDoc({
			caseTypes: orderCatalog(),
			modules: [
				{
					name: "Orders",
					caseType: "medication_order",
					caseListConfig: {
						...caseListConfig([{ field: "case_name", header: "Name" }]),
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
		expect(noWriterAdvisories(base)).toHaveLength(1);
		const advisories = noWriterAdvisories(doc);
		expect(advisories).toHaveLength(1);
		expect(advisories[0].reads.map((r) => r.slot).sort()).toEqual([
			"case_list_filter",
			"relevant",
		]);
	});
});

describe("noWriterAdvisories — when it stays quiet", () => {
	it("a writer anywhere in the app suppresses the advisory", () => {
		const doc = buildDoc({
			caseTypes: orderCatalog(),
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
		expect(noWriterAdvisories(doc)).toHaveLength(0);
	});

	it("an external declaration suppresses the advisory", () => {
		expect(
			noWriterAdvisories(gatedDoc({ note: "set by the pharmacy app" })),
		).toHaveLength(0);
		expect(noWriterAdvisories(gatedDoc({}))).toHaveLength(0);
	});

	it("data-flow and display reads never fire it", () => {
		const doc = buildDoc({
			caseTypes: orderCatalog(),
			modules: [
				{
					name: "Orders",
					caseType: "medication_order",
					caseListConfig: caseListConfig([
						// A display column reads the property — display, not a gate.
						{ field: "order_status", header: "Status" },
					]),
					forms: [
						{
							name: "Administer Medication",
							type: "followup",
							fields: [
								// A hidden calculate reads it — data flow, not a gate.
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
		expect(noWriterAdvisories(doc)).toHaveLength(0);
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
		expect(noWriterAdvisories(doc)).toHaveLength(0);
	});

	it("a gate read of an UNDECLARED property doesn't flag (advisory-honest direction)", () => {
		const doc = buildDoc({
			caseTypes: orderCatalog(),
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
		expect(noWriterAdvisories(doc)).toHaveLength(0);
	});
});

describe("rendering", () => {
	it("describeNoWriterAdvisory names the surface, the form, and the honest consequence", () => {
		const doc = gatedDoc();
		const [advisory] = noWriterAdvisories(doc);
		const text = describeNoWriterAdvisory(doc, advisory);
		expect(text).toContain("`order_status`");
		expect(text).toContain('the visibility of "med_given"');
		expect(text).toContain('in form "Administer Medication"');
		expect(text).toContain("no form in this app writes it");
	});

	it("noWriterAdvisoriesByCarrier groups by gate-reading carrier", () => {
		const doc = gatedDoc();
		const [advisory] = noWriterAdvisories(doc);
		const carrier = advisory.reads[0].carrier as Uuid;
		const byCarrier = noWriterAdvisoriesByCarrier(doc);
		expect(byCarrier.get(carrier)).toEqual([advisory]);
		expect(byCarrier.size).toBe(1);
	});
});

describe("describeIntroducedAdvisories — the batch delta", () => {
	it("reports an advisory the change introduced, with both remediations", () => {
		const withWriter = buildDoc({
			caseTypes: orderCatalog(),
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
		const withoutWriter = gatedDoc();
		const note = describeIntroducedAdvisories(withWriter, withoutWriter);
		expect(note).toBeDefined();
		expect(note).toContain("`order_status`");
		expect(note).toContain("markPropertyExternal");
	});

	it("stays silent when nothing new was introduced — including resolutions", () => {
		const withWriter = gatedDoc({ note: "pharmacy" });
		const open = gatedDoc();
		// Unchanged advisory set → quiet.
		expect(describeIntroducedAdvisories(open, open)).toBeUndefined();
		// A change that RESOLVES the advisory → quiet (the fix is its own
		// confirmation).
		expect(describeIntroducedAdvisories(open, withWriter)).toBeUndefined();
	});
});
