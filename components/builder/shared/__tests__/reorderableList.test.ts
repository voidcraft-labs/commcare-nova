import { describe, expect, it } from "vitest";
import {
	reorderByKeyboard,
	reorderByStableItemKey,
	resolveListDrop,
} from "../useReorderableList";

const source = {
	kind: "list-item-drag",
	containerKind: "rows",
	nodeKey: "list",
	itemKey: "b",
	itemIndex: 1,
};
const target = {
	kind: "list-item-drop",
	containerKind: "rows",
	nodeKey: "list",
	itemKey: "a",
	itemIndex: 0,
};
const args = {
	containerKey: "list",
	containerKind: "rows",
	items: ["d", "c", "a", "b"],
	itemKeys: ["d", "c", "a", "b"],
	source,
	target,
	edge: null,
};

describe("current-snapshot drop decision", () => {
	it("resolves the grabbed and hovered identities after a peer reorder, ignoring stale payload positions", () => {
		expect(resolveListDrop(args)).toEqual({
			items: ["d", "c", "b", "a"],
			move: { item: "b", fromIndex: 3, toIndex: 2 },
			pending: { itemKey: "b", fromIndex: 3, toIndex: 2, refused: false },
		});
	});
	it("keeps refused hover destinations explicit and rechecks admission for the commit", () => {
		let allowed = false;
		const canDropAtIndex = (index: number) => index === 2 && allowed;
		expect(resolveListDrop({ ...args, canDropAtIndex })?.pending.refused).toBe(
			true,
		);
		allowed = true;
		expect(resolveListDrop({ ...args, canDropAtIndex })?.pending.refused).toBe(
			false,
		);
	});
	it.each([
		{ source: { ...source, nodeKey: "other" } },
		{ target: { ...target, nodeKey: "other" } },
		{ source: { ...source, containerKind: "other" } },
		{ target: { ...target, containerKind: "other" } },
		{ source: { ...source, kind: "unrelated" } },
		{ target: undefined },
		{ source: { ...source, itemKey: "removed" } },
		{ target: { ...target, itemKey: "removed" } },
		{ itemKeys: ["a"] },
	])("refuses foreign, removed or inconsistent drag data: %j", (change) => {
		expect(resolveListDrop({ ...args, ...change })).toBeUndefined();
	});
	it("suppresses adjacency no-ops on the after edge", () => {
		expect(resolveListDrop({ ...args, edge: "bottom" })).toBeUndefined();
		expect(resolveListDrop({ ...args, edge: "right" })).toBeUndefined();
	});
	it("inserts correctly in both directions and preserves the original list", () => {
		const items = Object.freeze(["a", "b", "c", "d"]);
		for (const [sourceItemKey, targetItemKey, placeAfterTarget, expected] of [
			["b", "d", true, ["a", "c", "d", "b"]],
			["d", "a", false, ["d", "a", "b", "c"]],
			["a", "c", false, ["b", "a", "c", "d"]],
		] as const) {
			expect(
				reorderByStableItemKey({
					items,
					itemKeys: items,
					sourceItemKey,
					targetItemKey,
					placeAfterTarget,
				})?.items,
			).toEqual(expected);
		}
		expect(items).toEqual(["a", "b", "c", "d"]);
	});
});

describe("keyboard list decision", () => {
	const items = ["a", "b", "c"];
	it.each([
		[1, "ArrowUp", ["b", "a", "c"], 0],
		[1, "ArrowDown", ["a", "c", "b"], 2],
		[2, "Home", ["c", "a", "b"], 0],
		[0, "End", ["b", "c", "a"], 2],
	] as const)("moves %i with %s", (from, key, expected, to) => {
		expect(reorderByKeyboard(items, from, key)).toEqual({
			items: expected,
			move: { item: items[from], fromIndex: from, toIndex: to },
		});
	});
	it.each([
		[0, "ArrowUp"],
		[2, "ArrowDown"],
		[0, "Home"],
		[2, "End"],
		[-1, "End"],
		[3, "Home"],
	] as const)("does not emit a boundary mutation: %i %s", (from, key) => {
		expect(reorderByKeyboard(items, from, key)).toBeUndefined();
	});
});
