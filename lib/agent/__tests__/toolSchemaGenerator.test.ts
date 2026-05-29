// Behavioral tests for the SA tool schema generator.
//
// The generator is the single source of truth for `addFields`,
// `addField`, and `editField` tool input shapes. These tests pin down
// the contract consumers rely on:
//
//   - Every kind the registry declares shows up in the `kind` enum.
//   - The batch-item schema requires only `id` / `kind` / `label`;
//     `parentId` and `required` are optional (the tool runs on tool-use,
//     not grammar-constrained structured output, so the old 8-optional
//     cap never bound it).
//   - Clearable edit-patch fields accept `null`.
//   - Per-kind `saDocs` lines flow through into the `kind` enum's
//     description (the SA reads the description when picking a kind).
//   - A representative per-kind payload parses successfully (smoke test
//     that the shape is usable end-to-end).

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { fieldKinds, fieldRegistry } from "@/lib/domain";
import { generateToolSchemas } from "../toolSchemaGenerator";

describe("toolSchemaGenerator", () => {
	const generated = generateToolSchemas();

	it("exposes the three expected field-mutation schemas", () => {
		expect(generated.addFieldsItemSchema).toBeDefined();
		expect(generated.addFieldSchema).toBeDefined();
		expect(generated.editFieldUpdatesSchema).toBeDefined();
	});

	it("includes every kind from the registry in the addFields `kind` enum", () => {
		const jsonSchema = z.toJSONSchema(
			generated.addFieldsItemSchema,
		) as unknown as { properties: { kind: { enum: string[] } } };
		expect(new Set(jsonSchema.properties.kind.enum)).toEqual(
			new Set(fieldKinds),
		);
	});

	it("renders per-kind saDocs in the kind enum description", () => {
		// The SA reads the enum description when picking a kind — every
		// `fieldRegistry[kind].saDocs` line should appear in that text,
		// otherwise a new kind's guidance won't surface to the model.
		const jsonSchema = z.toJSONSchema(
			generated.addFieldsItemSchema,
		) as unknown as { properties: { kind: { description?: string } } };
		const description = jsonSchema.properties.kind.description ?? "";
		for (const kind of fieldKinds) {
			expect(description).toContain(fieldRegistry[kind].saDocs);
		}
	});

	it("keeps the batch-item schema at 10 optional fields", () => {
		// The addFields tool runs on tool-use input, which isn't grammar-
		// constrained, so the structured-output 8-optional compile ceiling
		// never bound it. `parentId` + `required` are optional alongside
		// the six flat optionals and the two nested-config objects
		// (`validate`, `repeat`) — ten in total. This test flags any
		// accidental addition or removal.
		const jsonSchema = z.toJSONSchema(
			generated.addFieldsItemSchema,
		) as unknown as {
			properties: Record<string, unknown>;
			required: string[];
		};
		const allKeys = Object.keys(jsonSchema.properties);
		const optionalCount = allKeys.filter(
			(k) => !jsonSchema.required.includes(k),
		).length;
		expect(optionalCount).toBe(10);
	});

	it("requires only id, kind, and label on batch items", () => {
		// `label` is required-with-sentinel ("" = no label) as a conscious-
		// choice guard for the empty-label kinds. `parentId` and `required`
		// are optional — the SA omits them (handler defaults parent →
		// form-level, absent required → not required). Repeat/validation
		// config live nested under their optional objects, contributing no
		// top-level required keys.
		const jsonSchema = z.toJSONSchema(
			generated.addFieldsItemSchema,
		) as unknown as { required: string[] };
		expect(new Set(jsonSchema.required)).toEqual(
			new Set(["id", "kind", "label"]),
		);
	});

	it("parses a batch item that omits parentId and required", () => {
		// The fix that made these optional: a flat field with neither
		// `parentId` nor `required` must parse cleanly (it used to be a
		// hard tool-input rejection that forced the SA to retry with ""
		// sentinels). `label` is still required.
		const result = generated.addFieldsItemSchema.safeParse({
			id: "patient_name",
			kind: "text",
			label: "Patient name",
		});
		expect(result.success).toBe(true);
	});

	it("makes clearable edit-patch fields nullable", () => {
		// `relevant` / `calculate` / `default_value` / `options` /
		// `case_property_on` accept `null` to explicitly clear the value;
		// the tool handler maps null → undefined so the reducer's
		// Object.assign drops the key.
		const jsonSchema = z.toJSONSchema(
			generated.editFieldUpdatesSchema,
		) as unknown as {
			properties: Record<string, { type?: string | string[] }>;
		};
		for (const key of [
			"relevant",
			"calculate",
			"default_value",
			"options",
			"case_property_on",
		]) {
			const prop = jsonSchema.properties[key];
			expect(prop, `expected ${key} in schema`).toBeDefined();
			// Zod's JSON Schema output may use anyOf or an array-typed
			// `type` for nullable — either form is acceptable as long as
			// `null` is a valid value.
			const serialized = JSON.stringify(prop);
			expect(serialized).toContain("null");
		}
	});

	it("parses a representative payload for every field kind", () => {
		// Smoke test: each kind parses with the minimum acceptable
		// shape. Repeat-mode config lives in the optional nested
		// `repeat` object — non-repeat kinds simply omit it.
		for (const kind of fieldKinds) {
			const payload: Record<string, unknown> = {
				id: `test_${kind}`,
				kind,
				parentId: "",
				label: "Test Field",
				required: "",
			};
			// Repeat needs the `repeat` config object (with at least a
			// `mode`) for the discriminated union to find a variant.
			if (kind === "repeat") {
				payload.repeat = { mode: "user_controlled" };
			}
			const result = generated.addFieldsItemSchema.safeParse(payload);
			expect(result.success, `kind ${kind} failed to parse`).toBe(true);
		}
	});

	it("accepts optional values on the batch-item schema (nested validate)", () => {
		// Validation lives under nested `validate: { expr, msg? }`. The
		// outer object consumes a single optional slot regardless of
		// whether `msg` is set.
		const result = generated.addFieldsItemSchema.safeParse({
			id: "f1",
			kind: "text",
			parentId: "",
			label: "Full name",
			required: "true()",
			hint: "Enter legal name",
			validate: {
				expr: "string-length(.) > 1",
				msg: "Must not be empty",
			},
			relevant: "#form/collect_name = 'yes'",
			calculate: "",
			default_value: "",
			options: [],
			case_property_on: "patient",
		});
		expect(result.success).toBe(true);
	});

	it("accepts a query_bound repeat with nested config on the single-add schema", () => {
		// SA picks `mode` and provides the matching mode-specific field
		// (`ids_query` for query_bound) inside the nested `repeat` object.
		const result = generated.addFieldSchema.safeParse({
			id: "service_cases",
			kind: "repeat",
			label: "Service cases",
			repeat: {
				mode: "query_bound",
				ids_query: "#form/service_case_ids",
			},
		});
		expect(result.success).toBe(true);
	});

	it("accepts a count_bound repeat with nested config on the single-add schema", () => {
		const result = generated.addFieldSchema.safeParse({
			id: "iterations",
			kind: "repeat",
			label: "Iterations",
			repeat: {
				mode: "count_bound",
				count: "#form/desired_count",
			},
		});
		expect(result.success).toBe(true);
	});

	it("requires `mode` inside the nested repeat config (no silent default)", () => {
		// A `repeat` object without `mode` should fail to parse — the
		// schema-level enforcement is what makes the `flatFieldToField`
		// reshape safe. SA omitting mode surfaces as a parse error
		// rather than a silent fallback to user_controlled.
		const result = generated.addFieldSchema.safeParse({
			id: "iterations",
			kind: "repeat",
			label: "Iterations",
			repeat: { count: "#form/desired_count" },
		});
		expect(result.success).toBe(false);
	});
});
