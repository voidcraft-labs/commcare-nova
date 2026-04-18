// lib/agent/__tests__/toolSchemaGenerator.test.ts
//
// Byte-identity contract: the generator's output must match the
// committed snapshot fixtures exactly. If this test fails after a
// generator change, either the generator drifted (fix the generator) or
// the fixture is stale (regenerate the fixture ONLY with explicit user
// sign-off — the LLM sees these schemas and changes affect its behavior).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { type FieldKind, fieldKinds } from "@/lib/domain";
import { generateToolSchemas } from "../toolSchemaGenerator";

const FIXTURES_DIR = join(__dirname, "..", "__fixtures__");

function loadFixture(name: string): string {
	return readFileSync(join(FIXTURES_DIR, `${name}.snapshot.json`), "utf-8");
}

function serialize(schema: z.ZodType): string {
	return `${JSON.stringify(z.toJSONSchema(schema), null, 2)}\n`;
}

describe("toolSchemaGenerator", () => {
	const generated = generateToolSchemas("flat-sentinels");

	it("addQuestionsQuestionSchema matches the hand-written snapshot byte-for-byte", () => {
		const expected = loadFixture("addQuestionsSchema");
		const actual = serialize(generated.addQuestionsQuestionSchema);
		expect(actual).toBe(expected);
	});

	it("addQuestionQuestionSchema matches the hand-written snapshot byte-for-byte", () => {
		const expected = loadFixture("addQuestionQuestionSchema");
		const actual = serialize(generated.addQuestionQuestionSchema);
		expect(actual).toBe(expected);
	});

	it("editQuestionUpdatesSchema matches the hand-written snapshot byte-for-byte", () => {
		const expected = loadFixture("editQuestionUpdatesSchema");
		const actual = serialize(generated.editQuestionUpdatesSchema);
		expect(actual).toBe(expected);
	});

	it("includes every kind from the registry in the type enum", () => {
		// `z.toJSONSchema` returns a wide `_JSONSchema` union; narrow it
		// via `unknown` to the single shape this assertion cares about.
		const jsonSchema = z.toJSONSchema(
			generated.addQuestionsQuestionSchema,
		) as unknown as { properties: { type: { enum: FieldKind[] } } };
		expect(new Set(jsonSchema.properties.type.enum)).toEqual(
			new Set(fieldKinds),
		);
	});

	it("keeps the batch schema under 8 optional fields per array item", () => {
		// The Anthropic schema compiler times out over 8 optionals. The
		// generator hits exactly 8 — this test flags any accidental
		// addition of a new optional key without the corresponding
		// sentinel conversion.
		const jsonSchema = z.toJSONSchema(
			generated.addQuestionsQuestionSchema,
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

	it("refuses the per-type mode (future work)", () => {
		expect(() => generateToolSchemas("per-type")).toThrow(/not implemented/);
	});
});
