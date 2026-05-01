// lib/domain/predicate/__tests__/jsonSchema.test.ts
//
// Acceptance tests for the CaseType -> JSON Schema generator. These pin
// every `data_type` variant in the blueprint enum, plus the
// no-data_type-default and empty-options edge cases. The schema this
// generator produces is the contract enforced at the case database's
// write boundary; a regression here would silently let mistyped
// payloads land on disk.
//
// The geopoint test compiles the emitted regex and exercises it against
// real CommCare wire-format strings (4 space-separated decimals, single
// ASCII space) sourced from `corehq/ex-submodules/couchforms/geopoint.py`.
// Asserting the literal pattern string would be tautological with the
// implementation; running it as a regex catches format bugs that a
// snapshot can't.

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

	it("emits a permissive schema when a select property has no options yet", () => {
		// A blueprint can briefly hold a select property with no options
		// (mid-edit, partial generation). The generator falls back to a
		// permissive shape — `{ type: "string" }` for single, `{ type:
		// "array", items: { type: "string" } }` for multi — rather than
		// emitting `enum: []`. Two reasons:
		//   1. Ajv 8 (and other strict JSON Schema validators) reject
		//      empty-enum schemas at compile time, which would block ALL
		//      writes against the case type rather than just writes to
		//      this property.
		//   2. The "fail closed until configured" intent is reasonable
		//      but the wrong layer for it; mid-edit blueprints aren't
		//      receiving real authored data, so locking the validator
		//      against them creates more breakage than it prevents. Once
		//      options are configured the schema tightens automatically.
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
		expect(schema.properties.status).toEqual({ type: "string" });
		expect(schema.properties.languages).toEqual({
			type: "array",
			items: { type: "string" },
		});
	});

	it("emits a geopoint pattern that matches CommCare's 4-element wire format", () => {
		// Verified against `corehq/ex-submodules/couchforms/geopoint.py`:
		//   - line 44: `input_string.split(' ')` — literal single ASCII
		//     space, NOT \s, so tabs and newlines are not accepted.
		//   - line 48: strict path requires exactly 4 elements
		//     (latitude, longitude, altitude, accuracy).
		//   - lines 55-65: `_to_decimal` calls Decimal(n), which accepts
		//     scientific notation; very small sci-notation values round
		//     to 0 but still parse.
		// Lat/lon range checks live in `_validate_range` (lines 68-71)
		// and are an application-layer concern; the regex handles shape
		// only.
		const ct: CaseType = {
			name: "clinic",
			properties: [{ name: "location", label: "Loc", data_type: "geopoint" }],
		};
		const schema = caseTypeToJsonSchema(ct);
		const propSchema = schema.properties.location;
		if (propSchema.type !== "string" || !propSchema.pattern) {
			throw new Error("expected string + pattern for geopoint property");
		}
		const re = new RegExp(propSchema.pattern);

		// Real CommCare wire-format values (lat lon altitude accuracy).
		expect(re.test("14.719783 -17.459261 0 0")).toBe(true);
		expect(re.test("-13.1058758 39.8739394 375.73 18.76")).toBe(true);
		expect(re.test("0 0 0 0")).toBe(true);
		// Scientific notation (CCHQ's _to_decimal accepts it).
		expect(re.test("1.23e-5 2.0E10 0 0")).toBe(true);
		expect(re.test("1e5 -1.23E-5 0 0")).toBe(true);

		// Things the regex must reject.
		expect(re.test("14.7 -17.4")).toBe(false); // 2 elements (flexible-mode only)
		expect(re.test("14.7 -17.4 0")).toBe(false); // 3 elements
		expect(re.test("14.7 -17.4 0 0 0")).toBe(false); // 5 elements
		expect(re.test("14.7,-17.4,0,0")).toBe(false); // commas
		expect(re.test("14.7\t-17.4 0 0")).toBe(false); // tab not allowed
		expect(re.test("abc def 0 0")).toBe(false); // non-numeric
		expect(re.test("")).toBe(false);
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
