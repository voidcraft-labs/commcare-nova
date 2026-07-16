// components/builder/shared/__tests__/expressionEditorSchemas.test.ts
//
// Registry-shape tests for the expression card editor. Two
// invariants pinned here (mirrors `editorSchemas.test.ts` on the
// Predicate side):
//
//   1. Exhaustivity over the ValueExpression union — every kind
//      appears as a key in `expressionCardSchemas`. The mapped-type
//      `Record<ValueExpression["kind"], ...>` enforces this at the
//      type layer; the runtime guard verifies the keys at the
//      import boundary as a defense against an `as` cast bypassing
//      the type system.
//
//   2. Every entry's `defaultValue(ctx)` factory produces a kind-
//      valid AST. The schema's parse pass is the structural
//      contract; ill-typed defaults that fail the type checker's
//      semantic rules are still kind-valid (e.g. an empty property
//      name is rejected by the type checker but accepted by the
//      schema).

import { describe, expect, it } from "vitest";
import type { CaseType } from "@/lib/domain";
import {
	type SearchInputDecl,
	type ValueExpression,
	valueExpressionSchema,
	walkExpressionTerms,
} from "@/lib/domain/predicate";
import {
	type ExpressionEditContext,
	expressionCardSchemas,
} from "../expressionEditorSchemas";

// ── Fixture ───────────────────────────────────────────────────────────

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

describe("expressionCardSchemas — registry exhaustivity", () => {
	it("declares an entry for every ValueExpression kind", () => {
		for (const kind of Object.keys(
			expressionCardSchemas,
		) as ValueExpression["kind"][]) {
			const entry = expressionCardSchemas[kind];
			expect(entry.kind).toBe(kind);
			expect(entry.label).toBeTruthy();
			expect(entry.icon).toBeTruthy();
			expect(typeof entry.component).toBe("function");
			expect(typeof entry.defaultValue).toBe("function");
			expect(typeof entry.applicable).toBe("function");
		}
	});
});

describe("expressionCardSchemas — defaultValue parses through the schema", () => {
	// Iterate every kind; assert the factory's output round-trips
	// through `valueExpressionSchema.parse`. Smoke test for "the
	// registry's defaults are kind-valid AST" — semantic validity
	// (does a property name resolve, are types compatible?) is the
	// type checker's job and has its own tests.
	for (const kind of Object.keys(
		expressionCardSchemas,
	) as ValueExpression["kind"][]) {
		it(`${kind}: default value parses through valueExpressionSchema`, () => {
			const entry = expressionCardSchemas[kind];
			const value = entry.defaultValue(ctx);
			expect(() => valueExpressionSchema.parse(value)).not.toThrow();
			expect(value.kind).toBe(kind);
		});
	}

	it("never seeds CCHQ's legacy property alias from an alias-first catalog", () => {
		for (const kind of Object.keys(
			expressionCardSchemas,
		) as ValueExpression["kind"][]) {
			const refs: string[] = [];
			walkExpressionTerms(
				expressionCardSchemas[kind].defaultValue(ctx),
				(term) => {
					if (term.kind === "prop") refs.push(term.property);
				},
			);
			expect(refs, `${kind} property refs`).not.toContain("name");
		}
	});
});

describe("expressionCardSchemas — applicable predicates", () => {
	it("term / if / switch / coalesce always apply (result-type-depends-on-inputs)", () => {
		// Kinds whose result type can't be inferred without examining
		// inputs always apply — strict expectedType filtering would
		// hide whole authoring patterns.
		expect(expressionCardSchemas.term.applicable(ctx)).toBe(true);
		expect(expressionCardSchemas.if.applicable(ctx)).toBe(true);
		expect(expressionCardSchemas.switch.applicable(ctx)).toBe(true);
		expect(expressionCardSchemas.coalesce.applicable(ctx)).toBe(true);
		// Also apply with strict expectedType set.
		expect(expressionCardSchemas.term.applicable(ctx, "int")).toBe(true);
		expect(expressionCardSchemas.if.applicable(ctx, "date")).toBe(true);
	});

	it("today applies to date / _any expectedTypes; not to datetime or int", () => {
		// `today` always resolves to `date` — strict-only.
		expect(expressionCardSchemas.today.applicable(ctx)).toBe(true);
		expect(expressionCardSchemas.today.applicable(ctx, "date")).toBe(true);
		expect(expressionCardSchemas.today.applicable(ctx, "_any")).toBe(true);
		expect(expressionCardSchemas.today.applicable(ctx, "datetime")).toBe(false);
		expect(expressionCardSchemas.today.applicable(ctx, "int")).toBe(false);
	});

	it("now applies to datetime / _any expectedTypes; not to date or int", () => {
		// `now` always resolves to `datetime` — strict-only.
		expect(expressionCardSchemas.now.applicable(ctx)).toBe(true);
		expect(expressionCardSchemas.now.applicable(ctx, "datetime")).toBe(true);
		expect(expressionCardSchemas.now.applicable(ctx, "_any")).toBe(true);
		expect(expressionCardSchemas.now.applicable(ctx, "date")).toBe(false);
		expect(expressionCardSchemas.now.applicable(ctx, "int")).toBe(false);
	});

	it("date-add applies to BOTH date and datetime expectedTypes", () => {
		// `date-add`'s result type follows the operand — `today() + N`
		// resolves to `date`, `now() + N` resolves to `datetime`. The
		// kind picker surfaces it for either temporal slot; the
		// operand picker drives which side the type checker validates.
		expect(expressionCardSchemas["date-add"].applicable(ctx, "date")).toBe(
			true,
		);
		expect(expressionCardSchemas["date-add"].applicable(ctx, "datetime")).toBe(
			true,
		);
		expect(expressionCardSchemas["date-add"].applicable(ctx, "int")).toBe(
			false,
		);
	});

	it("date-coerce ↔ datetime-coerce: each is applicable for the other's temporal slot", () => {
		// The structural-twin pair is operand-preserving via
		// `preservedExpressionSwap`; picker parity matches that
		// authoring path so the wrong-temporal arm doesn't de-emphasize.
		expect(expressionCardSchemas["date-coerce"].applicable(ctx, "date")).toBe(
			true,
		);
		expect(
			expressionCardSchemas["date-coerce"].applicable(ctx, "datetime"),
		).toBe(true);
		expect(
			expressionCardSchemas["datetime-coerce"].applicable(ctx, "date"),
		).toBe(true);
		expect(
			expressionCardSchemas["datetime-coerce"].applicable(ctx, "datetime"),
		).toBe(true);
		// Neither applies to a non-temporal slot.
		expect(expressionCardSchemas["date-coerce"].applicable(ctx, "text")).toBe(
			false,
		);
		expect(
			expressionCardSchemas["datetime-coerce"].applicable(ctx, "int"),
		).toBe(false);
	});

	it("arith / double apply to numeric expectedTypes; not to text", () => {
		expect(expressionCardSchemas.arith.applicable(ctx, "int")).toBe(true);
		expect(expressionCardSchemas.arith.applicable(ctx, "decimal")).toBe(true);
		expect(expressionCardSchemas.arith.applicable(ctx, "text")).toBe(false);
		expect(expressionCardSchemas.double.applicable(ctx, "int")).toBe(true);
		expect(expressionCardSchemas.double.applicable(ctx, "text")).toBe(false);
	});

	it("concat applies to text-shaped expectedTypes; not to int", () => {
		expect(expressionCardSchemas.concat.applicable(ctx, "text")).toBe(true);
		expect(expressionCardSchemas.concat.applicable(ctx, "single_select")).toBe(
			true,
		);
		expect(expressionCardSchemas.concat.applicable(ctx, "int")).toBe(false);
	});

	it("count applies to numeric / unset expectedTypes; not to text", () => {
		expect(expressionCardSchemas.count.applicable(ctx)).toBe(true);
		expect(expressionCardSchemas.count.applicable(ctx, "int")).toBe(true);
		expect(expressionCardSchemas.count.applicable(ctx, "decimal")).toBe(true);
		expect(expressionCardSchemas.count.applicable(ctx, "text")).toBe(false);
	});

	it("unwrap-list is gated to `_sequence` expectedTypes (round-trip-only)", () => {
		// `unwrap-list` produces a sequence type; no scalar value slot
		// consumes a sequence, so the kind picker hides it from every
		// scalar slot. The kind exists in the registry only for round-
		// trip preservation when a saved AST carries one.
		expect(expressionCardSchemas["unwrap-list"].applicable(ctx)).toBe(false);
		expect(expressionCardSchemas["unwrap-list"].applicable(ctx, "int")).toBe(
			false,
		);
		expect(
			expressionCardSchemas["unwrap-list"].applicable(ctx, "_sequence"),
		).toBe(true);
	});

	it("format-date requires a date / datetime property in the case type", () => {
		expect(expressionCardSchemas["format-date"].applicable(ctx)).toBe(true);
		const noDates: ExpressionEditContext = {
			...ctx,
			caseTypes: [
				{
					name: "patient",
					properties: [{ name: "name", label: "Name", data_type: "text" }],
				},
			],
		};
		expect(expressionCardSchemas["format-date"].applicable(noDates)).toBe(
			false,
		);
	});
});
