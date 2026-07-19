import { describe, expect, it } from "vitest";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import {
	asUuid,
	calculatedColumn,
	plainColumn,
	simpleSearchInputDef,
} from "@/lib/domain";
import { arith, prop, term } from "@/lib/domain/predicate";
import { runValidation } from "../../../runner";
import { propertyExists, resolvePropertyDataType } from "../shared";

describe("canonical case-property aliases in case-list validation", () => {
	it.each([
		["name", "case_name", "date", "text"],
		["external-id", "external_id", "date", "text"],
		["date-opened", "date_opened", "text", "datetime"],
	] as const)("resolves legacy %s through %s metadata instead of the stale alias declaration", (alias, canonical, staleType, expectedType) => {
		const doc = buildDoc({
			appName: "Legacy aliases",
			caseTypes: [
				{
					name: "patient",
					properties: [
						{
							name: alias,
							label: `Legacy ${alias}`,
							data_type: staleType,
						},
					],
				},
			],
		});

		expect(resolvePropertyDataType(doc, "patient", canonical)).toBe(
			expectedType,
		);
		expect(resolvePropertyDataType(doc, "patient", alias)).toBe(expectedType);
		expect(propertyExists(doc, "patient", alias)).toBe(true);
	});

	it("keeps a legacy AST reference readable while type-checking the canonical value", () => {
		const doc = buildDoc({
			appName: "Legacy calculation",
			caseTypes: [
				{
					name: "patient",
					properties: [{ name: "name", label: "Old name", data_type: "int" }],
				},
			],
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					caseListConfig: {
						columns: [
							plainColumn(asUuid("name-column"), "case_name", "Name"),
							calculatedColumn(
								asUuid("legacy-calculation"),
								"Name arithmetic",
								arith(
									"+",
									term(prop("patient", "name")),
									term(prop("patient", "name")),
								),
							),
						],
						searchInputs: [],
					},
					forms: [
						{
							name: "Register",
							type: "registration",
							fields: [
								f({
									kind: "text",
									id: "case_name",
									label: "Name",
									case_property_on: "patient",
								}),
							],
						},
					],
				},
			],
		});

		const hits = runValidation(doc).filter(
			(error) => error.code === "CASE_LIST_CALCULATED_COLUMN_TYPE_ERROR",
		);
		expect(hits.length).toBeGreaterThan(0);
		expect(hits.some((error) => /unknown property/i.test(error.message))).toBe(
			false,
		);
		expect(hits.some((error) => /arith|numeric/i.test(error.message))).toBe(
			true,
		);
	});

	it("uses canonical metadata in simple search-input compatibility rules", () => {
		const doc = buildDoc({
			appName: "Legacy search",
			caseTypes: [
				{
					name: "patient",
					properties: [
						{
							name: "external-id",
							label: "Old external ID",
							data_type: "date",
						},
					],
				},
			],
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					caseListConfig: {
						columns: [plainColumn(asUuid("name-column"), "case_name", "Name")],
						searchInputs: [
							simpleSearchInputDef(
								asUuid("external-id-search"),
								"external_id_search",
								"External ID",
								"date",
								"external-id",
							),
						],
					},
					forms: [
						{
							name: "Register",
							type: "registration",
							fields: [
								f({
									kind: "text",
									id: "case_name",
									label: "Name",
									case_property_on: "patient",
								}),
							],
						},
					],
				},
			],
		});

		expect(
			runValidation(doc).some(
				(error) =>
					error.code === "CASE_LIST_SEARCH_INPUT_TYPE_PROPERTY_TYPE_MISMATCH",
			),
		).toBe(true);
	});

	it("continues accepting all legacy spellings as compatibility references", () => {
		const doc = buildDoc({
			appName: "Legacy columns",
			caseTypes: [{ name: "patient", properties: [] }],
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					caseListConfig: caseListConfig([
						{ field: "name", header: "Name" },
						{ field: "external-id", header: "External ID" },
						{ field: "date-opened", header: "Date opened" },
					]),
					forms: [
						{
							name: "Register",
							type: "registration",
							fields: [
								f({
									kind: "text",
									id: "case_name",
									label: "Name",
									case_property_on: "patient",
								}),
							],
						},
					],
				},
			],
		});

		expect(
			runValidation(doc).some(
				(error) => error.code === "CASE_LIST_COLUMN_UNKNOWN_FIELD",
			),
		).toBe(false);
	});
});
