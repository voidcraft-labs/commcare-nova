// @vitest-environment happy-dom

import { act, renderHook } from "@testing-library/react";
import { type ReactNode, StrictMode } from "react";
import { describe, expect, it } from "vitest";
import {
	reconcileStableListKeys,
	stableValueFingerprint,
	useStableListIdentity,
} from "../useStableListIdentity";

interface Row {
	readonly value: string;
	readonly nested?: { readonly enabled: boolean };
}

const clone = <T,>(value: T): T => structuredClone(value);

function strictWrapper({ children }: { readonly children: ReactNode }) {
	return <StrictMode>{children}</StrictMode>;
}

describe("useStableListIdentity", () => {
	it("fingerprints equivalent objects canonically rather than by property order", () => {
		expect(
			stableValueFingerprint({ value: "a", nested: { enabled: true } }),
		).toBe(stableValueFingerprint({ nested: { enabled: true }, value: "a" }));
	});

	it("keeps unique occurrence keys through a structured clone with duplicates", () => {
		const initial: readonly Row[] = [
			{ value: "same" },
			{ value: "same" },
			{ value: "other" },
		];
		const { result, rerender } = renderHook(
			({ items }: { readonly items: readonly Row[] }) =>
				useStableListIdentity(items),
			{ initialProps: { items: initial }, wrapper: strictWrapper },
		);
		const before = [...result.current.keys];
		expect(new Set(before)).toHaveLength(3);

		rerender({ items: clone(initial) });

		expect(result.current.keys).toEqual(before);
	});

	it("retains a same-slot key for an operation-aware cloned replacement", () => {
		const initial: readonly Row[] = [{ value: "a" }, { value: "b" }];
		const { result, rerender } = renderHook(
			({ items }: { readonly items: readonly Row[] }) =>
				useStableListIdentity(items),
			{ initialProps: { items: initial } },
		);
		const before = [...result.current.keys];
		const next = [{ value: "edited" }, initial[1]];

		act(() => result.current.stage(next, { kind: "replace" }));
		rerender({ items: clone(next) });

		expect(result.current.keys).toEqual(before);
	});

	it("moves the chosen duplicate occurrence through a structured clone", () => {
		const first: Row = { value: "same" };
		const second: Row = { value: "same" };
		const other: Row = { value: "other" };
		const initial = [first, second, other];
		const { result, rerender } = renderHook(
			({ items }: { readonly items: readonly Row[] }) =>
				useStableListIdentity(items),
			{ initialProps: { items: initial } },
		);
		const [firstKey, secondKey, otherKey] = result.current.keys;
		const next = [second, first, other];

		act(() =>
			result.current.stage(next, {
				kind: "move",
				fromIndex: 1,
				toIndex: 0,
			}),
		);
		rerender({ items: clone(next) });

		expect(result.current.keys).toEqual([secondKey, firstKey, otherKey]);
	});

	it("discards a rejected equal-duplicate move before a later clone of old state", () => {
		const first: Row = { value: "same" };
		const second: Row = { value: "same" };
		const initial = [first, second];
		const { result, rerender } = renderHook(
			({ items }: { readonly items: readonly Row[] }) =>
				useStableListIdentity(items),
			{ initialProps: { items: initial } },
		);
		const before = [...result.current.keys];
		const moved = [second, first];

		act(() =>
			result.current.stage(moved, {
				kind: "move",
				fromIndex: 1,
				toIndex: 0,
			}),
		);
		// A guarded mutation rejection synchronously republishes the exact old list.
		rerender({ items: initial });
		expect(result.current.keys).toEqual(before);

		// A later unrelated document clone must not resurrect the rejected move.
		rerender({ items: clone(initial) });
		expect(result.current.keys).toEqual(before);
	});

	it("mints and removes the exact duplicate occurrence named by staged splices", () => {
		const first: Row = { value: "same" };
		const second: Row = { value: "same" };
		const initial = [first, second];
		const { result, rerender } = renderHook(
			({ items }: { readonly items: readonly Row[] }) =>
				useStableListIdentity(items),
			{ initialProps: { items: initial } },
		);
		const [firstKey, secondKey] = result.current.keys;
		const insertedRow: Row = { value: "same" };
		const inserted = [insertedRow, first, second];

		act(() =>
			result.current.stage(inserted, {
				kind: "splice",
				index: 0,
				deleteCount: 0,
				insertCount: 1,
			}),
		);
		rerender({ items: clone(inserted) });
		const insertedKey = result.current.keys[0];
		expect(result.current.keys).toEqual([insertedKey, firstKey, secondKey]);

		const removedMiddle = [insertedRow, second];
		act(() =>
			result.current.stage(removedMiddle, {
				kind: "splice",
				index: 1,
				deleteCount: 1,
				insertCount: 0,
			}),
		);
		rerender({ items: clone(removedMiddle) });
		expect(result.current.keys).toEqual([insertedKey, secondKey]);
	});

	it("mints only inserted rows and drops only removed rows", () => {
		const a: Row = { value: "a" };
		const b: Row = { value: "b" };
		const initial = [a, b];
		const { result, rerender } = renderHook(
			({ items }: { readonly items: readonly Row[] }) =>
				useStableListIdentity(items),
			{ initialProps: { items: initial } },
		);
		const [aKey, bKey] = result.current.keys;
		const inserted = [a, { value: "new" }, b];

		act(() =>
			result.current.stage(inserted, {
				kind: "splice",
				index: 1,
				deleteCount: 0,
				insertCount: 1,
			}),
		);
		rerender({ items: clone(inserted) });
		const insertedKey = result.current.keys[1];
		expect(result.current.keys).toEqual([aKey, insertedKey, bKey]);
		expect(insertedKey).not.toBe(aKey);
		expect(insertedKey).not.toBe(bKey);

		const removed = [inserted[0], inserted[2]];
		act(() =>
			result.current.stage(removed, {
				kind: "splice",
				index: 1,
				deleteCount: 1,
				insertCount: 0,
			}),
		);
		rerender({ items: clone(removed) });
		expect(result.current.keys).toEqual([aKey, bKey]);
	});

	it("does not transfer state from a removed head to a new tail", () => {
		const previousItems: readonly Row[] = [
			{ value: "a" },
			{ value: "b" },
			{ value: "c" },
		];
		const previousKeys = ["a-key", "b-key", "c-key"];
		const result = reconcileStableListKeys({
			previousItems,
			previousKeys,
			nextItems: clone([previousItems[1], previousItems[2], { value: "d" }]),
			prefix: "test",
			nextOrdinal: 3,
		});

		expect(result.keys.slice(0, 2)).toEqual(["b-key", "c-key"]);
		expect(result.keys[2]).not.toBe("a-key");
	});

	it("follows a distinct external reorder through a structured clone", () => {
		const previousItems: readonly Row[] = [
			{ value: "a" },
			{ value: "b" },
			{ value: "c" },
		];
		const result = reconcileStableListKeys({
			previousItems,
			previousKeys: ["a-key", "b-key", "c-key"],
			nextItems: clone([previousItems[2], previousItems[0], previousItems[1]]),
			prefix: "test",
			nextOrdinal: 3,
		});

		expect(result.keys).toEqual(["c-key", "a-key", "b-key"]);
	});

	it("conservatively retains one unambiguous external same-slot replacement", () => {
		const previousItems: readonly Row[] = [{ value: "a" }, { value: "b" }];
		const result = reconcileStableListKeys({
			previousItems,
			previousKeys: ["a-key", "b-key"],
			nextItems: clone([{ value: "edited" }, previousItems[1]]),
			prefix: "test",
			nextOrdinal: 2,
		});

		expect(result.keys).toEqual(["a-key", "b-key"]);
	});
});
