import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { summarizeBlueprint } from "@/lib/agent/summarizeBlueprint";
import { type BlueprintDoc, plainColumn, tileCell } from "@/lib/domain";
import { getModuleTool } from "../../getModule";
import { MOD_A, makeCaseListDoc, makeCaseListFixture } from "./fixtures";

const A = testUuid("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
const B = testUuid("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
const C = testUuid("cccccccc-cccc-cccc-cccc-cccccccccccc");

function independentlyArrangedDoc(): BlueprintDoc {
	const doc = makeCaseListDoc();
	return {
		...doc,
		modules: {
			...doc.modules,
			[MOD_A]: {
				...doc.modules[MOD_A],
				caseListConfig: {
					columns: [
						plainColumn(A, "case_name", "Patient", {}),
						plainColumn(B, "phone", "Phone", {
							visibleInDetail: false,
						}),
						plainColumn(C, "dob", "Date of birth", {
							visibleInList: false,
						}),
					],
					// Two independent arrangements over one set: Results shows
					// Phone above Patient, Details shows Patient above Date of
					// birth. Every column is a member of BOTH sequences —
					// visibility is what decides which of them draws.
					listColumnOrder: [B, A, C],
					detailColumnOrder: [A, C, B],
					searchInputs: [],
				},
			},
		},
	};
}

describe("case-list read projections", () => {
	it("getModule exposes the exact independent visible screen sequences", async () => {
		const h = makeCaseListFixture(independentlyArrangedDoc());
		const result = await h.runTool(getModuleTool, { moduleUuid: MOD_A });
		if ("error" in result.data) throw new Error(result.data.error);

		expect(result.data.results_column_order).toEqual([B, A]);
		expect(result.data.details_column_order).toEqual([A, C]);
	});

	it("summary preserves dormant definitions separately from screen compositions", () => {
		const base = independentlyArrangedDoc();
		const dormant = plainColumn(
			testUuid("dddddddd-dddd-dddd-dddd-dddddddddddd"),
			"external_id",
			"External ID",
			{ visibleInList: false, visibleInDetail: false },
		);
		const config = base.modules[MOD_A]?.caseListConfig;
		if (config === undefined) throw new Error("fixture config missing");
		const doc = {
			...base,
			modules: {
				...base.modules,
				[MOD_A]: {
					...base.modules[MOD_A],
					caseListConfig: {
						...config,
						columns: [...config.columns, dormant],
						listColumnOrder: [...config.listColumnOrder, dormant.uuid],
						detailColumnOrder: [...config.detailColumnOrder, dormant.uuid],
					},
				},
			},
		};
		const summary = summarizeBlueprint(doc);
		const results = summary.indexOf("      results:");
		const details = summary.indexOf("      details:");
		const saved = summary.indexOf("      saved_off_screen:");

		expect(results).toBeGreaterThan(-1);
		expect(details).toBeGreaterThan(results);
		expect(saved).toBeGreaterThan(details);
		expect(summary.slice(results, details)).toMatch(/Phone[\s\S]*Patient/);
		expect(summary.slice(details, saved)).toMatch(
			/Patient[\s\S]*Date of birth/,
		);
		expect(summary.slice(saved)).toContain(String(dormant.uuid));
		expect(summary.slice(saved)).toContain("External ID");
		expect(summary).not.toContain("[list:");
		expect(summary).not.toContain("      columns:");
	});

	it("both read surfaces carry the tile layout and every placement", async () => {
		// Rearranging a tile means knowing every OTHER cell — two may never
		// overlap — so a read that showed the layout without the placements
		// would force a guess. The summary is the edit turn's only read.
		const base = independentlyArrangedDoc();
		const doc = {
			...base,
			modules: {
				...base.modules,
				[MOD_A]: {
					...base.modules[MOD_A],
					caseListConfig: {
						searchInputs: [],
						columns: [
							plainColumn(A, "case_name", "Patient", {
								tile: tileCell(0, 0, 12, 1, { fontSize: "large" }),
							}),
							plainColumn(B, "phone", "Phone", {
								visibleInDetail: false,
								tile: tileCell(0, 1, 6, 2),
							}),
						],
						listColumnOrder: [A, B],
						detailColumnOrder: [A, B],
						tile: { persistOnForms: true as const },
					},
				},
			},
		};

		const h = makeCaseListFixture(doc);
		const result = await h.runTool(getModuleTool, { moduleUuid: MOD_A });
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

		const summary = summarizeBlueprint(doc);
		expect(summary).toContain("layout: tile (kept above every form)");
		expect(summary).toContain("@ 0,0 12x1");
		expect(summary).toContain("@ 0,1 6x2");
	});

	it("reports grouping on both read surfaces, with what it costs", async () => {
		// Grouping changes what a placement MEANS: a cell in the header band is
		// drawn once per group, from the group's first case. A read surface
		// that showed the cells without it would have the model rearranging a
		// tile whose shape it does not know — and the two consequences it
		// cannot infer from the layout are what it has to tell the user.
		const base = independentlyArrangedDoc();
		const doc = {
			...base,
			modules: {
				...base.modules,
				[MOD_A]: {
					...base.modules[MOD_A],
					caseListConfig: {
						searchInputs: [],
						columns: [
							plainColumn(A, "case_name", "Patient", {
								tile: tileCell(0, 0, 12, 1),
							}),
							plainColumn(B, "phone", "Phone", {
								tile: tileCell(0, 1, 12, 1),
							}),
						],
						listColumnOrder: [A, B],
						detailColumnOrder: [A, B],
						tile: {
							grouping: { identifier: "parent", headerRows: 1 },
						},
					},
				},
			},
		};

		const h = makeCaseListFixture(doc);
		const result = await h.runTool(getModuleTool, { moduleUuid: MOD_A });
		if ("error" in result.data) throw new Error(result.data.error);
		expect(result.data.case_list_config?.tile).toEqual({
			grouping: { identifier: "parent", headerRows: 1 },
		});

		const summary = summarizeBlueprint(doc);
		expect(summary).toContain("grouped_by: parent connection");
		expect(summary).toContain("top row is the group heading");
		expect(summary).toContain("choosing a group opens that first case");
		expect(summary).toContain("cases with no parent connection are one group");
	});

	it("leaves an untiled case list's summary unchanged", () => {
		// A case list with no DRAWN placement pays nothing, so an app that has
		// never used a tile keeps a byte-identical prompt prefix — which is what
		// the provider cache keys on.
		const doc = independentlyArrangedDoc();
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
		const base = independentlyArrangedDoc();
		const withCells = (tile: { persistOnForms: true } | undefined) => ({
			...base,
			modules: {
				...base.modules,
				[MOD_A]: {
					...base.modules[MOD_A],
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
						// Every column is a member of BOTH sequences whatever its
						// visibility — that is what lets a hidden one keep its place.
						listColumnOrder: [A, B],
						detailColumnOrder: [A, B],
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
