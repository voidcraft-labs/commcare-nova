/**
 * State-model tests for `undoRedoGateVerdict` — the pure gate the `useUndoRedo`
 * hook consults before it applies a recorded step.
 *
 * An undo is an ordinary edit: it applies the step's inverse through the same
 * write path everything else uses, so it runs the same commit verdict. What
 * makes the gate necessary is a peer — their committed change can make the
 * inverse reintroduce a finding, and refusing with the reason beats letting the
 * PUT 409 into a conflict reload. These tests exercise that decision purely —
 * no hook render, no DOM.
 */

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
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
	it("passes a benign step — taking back a label change", () => {
		const displayed = docWithFields([
			{ uuid: "q-a", kind: "text", id: "a", label: "A-renamed" },
			{ uuid: "q-b", kind: "text", id: "b", label: "B" },
		]);
		const verdict = undoRedoGateVerdict(displayed, [
			{
				kind: "updateField",
				uuid: testUuid("q-a"),
				targetKind: "text",
				patch: { label: "A" },
			},
		]);
		expect(verdict.ok).toBe(true);
	});

	it("passes an empty step — nothing to introduce", () => {
		const displayed = docWithFields([
			{ uuid: "q-a", kind: "text", id: "a", label: "A" },
		]);
		expect(undoRedoGateVerdict(displayed, [])).toEqual({ ok: true });
	});

	it("refuses a step that would introduce a finding", () => {
		// Taking back the add of the form's last remaining field would leave an
		// EMPTY_FORM — the shape a peer's removals can leave an old step facing.
		const displayed = docWithFields([
			{ uuid: "q-a", kind: "text", id: "a", label: "A" },
		]);
		const verdict = undoRedoGateVerdict(displayed, [
			{ kind: "removeField", uuid: testUuid("q-a") },
		]);
		expect(verdict.ok).toBe(false);
		if (!verdict.ok) {
			// The message is the person-to-person rejection prose.
			expect(verdict.message).toContain("wasn't applied");
		}
	});
});
