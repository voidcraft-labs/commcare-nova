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
		// A case list with no DRAWN placement pays nothing, so an app that has
		// never used a tile keeps a byte-identical prompt prefix — which is what
		// the provider cache keys on.
		const { doc } = independentlyArrangedFixture();
		const summary = summarizeBlueprint(doc);

		expect(summary).not.toContain("layout: tile");
		expect(summary).not.toContain(" @ ");
	});

	it("reports a placement only where the tile actually draws it", () => {
		// The SA reasons about overlap from this text: two cells may never share
		// a square, so a placement reported for a column the tile does NOT draw
		// makes the model route around an obstacle that is not on the grid, and
		// refuse its own next layout for a collision that cannot happen. Three
		// ways a stored cell goes undrawn, and none of them may be reported.
		const base = independentlyArrangedFixture();
		const withCells = (tile: { persistOnForms: true } | undefined) => ({
			...base.doc,
			modules: {
				...base.doc.modules,
				[MOD_A]: {
					...base.doc.modules[MOD_A],
					caseListConfig: {
						searchInputs: [],
						columns: [
							plainColumn(A, "case_name", "Patient", {
								tile: tileCell(0, 0, 4, 1),
							}),
							// Hidden from Results but still ordering the list: it rides
							// the detail as the zero-width carrier and holds no square.
							plainColumn(B, "phone", "Phone", {
								visibleInList: false,
								sort: { direction: "asc" as const, priority: 0 },
								tile: tileCell(4, 0, 8, 2),
							}),
						],
						...(tile === undefined ? {} : { tile }),
					},
				},
			},
		});

		const tiled = summarizeBlueprint(withCells({ persistOnForms: true }));
		// The drawn cell is reported in full.
		expect(tiled).toContain("@ 0,0 4x1");
		// The hidden carrier's retained cell is not.
		expect(tiled).not.toContain("@ 4,0 8x2");

		// Details is never a tile — long-detail tiles are out of scope — so no
		// placement is reported there even though the column carries one.
		const detailsBlock = tiled.slice(tiled.indexOf("details:"));
		expect(detailsBlock).not.toContain(" @ ");

		// Switching the layout off keeps every cell on the document, so the
		// author gets their drawing back — but nothing draws, so nothing is
		// reported.
		const untiled = summarizeBlueprint(withCells(undefined));
		expect(untiled).not.toContain("layout: tile");
		expect(untiled).not.toContain(" @ ");
	});
});
