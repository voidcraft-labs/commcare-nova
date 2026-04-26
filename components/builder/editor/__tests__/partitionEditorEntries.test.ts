// @vitest-environment happy-dom

/**
 * partitionEditorEntries — pure helper that decides which entries
 * become visible editors vs addable pills given a field value.
 *
 * Owns the single rule set both the section (renders the partition)
 * and the panel (gates card chrome on the partition) read. These
 * tests pin the behaviors that matter:
 *   - autoFocus only when pending AND the entry isn't independently
 *     visible.
 *   - sectionHasContent returns false for "entries exist but all
 *     hidden non-addable" so empty labelled cards never mount.
 */

import { describe, expect, it } from "vitest";
import type { TextField } from "@/lib/domain";
import type { FieldEditorEntry } from "@/lib/domain/kinds";
import {
	partitionEditorEntries,
	sectionHasContent,
} from "../partitionEditorEntries";

// Stub component — only its identity matters for the partition logic.
const StubComponent = () => null;

const baseField: TextField = {
	kind: "text",
	// The uuid is already branded; a hex literal satisfies the shape.
	uuid: "q-0000-0000-0000-0000-000000000000" as TextField["uuid"],
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

describe("partitionEditorEntries", () => {
	it("buckets a visible entry into visible with autoFocus=false", () => {
		const { visible, pills } = partitionEditorEntries(baseField, [
			entry({ visible: () => true }),
		]);
		expect(pills).toHaveLength(0);
		expect(visible).toHaveLength(1);
		expect(visible[0].autoFocus).toBe(false);
		expect(visible[0].independentlyVisible).toBe(true);
	});

	it("buckets a hidden addable entry as a pill", () => {
		const { visible, pills } = partitionEditorEntries(baseField, [
			entry({ visible: () => false, addable: true }),
		]);
		expect(visible).toHaveLength(0);
		expect(pills).toHaveLength(1);
	});

	it("drops hidden non-addable entries entirely", () => {
		const { visible, pills } = partitionEditorEntries(baseField, [
			entry({ visible: () => false }),
		]);
		expect(visible).toHaveLength(0);
		expect(pills).toHaveLength(0);
	});

	it("pending + not visible → visible with autoFocus=true", () => {
		// This is the pill-click path: predicate says hidden but the
		// activation flag forces it visible. autoFocus is true because
		// pending is the sole reason we're rendering it.
		const { visible } = partitionEditorEntries(
			baseField,
			[entry({ visible: () => false, addable: true })],
			(key) => key === "hint",
		);
		expect(visible).toHaveLength(1);
		expect(visible[0].autoFocus).toBe(true);
		expect(visible[0].independentlyVisible).toBe(false);
	});

	it("pending + independently visible → visible with autoFocus=false", () => {
		// When the predicate already reports visible (value committed by
		// any path), the pending flag must not carry autoFocus=true —
		// that would steal keyboard focus on the very next render.
		const { visible } = partitionEditorEntries(
			baseField,
			[entry({ visible: () => true, addable: true })],
			(key) => key === "hint",
		);
		expect(visible).toHaveLength(1);
		expect(visible[0].autoFocus).toBe(false);
		expect(visible[0].independentlyVisible).toBe(true);
	});

	it("treats missing visible predicate as always-visible", () => {
		// Entries without a `visible` function default to always-visible —
		// they never become pills, never get autoFocus.
		const { visible, pills } = partitionEditorEntries(baseField, [entry()]);
		expect(pills).toHaveLength(0);
		expect(visible).toHaveLength(1);
		expect(visible[0].independentlyVisible).toBe(true);
	});

	// ── pendingSatisfied flag ───────────────────────────────────────────
	// The flag reports "the user-requested activation has now been
	// satisfied by the value landing." The section consumes this signal
	// to clear stale pending state so a later value-clear doesn't
	// re-trigger autoFocus and steal keyboard focus.

	it("pendingSatisfied is false when nothing is pending", () => {
		const { pendingSatisfied } = partitionEditorEntries(baseField, [
			entry({ visible: () => true }),
		]);
		expect(pendingSatisfied).toBe(false);
	});

	it("pendingSatisfied is false when pending entry is NOT independently visible (still autoFocusing)", () => {
		// User clicked the pill; the value hasn't landed yet. Activation
		// must stay pending so the next render still passes autoFocus=true.
		const { pendingSatisfied } = partitionEditorEntries(
			baseField,
			[entry({ visible: () => false, addable: true })],
			(key) => key === "hint",
		);
		expect(pendingSatisfied).toBe(false);
	});

	it("pendingSatisfied is true when pending entry has become independently visible", () => {
		// The signal the section consumes to clear stale pending state:
		// pending=true AND independentlyVisible=true means the user's
		// pill-click intent has been fulfilled by a value landing.
		// Without this, a later value-clear would re-arm autoFocus and
		// hijack keyboard focus on the next render.
		const { pendingSatisfied } = partitionEditorEntries(
			baseField,
			[entry({ visible: () => true, addable: true })],
			(key) => key === "hint",
		);
		expect(pendingSatisfied).toBe(true);
	});

	it("pendingSatisfied is true even when only one of several pending entries has landed", () => {
		// Activation is section-scoped — at most one entry can be pending
		// at a time. The flag fires the moment any visible entry shows
		// the satisfied combo, even if others are still pending-and-hidden.
		const { pendingSatisfied } = partitionEditorEntries(
			baseField,
			[
				entry({ visible: () => true, addable: true }, "hint"),
				entry({ visible: () => false, addable: true }, "validate"),
			],
			(key) => key === "hint" || key === "validate",
		);
		expect(pendingSatisfied).toBe(true);
	});
});

describe("sectionHasContent", () => {
	it("returns true when at least one entry is independently visible", () => {
		expect(sectionHasContent(baseField, [entry({ visible: () => true })])).toBe(
			true,
		);
	});

	it("returns true when at least one entry is addable (pill)", () => {
		expect(
			sectionHasContent(baseField, [
				entry({ visible: () => false, addable: true }),
			]),
		).toBe(true);
	});

	it("returns false when every entry is hidden non-addable", () => {
		// The invariant the panel depends on: entries exist in the
		// schema but every one of them would contribute nothing, so
		// the labelled card should not mount.
		expect(
			sectionHasContent(baseField, [
				entry({ visible: () => false }),
				entry({ visible: () => false }, "validate"),
			]),
		).toBe(false);
	});

	it("returns false for an empty entries array", () => {
		expect(sectionHasContent(baseField, [])).toBe(false);
	});
});
