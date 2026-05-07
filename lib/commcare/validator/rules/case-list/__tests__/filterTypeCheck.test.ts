import { describe, expect, it } from "vitest";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { eq, gt, literal, prop } from "@/lib/domain/predicate";
import { runValidation } from "../../../runner";

describe("filterTypeCheck", () => {
	it("fires when the filter has an operand-type mismatch", () => {
		// `gt` on a `text` property — strings aren't ordered, so the type
		// checker rejects the comparison.
		const doc = buildDoc({
			appName: "Test",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [{ kind: "plain", field: "case_name", header: "Name" }],
						sort: [],
						calculatedColumns: [],
						searchInputs: [],
						filter: gt(prop("patient", "name"), literal("M")),
					},
					forms: [
						{
							name: "Reg",
							type: "registration",
							fields: [
								f({
									kind: "text",
									id: "case_name",
									label: "Name",
									case_property_on: "patient",
								}),
								f({
									kind: "text",
									id: "name",
									label: "Name",
									case_property_on: "patient",
								}),
							],
						},
					],
				},
			],
			caseTypes: [
				{
					name: "patient",
					properties: [
						{ name: "case_name", label: "Name", data_type: "text" },
						{ name: "name", label: "Name", data_type: "text" },
					],
				},
			],
		});
		const errors = runValidation(doc);
		expect(errors.some((e) => e.code === "CASE_LIST_FILTER_TYPE_ERROR")).toBe(
			true,
		);
	});

	it("does not fire on a well-typed filter", () => {
		const doc = buildDoc({
			appName: "Test",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [{ kind: "plain", field: "case_name", header: "Name" }],
						sort: [],
						calculatedColumns: [],
						searchInputs: [],
						// `eq(prop, literal)` — text vs string literal is structurally
						// compatible.
						filter: eq(prop("patient", "name"), literal("Alice")),
					},
					forms: [
						{
							name: "Reg",
							type: "registration",
							fields: [
								f({
									kind: "text",
									id: "case_name",
									label: "Name",
									case_property_on: "patient",
								}),
								f({
									kind: "text",
									id: "name",
									label: "Name",
									case_property_on: "patient",
								}),
							],
						},
					],
				},
			],
			caseTypes: [
				{
					name: "patient",
					properties: [
						{ name: "case_name", label: "Name", data_type: "text" },
						{ name: "name", label: "Name", data_type: "text" },
					],
				},
			],
		});
		expect(
			runValidation(doc).some((e) => e.code === "CASE_LIST_FILTER_TYPE_ERROR"),
		).toBe(false);
	});

	it("fires when the filter references an unknown property", () => {
		const doc = buildDoc({
			appName: "Test",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [{ kind: "plain", field: "case_name", header: "Name" }],
						sort: [],
						calculatedColumns: [],
						searchInputs: [],
						filter: eq(prop("patient", "ghost"), literal("x")),
					},
					forms: [
						{
							name: "Reg",
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
			caseTypes: [{ name: "patient", properties: [] }],
		});
		const errors = runValidation(doc);
		expect(
			errors.some(
				(e) =>
					e.code === "CASE_LIST_FILTER_TYPE_ERROR" &&
					e.message.toLowerCase().includes("unknown property"),
			),
		).toBe(true);
	});

	it("short-circuits cleanly when the filter slot is absent", () => {
		const doc = buildDoc({
			appName: "Test",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
					forms: [
						{
							name: "Reg",
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
			caseTypes: [{ name: "patient", properties: [] }],
		});
		expect(
			runValidation(doc).some((e) => e.code === "CASE_LIST_FILTER_TYPE_ERROR"),
		).toBe(false);
	});
});
