// @vitest-environment happy-dom
//
// State-model coverage for the validity-propagation utilities every
// list-editor in this package consumes. Uses `renderHook` to drive
// the hook's state transitions directly — no DOM render, no card
// editor mount, no assertion on rendered chrome.
//
// Two utilities under test:
//
//   - `useInnerValidityShadow<T>(rows)` — aggregates per-row verdicts
//     via logical-AND; keyed by row reference (WeakMap) so reorder
//     followed by a verdict flip on the moved row writes against the
//     correct slot. The regression this hook defends against is the
//     index-keyed shadow's silent-aggregation-error after reorder.
//
//   - `useValidityPropagator({ isValid, onValidityChange })` — fires
//     the parent callback on mount + every transition with `isValid`
//     stashed against an effect that ignores parent-callback identity
//     changes.

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
	useInnerValidityShadow,
	useValidityPropagator,
} from "@/components/builder/shared/useInnerValidityShadow";

// Rows are tracked by REFERENCE in the WeakMap shadow; tests construct
// distinct objects to model distinct rows.
interface Row {
	readonly id: string;
}
const row = (id: string): Row => ({ id });

describe("useInnerValidityShadow — aggregation default", () => {
	it("returns true for an empty row list", () => {
		const { result } = renderHook(({ rows }) => useInnerValidityShadow(rows), {
			initialProps: { rows: [] as readonly Row[] },
		});
		expect(result.current.aggregatedValid).toBe(true);
	});

	it("returns true when no row has fired a verdict yet (every row defaults to valid)", () => {
		const rows: readonly Row[] = [row("a"), row("b"), row("c")];
		const { result } = renderHook(() => useInnerValidityShadow(rows));
		expect(result.current.aggregatedValid).toBe(true);
	});
});

describe("useInnerValidityShadow — AND aggregation", () => {
	it("flips to false when any single row fires invalid", () => {
		const rows: readonly Row[] = [row("a"), row("b"), row("c")];
		const { result } = renderHook(() => useInnerValidityShadow(rows));
		act(() => result.current.setRowValid(rows[1], false));
		expect(result.current.aggregatedValid).toBe(false);
	});

	it("stays true when every row fires valid", () => {
		const rows: readonly Row[] = [row("a"), row("b"), row("c")];
		const { result } = renderHook(() => useInnerValidityShadow(rows));
		act(() => {
			for (const r of rows) result.current.setRowValid(r, true);
		});
		expect(result.current.aggregatedValid).toBe(true);
	});

	it("flips back to true when the single invalid row is fixed", () => {
		const rows: readonly Row[] = [row("a"), row("b")];
		const { result } = renderHook(() => useInnerValidityShadow(rows));
		act(() => result.current.setRowValid(rows[0], false));
		expect(result.current.aggregatedValid).toBe(false);
		act(() => result.current.setRowValid(rows[0], true));
		expect(result.current.aggregatedValid).toBe(true);
	});
});

describe("useInnerValidityShadow — reorder-safe (the load-bearing regression)", () => {
	it("preserves per-row verdicts across a reorder of the rows array", () => {
		// Concrete walkthrough of the regression an index-keyed shadow
		// would allow. With ROW-IDENTITY keying, A's "invalid" verdict
		// survives the reorder because the WeakMap entry is keyed by A's
		// reference, not its index.
		const A = row("A");
		const B = row("B");
		const C = row("C");
		const initial: readonly Row[] = [A, B, C];

		const { result, rerender } = renderHook(
			({ rows }: { rows: readonly Row[] }) => useInnerValidityShadow(rows),
			{ initialProps: { rows: initial } },
		);

		act(() => result.current.setRowValid(A, false));
		expect(result.current.aggregatedValid).toBe(false);

		// Reorder. References survive (the reorder hook splices the
		// same objects into a new array order).
		rerender({ rows: [C, A, B] });
		expect(result.current.aggregatedValid).toBe(false);

		// Fix A. With identity keying, the write lands on A's slot, the
		// aggregation walks rows by reference, and the verdict flips.
		act(() => result.current.setRowValid(A, true));
		expect(result.current.aggregatedValid).toBe(true);
	});

	it("auto-collects a removed row's verdict when its reference leaves the rows array", () => {
		// The WeakMap shadow holds the row object weakly — removing the
		// row from `rows` (i.e. emitting a new array without it) makes
		// its entry eligible for GC. Even without observing the GC, the
		// aggregation no longer walks the removed row, so its prior
		// `false` verdict has no effect on the aggregate.
		const A = row("A");
		const B = row("B");
		const initial: readonly Row[] = [A, B];

		const { result, rerender } = renderHook(
			({ rows }: { rows: readonly Row[] }) => useInnerValidityShadow(rows),
			{ initialProps: { rows: initial } },
		);

		act(() => result.current.setRowValid(A, false));
		expect(result.current.aggregatedValid).toBe(false);

		// Remove A. The aggregate is now AND over [B], which has no
		// stored verdict and defaults to true.
		rerender({ rows: [B] });
		expect(result.current.aggregatedValid).toBe(true);
	});
});

describe("useInnerValidityShadow — no-op transition short-circuit", () => {
	it("skips the version bump when re-emitting the same verdict twice", () => {
		// The host's inner editor fires `onValidityChange` on every
		// render — most of which re-emit the same verdict. Once a row's
		// shadow entry exists, re-emitting the same value is a no-op
		// transition and must not bump the version counter. (The first
		// emit from a row IS a transition from the trivially-valid
		// default to an explicit entry; only subsequent same-value
		// emits short-circuit.)
		const A = row("A");
		const rows: readonly Row[] = [A];

		let renders = 0;
		const { result } = renderHook(() => {
			renders++;
			return useInnerValidityShadow(rows);
		});

		// First emit lands a real entry (default → explicit true).
		act(() => result.current.setRowValid(A, true));
		const rendersAfterFirstEmit = renders;

		// Same-value re-emit: no version bump, no re-render.
		act(() => result.current.setRowValid(A, true));
		expect(renders).toBe(rendersAfterFirstEmit);

		// Real transition: re-renders.
		act(() => result.current.setRowValid(A, false));
		expect(renders).toBeGreaterThan(rendersAfterFirstEmit);
		expect(result.current.aggregatedValid).toBe(false);

		const rendersAfterFlip = renders;
		// Re-emit `false`. No-op transition; no re-render.
		act(() => result.current.setRowValid(A, false));
		expect(renders).toBe(rendersAfterFlip);
	});
});

describe("useValidityPropagator — mount + transition", () => {
	it("fires the parent callback once on mount with the current isValid", () => {
		const onValidityChange = vi.fn();
		renderHook(() =>
			useValidityPropagator({ isValid: true, onValidityChange }),
		);
		expect(onValidityChange).toHaveBeenCalledTimes(1);
		expect(onValidityChange).toHaveBeenLastCalledWith(true);
	});

	it("fires again only when isValid transitions", () => {
		const onValidityChange = vi.fn();
		const { rerender } = renderHook(
			({ isValid }: { isValid: boolean }) =>
				useValidityPropagator({ isValid, onValidityChange }),
			{ initialProps: { isValid: true } },
		);
		expect(onValidityChange).toHaveBeenCalledTimes(1);

		// Same value: no re-fire.
		rerender({ isValid: true });
		expect(onValidityChange).toHaveBeenCalledTimes(1);

		// Transition: re-fires with the new value.
		rerender({ isValid: false });
		expect(onValidityChange).toHaveBeenCalledTimes(2);
		expect(onValidityChange).toHaveBeenLastCalledWith(false);
	});

	it("swaps the callback ref-stash so a later transition fires the LATEST callback, not the original", () => {
		// Two assertions in one test, both load-bearing for the ref-
		// stash contract:
		//   (a) a parent that constructs `onValidityChange={() => ...}`
		//       per-render must NOT trip the effect on every render —
		//       deps are `[isValid]`, identity changes alone don't fire.
		//   (b) when a real `isValid` transition lands AFTER an identity
		//       swap, the LATEST callback fires (not the original) —
		//       proves the ref captures the freshly-rendered callback,
		//       not the mount-time one.
		interface Props {
			readonly cb: (v: boolean) => void;
			readonly isValid: boolean;
		}
		const first = vi.fn();
		const second = vi.fn();
		const { rerender } = renderHook(
			({ cb, isValid }: Props) =>
				useValidityPropagator({ isValid, onValidityChange: cb }),
			{ initialProps: { cb: first, isValid: true } as Props },
		);
		expect(first).toHaveBeenCalledTimes(1);

		// Swap callback identity without changing isValid → no fire.
		rerender({ cb: second, isValid: true });
		expect(first).toHaveBeenCalledTimes(1);
		expect(second).not.toHaveBeenCalled();

		// Real transition with the swapped callback → the SWAPPED
		// callback fires (the ref-stash updated). `first` stays at one
		// call from mount; `second` receives the transition's new value.
		rerender({ cb: second, isValid: false });
		expect(first).toHaveBeenCalledTimes(1);
		expect(second).toHaveBeenCalledTimes(1);
		expect(second).toHaveBeenLastCalledWith(false);
	});

	it("tolerates an undefined parent callback", () => {
		// Mounting with no callback must not throw; the propagator's
		// effect calls through `?.` so an absent parent is a no-op.
		expect(() => {
			renderHook(() =>
				useValidityPropagator({ isValid: false, onValidityChange: undefined }),
			);
		}).not.toThrow();
	});
});
