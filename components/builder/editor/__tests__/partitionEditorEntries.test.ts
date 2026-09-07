/**
 * partitionEditorEntries: pure helper that decides which entries
 * become visible editors vs addable pills given a field value and the
 * module + form it is selected in.
 *
 * Owns the single rule set both the section (renders the partition)
 * and the panel (gates card chrome on the partition) read. These
 * tests pin the behaviors that matter:
 *   - autoFocus only when pending AND the entry isn't independently
 *     visible.
 *   - sectionHasContent returns false for "entries exist but all
 *     hidden non-addable" so empty labelled cards never mount.
 *   - every predicate receives the editor context, so an entry can be
 *     forced visible (an active row, never a pill) by where the field
 *     lives and not only by what it holds.
 */

import { describe, expect, it } from "vitest";
import { type TextField, uuidSchema } from "@/lib/domain";
import type { FieldEditorContext, FieldEditorEntry } from "@/lib/domain/kinds";
import { proseText } from "@/lib/domain/prose";
import {
	partitionEditorEntries,
	sectionHasContent,
} from "../partitionEditorEntries";

// Stub component: only its identity matters for the partition logic.
const StubComponent = () => null;

const baseField: TextField = {
	kind: "text",
	uuid: uuidSchema.parse("00000000-0000-7000-8000-000000000321"),
	id: "name",
	label: proseText("Name"),
};

const NO_CONTEXT: FieldEditorContext = null;
const FOLLOWUP: FieldEditorContext = {
	module: { caseType: "patient" },
	form: { type: "followup" },
};

function entry(
	overrides: Partial<
		Omit<FieldEditorEntry<TextField>, "key" | "component">
	> = {},
	key: "hint" | "validate" = "hint",
): FieldEditorEntry<TextField> {
	return {
		key,
		component: StubComponent,
		label: key,
		...overrides,
	} as FieldEditorEntry<TextField>;
}

describe("partitionEditorEntries", () => {
	it("buckets a visible entry into visible with autoFocus=false", () => {
		const { visible, pills } = partitionEditorEntries(
			baseField,
			[entry({ visible: () => true })],
			NO_CONTEXT,
		);
		expect(pills).toHaveLength(0);
		expect(visible).toHaveLength(1);
		expect(visible[0].autoFocus).toBe(false);
		expect(visible[0].independentlyVisible).toBe(true);
	});

	it("buckets a hidden addable entry as a pill", () => {
		const { visible, pills } = partitionEditorEntries(
			baseField,
			[entry({ visible: () => false, addable: true })],
			NO_CONTEXT,
		);
		expect(visible).toHaveLength(0);
		expect(pills).toHaveLength(1);
	});

	it("drops hidden non-addable entries entirely", () => {
		const { visible, pills } = partitionEditorEntries(
			baseField,
			[entry({ visible: () => false })],
			NO_CONTEXT,
		);
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
			NO_CONTEXT,
			(key) => key === "hint",
		);
		expect(visible).toHaveLength(1);
		expect(visible[0].autoFocus).toBe(true);
		expect(visible[0].independentlyVisible).toBe(false);
	});

	it("pending + independently visible → visible with autoFocus=false", () => {
		// When the predicate already reports visible (value committed by
		// any path), the pending flag must not carry autoFocus=true:
		// that would steal keyboard focus on the very next render.
		const { visible } = partitionEditorEntries(
			baseField,
			[entry({ visible: () => true, addable: true })],
			NO_CONTEXT,
			(key) => key === "hint",
		);
		expect(visible).toHaveLength(1);
		expect(visible[0].autoFocus).toBe(false);
		expect(visible[0].independentlyVisible).toBe(true);
	});

	it("treats missing visible predicate as always-visible", () => {
		// Entries without a `visible` function default to always-visible:
		// they never become pills, never get autoFocus.
		const { visible, pills } = partitionEditorEntries(
			baseField,
			[entry()],
			NO_CONTEXT,
		);
		expect(pills).toHaveLength(0);
		expect(visible).toHaveLength(1);
		expect(visible[0].independentlyVisible).toBe(true);
	});

	// ── Editor context ──────────────────────────────────────────────────
	// The predicate answers for the field AND where it lives. The same
	// entry on the same field is an active row in one context and a pill
	// in another, and the forced-visible arm is never a pill.

	it("hands each predicate the field and the editor context", () => {
		const seen: Array<[TextField, FieldEditorContext]> = [];
		partitionEditorEntries(
			baseField,
			[
				entry({
					visible: (field: TextField, context: FieldEditorContext) => {
						seen.push([field, context]);
						return false;
					},
				}),
			],
			FOLLOWUP,
		);
		expect(seen).toEqual([[baseField, FOLLOWUP]]);
	});

	it("a context-forced entry is an active row in that context and a pill outside it", () => {
		const contextual = entry({
			addable: true,
			visible: (_field: TextField, context: FieldEditorContext) =>
				context !== null && context.form.type === "followup",
		});
		const inside = partitionEditorEntries(baseField, [contextual], FOLLOWUP);
		expect(inside.visible).toHaveLength(1);
		expect(inside.visible[0].autoFocus).toBe(false);
		expect(inside.visible[0].independentlyVisible).toBe(true);
		expect(inside.pills).toHaveLength(0);

		const outside = partitionEditorEntries(baseField, [contextual], NO_CONTEXT);
		expect(outside.visible).toHaveLength(0);
		expect(outside.pills).toHaveLength(1);
	});

	// ── pendingSatisfied flag ───────────────────────────────────────────
	// The flag reports "the user-requested activation has now been
	// satisfied by the value landing." The section consumes this signal
	// to clear stale pending state so a later value-clear doesn't
	// re-trigger autoFocus and steal keyboard focus.

	it("pendingSatisfied is false when nothing is pending", () => {
		const { pendingSatisfied } = partitionEditorEntries(
			baseField,
			[entry({ visible: () => true })],
			NO_CONTEXT,
		);
		expect(pendingSatisfied).toBe(false);
	});

	it("pendingSatisfied is false when pending entry is NOT independently visible (still autoFocusing)", () => {
		// User clicked the pill; the value hasn't landed yet. Activation
		// must stay pending so the next render still passes autoFocus=true.
		const { pendingSatisfied } = partitionEditorEntries(
			baseField,
			[entry({ visible: () => false, addable: true })],
			NO_CONTEXT,
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
			NO_CONTEXT,
			(key) => key === "hint",
		);
		expect(pendingSatisfied).toBe(true);
	});

	it("pendingSatisfied is true even when only one of several pending entries has landed", () => {
		// Activation is section-scoped: at most one entry can be pending
		// at a time. The flag fires the moment any visible entry shows
		// the satisfied combo, even if others are still pending-and-hidden.
		const { pendingSatisfied } = partitionEditorEntries(
			baseField,
			[
				entry({ visible: () => true, addable: true }, "hint"),
				entry({ visible: () => false, addable: true }, "validate"),
			],
			NO_CONTEXT,
			(key) => key === "hint" || key === "validate",
		);
		expect(pendingSatisfied).toBe(true);
	});
});

describe("sectionHasContent", () => {
	it("returns true when at least one entry is independently visible", () => {
		expect(
			sectionHasContent(
				baseField,
				[entry({ visible: () => true })],
				NO_CONTEXT,
			),
		).toBe(true);
	});

	it("returns true when at least one entry is addable (pill)", () => {
		expect(
			sectionHasContent(
				baseField,
				[entry({ visible: () => false, addable: true })],
				NO_CONTEXT,
			),
		).toBe(true);
	});

	it("returns false when every entry is hidden non-addable", () => {
		// The invariant the panel depends on: entries exist in the
		// schema but every one of them would contribute nothing, so
		// the labelled card should not mount.
		expect(
			sectionHasContent(
				baseField,
				[
					entry({ visible: () => false }),
					entry({ visible: () => false }, "validate"),
				],
				NO_CONTEXT,
			),
		).toBe(false);
	});

	it("returns false for an empty entries array", () => {
		expect(sectionHasContent(baseField, [], NO_CONTEXT)).toBe(false);
	});

	it("threads the editor context to the predicates", () => {
		// A non-addable entry visible only in a followup context: the card
		// mounts there and nowhere else, so the panel and the section
		// cannot disagree about a context-forced row.
		const contextual = entry({
			visible: (_field: TextField, context: FieldEditorContext) =>
				context !== null && context.form.type === "followup",
		});
		expect(sectionHasContent(baseField, [contextual], FOLLOWUP)).toBe(true);
		expect(sectionHasContent(baseField, [contextual], NO_CONTEXT)).toBe(false);
	});
});
