// @vitest-environment happy-dom
//
// components/builder/shared/__tests__/cards.smoke.test.tsx
//
// Table-driven smoke test for every card in the registry.
// Asserts each kind's `defaultValue(ctx)` factory produces a
// schema-valid AST and that mounting the corresponding card
// component does not throw. Per-card logic-specific behavior
// (drag-drop, recursive scope flip, type-mismatch rendering)
// lives in dedicated test files.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import type { CaseType } from "@/lib/domain";
import {
	type Predicate,
	predicateSchema,
	type SearchInputDecl,
} from "@/lib/domain/predicate";
import { proseText } from "@/lib/domain/prose";
import {
	type PredicateEditContext,
	predicateCardSchemas,
} from "../editorSchemas";
import { PredicateCardEditor } from "../PredicateCardEditor";

const PATIENT: CaseType = {
	name: "patient",
	properties: [
		{ name: "name", label: proseText("Name"), data_type: "text" },
		{ name: "age", label: proseText("Age"), data_type: "int" },
		{ name: "weight", label: proseText("Weight"), data_type: "decimal" },
		{ name: "dob", label: proseText("Date of birth"), data_type: "date" },
		{ name: "last_seen", label: proseText("Last seen"), data_type: "datetime" },
		{ name: "wakeup", label: proseText("Wake time"), data_type: "time" },
		{
			name: "status",
			label: proseText("Status"),
			data_type: "single_select",
			options: [
				{ value: "active", label: proseText("Active") },
				{ value: "inactive", label: proseText("Inactive") },
			],
		},
		{
			name: "tags",
			label: proseText("Tags"),
			data_type: "multi_select",
			options: [
				{ value: "vip", label: proseText("VIP") },
				{ value: "new", label: proseText("New") },
			],
		},
		{ name: "location", label: proseText("Home"), data_type: "geopoint" },
	],
};

const KNOWN_INPUTS: readonly SearchInputDecl[] = [
	{ uuid: testUuid("name_search"), name: "name_search", data_type: "text" },
];

const ctx: PredicateEditContext = {
	caseTypes: [PATIENT],
	currentCaseType: "patient",
	knownInputs: KNOWN_INPUTS,
	caseDataScope: "per-case",
};

const allKinds = Object.keys(predicateCardSchemas) as Predicate["kind"][];

// ── Round-trip parsing — every default is schema-valid AST ─────────────

describe("cards smoke — defaultValue parses through predicateSchema", () => {
	for (const kind of allKinds) {
		it(`${kind}: default value is parseable`, () => {
			const value = predicateCardSchemas[kind].defaultValue(ctx);
			expect(() => predicateSchema.parse(value)).not.toThrow();
		});
	}
});

// ── Mount-and-render — every card mounts without throwing ──────────────

describe("cards smoke — mount via PredicateCardEditor", () => {
	for (const kind of allKinds) {
		it(`${kind}: mounts inside PredicateCardEditor`, () => {
			const value = predicateCardSchemas[kind].defaultValue(ctx);
			const { container } = render(
				<PredicateCardEditor
					value={value}
					onChange={() => {}}
					caseTypes={ctx.caseTypes}
					currentCaseType={ctx.currentCaseType}
					knownInputs={ctx.knownInputs}
				/>,
			);
			// One element in the container — the predicate card —
			// confirms render landed without throwing.
			expect(container.firstElementChild).not.toBeNull();
		});
	}
});
