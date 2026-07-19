import { describe, expect, it } from "vitest";
import { asUuid } from "@/lib/domain";
import { eq, literal, prop, term } from "@/lib/domain/predicate";
import { stampColumnUuid, stampSearchInputUuid } from "../shared";

const UUID = asUuid("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");

describe("case-list tool canonical property vocabulary", () => {
	it.each([
		["name", "case_name"],
		["external-id", "external_id"],
		["date-opened", "date_opened"],
		["status", "status"],
		["current_status", "current_status"],
	])("normalizes column field %s to %s", (field, expected) => {
		const column = stampColumnUuid(
			{ kind: "plain", field, header: "Value" },
			UUID,
		);
		if (column.kind !== "plain") throw new Error("expected plain column");
		expect(column.field).toBe(expected);
	});

	it("normalizes calculated-column property references without mutating input", () => {
		const expression = term(prop("patient", "external-id"));
		const column = stampColumnUuid(
			{ kind: "calculated", header: "External ID", expression },
			UUID,
		);
		if (column.kind !== "calculated") {
			throw new Error("expected calculated column");
		}
		expect(column.expression).toEqual(term(prop("patient", "external_id")));
		expect(expression).toEqual(term(prop("patient", "external-id")));
	});

	it("normalizes simple targets and property references in defaults", () => {
		const input = stampSearchInputUuid(
			{
				kind: "simple",
				name: "case_name_query",
				label: "Name",
				type: "text",
				property: "name",
				default: term(prop("patient", "date-opened")),
			},
			UUID,
		);
		if (input.kind !== "simple") throw new Error("expected simple input");
		expect(input.property).toBe("case_name");
		expect(input.default).toEqual(term(prop("patient", "date_opened")));
	});

	it("normalizes advanced predicates but keeps current_status distinct", () => {
		const input = stampSearchInputUuid(
			{
				kind: "advanced",
				name: "name_query",
				label: "Name",
				type: "text",
				predicate: eq(prop("patient", "name"), literal("Ada")),
				default: term(prop("patient", "current_status")),
			},
			UUID,
		);
		if (input.kind !== "advanced") throw new Error("expected advanced input");
		expect(input.predicate).toEqual(
			eq(prop("patient", "case_name"), literal("Ada")),
		);
		expect(input.default).toEqual(term(prop("patient", "current_status")));
	});
});
