import { expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	arith,
	coalesce,
	concat,
	count,
	dateCoerce,
	double,
	eq,
	gt,
	ifExpr,
	input,
	literal,
	matchAll,
	prop,
	subcasePath,
	switchCase,
	switchExpr,
	term,
	whenInput,
} from "@/lib/domain/predicate";
import {
	collectRuntimeCsqlStringExpressionInputNames,
	collectRuntimeCsqlStringInputNames,
} from "../runtimeCsqlQuoteSafety";

const names = [
	"direct",
	"date_text",
	"trigger",
	"number",
	"control",
	"branch_value",
	"fallback",
	"visit_name",
] as const;
const inputs = names.map((name) => ({
	uuid: testUuid(name),
	name,
	data_type: "text" as const,
}));
const ref = (name: (typeof names)[number]) => input(testUuid(name));
const value = (name: (typeof names)[number]) => term(ref(name));
const collect = (
	predicate: Parameters<typeof collectRuntimeCsqlStringInputNames>[0],
) => collectRuntimeCsqlStringInputNames(predicate, inputs);

// Private conservative byte-flow analysis; complete query composition and real
// runtime error assignment are exercised by the admitted Search prompt corpus.
it("distinguishes raw native function arguments from already converted device output", () => {
	expect(collect(eq(prop("patient", "case_name"), ref("direct")))).toEqual(
		new Set(["direct"]),
	);
	expect(
		collect(eq(prop("patient", "dob"), dateCoerce(value("date_text")))),
	).toEqual(new Set(["date_text"]));
	expect(
		collect(eq(prop("patient", "score"), double(value("number")))),
	).toEqual(new Set(["number"]));
	expect(
		collectRuntimeCsqlStringExpressionInputNames(
			double(value("number")),
			inputs,
		),
	).toEqual(new Set());
	expect(
		collect(
			eq(
				prop("patient", "score"),
				arith("+", double(value("number")), term(literal(1))),
			),
		),
	).toEqual(new Set());
});
it("does not blame inputs used only for presence or branch selection", () => {
	expect(
		collect(
			whenInput(
				ref("trigger"),
				eq(prop("patient", "status"), literal("active")),
			),
		),
	).toEqual(new Set());
	expect(
		collect(
			eq(
				prop("patient", "label"),
				ifExpr(
					eq(ref("control"), literal("yes")),
					term(literal("accepted")),
					term(literal("rejected")),
				),
			),
		),
	).toEqual(new Set());
});
it("unions raw outputs across concat, coalesce and switch without collecting their controls", () => {
	const expression = concat(
		value("direct"),
		coalesce(double(value("number")), value("branch_value")),
		switchExpr(
			value("control"),
			[switchCase(literal("yes"), value("fallback"))],
			value("branch_value"),
		),
	);
	expect(
		collectRuntimeCsqlStringExpressionInputNames(expression, inputs),
	).toEqual(new Set(["direct", "branch_value", "fallback"]));
	expect(collect(eq(prop("patient", "case_name"), expression))).toEqual(
		new Set(["direct", "branch_value", "fallback"]),
	);
});
it("includes both possible raw conditional outputs", () => {
	const expression = ifExpr(
		eq(ref("control"), literal("yes")),
		value("branch_value"),
		value("fallback"),
	);
	expect(
		collectRuntimeCsqlStringExpressionInputNames(expression, inputs),
	).toEqual(new Set(["branch_value", "fallback"]));
});
it("finds a server-side count filter after reversing the authored comparison", () => {
	const predicate = gt(
		literal(2),
		count(
			subcasePath("parent", "visit"),
			whenInput(
				ref("visit_name"),
				eq(prop("visit", "case_name"), ref("visit_name")),
			),
		),
	);
	expect(collect(predicate)).toEqual(new Set(["visit_name"]));
});
it("resolves current names by identity and does not borrow an unrelated declaration", () => {
	const expression = value("direct");
	expect(
		collectRuntimeCsqlStringExpressionInputNames(expression, [
			{ uuid: testUuid("direct"), name: "renamed", data_type: "text" },
			{ uuid: testUuid("other"), name: "direct", data_type: "text" },
		]),
	).toEqual(new Set(["renamed"]));
	expect(
		collectRuntimeCsqlStringExpressionInputNames(expression, [
			{ uuid: testUuid("other"), name: "direct", data_type: "text" },
		]),
	).toEqual(new Set());
	expect(collect(undefined)).toEqual(new Set());
	expect(collect(matchAll())).toEqual(new Set());
});
