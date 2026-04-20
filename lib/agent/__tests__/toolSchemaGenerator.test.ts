// Behavioral tests for the SA tool schema generator.
//
// The generator is the single source of truth for `addFields`,
// `addField`, and `editField` tool input shapes. These tests pin down
// the contract consumers rely on:
//
//   - Every kind the registry declares shows up in the `kind` enum.
//   - The batch-item schema stays exactly at the 8-optional-field
//     Anthropic compiler ceiling.
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

	it("keeps the batch-item schema at exactly 8 optional fields (Anthropic ceiling)", () => {
		// The Anthropic structured-output compiler times out above 8
		// optional fields per array item. The generator promotes `label`
		// and `required` to sentinel-required to stay at the limit; this
		// test flags any accidental addition or removal.
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
		expect(optionalCount).toBe(8);
	});

	it("requires id, kind, parentId, label, and required on batch items", () => {
		const jsonSchema = z.toJSONSchema(
			generated.addFieldsItemSchema,
		) as unknown as { required: string[] };
		expect(new Set(jsonSchema.required)).toEqual(
			new Set(["id", "kind", "parentId", "label", "required"]),
		);
	});

	it("makes clearable edit-patch fields nullable", () => {
		// `relevant` / `calculate` / `default_value` / `options` /
		// `case_property` accept `null` to explicitly clear the value;
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
			"case_property",
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
		// Smoke test: each kind should parse successfully when given the
		// minimum acceptable shape. Exercises the union enum + sentinel
		// fields without asserting on individual kind semantics.
		for (const kind of fieldKinds) {
			const payload = {
				id: `test_${kind}`,
				kind,
				parentId: "",
				label: "Test Field",
				required: "",
			};
			const result = generated.addFieldsItemSchema.safeParse(payload);
			expect(result.success, `kind ${kind} failed to parse`).toBe(true);
		}
	});

	it("accepts optional sentinel values on the batch-item schema", () => {
		const result = generated.addFieldsItemSchema.safeParse({
			id: "f1",
			kind: "text",
			parentId: "",
			label: "Full name",
			required: "true()",
			hint: "Enter legal name",
			validate: "string-length(.) > 1",
			validate_msg: "Must not be empty",
			relevant: "#form/collect_name = 'yes'",
			calculate: "",
			default_value: "",
			options: [],
			case_property: "patient",
		});
		expect(result.success).toBe(true);
	});
});
