// @vitest-environment happy-dom
//
// components/builder/shared/__tests__/expressionCards.smoke.test.tsx
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
import { testUuid } from "@/__tests__/helpers/uuid";
import { BlueprintDocProvider } from "@/lib/doc/provider";
import {
	type CaseType,
	lookupColumnIdSchema,
	lookupTableIdSchema,
} from "@/lib/domain";
import {
	and,
	type SearchInputDecl,
	type ValueExpression,
	valueExpressionSchema,
} from "@/lib/domain/predicate";
import { proseText } from "@/lib/domain/prose";
import { ExpressionCardEditor } from "../ExpressionCardEditor";
import {
	type ExpressionEditContext,
	expressionCardSchemas,
} from "../expressionEditorSchemas";

const PATIENT: CaseType = {
	name: "patient",
	properties: [
		{ name: "case_name", label: proseText("Case name"), data_type: "text" },
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
	{ uuid: testUuid("name-search"), name: "name_search", data_type: "text" },
];

const ctx: ExpressionEditContext = {
	caseTypes: [PATIENT],
	currentCaseType: "patient",
	knownInputs: KNOWN_INPUTS,
	operationScope: {
		creates: [{ uuid: testUuid("earlier-create"), label: "Create a referral" }],
	},
};

const allKinds = Object.keys(
	expressionCardSchemas,
) as ValueExpression["kind"][];

function valueForKind(kind: ValueExpression["kind"]): ValueExpression {
	if (kind === "table-lookup") {
		return {
			kind: "table-lookup",
			tableId: lookupTableIdSchema.parse(
				"018f3e8a-7b2c-7def-8abc-1234567890ab",
			),
			resultColumnId: lookupColumnIdSchema.parse(
				"018f3e8a-7b2c-7def-8abc-1234567890ac",
			),
			where: and(),
		};
	}
	return expressionCardSchemas[kind].defaultValue(ctx);
}

// ── Round-trip parsing — every default is schema-valid AST ─────────────

describe("expression cards smoke — defaultValue parses through valueExpressionSchema", () => {
	for (const kind of allKinds) {
		it(`${kind}: default value is parseable`, () => {
			const value = valueForKind(kind);
			expect(() => valueExpressionSchema.parse(value)).not.toThrow();
		});
	}
});

// ── Mount-and-render — every card mounts without throwing ──────────────

describe("expression cards smoke — mount via ExpressionCardEditor", () => {
	for (const kind of allKinds) {
		it(`${kind}: mounts inside ExpressionCardEditor`, () => {
			const value = valueForKind(kind);
			// Cards spell authored prose against the document; every
			// production mount sits inside the builder's provider.
			const { container } = render(
				<BlueprintDocProvider appId="test-app">
					<ExpressionCardEditor
						value={value}
						onChange={() => {}}
						caseTypes={ctx.caseTypes}
						currentCaseType={ctx.currentCaseType}
						knownInputs={ctx.knownInputs}
						operationScope={ctx.operationScope}
					/>
				</BlueprintDocProvider>,
			);
			expect(container.firstElementChild).not.toBeNull();
		});
	}
});
