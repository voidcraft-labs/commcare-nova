/**
 * State-model tests for `undoRedoGateVerdict` — the pure collaborative-undo
 * gate the `useUndoRedo` hook consults before it mutates.
 *
 * The gate diffs the rebased undo/redo target against `localBase` (the
 * confirmed⊕sentPending base the reconciler PUTs from) and runs the same commit
 * verdict every write surface runs — the SAME delta the PUT will carry after the
 * undo — so an undo/redo that would reintroduce a validator finding is REFUSED
 * before any temporal mutation or PUT (and a gate pass can't 409-surprise).
 * These tests exercise that decision purely — no hook render, no DOM.
 */

import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	hydratePersistedBlueprint,
	toPersistableDoc,
} from "@/lib/doc/fieldParent";
import { buildReferenceIndex } from "@/lib/doc/referenceIndex";
import type { BlueprintDoc } from "@/lib/doc/types";
import { undoRedoGateVerdict } from "@/lib/routing/builderActions";

/** Hydrate a spec-built doc into a fully-indexed working doc (fieldParent +
 *  refIndex), matching what the store holds. */
function hydrate(doc: BlueprintDoc): BlueprintDoc {
	const h = hydratePersistedBlueprint(toPersistableDoc(doc));
	h.refIndex = buildReferenceIndex(h);
	return h;
}

/** A one-form survey doc with the given fields. */
function docWithFields(fields: Parameters<typeof f>[0][]): BlueprintDoc {
	return hydrate(
		buildDoc({
			appId: "app-1",
			appName: "App",
			modules: [
				{
					uuid: "module-1-uuid",
					name: "M",
					forms: [
						{
							uuid: "form-1-uuid",
							name: "F",
							type: "survey",
							fields: fields.map(f),
						},
					],
				},
			],
		}),
	);
}

describe("undoRedoGateVerdict", () => {
	it("passes a benign target (a field-label change) — { ok: true }", () => {
		const displayed = docWithFields([
			{ uuid: "q-a", kind: "text", id: "a", label: "A" },
			{ uuid: "q-b", kind: "text", id: "b", label: "B" },
		]);
		// The target renames field A's label — a valid edit, so the verdict passes.
		const target = docWithFields([
			{ uuid: "q-a", kind: "text", id: "a", label: "A-renamed" },
			{ uuid: "q-b", kind: "text", id: "b", label: "B" },
		]);
		// No pending → localBase equals displayed.
		expect(undoRedoGateVerdict(displayed, target, displayed)).toEqual({
			ok: true,
		});
	});

	it("refuses a target that would introduce a finding (an empty form)", () => {
		// Displayed: a valid form with one field.
		const displayed = docWithFields([
			{ uuid: "q-a", kind: "text", id: "a", label: "A" },
		]);
		// The rebased target strips every field — undoing to it would leave an
		// EMPTY_FORM, a finding the gate must catch. (In practice a remote frame
		// rebased the stacks so the recorded target no longer holds a valid state.)
		const target = docWithFields([]);
		const verdict = undoRedoGateVerdict(displayed, target, displayed);
		expect(verdict.ok).toBe(false);
		if (!verdict.ok) {
			// The message is the person-to-person rejection prose.
			expect(verdict.message).toContain("wasn't applied");
		}
	});

	it("passes a no-op target (identical doc) — nothing to introduce", () => {
		const displayed = docWithFields([
			{ uuid: "q-a", kind: "text", id: "a", label: "A" },
		]);
		expect(undoRedoGateVerdict(displayed, displayed, displayed)).toEqual({
			ok: true,
		});
	});

	// [4] — the gate verdicts the delta from `localBase` (NOT `displayed`) to the
	// target, matching what the reconciler PUTs after the undo. When `localBase`
	// differs from `displayed` (un-acked pending), the two deltas differ; a gate
	// keyed on `displayed` would verdict the wrong batch.
	it("verdicts the localBase→target delta, not displayed→target", () => {
		// localBase (confirmed+pending) still has BOTH fields.
		const localBase = docWithFields([
			{ uuid: "q-a", kind: "text", id: "a", label: "A" },
			{ uuid: "q-b", kind: "text", id: "b", label: "B" },
		]);
		// displayed has a local human edit that removed field B (not yet PUT).
		const displayed = docWithFields([
			{ uuid: "q-a", kind: "text", id: "a", label: "A" },
		]);
		// The undo target: back to only field B (field A removed). The PUT delta
		// is localBase→target = remove A. Against localBase (which has A+B) that's
		// a valid one-field form — passes. A gate keyed on `displayed` (only A)
		// would instead diff displayed→target = {remove A, add B}, a different
		// batch. Assert the gate uses the localBase delta.
		const target = docWithFields([
			{ uuid: "q-b", kind: "text", id: "b", label: "B" },
		]);
		const verdict = undoRedoGateVerdict(displayed, target, localBase);
		// localBase→target removes A, leaving B — a valid single-field form.
		expect(verdict.ok).toBe(true);
	});

	// The gate REFUSES when the localBase→target delta introduces a finding, even
	// though the displayed→target delta might not — proving it keys on localBase.
	it("refuses when the localBase→target delta introduces a finding", () => {
		// localBase has one field.
		const localBase = docWithFields([
			{ uuid: "q-a", kind: "text", id: "a", label: "A" },
		]);
		// displayed has a pending add of a second field.
		const displayed = docWithFields([
			{ uuid: "q-a", kind: "text", id: "a", label: "A" },
			{ uuid: "q-b", kind: "text", id: "b", label: "B" },
		]);
		// The undo target drops to an empty form. localBase→target = remove A →
		// EMPTY_FORM finding. (displayed→target = remove A + remove B — also a
		// finding, but the point is the gate verdicts against localBase.)
		const target = docWithFields([]);
		const verdict = undoRedoGateVerdict(displayed, target, localBase);
		expect(verdict.ok).toBe(false);
	});
});
