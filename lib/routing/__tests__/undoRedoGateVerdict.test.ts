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
import {
	LOOKUP_CONTEXT_UNAVAILABLE,
	type LookupValidationContext,
} from "@/lib/doc/lookupReferences";
import { buildReferenceIndex } from "@/lib/doc/referenceIndex";
import type { BlueprintDoc } from "@/lib/doc/types";
import {
	lookupColumnIdSchema,
	lookupTableIdSchema,
} from "@/lib/domain/lookupIds";
import { proseText } from "@/lib/domain/prose";
import { parseLookupRevision } from "@/lib/lookup/schema";
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
			{ uuid: "q-a", kind: "text", id: "a", label: proseText("A-renamed") },
			{ uuid: "q-b", kind: "text", id: "b", label: proseText("B") },
		]);
		const verdict = undoRedoGateVerdict(
			displayed,
			[
				{
					kind: "updateField",
					uuid: testUuid("q-a"),
					targetKind: "text",
					patch: { label: proseText("A") },
				},
			],
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		expect(verdict.ok).toBe(true);
	});

	it("passes an empty step — nothing to introduce", () => {
		const displayed = docWithFields([
			{ uuid: "q-a", kind: "text", id: "a", label: proseText("A") },
		]);
		expect(
			undoRedoGateVerdict(displayed, [], LOOKUP_CONTEXT_UNAVAILABLE),
		).toEqual({ ok: true });
	});

	it("refuses a step that would introduce a finding", () => {
		// Taking back the add of the form's last remaining field would leave an
		// EMPTY_FORM — the shape a peer's removals can leave an old step facing.
		const displayed = docWithFields([
			{ uuid: "q-a", kind: "text", id: "a", label: proseText("A") },
		]);
		const verdict = undoRedoGateVerdict(
			displayed,
			[{ kind: "removeField", uuid: testUuid("q-a") }],
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		expect(verdict.ok).toBe(false);
		if (!verdict.ok) {
			// The message is the person-to-person rejection prose.
			expect(verdict.message).toContain("wasn't applied");
		}
	});
});

/* The gate is absolute: a lookup reference it cannot check is a soundness
 * finding, whatever the step touched. So on a doc that carries a lookup-backed
 * select, the verdict must run under the Project's lookup context the builder
 * holds — with an unavailable one, every undo and redo is refused. */
describe("undoRedoGateVerdict on a doc that carries a lookup source", () => {
	const TABLE = lookupTableIdSchema.parse(
		"01912d68-783e-7000-8000-00000000a001",
	);
	const VALUE = lookupColumnIdSchema.parse(
		"01912d68-783e-7000-8000-00000000c001",
	);
	const LABEL = lookupColumnIdSchema.parse(
		"01912d68-783e-7000-8000-00000000c002",
	);
	const REVISION = parseLookupRevision("1");
	const AVAILABLE: LookupValidationContext = {
		kind: "available",
		projectId: "project-1",
		projectRevision: REVISION,
		definitions: [
			{
				id: TABLE,
				name: "Destinations",
				tag: "destinations",
				definitionRevision: REVISION,
				columns: [
					{ id: VALUE, wireName: "code", label: "Code", dataType: "text" },
					{ id: LABEL, wireName: "name", label: "Name", dataType: "text" },
				],
			},
		],
	};

	function displayedWithLookupSelect(): BlueprintDoc {
		return docWithFields([
			{
				uuid: "q-a",
				kind: "single_select",
				id: "destination",
				label: proseText("Destination"),
				optionsSource: {
					kind: "lookup",
					tableId: TABLE,
					valueColumnId: VALUE,
					labelColumnId: LABEL,
				},
			},
			{ uuid: "q-b", kind: "text", id: "b", label: proseText("B-renamed") },
		]);
	}

	const takeBackRename = [
		{
			kind: "updateField" as const,
			uuid: testUuid("q-b"),
			targetKind: "text" as const,
			patch: { label: proseText("B") },
		},
	];

	it("passes an unrelated step under the Project's lookup context", () => {
		expect(
			undoRedoGateVerdict(
				displayedWithLookupSelect(),
				takeBackRename,
				AVAILABLE,
			),
		).toEqual({ ok: true });
	});

	it("refuses the same step when the lookup context is unavailable — fail closed", () => {
		const verdict = undoRedoGateVerdict(
			displayedWithLookupSelect(),
			takeBackRename,
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		expect(verdict.ok).toBe(false);
	});
});
