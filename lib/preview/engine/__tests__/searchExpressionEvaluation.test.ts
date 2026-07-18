import { describe, expect, it } from "vitest";
import { asUuid, simpleSearchInputDef } from "@/lib/domain";
import {
	concat,
	dateAdd,
	dateLiteral,
	eq,
	input,
	literal,
	prop,
	sessionContext,
	sessionUser,
	term,
	today,
} from "@/lib/domain/predicate";
import type { SearchInputValues } from "../runtimeBindings";
import {
	evaluatePreviewSearchExpression,
	evaluatePreviewSearchPredicate,
	parseExcludedOwnerIds,
	previewSearchSessionValues,
	resolveSearchInputDefaults,
} from "../searchExpressionEvaluation";

const SESSION = previewSearchSessionValues({
	id: "worker-42",
	name: "Amina Diallo",
	email: "amina@example.org",
});

describe("preview case-search expression evaluation", () => {
	it("evaluates literals, date functions, and session-backed terms", () => {
		expect(
			evaluatePreviewSearchExpression(term(literal("north")), SESSION),
		).toBe("north");
		expect(evaluatePreviewSearchExpression(today(), SESSION)).toMatch(
			/^\d{4}-\d{2}-\d{2}$/,
		);
		expect(
			evaluatePreviewSearchExpression(term(sessionContext("userid")), SESSION),
		).toBe("worker-42");
		expect(
			evaluatePreviewSearchExpression(term(sessionUser("first_name")), SESSION),
		).toBe("Amina");
	});

	it("binds submitted search inputs before evaluating a dependent expression", () => {
		const values: SearchInputValues = new Map([["clinic", "Kolda"]]);
		expect(
			evaluatePreviewSearchExpression(
				concat(term(literal("owner-")), term(input("clinic"))),
				SESSION,
				values,
			),
		).toBe("owner-Kolda");
	});

	it("keeps a date widget typed while evaluating dependent date arithmetic", () => {
		const visitDay = simpleSearchInputDef(
			asUuid("00000000-0000-4000-8000-000000000104"),
			"visit_day",
			"Visit day",
			"date",
			"visit_day",
		);
		expect(
			evaluatePreviewSearchExpression(
				dateAdd(term(input("visit_day")), "days", term(literal(1))),
				SESSION,
				new Map([["visit_day", "2026-07-17"]]),
				[visitDay],
			),
		).toBe("2026-07-18");
	});

	it("evaluates search predicates against live inputs, session values, and an empty preselection case context", () => {
		const clinicInput = simpleSearchInputDef(
			asUuid("00000000-0000-4000-8000-000000000103"),
			"clinic",
			"Clinic",
			"text",
			"clinic",
		);
		const values: SearchInputValues = new Map([["clinic", "Kolda"]]);

		expect(
			evaluatePreviewSearchPredicate(
				eq(input("clinic"), literal("Kolda")),
				[clinicInput],
				SESSION,
				values,
			),
		).toBe(true);
		expect(
			evaluatePreviewSearchPredicate(
				eq(sessionContext("userid"), literal("worker-42")),
				[clinicInput],
				SESSION,
				values,
			),
		).toBe(true);
		expect(
			evaluatePreviewSearchPredicate(
				eq(prop("patient", "case_name"), literal("Alice")),
				[clinicInput],
				SESSION,
				values,
			),
		).toBe(false);
	});

	it("resolves scalar defaults but never invents a one-sided date-range default", () => {
		const defaults = resolveSearchInputDefaults(
			[
				simpleSearchInputDef(
					asUuid("00000000-0000-4000-8000-000000000101"),
					"worker",
					"Worker",
					"text",
					"owner_id",
					{ default: term(sessionContext("userid")) },
				),
				simpleSearchInputDef(
					asUuid("00000000-0000-4000-8000-000000000102"),
					"visit_date",
					"Visit date",
					"date-range",
					"visit_date",
					{ default: term(dateLiteral("2026-07-16")) },
				),
			],
			SESSION,
		);

		expect(Object.fromEntries(defaults)).toEqual({
			worker: "worker-42",
		});
	});

	it("splits excluded owners on whitespace, deduplicating without splitting commas", () => {
		expect(
			parseExcludedOwnerIds(" \towner-a  owner-b\nowner-a id3,id4\t "),
		).toEqual(["owner-a", "owner-b", "id3,id4"]);
		expect(parseExcludedOwnerIds(" \t\n ")).toEqual([]);
	});
});
