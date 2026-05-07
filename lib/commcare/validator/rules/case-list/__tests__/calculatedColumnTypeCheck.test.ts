import { describe, expect, it } from "vitest";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { calculatedColumn, plainColumn } from "@/lib/domain";
import { arith, prop, term } from "@/lib/domain/predicate";
import { runValidation } from "../../../runner";

describe("calculatedColumnTypeCheck", () => {
	it("fires when a calculated column's expression has a type error", () => {
		// `arith` requires numeric operands — a `text` property fails the
		// per-side numeric check.
		const doc = buildDoc({
			appName: "Test",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [plainColumn("case_name", "Name")],
						sort: [],
						calculatedColumns: [
							calculatedColumn(
								"bad_arith",
								"Bad",
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
			runValidation(doc).some(
				(e) => e.code === "CASE_LIST_CALCULATED_COLUMN_TYPE_ERROR",
			),
		).toBe(true);
	});

	it("does not fire on a well-typed calculated column", () => {
		const doc = buildDoc({
			appName: "Test",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [plainColumn("case_name", "Name")],
						sort: [],
						calculatedColumns: [
							calculatedColumn(
								"age_plus_one",
								"Age + 1",
								arith(
									"+",
									term(prop("patient", "age")),
									term(prop("patient", "age")),
								),
							),
						],
						searchInputs: [],
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
									kind: "int",
									id: "age",
									label: "Age",
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
						{ name: "age", label: "Age", data_type: "int" },
					],
				},
			],
		});
		expect(
			runValidation(doc).some(
				(e) => e.code === "CASE_LIST_CALCULATED_COLUMN_TYPE_ERROR",
			),
		).toBe(false);
	});

	it("fires when a calculated column references an unknown property", () => {
		const doc = buildDoc({
			appName: "Test",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [plainColumn("case_name", "Name")],
						sort: [],
						calculatedColumns: [
							calculatedColumn(
								"unknown_ref",
								"Unknown",
								term(prop("patient", "ghost")),
							),
						],
						searchInputs: [],
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
		expect(
			runValidation(doc).some(
				(e) =>
					e.code === "CASE_LIST_CALCULATED_COLUMN_TYPE_ERROR" &&
					e.message.toLowerCase().includes("unknown property"),
			),
		).toBe(true);
	});

	it("short-circuits cleanly when no calculated columns are declared", () => {
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
			runValidation(doc).some(
				(e) => e.code === "CASE_LIST_CALCULATED_COLUMN_TYPE_ERROR",
			),
		).toBe(false);
	});
});
