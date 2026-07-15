/**
 * The case-list workspace has one globally ordered column sequence, but each
 * canvas renders a visibility projection of it. These tests pin the seam that
 * keeps hidden/detail-only columns out of the primary screen outlines while
 * preserving the one canonical full sequence for the inspector.
 */

import { describe, expect, it } from "vitest";
import { asUuid, type Column } from "@/lib/domain";
import { projectCaseWorkspaceColumns } from "../workspaceProjection";

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
