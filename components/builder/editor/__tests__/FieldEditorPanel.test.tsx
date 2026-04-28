/**
 * FieldEditorPanel — pure registry-driven contract tests.
 *
 * Two contracts live here, both exercised against the real per-kind
 * schemas in `fieldEditorSchemas`:
 *
 *   1. Section visibility — `sectionHasContent` decides whether the
 *      panel mounts each card (Data / Logic / Appearance). The card
 *      skips when no entry would render and mounts otherwise.
 *
 *   2. `valueOnAdd` on `required` — every kind that exposes a
 *      `required` entry must declare `valueOnAdd: ALWAYS_REQUIRED`,
 *      so clicking "+ Required" turns the toggle on in one click
 *      rather than mounting an empty editor that the user has to
 *      manually flip.
 *
 * Rendered chrome (CSS, motion transitions, label ordering) belongs
 * in Playwright.
 */

import { describe, expect, it } from "vitest";
import { asUuid } from "@/lib/doc/types";
import {
	type Field,
	fieldKinds,
	type GroupField,
	type TextField,
} from "@/lib/domain";
import { fieldEditorSchemas } from "../fieldEditorSchemas";
import { ALWAYS_REQUIRED } from "../fields/requiredState";
import { sectionHasContent } from "../partitionEditorEntries";

// Trivial fixtures — only the discriminant + identity keys are read by
// the schema's visibility predicates. The schemas are kind-typed so the
// `field` cast inside each test narrows safely.
const FIELD_UUID = asUuid("q-panel-0000-0000-0000-000000000000");

function textField(extras: Partial<TextField> = {}): TextField {
	return {
		kind: "text",
		uuid: FIELD_UUID,
		id: "name",
		label: "Name",
		...extras,
	};
}

function groupField(extras: Partial<GroupField> = {}): GroupField {
	return {
		kind: "group",
		uuid: FIELD_UUID,
		id: "household",
		label: "Household",
		...extras,
	};
}

// Helpers that read the schema for a kind and ask each section the
// "would I render anything?" question. The cast through `unknown` is the
// minimum noise needed to pass the discriminated-union schema entries
// into the generic `sectionHasContent` — the runtime invariant is that
// `schemas[field.kind]` is the correct schema for the field's kind.
function panelSections<F extends Field>(
	field: F,
): { data: boolean; logic: boolean; ui: boolean } {
	const schema = fieldEditorSchemas[field.kind] as unknown as {
		data: readonly Parameters<typeof sectionHasContent<F>>[1][number][];
		logic: readonly Parameters<typeof sectionHasContent<F>>[1][number][];
		ui: readonly Parameters<typeof sectionHasContent<F>>[1][number][];
	};
	return {
		data: sectionHasContent(field, schema.data),
		logic: sectionHasContent(field, schema.logic),
		ui: sectionHasContent(field, schema.ui),
	};
}

describe("FieldEditorPanel section visibility", () => {
	it("text field exposes Data + Logic + Appearance sections", () => {
		// Every section card mounts: text has case_property_on (data), required
		// + relevant + validate (logic, all addable), and hint (ui, addable).
		expect(panelSections(textField())).toEqual({
			data: true,
			logic: true,
			ui: true,
		});
	});

	it("group field collapses to Logic only", () => {
		// Group has no data or ui entries — those cards never mount. Only
		// `relevant` (logic, addable) keeps the Logic card alive.
		expect(panelSections(groupField())).toEqual({
			data: false,
			logic: true,
			ui: false,
		});
	});

	it("a kind with empty data + ui sections never mounts those cards", () => {
		// Regression pin for the panel's contract: the schema-empty + no-
		// addable case must short-circuit to false so the panel doesn't
		// mount a labelled-but-empty card. Group is the canonical example.
		const sections = panelSections(groupField());
		expect(sections.data).toBe(false);
		expect(sections.ui).toBe(false);
	});
});

describe("required entry — valueOnAdd contract", () => {
	// Pins the section-pill UX rule registry-wide: clicking "+ Required"
	// turns the toggle on, not off. The entry's `valueOnAdd` is what
	// FieldEditorSection writes through `updateField` on pill click,
	// instead of the empty-editor + autoFocus dance the other addable
	// entries take. Without it, the user would have to click twice (add
	// property → flip toggle) to express one decision.
	//
	// Iterating `fieldKinds` and scanning every section of every schema
	// means a future kind that inlines a bare `{ key: "required" }`
	// entry without going through the `requiredEntry()` factory fails
	// here — the contract follows the registry instead of mirroring it.

	// Per-kind variants reference different `FieldEditorEntry<F>` shapes
	// that TS can't correlate when the schema is indexed by a
	// `kind: FieldKind` value. The cast collapses the union to the
	// minimal record this contract reads (`key` + `valueOnAdd`); a
	// stricter type would just be ceremony.
	interface ContractEntry {
		key: string;
		valueOnAdd?: unknown;
	}

	it.each(
		fieldKinds,
	)("%s schema's `required` entries (any section) write ALWAYS_REQUIRED on pill click", (kind) => {
		const schema = fieldEditorSchemas[kind] as unknown as {
			data: readonly ContractEntry[];
			logic: readonly ContractEntry[];
			ui: readonly ContractEntry[];
		};
		const sections = [schema.data, schema.logic, schema.ui];
		for (const section of sections) {
			for (const entry of section) {
				if (entry.key === "required") {
					expect(entry.valueOnAdd).toBe(ALWAYS_REQUIRED);
				}
			}
		}
	});
});
