/**
 * `markPropertyExternal` — the no-writer advisory's resolution tool.
 *
 * The contract these tests pin:
 *
 *   - marking a DECLARED property replaces its entry (setCaseProperty)
 *     with the external marking (and note) attached, preserving every
 *     other slot;
 *   - marking an UNDECLARED property declares it in the chokepoint's
 *     bare shape plus the marking (addCaseProperty);
 *   - an unknown case type is refused with the generateSchema pointer
 *     and the known-type list, persisting nothing;
 *   - clearing removes the marking (and only it); clearing an unmarked
 *     property is a successful no-op with nothing persisted;
 *   - the marking actually resolves the advisory the derivation
 *     computes, end to end.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { noWriterAdvisories } from "@/lib/doc/noWriterAdvisories";
import type { BlueprintDoc, CaseProperty } from "@/lib/domain";
import { makeStubToolContext } from "../../__tests__/fixtures";
import { generateSchemaTool } from "../generateSchema";
import { markPropertyExternalTool } from "../markPropertyExternal";

vi.mock("@/lib/db/apps", () => ({
	completeApp: vi.fn(() => Promise.resolve()),
}));
vi.mock("@/lib/db/applyBlueprintChange", () => ({
	applyBlueprintChange: vi.fn(() => Promise.resolve({ seq: 0 })),
}));

/** The July-9 shape: a gate on `order_status`, no writer. */
function gatedDoc(orderStatus?: Partial<CaseProperty>): BlueprintDoc {
	return buildDoc({
		caseTypes: [
			{
				name: "medication_order",
				properties: [
					{ name: "order_status", label: "Order status", ...orderStatus },
				],
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
								relevant: "#medication_order/order_status = 'delivered'",
							}),
						],
					},
				],
			},
		],
	});
}

function catalogProperty(
	doc: BlueprintDoc,
	caseType: string,
	name: string,
): CaseProperty | undefined {
	return (doc.caseTypes ?? [])
		.find((ct) => ct.name === caseType)
		?.properties.find((p) => p.name === name);
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("markPropertyExternal — marking", () => {
	it("marks a declared property, preserving its other slots, and resolves the advisory", async () => {
		const doc = gatedDoc({ hint: "Where the order stands" });
		expect(noWriterAdvisories(doc)).toHaveLength(1);
		const { ctx } = makeStubToolContext();
		const result = await markPropertyExternalTool.execute(
			{
				case_type: "medication_order",
				property: "order_status",
				external: { note: "set by the pharmacy fulfillment app" },
			},
			ctx,
			doc,
		);
		if ("error" in result.result) throw new Error(result.result.error);
		expect(result.result.message).toContain("set outside this app");
		expect(result.result.message).toContain("pharmacy fulfillment");
		// The gate on order_status was open — the prose may honestly claim
		// the advisory is silenced.
		expect(result.result.message).toContain("silenced");

		expect(result.mutations).toEqual([
			expect.objectContaining({
				kind: "setCaseProperty",
				caseType: "medication_order",
			}),
		]);
		const after = catalogProperty(
			result.newDoc,
			"medication_order",
			"order_status",
		);
		expect(after?.external).toEqual({
			note: "set by the pharmacy fulfillment app",
		});
		expect(after?.hint).toBe("Where the order stands");
		expect(noWriterAdvisories(result.newDoc)).toHaveLength(0);
	});

	it("marks with no note as a bare marking", async () => {
		const doc = gatedDoc();
		const { ctx } = makeStubToolContext();
		const result = await markPropertyExternalTool.execute(
			{
				case_type: "medication_order",
				property: "order_status",
				external: {},
			},
			ctx,
			doc,
		);
		if ("error" in result.result) throw new Error(result.result.error);
		expect(
			catalogProperty(result.newDoc, "medication_order", "order_status")
				?.external,
		).toEqual({});
	});

	it("declares an unlisted property in the bare shape — and DISCLOSES the new declaration loudly", async () => {
		// The declare-new arm is deliberate (the only declare-external path
		// on an authored record), but a typo'd name would land here too —
		// so the prose must scream "declared it new", never claim an
		// advisory was silenced, and hand back the correction recipe.
		const doc = gatedDoc();
		const { ctx } = makeStubToolContext();
		const result = await markPropertyExternalTool.execute(
			{
				case_type: "medication_order",
				property: "priority_flag",
				external: { note: "set by HQ" },
			},
			ctx,
			doc,
		);
		if ("error" in result.result) throw new Error(result.result.error);
		expect(result.mutations[0]?.kind).toBe("addCaseProperty");
		const after = catalogProperty(
			result.newDoc,
			"medication_order",
			"priority_flag",
		);
		expect(after).toEqual({
			name: "priority_flag",
			label: "priority_flag",
			external: { note: "set by HQ" },
		});
		expect(result.result.message).toContain("DECLARED it new");
		expect(result.result.message).toContain('"order_status"');
		expect(result.result.message).toContain("external: null");
		expect(result.result.message).not.toContain("silenced");
	});

	it("marking a property with no open advisory says so instead of claiming a silence", async () => {
		// order_status has a writer here, so no advisory is open — the
		// marking is a recorded fact, and the prose must not invent a
		// silence that never happened.
		const doc = buildDoc({
			caseTypes: [
				{
					name: "medication_order",
					properties: [{ name: "order_status", label: "Order status" }],
				},
			],
			modules: [
				{
					name: "Orders",
					caseType: "medication_order",
					forms: [
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
		const { ctx } = makeStubToolContext();
		const result = await markPropertyExternalTool.execute(
			{
				case_type: "medication_order",
				property: "order_status",
				external: {},
			},
			ctx,
			doc,
		);
		if ("error" in result.result) throw new Error(result.result.error);
		expect(result.result.message).toContain("No advisory was open");
		expect(result.result.message).not.toContain("silenced");
	});

	it("refuses an unknown case type, naming the known ones and generateSchema", async () => {
		const doc = gatedDoc();
		const { ctx, recordMutations } = makeStubToolContext();
		const result = await markPropertyExternalTool.execute(
			{
				case_type: "medication_odrer",
				property: "order_status",
				external: {},
			},
			ctx,
			doc,
		);
		if (!("error" in result.result)) throw new Error("expected a refusal");
		expect(result.result.error).toContain('"medication_odrer"');
		expect(result.result.error).toContain('"medication_order"');
		expect(result.result.error).toContain("generateSchema");
		expect(result.mutations).toHaveLength(0);
		expect(recordMutations).not.toHaveBeenCalled();
	});
});

describe("markPropertyExternal — clearing", () => {
	it("clears the marking and only the marking", async () => {
		const doc = gatedDoc({
			hint: "Where the order stands",
			external: { note: "pharmacy" },
		});
		expect(noWriterAdvisories(doc)).toHaveLength(0);
		const { ctx } = makeStubToolContext();
		const result = await markPropertyExternalTool.execute(
			{
				case_type: "medication_order",
				property: "order_status",
				external: null,
			},
			ctx,
			doc,
		);
		if ("error" in result.result) throw new Error(result.result.error);
		const after = catalogProperty(
			result.newDoc,
			"medication_order",
			"order_status",
		);
		expect(after?.external).toBeUndefined();
		expect(after?.hint).toBe("Where the order stands");
		// The gate is unwritten again — the advisory returns.
		expect(noWriterAdvisories(result.newDoc)).toHaveLength(1);
	});

	it("clearing an unmarked property is a successful no-op that persists nothing", async () => {
		const doc = gatedDoc();
		const { ctx, recordMutations } = makeStubToolContext();
		const result = await markPropertyExternalTool.execute(
			{
				case_type: "medication_order",
				property: "order_status",
				external: null,
			},
			ctx,
			doc,
		);
		if ("error" in result.result) throw new Error(result.result.error);
		expect(result.result.message).toContain("isn't marked external");
		expect(result.mutations).toHaveLength(0);
		expect(recordMutations).not.toHaveBeenCalled();
	});
});

describe("generateSchema × external — the marking survives enrichment", () => {
	it("a marking on a bare record neither blocks enrichment nor gets dropped by it", async () => {
		// A chokepoint-declared bare record whose property was then marked
		// external. Recording the model afterwards must still work (external
		// is not authored content for bareness), and the restated property
		// must carry the marking forward rather than silently un-marking it.
		const doc = buildDoc({
			caseTypes: [
				{
					name: "medication_order",
					properties: [
						{
							name: "order_status",
							label: "order_status",
							external: { note: "pharmacy" },
						},
					],
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
							fields: [f({ id: "med_given", kind: "text" })],
						},
					],
				},
			],
		});
		const { ctx } = makeStubToolContext();
		const result = await generateSchemaTool.execute(
			{
				caseTypes: [
					{
						name: "medication_order",
						properties: [
							{ name: "order_status", label: "Order status" },
							{ name: "ordered_on", label: "Ordered on", data_type: "date" },
						],
					},
				],
			},
			ctx,
			doc,
		);
		if ("error" in result.result) throw new Error(result.result.error);
		const after = catalogProperty(
			result.newDoc,
			"medication_order",
			"order_status",
		);
		expect(after?.label).toBe("Order status");
		expect(after?.external).toEqual({ note: "pharmacy" });
	});

	it("an explicit external: null on a restated property CLEARS the stored marking", async () => {
		// The edit-path law at the enrichment boundary: omission keeps (the
		// carry-forward), an explicit null clears — cleanCaseTypeRecord
		// collapses the null before the catalog sees it, so the tool reads
		// the distinction off the parsed input.
		const doc = buildDoc({
			caseTypes: [
				{
					name: "medication_order",
					properties: [
						{
							name: "order_status",
							label: "order_status",
							external: { note: "pharmacy" },
						},
					],
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
							fields: [f({ id: "med_given", kind: "text" })],
						},
					],
				},
			],
		});
		const { ctx } = makeStubToolContext();
		const result = await generateSchemaTool.execute(
			{
				caseTypes: [
					{
						name: "medication_order",
						properties: [
							{
								name: "order_status",
								label: "Order status",
								external: null,
							},
						],
					},
				],
			},
			ctx,
			doc,
		);
		if ("error" in result.result) throw new Error(result.result.error);
		const after = catalogProperty(
			result.newDoc,
			"medication_order",
			"order_status",
		);
		expect(after?.label).toBe("Order status");
		expect(after?.external).toBeUndefined();
	});

	it("an incoming record's own external wins over the carried one", async () => {
		const doc = buildDoc({
			caseTypes: [
				{
					name: "medication_order",
					properties: [
						{
							name: "order_status",
							label: "order_status",
							external: { note: "old note" },
						},
					],
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
							fields: [f({ id: "med_given", kind: "text" })],
						},
					],
				},
			],
		});
		const { ctx } = makeStubToolContext();
		const result = await generateSchemaTool.execute(
			{
				caseTypes: [
					{
						name: "medication_order",
						properties: [
							{
								name: "order_status",
								label: "Order status",
								external: { note: "set by the pharmacy app" },
							},
						],
					},
				],
			},
			ctx,
			doc,
		);
		if ("error" in result.result) throw new Error(result.result.error);
		expect(
			catalogProperty(result.newDoc, "medication_order", "order_status")
				?.external,
		).toEqual({ note: "set by the pharmacy app" });
	});
});
