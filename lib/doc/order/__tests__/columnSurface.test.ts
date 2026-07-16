import { describe, expect, it } from "vitest";
import type { Mutation, Uuid } from "@/lib/doc/types";
import { asUuid, type Column } from "@/lib/domain";
import {
	columnSurfaceMoveMutation,
	orderedColumnsOnSurface,
} from "../columnSurface";

const MODULE = asUuid("10000000-0000-4000-8000-000000000000");
const A = asUuid("20000000-0000-4000-8000-000000000001");
const B = asUuid("20000000-0000-4000-8000-000000000002");
const C = asUuid("20000000-0000-4000-8000-000000000003");

function column(
	uuid: Uuid,
	field: string,
	order: string,
	listOrder: string,
	detailOrder: string,
	extra: { visibleInList?: boolean; visibleInDetail?: boolean } = {},
): Column {
	return {
		uuid,
		kind: "plain",
		field,
		header: field.toUpperCase(),
		order,
		listOrder,
		detailOrder,
		...extra,
	};
}

const COLUMNS: Column[] = [
	column(A, "a", "a", "a", "c"),
	column(B, "b", "b", "b", "b"),
	column(C, "c", "c", "c", "a"),
];

function applyOne(columns: readonly Column[], mutation: Mutation): Column[] {
	return columns.map((candidate) => {
		if (candidate.uuid !== ("uuid" in mutation ? mutation.uuid : undefined)) {
			return candidate;
		}
		if (mutation.kind === "moveColumnInList") {
			return { ...candidate, listOrder: mutation.order ?? undefined };
		}
		if (mutation.kind === "moveColumnInDetail") {
			return { ...candidate, detailOrder: mutation.order ?? undefined };
		}
		return candidate;
	});
}

describe("columnSurfaceMoveMutation", () => {
	it("moves one Results row by changing only that row's list key", () => {
		const mutation = columnSurfaceMoveMutation({
			moduleUuid: MODULE,
			columns: COLUMNS,
			surface: "list",
			uuid: C,
			toIndex: 0,
		});

		expect(mutation).toMatchObject({
			kind: "moveColumnInList",
			moduleUuid: MODULE,
			uuid: C,
		});
		if (mutation === undefined) throw new Error("expected a move");
		const next = applyOne(COLUMNS, mutation);

		expect(orderedColumnsOnSurface(next, "list").map((c) => c.uuid)).toEqual([
			C,
			A,
			B,
		]);
		// Results changes independently; Details still consumes C, B, A.
		expect(orderedColumnsOnSurface(next, "detail").map((c) => c.uuid)).toEqual([
			C,
			B,
			A,
		]);
		expect(next[0]).toBe(COLUMNS[0]);
		expect(next[1]).toBe(COLUMNS[1]);
		expect(next[2]?.detailOrder).toBe(COLUMNS[2]?.detailOrder);
	});

	it("uses the legacy generic key as the neighbor bound", () => {
		const legacy = COLUMNS.map(({ listOrder: _listOrder, ...rest }) => rest);
		const mutation = columnSurfaceMoveMutation({
			moduleUuid: MODULE,
			columns: legacy,
			surface: "list",
			uuid: B,
			toIndex: 0,
		});

		expect(mutation?.kind).toBe("moveColumnInList");
		if (mutation?.kind !== "moveColumnInList") {
			throw new Error("expected a Results move");
		}
		expect(mutation.order).not.toBeNull();
		if (mutation.order === null) throw new Error("expected a fractional key");
		expect(mutation.order < "a").toBe(true);
	});

	it("does not write for an already-placed or omitted row", () => {
		expect(
			columnSurfaceMoveMutation({
				moduleUuid: MODULE,
				columns: COLUMNS,
				surface: "list",
				uuid: A,
				toIndex: 0,
			}),
		).toBeUndefined();

		const hidden = COLUMNS.map((candidate) =>
			candidate.uuid === A
				? ({ ...candidate, visibleInList: false } as Column)
				: candidate,
		);
		expect(
			columnSurfaceMoveMutation({
				moduleUuid: MODULE,
				columns: hidden,
				surface: "list",
				uuid: A,
				toIndex: 1,
			}),
		).toBeUndefined();
	});
});
