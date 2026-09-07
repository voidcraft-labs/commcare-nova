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
			columnInputSchema.parse({
				kind: "plain",
				field: "external_id",
				header: "Value",
			}),
			UUID,
		);
		if (column.kind !== "plain") throw new Error("expected plain column");
		expect(column.field).toBe("external_id");
	});

	it("preserves accepted expression references exactly", () => {
		const expression = term(prop("patient", "client-code"));
		const column = stampColumnUuid(
			columnInputSchema.parse({
				kind: "calculated",
				header: "Client code",
				expression,
			}),
			UUID,
		);
		if (column.kind !== "calculated") {
			throw new Error("expected calculated column");
		}
		expect(column.expression).toEqual(expression);
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
		"rejects alias %s specifically in simple targets and advanced case predicates",
		(property) => {
			const simple = {
				kind: "simple",
				name: "query",
				label: "Query",
				type: "text",
				property: "case_name",
			};
			expect(searchInputDefInputSchema.safeParse(simple).success).toBe(true);
			expect(
				searchInputDefInputSchema.safeParse({ ...simple, property }).success,
			).toBe(false);
			const advanced = (caseProperty: string) => ({
				kind: "advanced",
				name: "query",
				label: "Query",
				type: "text",
				predicate: {
					kind: "eq",
					left: {
						kind: "term",
						term: { kind: "prop", caseType: "patient", property: caseProperty },
					},
					right: term(literal("Alice")),
				},
			});
			// Case reads are allowed in the predicate; a default would reject every
			// property for scope reasons and could not witness vocabulary enforcement.
			expect(
				searchInputDefInputSchema.safeParse(advanced("case_name")).success,
			).toBe(true);
			expect(
				searchInputDefInputSchema.safeParse(advanced(property)).success,
			).toBe(false);
		},
	);

	it("stamps an accepted search input without rewriting it", () => {
		const input = stampSearchInputUuid(
			searchInputDefInputSchema.parse({
				kind: "simple",
				name: "client_code",
				label: "Client code",
				type: "text",
				property: "client-code",
				default: term(literal("")),
			}),
			UUID,
		);
		if (input.kind !== "simple")
			throw new Error("expected simple Search input");
		expect(input.property).toBe("client-code");
	});
});
