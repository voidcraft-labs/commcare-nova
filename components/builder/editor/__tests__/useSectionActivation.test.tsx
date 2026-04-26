// @vitest-environment happy-dom

/**
 * useSectionActivation — tests for the activation lifecycle bundled
 * with the section's partition.
 *
 * The hook owns three rules the section consumes:
 *   1. `activate(key)` flips a hidden-but-addable entry into the
 *      visible bucket with `autoFocus=true`.
 *   2. The pendingSatisfied effect clears activation the moment the
 *      entry's value lands by any path (typing, undo, sibling-flip).
 *   3. `onCommit(key, undefined)` clears activation synchronously when
 *      the user commits an empty value, so the editor unmounts and the
 *      Add Property pill returns.
 */

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { asUuid } from "@/lib/doc/types";
import type { TextField } from "@/lib/domain";
import type { FieldEditorEntry } from "@/lib/domain/kinds";
import { useSectionActivation } from "../useSectionActivation";

// Trivial stub component — only its identity matters for the partition.
const StubComponent = () => null;

const FIELD_UUID = asUuid("q-section-act-0000-0000-0000-000000000000");

const baseField: TextField = {
	kind: "text",
	uuid: FIELD_UUID,
	id: "name",
	label: "Name",
};

function entry(
	overrides: Partial<
		Omit<FieldEditorEntry<TextField>, "key" | "component">
	> = {},
	key: "hint" | "validate" = "hint",
): FieldEditorEntry<TextField> {
	return {
		key,
		component: StubComponent as unknown,
		label: key,
		...overrides,
	} as unknown as FieldEditorEntry<TextField>;
}

describe("useSectionActivation — initial render", () => {
	it("hidden + addable entry shows as a pill, not a visible editor", () => {
		const { result } = renderHook(() =>
			useSectionActivation(baseField, "ui", [
				entry({ visible: () => false, addable: true }),
			]),
		);
		expect(result.current.visible).toHaveLength(0);
		expect(result.current.pills).toHaveLength(1);
	});

	it("independently visible entry shows in the visible bucket with autoFocus=false", () => {
		const { result } = renderHook(() =>
			useSectionActivation(baseField, "ui", [entry({ visible: () => true })]),
		);
		expect(result.current.visible).toHaveLength(1);
		expect(result.current.visible[0].autoFocus).toBe(false);
		expect(result.current.pills).toHaveLength(0);
	});
});

describe("useSectionActivation — activate", () => {
	it("activate flips a pill into the visible bucket with autoFocus=true", () => {
		const entries = [entry({ visible: () => false, addable: true })];
		const { result, rerender } = renderHook(() =>
			useSectionActivation(baseField, "ui", entries),
		);
		act(() => result.current.activate("hint"));
		rerender();
		expect(result.current.pills).toHaveLength(0);
		expect(result.current.visible).toHaveLength(1);
		expect(result.current.visible[0].autoFocus).toBe(true);
	});
});

describe("useSectionActivation — pendingSatisfied effect (value lands)", () => {
	it("clears activation when an active entry becomes independently visible", () => {
		// Simulate the user-typing path: activate a pill, then re-render
		// with a field where the predicate now reports visible. The
		// partition's `pendingSatisfied` flag fires and the effect clears
		// pending, so the entry's autoFocus drops to false on the next render.
		const entries = [
			entry({ visible: (f: TextField) => !!f.hint, addable: true }),
		];
		let field: TextField = baseField;
		const { result, rerender } = renderHook(() =>
			useSectionActivation(field, "ui", entries),
		);
		// 1. Click the pill.
		act(() => result.current.activate("hint"));
		rerender();
		expect(result.current.visible[0].autoFocus).toBe(true);

		// 2. Value lands by some path (LLM, undo, user typing — all flow
		//    through the same independentlyVisible flip).
		field = { ...baseField, hint: "typed value" };
		rerender();

		// 3. The effect runs after the render that exposes
		//    pendingSatisfied=true. After it runs, pending is false; the
		//    next render shows autoFocus=false.
		rerender();
		expect(result.current.visible[0].autoFocus).toBe(false);
		expect(result.current.visible[0].independentlyVisible).toBe(true);
	});

	it("does not clear activation while the value is still missing", () => {
		// User clicked the pill but nothing has landed yet — pending must
		// stay true so the editor keeps autoFocus on subsequent renders.
		const entries = [entry({ visible: () => false, addable: true })];
		const { result, rerender } = renderHook(() =>
			useSectionActivation(baseField, "ui", entries),
		);
		act(() => result.current.activate("hint"));
		rerender();
		// Re-render with no field change — predicate still falsy, pending
		// must stay true.
		rerender();
		expect(result.current.visible[0].autoFocus).toBe(true);
	});
});

describe("useSectionActivation — onCommit (empty-commit clear)", () => {
	it("clears pending when the user commits an empty value on a pending entry", () => {
		// The bug this fixes: without the synchronous clear, partition
		// would still place the entry in the visible bucket because
		// `pending=true` overrides the now-falsy `visible()` predicate,
		// leaving an empty editor stuck on screen.
		const entries = [
			entry({ visible: (f: TextField) => !!f.hint, addable: true }),
		];
		const { result, rerender } = renderHook(() =>
			useSectionActivation(baseField, "ui", entries),
		);
		act(() => result.current.activate("hint"));
		rerender();
		expect(result.current.visible).toHaveLength(1);

		// User commits empty — onCommit should clear pending immediately.
		act(() => result.current.onCommit("hint", undefined));
		rerender();
		expect(result.current.visible).toHaveLength(0);
		expect(result.current.pills).toHaveLength(1);
	});

	it("is a no-op when committing a non-undefined value", () => {
		// Non-empty commits don't trigger the clear path here; the
		// pendingSatisfied effect handles them on the next render after
		// the predicate flips truthy.
		const entries = [entry({ visible: () => false, addable: true })];
		const { result, rerender } = renderHook(() =>
			useSectionActivation(baseField, "ui", entries),
		);
		act(() => result.current.activate("hint"));
		rerender();
		act(() => result.current.onCommit("hint", "typed value"));
		rerender();
		// Pending stays true because the field's predicate still reports
		// hidden (the test doesn't mutate the field).
		expect(result.current.visible[0].autoFocus).toBe(true);
	});

	it("is a no-op when the entry was not pending in the first place", () => {
		// Independently-visible entries clear themselves only via the
		// schema predicate; onCommit must not yank them out of the
		// visible bucket on a normal write.
		const entries = [entry({ visible: () => true })];
		const { result, rerender } = renderHook(() =>
			useSectionActivation(baseField, "ui", entries),
		);
		expect(result.current.visible).toHaveLength(1);
		act(() => result.current.onCommit("hint", undefined));
		rerender();
		expect(result.current.visible).toHaveLength(1);
	});
});
