/**
 * Contract: the commit gate holds a menu's Details tabs and Details tile to the rules the stored
 * document's schema holds them to, on every editor: the tabs partition the fields shown in
 * Details, a tab of records orders its rows only by its own text or calculated fields in Details
 * order, and the Details tile places exactly the fields shown in Details. The plausible failure:
 * a batch planned over an older document (a tab's first field removed by a peer) or a partial
 * tile placement commits, then the save-time schema throws and both emitters throw on it.
 */
import { describe, expect, it } from "vitest";
import { tileFixture } from "@/lib/commcare/__tests__/tileFixture";
import { planDetailTabGroups } from "@/lib/doc/caseDetailTabMutations";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import type { Mutation } from "@/lib/doc/types";
import type { BlueprintDoc } from "@/lib/domain";
import { tileCell } from "@/lib/domain";
import { detailTabMembership } from "@/lib/domain/detailTabs";

function codes(doc: BlueprintDoc, mutations: Mutation[]): string[] {
	const verdict = mutationCommitVerdict(
		doc,
		mutations,
		LOOKUP_CONTEXT_UNAVAILABLE,
	);
	return verdict.ok ? [] : verdict.findings.map((finding) => finding.code);
}

function menuOf(doc: BlueprintDoc) {
	const menu = doc.modules[doc.moduleOrder[0]];
	const config = menu?.caseListConfig;
	if (!menu || !config) throw new Error("The fixture menu has a case list.");
	return { menu, config };
}

describe("the Details tabs at the gate", () => {
	it("refuses a removal replayed over tabs that start at the removed field", () => {
		const doc = tileFixture("detail-tabs");
		const { menu, config } = menuOf(doc);
		const start = config.detailTabs?.[1]?.startColumnUuid;
		if (!start) throw new Error("The fixture's second tab has a start.");
		// Planned over a document with no tabs, the removal carries no tab
		// patch.
		expect(
			codes(doc, [
				{ kind: "removeColumn", moduleUuid: menu.uuid, uuid: start },
			]),
		).toContain("CASE_DETAIL_TABS_INVALID");
	});

	it("refuses a tab ordering its rows by a field of another tab or of another kind", () => {
		const doc = tileFixture("conditional-search-children");
		const { menu, config } = menuOf(doc);
		const tabs = config.detailTabs ?? [];
		const [name, , lastVisit] = config.detailColumnOrder;
		for (const orderFields of [[name], [lastVisit]]) {
			const patched = tabs.map((tab, index) =>
				index === 1 ? { ...tab, orderFields } : tab,
			);
			const mutations: Mutation[] = [
				{
					kind: "setCaseListMeta",
					uuid: menu.uuid,
					patch: { detailTabs: patched },
				},
			];
			if (orderFields[0] === lastVisit)
				mutations.push({
					kind: "updateColumn",
					moduleUuid: menu.uuid,
					uuid: lastVisit,
					column: {
						kind: "date",
						field: "last_visit",
						header: "Last visit",
						pattern: "%Y-%m-%d",
					},
				});
			expect(codes(doc, mutations)).toContain("CASE_DETAIL_TABS_INVALID");
		}
		const own = tabs.map((tab, index) =>
			index === 1 ? { ...tab, orderFields: [lastVisit] } : tab,
		);
		expect(
			codes(doc, [
				{
					kind: "setCaseListMeta",
					uuid: menu.uuid,
					patch: { detailTabs: own },
				},
			]),
		).toEqual([]);
	});
});

describe("a tab's ordering fields through the tab planner", () => {
	it("keeps, when left out, only the ordering fields still in the tab", () => {
		const doc = tileFixture("conditional-search-children");
		const { menu, config } = menuOf(doc);
		const [name, village, lastVisit] = config.detailColumnOrder;
		const [first, second] = config.detailTabs ?? [];
		if (!first || !second) throw new Error("The fixture has two tabs.");
		const ordered = mutationCommitVerdict(
			doc,
			[
				{
					kind: "setCaseListMeta",
					uuid: menu.uuid,
					patch: {
						detailTabs: [first, { ...second, orderFields: [lastVisit] }],
					},
				},
			],
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		if (!ordered.ok) throw new Error(JSON.stringify(ordered.findings));
		const current = menuOf(ordered.nextDoc).config;
		// Move the ordering field into the first tab and leave orderFields out.
		const moved = planDetailTabGroups(menu.uuid, current, [
			{ uuid: first.uuid, title: first.title, fields: [name, lastVisit] },
			{ uuid: second.uuid, title: second.title, fields: [village] },
		]);
		if ("error" in moved) throw new Error(moved.error);
		const verdict = mutationCommitVerdict(
			ordered.nextDoc,
			moved.mutations,
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		expect(verdict.ok ? [] : verdict.findings).toEqual([]);
		if (!verdict.ok) return;
		const after = menuOf(verdict.nextDoc).config;
		expect(after.detailTabs?.[1]?.orderFields).toBeUndefined();
		expect(detailTabMembership(after).get(lastVisit)?.uuid).toBe(first.uuid);
	});

	it("refuses an ordering field that is neither text nor calculated", () => {
		const doc = tileFixture("conditional-search-children");
		const { menu, config } = menuOf(doc);
		const [name, village, lastVisit] = config.detailColumnOrder;
		const [first, second] = config.detailTabs ?? [];
		if (!first || !second) throw new Error("The fixture has two tabs.");
		const dated = {
			...config,
			columns: config.columns.map((column) =>
				column.uuid === lastVisit
					? {
							uuid: lastVisit,
							kind: "date" as const,
							field: "last_visit",
							header: "Last visit",
							pattern: "%Y-%m-%d",
						}
					: column,
			),
		};
		const plan = planDetailTabGroups(menu.uuid, dated, [
			{ uuid: first.uuid, title: first.title, fields: [name, village] },
			{
				uuid: second.uuid,
				title: second.title,
				fields: [lastVisit],
				orderFields: [lastVisit],
			},
		]);
		expect(plan).toEqual({
			error: expect.stringContaining("text or calculated"),
		});
	});
});

describe("the Details tile at the gate", () => {
	it("refuses a layout that leaves a shown field unplaced or places a field Details hides", () => {
		const doc = tileFixture("detail-layout");
		const { menu, config } = menuOf(doc);
		const cells = config.detailTile?.cells ?? {};
		const [first, ...rest] = Object.keys(cells);
		const partial = Object.fromEntries(rest.map((key) => [key, cells[key]]));
		expect(
			codes(doc, [
				{
					kind: "setCaseListMeta",
					uuid: menu.uuid,
					patch: { detailTile: { cells: partial } },
				},
			]),
		).toContain("CASE_DETAIL_TILE_LAYOUT_INVALID");
		const hidden = config.columns.find(
			(column) => column.visibleInDetail === false,
		);
		if (!hidden || !first) throw new Error("The fixture hides a field.");
		expect(
			codes(doc, [
				{
					kind: "setCaseListMeta",
					uuid: menu.uuid,
					patch: {
						detailTile: {
							cells: { ...cells, [hidden.uuid]: tileCell(0, 6, 12, 1) },
						},
					},
				},
			]),
		).toContain("CASE_DETAIL_TILE_LAYOUT_INVALID");
	});
});
