import { describe, expect, it } from "vitest";
import {
	eq,
	ifExpr,
	input,
	literal,
	matchAll,
	neq,
	not,
	or,
	prop,
	term,
	unwrapList,
	whenInput,
} from "@/lib/domain/predicate";
import { evaluate } from "@/lib/preview/xpath/evaluator";
import type { EvalContext } from "@/lib/preview/xpath/types";
import { emitCsql } from "../csqlEmitter";
import { quoteLiteral } from "../stringQuoting";
import {
	CSQL_UNREPRESENTABLE_RUNTIME_STRING,
	emitSearchInputXPath,
} from "../termEmitter";

const CONTEXT: EvalContext = {
	getValue: () => undefined,
	resolveHashtag: () => "",
	contextPath: "/data/current",
	position: 1,
	size: 1,
};

function resolveInput(wrapper: string, name: string, value: string): string {
	const xpath = emitSearchInputXPath(input(name));
	const valueXpath = quoteLiteral(value, "case-list-filter");
	// Preserve Core's nodeset-presence semantics before substituting the scalar
	// value. `count('answer')` is not equivalent to count(input-field): the
	// lightweight evaluator quite correctly treats the scalar as no nodeset,
	// which would exercise the trigger-absent branch and hide an outer guard.
	const bound = wrapper
		.replaceAll(`count(${xpath})`, value === "" ? "false()" : "true()")
		.replaceAll(xpath, valueXpath);
	return String(evaluate(bound, CONTEXT));
}

describe("runtime CSQL value quoting", () => {
	it.each([
		["plain text", "Alice", 'full_name = "Alice"'],
		["single quote only", "O'Connor", `full_name = "O'Connor"`],
		["double quote only", 'The "Boss"', `full_name = 'The "Boss"'`],
	])("preserves %s byte-for-byte", (_label, value, expected) => {
		const wrapper = emitCsql(
			eq(prop("patient", "full_name"), input("query")),
		).wrapper;
		expect(resolveInput(wrapper, "query", value)).toBe(expected);
	});

	it.each([`x' or match-all() or 'y`, `x" or match-all() or "y`])(
		"keeps a one-delimiter adversarial value inside one literal",
		(value) => {
			const wrapper = emitCsql(
				eq(prop("patient", "full_name"), input("query")),
			).wrapper;
			const rendered = resolveInput(wrapper, "query", value);
			expect(rendered).toContain(value);
			expect(rendered).not.toBe(CSQL_UNREPRESENTABLE_RUNTIME_STRING);
			expect(rendered.startsWith("full_name = ")).toBe(true);
		},
	);

	it("rejects a value containing both delimiters before any bytes enter CSQL", () => {
		const wrapper = emitCsql(
			eq(prop("patient", "full_name"), input("query")),
		).wrapper;
		expect(resolveInput(wrapper, "query", `it's "quoted"`)).toBe(
			CSQL_UNREPRESENTABLE_RUNTIME_STRING,
		);
	});

	it.each([
		["not-equal", neq(prop("patient", "name"), input("query"))],
		["not", not(eq(prop("patient", "name"), input("query")))],
		[
			"or",
			or(
				eq(prop("patient", "name"), input("query")),
				eq(prop("patient", "status"), literal("active")),
			),
		],
	])(
		"rejects the whole %s query instead of broadening it",
		(_label, predicate) => {
			const wrapper = emitCsql(predicate).wrapper;
			expect(resolveInput(wrapper, "query", `it's "quoted"`)).toBe(
				CSQL_UNREPRESENTABLE_RUNTIME_STRING,
			);
			expect(wrapper).not.toContain("match-none()");
		},
	);

	it("propagates a nested when-input guard to the outermost query", () => {
		const predicate = or(
			whenInput(
				input("query"),
				not(eq(prop("patient", "name"), input("query"))),
			),
			eq(prop("patient", "status"), literal("active")),
		);
		const wrapper = emitCsql(predicate).wrapper;
		expect(resolveInput(wrapper, "query", `it's "quoted"`)).toBe(
			CSQL_UNREPRESENTABLE_RUNTIME_STRING,
		);
	});

	it.each([
		["single quote only", "O'Connor", `label = "O'Connor"`],
		["double quote only", 'The "Boss"', `label = 'The "Boss"'`],
		["both quote types", `it's "quoted"`, CSQL_UNREPRESENTABLE_RUNTIME_STRING],
	])("quotes a computed %s result safely", (_label, value, expected) => {
		const computed = ifExpr(
			matchAll(),
			term(literal(value)),
			term(literal("fallback")),
		);
		const rendered = String(
			evaluate(
				emitCsql(eq(prop("patient", "label"), computed)).wrapper,
				CONTEXT,
			),
		);
		expect(rendered).toBe(expected);
	});

	it("prefers single quotes for JSON passed to unwrap-list", () => {
		const wrapper = emitCsql(
			eq(prop("patient", "tags"), unwrapList(term(input("selected_tags")))),
		).wrapper;
		expect(resolveInput(wrapper, "selected_tags", '["alpha","beta"]')).toBe(
			`tags = unwrap-list('["alpha","beta"]')`,
		);
		expect(resolveInput(wrapper, "selected_tags", `["O'Connor"]`)).toBe(
			CSQL_UNREPRESENTABLE_RUNTIME_STRING,
		);
	});
});
