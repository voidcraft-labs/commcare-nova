// lib/domain/predicate/__tests__/jsonSchema.test.ts
//
// Acceptance tests for the CaseType -> JSON Schema generator. These pin
// every `data_type` variant in the blueprint enum, plus the
// no-data_type-default and empty-options edge cases. The schema this
// generator produces is the contract enforced at the case database's
// write boundary; a regression here would silently let mistyped
// payloads land on disk.

import { describe, expect, it } from "vitest";
import type { CaseType } from "@/lib/domain";
import { caseTypeToJsonSchema } from "../jsonSchema";

describe("caseTypeToJsonSchema", () => {
	it("maps a text property", () => {
		const ct: CaseType = {
			name: "patient",
			properties: [{ name: "name", label: "Name", data_type: "text" }],
		};
		expect(caseTypeToJsonSchema(ct)).toEqual({
			type: "object",
			properties: {
				name: { type: "string" },
			},
			additionalProperties: false,
		});
	});

	it("maps int / decimal / date / time / datetime", () => {
		const ct: CaseType = {
			name: "patient",
			properties: [
				{ name: "age", label: "Age", data_type: "int" },
				{ name: "bmi", label: "BMI", data_type: "decimal" },
				{ name: "dob", label: "DOB", data_type: "date" },
				{ name: "appointment_at", label: "When", data_type: "time" },
				{ name: "registered_at", label: "When", data_type: "datetime" },
			],
		};
		const schema = caseTypeToJsonSchema(ct);
		expect(schema.properties.age).toEqual({ type: "integer" });
		expect(schema.properties.bmi).toEqual({ type: "number" });
		expect(schema.properties.dob).toEqual({ type: "string", format: "date" });
		expect(schema.properties.appointment_at).toEqual({
			type: "string",
			format: "time",
		});
		expect(schema.properties.registered_at).toEqual({
			type: "string",
			format: "date-time",
		});
	});

	it("maps single_select with options to an enum", () => {
		const ct: CaseType = {
			name: "patient",
			properties: [
				{
					name: "status",
					label: "Status",
					data_type: "single_select",
					options: [
						{ value: "open", label: "Open" },
						{ value: "closed", label: "Closed" },
					],
				},
			],
		};
		expect(caseTypeToJsonSchema(ct).properties.status).toEqual({
			type: "string",
			enum: ["open", "closed"],
		});
	});

	it("maps multi_select to an array of enum-restricted strings", () => {
		const ct: CaseType = {
			name: "patient",
			properties: [
				{
					name: "languages",
					label: "Languages",
					data_type: "multi_select",
					options: [
						{ value: "en", label: "English" },
						{ value: "fr", label: "French" },
					],
				},
			],
		};
		expect(caseTypeToJsonSchema(ct).properties.languages).toEqual({
			type: "array",
			items: { type: "string", enum: ["en", "fr"] },
		});
	});

	it("emits an empty enum when a select property has no options yet", () => {
		// A blueprint can briefly hold a select property with no options
		// (mid-edit, partial generation). The generator faithfully reflects
		// that state — `enum: []` matches nothing, which is the correct
		// downstream behavior: writes against an unconfigured select are
		// rejected until the blueprint is filled in.
		const ct: CaseType = {
			name: "patient",
			properties: [
				{
					name: "status",
					label: "Status",
					data_type: "single_select",
				},
				{
					name: "languages",
					label: "Languages",
					data_type: "multi_select",
					options: [],
				},
			],
		};
		const schema = caseTypeToJsonSchema(ct);
		expect(schema.properties.status).toEqual({
			type: "string",
			enum: [],
		});
		expect(schema.properties.languages).toEqual({
			type: "array",
			items: { type: "string", enum: [] },
		});
	});

	it("maps geopoint to a string with the CommCare pattern", () => {
		const ct: CaseType = {
			name: "clinic",
			properties: [{ name: "location", label: "Loc", data_type: "geopoint" }],
		};
		expect(caseTypeToJsonSchema(ct).properties.location).toEqual({
			type: "string",
			pattern: "^-?\\d+\\.?\\d*\\s-?\\d+\\.?\\d*$",
		});
	});

	it("defaults a property without data_type to string", () => {
		const ct: CaseType = {
			name: "patient",
			properties: [{ name: "notes", label: "Notes" }],
		};
		expect(caseTypeToJsonSchema(ct).properties.notes).toEqual({
			type: "string",
		});
	});

	it("forbids unknown properties via additionalProperties:false", () => {
		const ct: CaseType = {
			name: "patient",
			properties: [{ name: "name", label: "Name", data_type: "text" }],
		};
		expect(caseTypeToJsonSchema(ct).additionalProperties).toBe(false);
	});
});
