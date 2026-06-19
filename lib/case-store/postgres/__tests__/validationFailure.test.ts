// lib/case-store/postgres/__tests__/validationFailure.test.ts
//
// Unit tests for `ajvErrorToCaseFailure` — the AJV-error → typed
// `CasePropertyFailure` projection both write paths share. Pure: a
// real AJV validator produces the errors, so the test pins the actual
// `params.additionalProperty` shape AJV emits (the contract that makes
// naming the offending property possible), not a hand-mocked stand-in.

import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import { ajvErrorToCaseFailure } from "../validationFailure";

function compile(schema: object) {
	const ajv = new Ajv2020({ strict: false });
	addFormats(ajv);
	return ajv.compile(schema);
}

// A closed object schema — the exact shape `caseTypeToJsonSchema`
// emits (`additionalProperties: false` over the declared property set).
const CLOSED_SCHEMA = {
	type: "object",
	properties: { age: { type: "integer" } },
	additionalProperties: false,
} as const;

describe("ajvErrorToCaseFailure", () => {
	it("names the offending key AND surfaces it structurally on an additionalProperties failure (the stale-schema drift signal)", () => {
		const validate = compile(CLOSED_SCHEMA);
		// `phone` is the property a stale `client` schema row lacks — the
		// real-world reproduction behind this fix.
		expect(validate({ age: 30, phone: "+1 5551234567" })).toBe(false);
		const errors = validate.errors ?? [];
		const additional = errors.find((e) => e.keyword === "additionalProperties");
		expect(additional).toBeDefined();
		// `additionalProperty` is the structural drift signal `withSchemaHeal`
		// keys on (not the message text), so it must be set here.
		// biome-ignore lint/style/noNonNullAssertion: guarded by the assertion above
		expect(ajvErrorToCaseFailure(additional!)).toEqual({
			path: "",
			message: "must NOT have additional property 'phone'",
			additionalProperty: "phone",
		});
	});

	it("passes a type failure through with AJV's default message and path", () => {
		const validate = compile(CLOSED_SCHEMA);
		expect(validate({ age: "thirty" })).toBe(false);
		const typeError = (validate.errors ?? []).find((e) => e.keyword === "type");
		expect(typeError).toBeDefined();
		// biome-ignore lint/style/noNonNullAssertion: guarded by the assertion above
		const failure = ajvErrorToCaseFailure(typeError!);
		expect(failure.path).toBe("/age");
		expect(failure.message).toBe("must be integer");
	});

	it("falls back to the default message if an additionalProperties error carries no key", () => {
		// Defensive: a synthetic additionalProperties error whose params
		// lack `additionalProperty` (shape AJV should never emit) must not
		// produce `additional property 'undefined'` — it falls back to the
		// keyword's own message.
		const synthetic = {
			keyword: "additionalProperties",
			instancePath: "",
			schemaPath: "#/additionalProperties",
			params: {},
			message: "must NOT have additional properties",
			// biome-ignore lint/suspicious/noExplicitAny: hand-built ErrorObject for the defensive arm
		} as any;
		expect(ajvErrorToCaseFailure(synthetic)).toEqual({
			path: "",
			message: "must NOT have additional properties",
		});
	});
});
