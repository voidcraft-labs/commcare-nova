// components/builder/case-list-config/__tests__/tileBornValid.test.ts
//
// The arrangement switch against the REAL commit gate. "Turning the tile
// on lands a working layout" is only true if the gate agrees, so these
// run the planner's batch through `mutationCommitVerdict`: the same
// adjudication `useBlueprintMutations` performs, rather than trusting
// the planner's own arithmetic.

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import { columnSnapshotMutations } from "@/lib/doc/caseListColumnMutations";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import type { Mutation } from "@/lib/doc/types";
import {
	type BlueprintDoc,
	type Column,
	emptyCaseListConfig,
	plainColumn,
	tileGroupHeaderRowChoices,
	type Uuid,
} from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import {
	nextFreeTilePlacement,
	placementForJoiningTile,
	tileMembership,
} from "../tile/tileModel";
import {
	planTileGrouping,
	planTileLayoutDisable,
	planTileLayoutEnable,
} from "../tile/tileMutationPlan";

function docWithColumns(columns: readonly Column[]): {
	doc: BlueprintDoc;
	moduleUuid: Uuid;
} {
	const doc = buildDoc({
		caseTypes: [
			{
				name: "patient",
				properties: [
					{ name: "case_name", label: proseText("Name"), data_type: "text" },
					{ name: "village", label: proseText("Village"), data_type: "text" },
					{ name: "age", label: proseText("Age"), data_type: "int" },
				],
			},
		],
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				caseListConfig: { columns: [...columns], searchInputs: [] },
				forms: [
					{
						name: "Follow up",
						type: "followup",
						fields: [{ kind: "text", id: "note", label: proseText("Note") }],
					},
				],
			},
		],
	});
	const moduleUuid = doc.moduleOrder[0];
	if (moduleUuid === undefined) throw new Error("no module");
	return { doc, moduleUuid };
}

function column(field: string, header: string, slots: Partial<Column> = {}) {
	return {
		...plainColumn(testUuid(`col-${field}`), field, header),
		...slots,
	} as Column;
}

function accepts(doc: BlueprintDoc, mutations: readonly Mutation[]) {
	return mutationCommitVerdict(doc, mutations, LOOKUP_CONTEXT_UNAVAILABLE);
}

describe("turning the tile on", () => {
	it("commits as one batch the gate accepts", () => {
		const { doc, moduleUuid } = docWithColumns([
			column("case_name", "Patient name"),
			column("village", "Village"),
			column("age", "Age"),
		]);
		const plan = planTileLayoutEnable({
			moduleUuid,
			config: doc.modules[moduleUuid]?.caseListConfig ?? emptyCaseListConfig(),
		});
		expect(plan.ok).toBe(true);
		if (!plan.ok) return;

		const verdict = accepts(doc, plan.mutations);
		expect(verdict.ok).toBe(true);
	});

	it("would be refused without its seeded placements", () => {
		// The proof that seeding is load-bearing rather than decorative: the
		// switch alone introduces `CASE_LIST_TILE_COLUMN_NOT_PLACED`.
		const { doc, moduleUuid } = docWithColumns([
			column("case_name", "Patient name"),
		]);
		const verdict = accepts(doc, [
			{ kind: "setCaseListMeta", uuid: moduleUuid, patch: { tile: {} } },
		]);
		expect(verdict.ok).toBe(false);
		if (verdict.ok) return;
		expect(
			verdict.findings.some(
				(finding) => finding.code === "CASE_LIST_TILE_COLUMN_NOT_PLACED",
			),
		).toBe(true);
	});

	it("leaves a hidden default-order field unplaced — it draws nothing", () => {
		const { doc, moduleUuid } = docWithColumns([
			column("case_name", "Patient name"),
			column("age", "Age", {
				visibleInList: false,
				sort: { direction: "asc", priority: 1 },
			}),
		]);
		const plan = planTileLayoutEnable({
			moduleUuid,
			config: doc.modules[moduleUuid]?.caseListConfig ?? emptyCaseListConfig(),
		});
		expect(plan.ok).toBe(true);
		if (!plan.ok) return;
		const verdict = accepts(doc, plan.mutations);
		expect(verdict.ok).toBe(true);
		if (!verdict.ok) return;
		expect(
			verdict.nextDoc.modules[moduleUuid]?.caseListConfig?.columns.map(
				(entry) => entry.tile,
			),
		).toEqual([{ x: 0, y: 0, width: 12, height: 1 }, undefined]);
	});

	it("stays accepted at a full grid of single squares", () => {
		const columns = Array.from({ length: 144 }, (_unused, index) =>
			column(`age`, `Field ${index}`),
		).map((entry, index) => ({ ...entry, uuid: testUuid(`col-${index}`) }));
		const { doc, moduleUuid } = docWithColumns(columns);
		const plan = planTileLayoutEnable({
			moduleUuid,
			config: doc.modules[moduleUuid]?.caseListConfig ?? emptyCaseListConfig(),
		});
		expect(plan.ok).toBe(true);
		if (!plan.ok) return;
		expect(accepts(doc, plan.mutations).ok).toBe(true);
	});
});

describe("joining Results while it is a tile", () => {
	// The workspace's add and reveal paths carry a placement for exactly
	// this reason: an unplaced field the tile shows is a gate rejection, so
	// a bare add would refuse the author's ordinary gesture.
	function tiledDoc() {
		const { doc, moduleUuid } = docWithColumns([
			column("case_name", "Patient name", {
				tile: { x: 0, y: 0, width: 12, height: 1 },
			}),
		]);
		const enabled = accepts(doc, [
			{ kind: "setCaseListMeta", uuid: moduleUuid, patch: { tile: {} } },
		]);
		if (!enabled.ok) throw new Error("tile did not turn on");
		return { doc: enabled.nextDoc, moduleUuid };
	}

	it("is refused when the new field has no place", () => {
		const { doc, moduleUuid } = tiledDoc();
		const verdict = accepts(doc, [
			{
				kind: "addColumn",
				moduleUuid,
				column: column("village", "Village"),
				afterInList: null,
				afterInDetail: null,
			},
		]);
		expect(verdict.ok).toBe(false);
		if (verdict.ok) return;
		expect(
			verdict.findings.some(
				(finding) => finding.code === "CASE_LIST_TILE_COLUMN_NOT_PLACED",
			),
		).toBe(true);
	});

	it("re-places a hidden field whose saved square was taken while it was away", () => {
		// Hiding a field frees its square; the next field added lands on it.
		// Showing the first one again must not hand back the stale cell:
		// the gate refuses it, and the panel that refusal opens cannot move
		// a cell the tile no longer draws.
		const { doc, moduleUuid } = docWithColumns([
			column("case_name", "Patient name", {
				tile: { x: 0, y: 0, width: 12, height: 1 },
			}),
			column("age", "Age", {
				visibleInList: false,
				tile: { x: 0, y: 1, width: 12, height: 1 },
			}),
			column("village", "Village", {
				tile: { x: 0, y: 1, width: 12, height: 1 },
			}),
		]);
		const enabled = accepts(doc, [
			{ kind: "setCaseListMeta", uuid: moduleUuid, patch: { tile: {} } },
		]);
		expect(enabled.ok).toBe(true);
		if (!enabled.ok) return;

		const columns =
			enabled.nextDoc.modules[moduleUuid]?.caseListConfig?.columns ?? [];
		const hidden = columns.find((entry) => entry.uuid === testUuid("col-age"));
		expect(hidden).toBeDefined();
		if (hidden === undefined) return;

		// The stale cell would refuse; the re-adjudicated one commits.
		const stale = accepts(
			enabled.nextDoc,
			columnSnapshotMutations(moduleUuid, hidden, {
				...hidden,
				visibleInList: undefined,
			} as Column),
		);
		expect(stale.ok).toBe(false);

		const place = placementForJoiningTile(
			enabled.nextDoc.modules[moduleUuid]?.caseListConfig ??
				emptyCaseListConfig(),
			hidden,
		);
		expect(place).not.toBeNull();
		if (place === null) return;
		const revealed = accepts(
			enabled.nextDoc,
			columnSnapshotMutations(moduleUuid, hidden, {
				...hidden,
				visibleInList: undefined,
				tile: place,
			} as Column),
		);
		expect(revealed.ok).toBe(true);
	});

	it("is accepted when the field arrives carrying one", () => {
		const { doc, moduleUuid } = tiledDoc();
		const occupied = tileMembership(
			doc.modules[moduleUuid]?.caseListConfig ?? emptyCaseListConfig(),
		).placed.map((entry) => entry.cell);
		const place = nextFreeTilePlacement(occupied);
		expect(place).toEqual({ x: 0, y: 1, width: 12, height: 1 });
		if (place === null) return;
		const verdict = accepts(doc, [
			{
				kind: "addColumn",
				moduleUuid,
				column: {
					...column("village", "Village"),
					tile: place,
				} as Column,
				afterInList: null,
				afterInDetail: null,
			},
		]);
		expect(verdict.ok).toBe(true);
	});
});

describe("turning the tile off", () => {
	it("is accepted and leaves every placement in the document", () => {
		const { doc, moduleUuid } = docWithColumns([
			column("case_name", "Patient name"),
			column("village", "Village"),
		]);
		const enable = planTileLayoutEnable({
			moduleUuid,
			config: doc.modules[moduleUuid]?.caseListConfig ?? emptyCaseListConfig(),
		});
		expect(enable.ok).toBe(true);
		if (!enable.ok) return;
		const enabled = accepts(doc, enable.mutations);
		expect(enabled.ok).toBe(true);
		if (!enabled.ok) return;

		const disabled = accepts(
			enabled.nextDoc,
			planTileLayoutDisable(moduleUuid),
		);
		expect(disabled.ok).toBe(true);
		if (!disabled.ok) return;

		const config = disabled.nextDoc.modules[moduleUuid]?.caseListConfig;
		expect(config?.tile).toBeUndefined();
		expect(config?.columns.map((entry) => entry.tile)).toEqual([
			{ x: 0, y: 0, width: 12, height: 1 },
			{ x: 0, y: 1, width: 12, height: 1 },
		]);
	});

	it("lets the same drawing come straight back on", () => {
		const { doc, moduleUuid } = docWithColumns([
			column("case_name", "Patient name", {
				tile: { x: 0, y: 0, width: 6, height: 2 },
			}),
			column("village", "Village", {
				tile: { x: 6, y: 0, width: 6, height: 1 },
			}),
		]);
		const plan = planTileLayoutEnable({
			moduleUuid,
			config: doc.modules[moduleUuid]?.caseListConfig ?? emptyCaseListConfig(),
		});
		expect(plan.ok).toBe(true);
		if (!plan.ok) return;
		// Nothing needs seeding, so the batch is the switch alone.
		expect(plan.mutations).toHaveLength(1);
		const verdict = accepts(doc, plan.mutations);
		expect(verdict.ok).toBe(true);
		if (!verdict.ok) return;
		expect(
			verdict.nextDoc.modules[moduleUuid]?.caseListConfig?.columns.map(
				(entry) => entry.tile,
			),
		).toEqual([
			{ x: 0, y: 0, width: 6, height: 2 },
			{ x: 6, y: 0, width: 6, height: 1 },
		]);
	});
});

describe("grouping the tile", () => {
	/** A two-band tile: a name row over a village row, so a one-row
	 *  heading is a clean cut and a two-row one is not. */
	function bandedDoc() {
		const { doc, moduleUuid } = docWithColumns([
			column("case_name", "Patient name", {
				tile: { x: 0, y: 0, width: 12, height: 1 },
			}),
			column("village", "Village", {
				tile: { x: 0, y: 1, width: 12, height: 1 },
			}),
		]);
		const enabled = accepts(doc, [
			{ kind: "setCaseListMeta", uuid: moduleUuid, patch: { tile: {} } },
		]);
		if (!enabled.ok) throw new Error("tile did not turn on");
		return { doc: enabled.nextDoc, moduleUuid };
	}

	it("commits the depth the builder offers", () => {
		const { doc, moduleUuid } = bandedDoc();
		const config = doc.modules[moduleUuid]?.caseListConfig;
		const cells = (config?.columns ?? []).flatMap((entry) =>
			entry.tile === undefined ? [] : [entry.tile],
		);
		const offered = tileGroupHeaderRowChoices(cells);
		expect(offered).toEqual([1]);
		const verdict = accepts(doc, [
			...planTileGrouping(
				moduleUuid,
				{ identifier: "parent", headerRows: offered[0] ?? 1 },
				config?.tile,
			),
		]);
		expect(verdict.ok).toBe(true);
		if (!verdict.ok) return;
		expect(
			verdict.nextDoc.modules[moduleUuid]?.caseListConfig?.tile?.grouping,
		).toEqual({ identifier: "parent", headerRows: 1 });
	});

	it("is refused at a depth the builder withholds", () => {
		// The other half of the same contract: a heading covering both bands
		// leaves nothing per case, and the gate says so rather than the
		// author discovering it on the device.
		const { doc, moduleUuid } = bandedDoc();
		const verdict = accepts(doc, [
			...planTileGrouping(
				moduleUuid,
				{ identifier: "parent", headerRows: 2 },
				doc.modules[moduleUuid]?.caseListConfig?.tile,
			),
		]);
		expect(verdict.ok).toBe(false);
		if (verdict.ok) return;
		expect(
			verdict.findings.some(
				(finding) =>
					finding.code === "CASE_LIST_TILE_GROUP_HEADER_ROWS_OUT_OF_RANGE",
			),
		).toBe(true);
	});

	it("goes away with the tile, and the drawing still comes back", () => {
		const { doc, moduleUuid } = bandedDoc();
		const grouped = accepts(doc, [
			...planTileGrouping(
				moduleUuid,
				{ identifier: "parent", headerRows: 1 },
				doc.modules[moduleUuid]?.caseListConfig?.tile,
			),
		]);
		expect(grouped.ok).toBe(true);
		if (!grouped.ok) return;

		const disabled = accepts(
			grouped.nextDoc,
			planTileLayoutDisable(moduleUuid),
		);
		expect(disabled.ok).toBe(true);
		if (!disabled.ok) return;
		// Grouping lives INSIDE the layout, so turning the tile off takes it
		// with the layout: there is no orphaned `<group>` to emit and no
		// grouping setting waiting under a rows list. Every cell survives.
		const config = disabled.nextDoc.modules[moduleUuid]?.caseListConfig;
		expect(config?.tile).toBeUndefined();
		expect(config?.columns.map((entry) => entry.tile)).toEqual([
			{ x: 0, y: 0, width: 12, height: 1 },
			{ x: 0, y: 1, width: 12, height: 1 },
		]);

		// And coming back on is an ungrouped tile, not the old grouping
		// silently restored.
		const plan = planTileLayoutEnable({
			moduleUuid,
			config: config ?? emptyCaseListConfig(),
		});
		expect(plan.ok).toBe(true);
		if (!plan.ok) return;
		const reenabled = accepts(disabled.nextDoc, plan.mutations);
		expect(reenabled.ok).toBe(true);
		if (!reenabled.ok) return;
		expect(reenabled.nextDoc.modules[moduleUuid]?.caseListConfig?.tile).toEqual(
			{},
		);
	});
});
