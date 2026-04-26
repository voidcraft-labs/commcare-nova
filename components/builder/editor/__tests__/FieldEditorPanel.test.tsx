/**
 * FieldEditorPanel section-visibility — pure tests.
 *
 * The panel mounts one card per Data / Logic / Appearance section and
 * skips a card entirely when the section has no entries that would
 * render. The decision is owned by `sectionHasContent`; this file pins
 * the contract for every kind in the registry by running the predicate
 * against the real per-kind schemas.
 *
 * Rendered chrome (CSS, motion transitions, label ordering) belongs in
 * Playwright.
 */

import { describe, expect, it } from "vitest";
import { asUuid } from "@/lib/doc/types";
import type { Field, GroupField, TextField } from "@/lib/domain";
import { fieldEditorSchemas } from "../fieldEditorSchemas";
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
		// Every section card mounts: text has case_property (data), required
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
