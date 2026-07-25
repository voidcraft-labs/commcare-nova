import { describe, expect, it } from "vitest";
import { summarizeBlueprint } from "@/lib/agent/summarizeBlueprint";
import { asUuid, plainColumn, tileCell } from "@/lib/domain";
import { getModuleTool } from "../../getModule";
import { MOD_A, makeCaseListFixture } from "./fixtures";

const A = asUuid("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
const B = asUuid("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
const C = asUuid("cccccccc-cccc-cccc-cccc-cccccccccccc");

function independentlyArrangedFixture() {
	const fixture = makeCaseListFixture();
	return {
		...fixture,
		doc: {
			...fixture.doc,
			modules: {
				...fixture.doc.modules,
				[MOD_A]: {
					...fixture.doc.modules[MOD_A],
					caseListConfig: {
						columns: [
							plainColumn(A, "case_name", "Patient", {
								listOrder: "z",
								detailOrder: "a",
							}),
							plainColumn(B, "phone", "Phone", {
								listOrder: "a",
								detailOrder: "z",
								visibleInDetail: false,
							}),
							plainColumn(C, "dob", "Date of birth", {
								listOrder: "b",
								detailOrder: "b",
								visibleInList: false,
							}),
						],
						searchInputs: [],
					},
				},
			},
		},
	};
}

describe("case-list read projections", () => {
	it("getModule exposes the exact independent visible screen sequences", async () => {
		const { doc, ctx } = independentlyArrangedFixture();
		const result = await getModuleTool.execute({ moduleIndex: 0 }, ctx, doc);
		if ("error" in result.data) throw new Error(result.data.error);

		expect(result.data.results_column_order).toEqual([B, A]);
		expect(result.data.details_column_order).toEqual([A, C]);
	});

	it("summary describes Results and Details as compositions, not hidden columns", () => {
		const { doc } = independentlyArrangedFixture();
		const summary = summarizeBlueprint(doc);
		const results = summary.indexOf("      results:");
		const details = summary.indexOf("      details:");

		expect(results).toBeGreaterThan(-1);
		expect(details).toBeGreaterThan(results);
		expect(summary.slice(results, details)).toMatch(/Phone[\s\S]*Patient/);
		expect(summary.slice(details)).toMatch(/Patient[\s\S]*Date of birth/);
		expect(summary).not.toContain("[list:");
		expect(summary).not.toContain("      columns:");
	});

	it("both read surfaces carry the tile layout and every placement", async () => {
		// Rearranging a tile means knowing every OTHER cell — two may never
		// overlap — so a read that showed the layout without the placements
		// would force a guess. The summary is the edit turn's only read.
		const base = independentlyArrangedFixture();
		const fixture = {
			...base,
			doc: {
				...base.doc,
				modules: {
					...base.doc.modules,
					[MOD_A]: {
						...base.doc.modules[MOD_A],
						caseListConfig: {
							searchInputs: [],
							columns: [
								plainColumn(A, "case_name", "Patient", {
									listOrder: "z",
									detailOrder: "a",
									tile: tileCell(0, 0, 12, 1, { fontSize: "large" }),
								}),
								plainColumn(B, "phone", "Phone", {
									listOrder: "a",
									detailOrder: "z",
									visibleInDetail: false,
									tile: tileCell(0, 1, 6, 2),
								}),
							],
							tile: { persistOnForms: true as const },
						},
					},
				},
			},
		};

		const result = await getModuleTool.execute(
			{ moduleIndex: 0 },
			fixture.ctx,
			fixture.doc,
		);
		if ("error" in result.data) throw new Error(result.data.error);
		expect(result.data.case_list_config?.tile).toEqual({
			persistOnForms: true,
		});
		expect(
			result.data.case_list_config?.columns.map((column) => column.tile),
		).toEqual([
			{ x: 0, y: 0, width: 12, height: 1, fontSize: "large" },
			{ x: 0, y: 1, width: 6, height: 2 },
		]);

		const summary = summarizeBlueprint(fixture.doc);
		expect(summary).toContain("layout: tile (kept above every form)");
		expect(summary).toContain("@ 0,0 12x1");
		expect(summary).toContain("@ 0,1 6x2");
	});

	it("leaves an untiled case list's summary unchanged", () => {
		// The placement suffix is keyed on the cell, not the layout switch, so an
		// app that has never used a tile pays nothing — its prompt prefix, which
		// the provider cache keys on, stays byte-identical.
		const { doc } = independentlyArrangedFixture();
		const summary = summarizeBlueprint(doc);

		expect(summary).not.toContain("layout: tile");
		expect(summary).not.toContain(" @ ");
	});
});
