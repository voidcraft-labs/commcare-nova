import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildRuntimeCsqlPromptValidations } from "@/lib/commcare/suite/case-search/xpathQuery";
import {
	between,
	dateLiteral,
	datetimeCoerce,
	eq,
	gte,
	input,
	isIn,
	literal,
	prop,
	sessionUserProperty,
	term,
	whenInput,
} from "@/lib/domain/predicate/builders";
import { emitCsql } from "../csqlEmitter";

const worker = testUuid("worker-property");
const day = testUuid("day");
const session = "instance('commcaresession')/session/user/data/visit_day";
const answer = "instance('search-input:results')/input/field[@name='day']";
const sessionContext = {
	caseTypes: [],
	knownInputs: [],
	userPropertySlugs: new Map([[worker, "visit_day"]]),
};
const inputContext = {
	caseTypes: [],
	knownInputs: [
		{ uuid: day, name: "day", label: "Day", data_type: "date" as const },
	],
};
const opened = prop("patient", "date_opened");

describe("the blank-comparand guard", () => {
	it("replaces the clause with match-none() while a session value compared with a system date is blank", () => {
		const emission = emitCsql(
			gte(opened, datetimeCoerce(term(sessionUserProperty(worker)))),
			sessionContext,
		);
		expect(emission).toEqual({
			wrapper: `if((contains(${session}, "'") and contains(${session}, '"')) or (${session} = ''), 'match-none()', concat('date_opened >= datetime(', if(contains(${session}, '"'), concat("'", ${session}, "'"), concat('"', ${session}, '"')), ')', ''))`,
			runtimeRejections: [
				{
					condition: `contains(${session}, "'") and contains(${session}, '"')`,
					kind: "quote",
				},
				{ condition: `${session} = ''`, kind: "blank-comparand" },
			],
		});
	});

	it("guards an input inside its own presence test", () => {
		expect(
			emitCsql(
				whenInput(input(day), gte(opened, datetimeCoerce(term(input(day))))),
				inputContext,
			),
		).toEqual({
			wrapper: `if(count(${answer}), if((${answer} = ''), 'match-none()', concat('date_opened >= datetime("', ${answer}, '")', '')), 'match-all()')`,
			runtimeRejections: [
				{
					condition: `count(${answer}) and (${answer} = '')`,
					kind: "blank-comparand",
				},
			],
		});
	});

	it("guards a runtime bound of a range on any property, and an equality on no ordinary property", () => {
		expect(
			emitCsql(
				between(prop("patient", "age"), { lower: term(input(day)) }),
				inputContext,
			).runtimeRejections,
		).toEqual([{ condition: `${answer} = ''`, kind: "blank-comparand" }]);
		expect(
			emitCsql(eq(prop("patient", "name"), input(day)), inputContext),
		).toEqual({
			wrapper: `concat('name = "', ${answer}, '"')`,
		});
	});

	it("writes no guard for a fixed date or for membership", () => {
		expect(
			emitCsql(gte(opened, datetimeCoerce(term(dateLiteral("2026-01-01"))))),
		).toEqual({ wrapper: `"date_opened >= datetime('2026-01-01')"` });
		expect(
			emitCsql(isIn(prop("patient", "age"), literal(3), literal(4))),
		).toEqual({ wrapper: "'(age = 3 or age = 4)'" });
	});

	it("adds no prompt validation, since a blank value has nothing for a worker to repair", () => {
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
