// @vitest-environment happy-dom

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

type DragRecord = Record<string | symbol, unknown>;

interface DropEvent {
	readonly source: { readonly data: DragRecord };
	readonly location: {
		readonly current: {
			readonly dropTargets: readonly [{ readonly data: DragRecord }];
		};
	};
}

interface CapturedMonitor {
	readonly onDrop: (event: DropEvent) => void;
}

const monitorCapture = vi.hoisted(() => ({
	current: undefined as CapturedMonitor | undefined,
}));

vi.mock("@atlaskit/pragmatic-drag-and-drop/element/adapter", () => ({
	draggable: () => () => {},
	dropTargetForElements: () => () => {},
	monitorForElements: (config: CapturedMonitor) => {
		monitorCapture.current = config;
		return () => {};
	},
}));

vi.mock("@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge", () => ({
	attachClosestEdge: (data: DragRecord) => data,
	extractClosestEdge: () => null,
}));

import { reorderByKeyboard, useReorderableList } from "../useReorderableList";

interface Item {
	readonly id: string;
}

describe("useReorderableList", () => {
	it("moves the grabbed identity against the latest items after a remote reorder", () => {
		const a = { id: "a" };
		const b = { id: "b" };
		const c = { id: "c" };
		const d = { id: "d" };
		const onReorder = vi.fn();

		const { rerender } = renderHook(
			({ items }: { readonly items: readonly Item[] }) =>
				useReorderableList({
					containerKey: "the-list",
					containerKind: "test-items",
					items,
					itemKeys: items.map((item) => item.id),
					onReorder,
				}),
			{ initialProps: { items: [a, b, c, d] } },
		);

		// The pointer went down on b at index 1 and was hovering a at index 0.
		// Before drop, a multiplayer frame moved both rows to new positions.
		rerender({ items: [d, c, a, b] });

		act(() => {
			monitorCapture.current?.onDrop({
				source: {
					data: {
						kind: "list-item-drag",
						containerKind: "test-items",
						itemKey: "b",
						itemIndex: 1,
						nodeKey: "the-list",
					},
				},
				location: {
					current: {
						dropTargets: [
							{
								data: {
									kind: "list-item-drop",
									containerKind: "test-items",
									itemKey: "a",
									itemIndex: 0,
									nodeKey: "the-list",
								},
							},
						],
					},
				},
			});
		});

		expect(onReorder).toHaveBeenCalledOnce();
		expect(onReorder).toHaveBeenCalledWith([d, c, b, a], {
			item: b,
			fromIndex: 3,
			toIndex: 2,
		});
	});
});

describe("reorderByKeyboard", () => {
	const items = ["first", "second", "third"] as const;

	it("moves one place or directly to a boundary", () => {
		expect(reorderByKeyboard(items, 1, "ArrowUp")?.items).toEqual([
			"second",
			"first",
			"third",
		]);
		expect(reorderByKeyboard(items, 1, "End")?.items).toEqual([
			"first",
			"third",
			"second",
		]);
	});

	it("does not emit a mutation beyond a list boundary", () => {
		expect(reorderByKeyboard(items, 0, "ArrowUp")).toBeUndefined();
		expect(reorderByKeyboard(items, 2, "End")).toBeUndefined();
	});
});
