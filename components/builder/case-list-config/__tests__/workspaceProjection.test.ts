/**
 * Results and Details share field definitions but own independent visible
 * sequences. These tests pin the projection seam: information removed from a
 * screen stays out of the direct canvas and is available only to the add menu.
 */

import { describe, expect, it } from "vitest";
import { asUuid, type Column, emptyCaseListConfig } from "@/lib/domain";
import {
	projectCaseWorkspaceColumns,
	pruneStoppedSortOrphans,
	removeColumnFromDisplay,
	showColumnOnDisplay,
} from "../workspaceProjection";

function column(
	uuid: string,
	visibility: Pick<Column, "visibleInList" | "visibleInDetail"> = {},
): Column {
	return {
		uuid: asUuid(uuid),
		kind: "plain",
		field: uuid,
		header: uuid,
		...visibility,
	};
}

function uuids(columns: readonly Column[]): string[] {
	return columns.map((entry) => entry.uuid);
}

describe("projectCaseWorkspaceColumns", () => {
	it("sorts the full sequence and projects all four visibility combinations", () => {
		const both = column("both");
		const listOnly = column("list-only", {
			visibleInDetail: false,
		});
		const detailOnly = column("detail-only", {
			visibleInList: false,
		});
		const fullyHidden = column("fully-hidden", {
			visibleInList: false,
			visibleInDetail: false,
		});

		// Storage order deliberately differs from the two display sequences.
		const projection = projectCaseWorkspaceColumns({
			...emptyCaseListConfig(),
			columns: [both, detailOnly, listOnly, fullyHidden],
			listColumnOrder: [listOnly, both, detailOnly, fullyHidden].map(
				(entry) => entry.uuid,
			),
			detailColumnOrder: [listOnly, both, detailOnly, fullyHidden].map(
				(entry) => entry.uuid,
			),
		});

		expect(uuids(projection.ordered)).toEqual([
			"list-only",
			"both",
			"detail-only",
			"fully-hidden",
		]);
		expect(uuids(projection.listVisible)).toEqual(["list-only", "both"]);
		expect(uuids(projection.listHidden)).toEqual([
			"detail-only",
			"fully-hidden",
		]);
		expect(uuids(projection.detailVisible)).toEqual(["both", "detail-only"]);
		expect(uuids(projection.detailHidden)).toEqual([
			"list-only",
			"fully-hidden",
		]);
		expect(uuids(projection.fullyHidden)).toEqual(["fully-hidden"]);

		// An absent visibility slot is the domain's canonical `true`.
		expect(projection.listVisible).toContain(both);
		expect(projection.detailVisible).toContain(both);
	});

	it("does not mutate the storage array while deriving display order", () => {
		const later = column("later");
		const earlier = column("earlier");
		const storageOrder = [later, earlier];

		projectCaseWorkspaceColumns({
			...emptyCaseListConfig(),
			columns: storageOrder,
			listColumnOrder: [earlier.uuid, later.uuid],
			detailColumnOrder: [earlier.uuid, later.uuid],
		});

		expect(storageOrder).toEqual([later, earlier]);
	});
});

describe("removeColumnFromDisplay", () => {
	it("removes a field from Results without disturbing its Details placement", () => {
		const shared = column("shared");

		expect(removeColumnFromDisplay([shared], shared.uuid, "list")).toEqual([
			{ ...shared, visibleInList: false },
		]);
	});

	it("retains an unsorted field when its final screen hides it", () => {
		const detailOnly = column("detail-only", {
			visibleInList: false,
		});

		expect(
			removeColumnFromDisplay([detailOnly], detailOnly.uuid, "detail"),
		).toEqual([{ ...detailOnly, visibleInDetail: false }]);
	});

	it("keeps an off-screen definition while Default order still uses it", () => {
		const detailOnly = {
			...column("detail-only", { visibleInList: false }),
			sort: { direction: "asc" as const, priority: 0 },
		};

		expect(
			removeColumnFromDisplay([detailOnly], detailOnly.uuid, "detail"),
		).toEqual([{ ...detailOnly, visibleInDetail: false }]);
	});
});

describe("showColumnOnDisplay", () => {
	it("returns a Nova-hidden field to its saved Results position", () => {
		const hidden = {
			...column("hidden", { visibleInList: false }),
		};

		expect(showColumnOnDisplay([hidden], hidden.uuid, "list")).toEqual([
			{ ...hidden, visibleInList: undefined },
		]);
	});

	it("appends information that has never appeared on that screen", () => {
		const detailOnly = column("detail-only", {
			visibleInList: false,
		});

		expect(showColumnOnDisplay([detailOnly], detailOnly.uuid, "list")).toEqual([
			{
				...detailOnly,
				visibleInList: undefined,
			},
		]);
	});
});

describe("pruneStoppedSortOrphans", () => {
	it("retains an off-screen definition after its final ordering job ends", () => {
		const before = {
			...column("sort-only", {
				visibleInList: false,
				visibleInDetail: false,
			}),
			sort: { direction: "asc" as const, priority: 0 },
		};
		const { sort: _sort, ...after } = before;

		expect(pruneStoppedSortOrphans([before], [after])).toEqual([after]);
	});

	it("preserves untouched legacy off-screen definitions", () => {
		const legacy = column("legacy-search-only", {
			visibleInList: false,
			visibleInDetail: false,
		});

		expect(pruneStoppedSortOrphans([legacy], [legacy])).toEqual([legacy]);
	});
});
