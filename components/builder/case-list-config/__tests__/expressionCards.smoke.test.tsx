// @vitest-environment happy-dom
//
// components/builder/case-list-config/__tests__/expressionCards.smoke.test.tsx
//
// Table-driven smoke test for every card in the expression registry.
// Asserts each kind's `defaultValue(ctx)` factory produces a schema-
// valid AST and that mounting the corresponding card component does
// not throw. Per-card logic-specific behavior (drag-drop reorder,
// recursive scope flip, type-mismatch rendering) lives in dedicated
// test files; this file is the coverage gate that every kind has a
// mount path.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { CaseType } from "@/lib/domain";
import {
	type SearchInputDecl,
	type ValueExpression,
	valueExpressionSchema,
} from "@/lib/domain/predicate";
import { ExpressionCardEditor } from "../ExpressionCardEditor";
import {
	type ExpressionEditContext,
	expressionCardSchemas,
} from "../expressionEditorSchemas";

const PATIENT: CaseType = {
	name: "patient",
	properties: [
		{ name: "name", label: "Name", data_type: "text" },
		{ name: "age", label: "Age", data_type: "int" },
		{ name: "weight", label: "Weight", data_type: "decimal" },
		{ name: "dob", label: "Date of birth", data_type: "date" },
		{ name: "last_seen", label: "Last seen", data_type: "datetime" },
		{ name: "wakeup", label: "Wake time", data_type: "time" },
		{
			name: "status",
			label: "Status",
			data_type: "single_select",
			options: [
				{ value: "active", label: "Active" },
				{ value: "inactive", label: "Inactive" },
			],
		},
		{
			name: "tags",
			label: "Tags",
			data_type: "multi_select",
			options: [
				{ value: "vip", label: "VIP" },
				{ value: "new", label: "New" },
			],
		},
		{ name: "location", label: "Home", data_type: "geopoint" },
	],
};

const KNOWN_INPUTS: readonly SearchInputDecl[] = [
	{ name: "name_search", data_type: "text" },
];

const ctx: ExpressionEditContext = {
	caseTypes: [PATIENT],
	currentCaseType: "patient",
	knownInputs: KNOWN_INPUTS,
};

const allKinds = Object.keys(
	expressionCardSchemas,
) as ValueExpression["kind"][];

// ── Round-trip parsing — every default is schema-valid AST ─────────────

describe("expression cards smoke — defaultValue parses through valueExpressionSchema", () => {
	for (const kind of allKinds) {
		it(`${kind}: default value is parseable`, () => {
			const value = expressionCardSchemas[kind].defaultValue(ctx);
			expect(() => valueExpressionSchema.parse(value)).not.toThrow();
		});
	}
});

// ── Mount-and-render — every card mounts without throwing ──────────────

describe("expression cards smoke — mount via ExpressionCardEditor", () => {
	for (const kind of allKinds) {
		it(`${kind}: mounts inside ExpressionCardEditor`, () => {
			const value = expressionCardSchemas[kind].defaultValue(ctx);
			const { container } = render(
				<ExpressionCardEditor
					value={value}
					onChange={() => {}}
					caseTypes={ctx.caseTypes}
					currentCaseType={ctx.currentCaseType}
					knownInputs={ctx.knownInputs}
				/>,
			);
			expect(container.firstElementChild).not.toBeNull();
		});
	}
});
