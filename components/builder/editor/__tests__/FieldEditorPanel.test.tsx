/**
 * FieldEditorPanel: pure registry-driven contract tests.
 *
 * The section-content contract is exercised against the real per-kind
 * schemas in `fieldEditorSchemas`:
 *
 *   1. Section visibility: `sectionHasContent` decides whether the
 *      panel mounts each card (Data / Logic / Appearance). The card
 *      skips when no entry would render and mounts otherwise.
 *   2. The `default_value` entry's answer depends on where the field
 *      lives: an active row (never a pill) on a writer the form opens
 *      with the loaded case's value, an addable pill everywhere else,
 *      and absent on the capture kinds.
 *   3. A hidden field's Logic section is the single Value control plus
 *      Show when; there is no separate default-value entry to add.
 *
 * Required pill activation uses FieldEditorSection and its actual
 * requiredEntry factory in the native browser suite.
 *
 * Rendered chrome (CSS, motion transitions, label ordering) belongs
 * in Playwright.
 */

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { xp } from "@/lib/__tests__/docHelpers";
import {
	captureFieldKinds,
	type Field,
	type GroupField,
	type HiddenField,
	type TextField,
} from "@/lib/domain";
import type { FieldEditorContext, FieldEditorEntry } from "@/lib/domain/kinds";
import { proseText } from "@/lib/domain/prose";
import { fieldEditorSchemas } from "../fieldEditorSchemas";
import {
	partitionEditorEntries,
	sectionHasContent,
} from "../partitionEditorEntries";

// Trivial fixtures: only the discriminant + identity keys are read by
// the schema's visibility predicates. The schemas are kind-typed so the
// `field` cast inside each test narrows safely.
const FIELD_UUID = testUuid("q-panel-0000-0000-0000-000000000000");

function textField(extras: Partial<TextField> = {}): TextField {
	return {
		kind: "text",
		uuid: FIELD_UUID,
		id: "name",
		label: proseText("Name"),
		...extras,
	};
}

function groupField(extras: Partial<GroupField> = {}): GroupField {
	return {
		kind: "group",
		uuid: FIELD_UUID,
		id: "household",
		label: proseText("Household"),
		...extras,
	};
}

const NO_CONTEXT: FieldEditorContext = null;
const ONE_CASE_FOLLOWUP: FieldEditorContext = {
	module: { caseType: "patient" },
	form: { type: "followup" },
};
const SEVERAL_CASE_FOLLOWUP: FieldEditorContext = {
	module: {
		caseType: "patient",
		caseListConfig: {
			searchInputs: [],
			columns: [],
			listColumnOrder: [],
			detailColumnOrder: [],
			selection: { kind: "multiple", maximum: 10 },
		},
	},
	form: { type: "followup" },
};

type SchemaEntries<F extends Field> = readonly NonNullable<
	FieldEditorEntry<F>
>[];

/** The schema for a field's kind, narrowed to that kind. The cast through
 *  `unknown` is the minimum noise needed to pass the discriminated-union
 *  schema entries into the generic helpers: the runtime invariant is that
 *  `schemas[field.kind]` is the correct schema for the field's kind. */
function schemaOf<F extends Field>(field: F) {
	return fieldEditorSchemas[field.kind] as unknown as {
		data: SchemaEntries<F>;
		logic: SchemaEntries<F>;
		ui: SchemaEntries<F>;
	};
}

function panelSections<F extends Field>(
	field: F,
	context: FieldEditorContext = NO_CONTEXT,
): { data: boolean; logic: boolean; ui: boolean } {
	const schema = schemaOf(field);
	return {
		data: sectionHasContent(field, schema.data, context),
		logic: sectionHasContent(field, schema.logic, context),
		ui: sectionHasContent(field, schema.ui, context),
	};
}

/** Where the `default_value` entry lands for this field in this context. */
function defaultValuePlacement<F extends Field>(
	field: F,
	context: FieldEditorContext,
): "row" | "pill" | "absent" {
	const { visible, pills } = partitionEditorEntries(
		field,
		schemaOf(field).logic,
		context,
	);
	if (visible.some(({ entry }) => entry.key === "default_value")) return "row";
	if (pills.some((entry) => entry.key === "default_value")) return "pill";
	return "absent";
}

describe("FieldEditorPanel section visibility", () => {
	it("text field exposes Data + Logic + Appearance sections", () => {
		// Every section card mounts: text has caseWrite (data), required
		// + relevant + validate (logic, all addable), and hint (ui, addable).
		expect(panelSections(textField())).toEqual({
			data: true,
			logic: true,
			ui: true,
		});
	});

	it("group field collapses to Logic only", () => {
		// Group has no data or ui entries: those cards never mount. Only
		// `relevant` (logic, addable) keeps the Logic card alive.
		expect(panelSections(groupField())).toEqual({
			data: false,
			logic: true,
			ui: false,
		});
	});
});

describe("the default value entry", () => {
	const writer = textField({
		caseWrite: { caseType: "patient", property: "phone" },
	});

	it("is an active row, never a pill, on a writer the form opens with the case's value", () => {
		expect(defaultValuePlacement(writer, ONE_CASE_FOLLOWUP)).toBe("row");
	});

	it("is an addable pill without a form location", () => {
		expect(defaultValuePlacement(writer, NO_CONTEXT)).toBe("pill");
	});

	it("is an addable pill on a several-case form", () => {
		expect(defaultValuePlacement(writer, SEVERAL_CASE_FOLLOWUP)).toBe("pill");
	});

	it("is an addable pill on a followup writer to a child type", () => {
		expect(
			defaultValuePlacement(
				textField({ caseWrite: { caseType: "visit", property: "notes" } }),
				ONE_CASE_FOLLOWUP,
			),
		).toBe("pill");
	});

	it("is an active row wherever a stored expression exists", () => {
		expect(
			defaultValuePlacement(
				textField({ default_value: xp("'none'") }),
				NO_CONTEXT,
			),
		).toBe("row");
	});

	it("does not exist on the capture kinds", () => {
		for (const kind of captureFieldKinds) {
			const field = {
				kind,
				uuid: FIELD_UUID,
				id: "capture",
				label: proseText("Capture"),
				caseWrite: { caseType: "patient", property: "photo", mode: "url" },
			} as Field;
			expect(defaultValuePlacement(field, ONE_CASE_FOLLOWUP)).toBe("absent");
		}
	});
});

describe("the hidden field's Logic section", () => {
	it("is exactly the Value control and Show when", () => {
		const hidden: HiddenField = {
			kind: "hidden",
			uuid: FIELD_UUID,
			id: "total",
			calculate: xp("1 + 1"),
		};
		expect(schemaOf(hidden).logic.map((entry) => entry.key)).toEqual([
			"calculate",
			"relevant",
		]);
		// The Value control is always an active row: a hidden field with no
		// value is refused before it can exist, so there is nothing to add.
		const { visible, pills } = partitionEditorEntries(
			hidden,
			schemaOf(hidden).logic,
			ONE_CASE_FOLLOWUP,
		);
		expect(visible.map(({ entry }) => entry?.key)).toEqual(["calculate"]);
		expect(pills.map((entry) => entry?.key)).toEqual(["relevant"]);
	});
});
