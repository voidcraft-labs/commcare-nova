import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildRuntimeCsqlPromptValidations } from "@/lib/commcare/suite/case-search/xpathQuery";
import { advancedSearchInputDef } from "@/lib/domain";
import {
	between,
	dateLiteral,
	datetimeCoerce,
	eq,
	gte,
	input,
	isIn,
	literal,
	matchAll,
	prop,
	sessionUserProperty,
	term,
	whenInput,
} from "@/lib/domain/expression/builders";
import {
	csqlFixtureContext,
	csqlInputContext,
} from "../../__tests__/csqlFunctionFixture";
import { w } from "../../xpath/wire/builders";
import {
	searchInputInstance,
	sessionInstance,
} from "../../xpath/wire/instances";
import { emitCsql } from "../emitter";

const worker = testUuid("worker-property");
const day = testUuid("day");
const session = w.instance(
	sessionInstance(),
	["session", "user", "data", "visit_day"].map((name) => w.step(name)),
);
const answer = w.instance(searchInputInstance("search-input:results"), [
	w.step("input"),
	w.step("field", [w.eq(w.context([w.attr("name")]), w.str("day"))]),
]);
const blank = w.eq(answer, w.str(""));
const sessionContext = {
	...csqlFixtureContext(),
	bindings: { userPropertySlugs: new Map([[worker, "visit_day"]]) },
};
const inputContext = csqlInputContext([
	advancedSearchInputDef(day, "day", "Day", "date", matchAll()),
]);
const opened = prop("patient", "date_opened");

describe("the blank-comparand guard", () => {
	it("places the blank and quote obligations outside the complete clause", () => {
		const emission = emitCsql(
			gte(opened, datetimeCoerce(term(sessionUserProperty(worker)))),
			sessionContext,
		);
		const quote = w.and(
			w.call("contains", [session, w.str("'")]),
			w.call("contains", [session, w.str('"')]),
		);
		const empty = w.eq(session, w.str(""));
		expect(emission.runtimeRejections).toEqual([
			{ condition: quote, kind: "quote" },
			{ condition: empty, kind: "blank-comparand" },
		]);
		expect(emission.wrapper).toMatchObject({ k: "call", fn: "if" });
		if (emission.wrapper.k !== "call")
			throw new Error("Expected an outer guard");
		expect(emission.wrapper.args.slice(0, 2)).toEqual([
			w.or(quote, empty),
			w.str("match-none()"),
		]);
		expect(emission.wrapper.args[2]).toMatchObject({ k: "call", fn: "concat" });
	});

	it("guards an input inside its own presence test", () => {
		const emission = emitCsql(
			whenInput(input(day), gte(opened, datetimeCoerce(term(input(day))))),
			inputContext,
		);
		expect(emission.runtimeRejections).toEqual([
			{
				condition: w.and(w.call("count", [answer]), blank),
				kind: "blank-comparand",
			},
		]);
		expect(emission.wrapper).toMatchObject({ k: "call", fn: "if" });
		if (emission.wrapper.k !== "call")
			throw new Error("Expected a presence gate");
		expect(emission.wrapper.args[0]).toEqual(w.call("count", [answer]));
		expect(emission.wrapper.args[2]).toEqual(w.str("match-all()"));
		const guarded = emission.wrapper.args[1];
		expect(guarded).toMatchObject({ k: "call", fn: "if" });
		if (guarded.k !== "call") throw new Error("Expected an inner guard");
		expect(guarded.args.slice(0, 2)).toEqual([blank, w.str("match-none()")]);
	});

	it("guards a runtime range bound but leaves ordinary equality unguarded", () => {
		expect(
			emitCsql(
				between(prop("patient", "age"), { lower: term(input(day)) }),
				inputContext,
			).runtimeRejections,
		).toEqual([{ condition: blank, kind: "blank-comparand" }]);
		const equality = emitCsql(
			eq(prop("patient", "name"), input(day)),
			inputContext,
		);
		expect(equality.runtimeRejections).toBeUndefined();
		expect(equality.wrapper).toEqual(
			w.call("concat", [w.str('name = "'), answer, w.str('"')]),
		);
	});

	it("writes no runtime guard for a fixed date or membership", () => {
		expect(
			emitCsql(
				gte(opened, datetimeCoerce(term(dateLiteral("2026-01-01")))),
				csqlFixtureContext(),
			),
		).toEqual({ wrapper: w.str("date_opened >= datetime('2026-01-01')") });
		expect(
			emitCsql(
				isIn(prop("patient", "age"), literal(3), literal(4)),
				csqlFixtureContext(),
			),
		).toEqual({ wrapper: w.str("(age = 3 or age = 4)") });
	});

	it("adds no prompt validation because a blank value has nothing for a worker to repair", () => {
		const emission = emitCsql(
			gte(opened, datetimeCoerce(term(input(day)))),
			inputContext,
		);
		expect(emission.runtimeRejections?.map(({ kind }) => kind)).toEqual([
			"blank-comparand",
		]);
		expect(
			buildRuntimeCsqlPromptValidations({
				clauseWrappers: [emission.wrapper],
				runtimeRejections: emission.runtimeRejections,
			}),
		).toEqual(new Map());
	});
});
