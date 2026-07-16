import { describe, expect, it } from "vitest";
import { asUuid, simpleSearchInputDef } from "@/lib/domain";
import {
	concat,
	dateLiteral,
	input,
	literal,
	sessionContext,
	sessionUser,
	term,
	today,
} from "@/lib/domain/predicate";
import type { SearchInputValues } from "../runtimeBindings";
import {
	evaluatePreviewSearchExpression,
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

	it("resolves visible defaults and seeds a single date into the range's From bound", () => {
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
			"visit_date:from": "2026-07-16",
		});
	});

	it("splits excluded owners on whitespace, deduplicating without splitting commas", () => {
		expect(
			parseExcludedOwnerIds(" owner-a  owner-b\nowner-a id3,id4 "),
		).toEqual(["owner-a", "owner-b", "id3,id4"]);
	});
});
