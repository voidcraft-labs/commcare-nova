/**
 * Results and Details share field definitions but own independent visible
 * sequences. These tests pin the projection seam: information removed from a
 * screen stays out of the direct canvas and is available only to the add menu.
 */

import { describe, expect, it } from "vitest";
import { asUuid, type Column } from "@/lib/domain";
import {
	projectCaseWorkspaceColumns,
	pruneStoppedSortOrphans,
	removeColumnFromDisplay,
	showColumnOnDisplay,
} from "../workspaceProjection";

function column(
	uuid: string,
	order: string,
	visibility: Pick<Column, "visibleInList" | "visibleInDetail"> = {},
): Column {
	return {
		uuid: asUuid(uuid),
		order,
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
		const both = column("both", "d");
		const listOnly = column("list-only", "a", {
			visibleInDetail: false,
		});
		const detailOnly = column("detail-only", "c", {
			visibleInList: false,
		});
		const fullyHidden = column("fully-hidden", "b", {
			visibleInList: false,
			visibleInDetail: false,
		});

		const projection = projectCaseWorkspaceColumns([
			both,
			detailOnly,
			listOnly,
			fullyHidden,
		]);

		expect(uuids(projection.ordered)).toEqual([
			"list-only",
			"fully-hidden",
			"detail-only",
			"both",
		]);
		expect(uuids(projection.listVisible)).toEqual(["list-only", "both"]);
		expect(uuids(projection.listHidden)).toEqual([
			"fully-hidden",
			"detail-only",
		]);
		expect(uuids(projection.detailVisible)).toEqual(["detail-only", "both"]);
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
		const later = column("later", "z");
		const earlier = column("earlier", "a");
		const storageOrder = [later, earlier];

		projectCaseWorkspaceColumns(storageOrder);

		expect(storageOrder).toEqual([later, earlier]);
	});
});

describe("removeColumnFromDisplay", () => {
	it("removes a field from Results without disturbing its Details placement", () => {
		const shared = column("shared", "a");

		expect(removeColumnFromDisplay([shared], shared.uuid, "list")).toEqual([
			{ ...shared, listOrder: "a", visibleInList: false },
		]);
	});

	it("retains an unsorted field when its final screen hides it", () => {
		const detailOnly = column("detail-only", "a", {
			visibleInList: false,
		});

		expect(
			removeColumnFromDisplay([detailOnly], detailOnly.uuid, "detail"),
		).toEqual([{ ...detailOnly, detailOrder: "a", visibleInDetail: false }]);
	});

	it("keeps an off-screen definition while Default order still uses it", () => {
		const detailOnly = {
			...column("detail-only", "a", { visibleInList: false }),
			sort: { direction: "asc" as const, priority: 0 },
		};

		expect(
			removeColumnFromDisplay([detailOnly], detailOnly.uuid, "detail"),
		).toEqual([{ ...detailOnly, detailOrder: "a", visibleInDetail: false }]);
	});
});

describe("showColumnOnDisplay", () => {
	it("returns a Nova-hidden field to its saved Results position", () => {
		const hidden = {
			...column("hidden", "a", { visibleInList: false }),
			listOrder: "saved-place",
		};

		expect(
			showColumnOnDisplay([hidden], hidden.uuid, "list", "append-place"),
		).toEqual([{ ...hidden, visibleInList: undefined }]);
	});

	it("appends information that has never appeared on that screen", () => {
		const detailOnly = column("detail-only", "a", {
			visibleInList: false,
		});

		expect(
			showColumnOnDisplay(
				[detailOnly],
				detailOnly.uuid,
				"list",
				"append-place",
			),
		).toEqual([
			{
				...detailOnly,
				visibleInList: undefined,
				listOrder: "append-place",
			},
		]);
	});
});

describe("pruneStoppedSortOrphans", () => {
	it("retains an off-screen definition after its final ordering job ends", () => {
		const before = {
			...column("sort-only", "a", {
				visibleInList: false,
				visibleInDetail: false,
			}),
			sort: { direction: "asc" as const, priority: 0 },
		};
		const { sort: _sort, ...after } = before;

		expect(pruneStoppedSortOrphans([before], [after])).toEqual([after]);
	});

	it("preserves untouched legacy off-screen definitions", () => {
		const legacy = column("legacy-search-only", "a", {
			visibleInList: false,
			visibleInDetail: false,
		});

		expect(pruneStoppedSortOrphans([legacy], [legacy])).toEqual([legacy]);
	});
});
