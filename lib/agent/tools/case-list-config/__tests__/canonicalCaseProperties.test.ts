import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { literal, prop, term } from "@/lib/domain/predicate";
import {
	columnInputSchema,
	searchInputDefInputSchema,
	stampColumnUuid,
	stampSearchInputUuid,
} from "../shared";

const UUID = testUuid("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");

describe("case-list tools use the exact case-property vocabulary", () => {
	it("preserves an accepted column field exactly", () => {
		const column = stampColumnUuid(
			{ kind: "plain", field: "external_id", header: "Value" },
			UUID,
		);
		if (column.kind !== "plain") throw new Error("expected plain column");
		expect(column.field).toBe("external_id");
	});

	it("preserves accepted expression references exactly", () => {
		const expression = term(prop("patient", "client-code"));
		const column = stampColumnUuid(
			{ kind: "calculated", header: "Client code", expression },
			UUID,
		);
		if (column.kind !== "calculated") {
			throw new Error("expected calculated column");
		}
		expect(column.expression).toBe(expression);
	});

	it.each(["name", "external-id", "date-opened"])(
		"rejects %s at the column tool schema",
		(field) => {
			expect(
				columnInputSchema.safeParse({
					kind: "plain",
					field,
					header: "Value",
				}).success,
			).toBe(false);
		},
	);

	it.each(["name", "external-id", "date-opened"])(
		"rejects %s in simple targets and nested expression refs",
		(property) => {
			expect(
				searchInputDefInputSchema.safeParse({
					kind: "simple",
					name: "query",
					label: "Query",
					type: "text",
					property,
				}).success,
			).toBe(false);
			expect(
				searchInputDefInputSchema.safeParse({
					kind: "simple",
					name: "query",
					label: "Query",
					type: "text",
					property: "case_name",
					default: {
						kind: "term",
						term: { kind: "prop", caseType: "patient", property },
					},
				}).success,
			).toBe(false);
		},
	);

	it("stamps an accepted search input without rewriting it", () => {
		const input = stampSearchInputUuid(
			{
				kind: "simple",
				name: "client_code",
				label: "Client code",
				type: "text",
				property: "client-code",
				default: term(literal("")),
			},
			UUID,
		);
		if (input.kind !== "simple")
			throw new Error("expected simple Search input");
		expect(input.property).toBe("client-code");
	});
});
