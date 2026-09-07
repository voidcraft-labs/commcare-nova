/**
 * Results and Details share field definitions but own independent visible
 * sequences. These tests pin the projection seam: information removed from a
 * screen stays out of the direct canvas and is available only to the add menu.
 */

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { type Column, emptyCaseListConfig } from "@/lib/domain";
import {
	projectCaseWorkspaceColumns,
	removeColumnFromDisplay,
	showColumnOnDisplay,
} from "../workspaceProjection";

function column(
	uuid: string,
	visibility: Pick<Column, "visibleInList" | "visibleInDetail"> = {},
): Column {
	return {
		uuid: testUuid(uuid),
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
			detailColumnOrder: [fullyHidden, detailOnly, both, listOnly].map(
				(entry) => entry.uuid,
			),
		});

		expect(uuids(projection.ordered)).toEqual([
			testUuid("list-only"),
			testUuid("both"),
			testUuid("detail-only"),
			testUuid("fully-hidden"),
		]);
		expect(uuids(projection.listVisible)).toEqual([
			testUuid("list-only"),
			testUuid("both"),
		]);
		expect(uuids(projection.listHidden)).toEqual([
			testUuid("detail-only"),
			testUuid("fully-hidden"),
		]);
		expect(uuids(projection.detailVisible)).toEqual([
			testUuid("detail-only"),
			testUuid("both"),
		]);
		expect(uuids(projection.detailHidden)).toEqual([
			testUuid("fully-hidden"),
			testUuid("list-only"),
		]);
		expect(uuids(projection.fullyHidden)).toEqual([testUuid("fully-hidden")]);

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

	it("asserts the exact stored permutations instead of skipping unknown uuids", () => {
		const saved = column("saved");
		expect(() =>
			projectCaseWorkspaceColumns({
				...emptyCaseListConfig(),
				columns: [saved],
				listColumnOrder: [testUuid("unknown")],
				detailColumnOrder: [saved.uuid],
			}),
		).toThrow(
			"Invalid list case-list column permutation reached orderedColumns.",
		);
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
			column("hidden"),
		]);
	});

	it("restores a previously Details-only definition without changing its Details visibility", () => {
		const detailOnly = column("detail-only", {
			visibleInList: false,
		});

		expect(showColumnOnDisplay([detailOnly], detailOnly.uuid, "list")).toEqual([
			{
				uuid: detailOnly.uuid,
				kind: "plain",
				field: "detail-only",
				header: "detail-only",
			},
		]);
	});
});
