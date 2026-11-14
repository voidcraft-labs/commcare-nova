/** The name grammars a client receives from tools/list are the ones Nova
 * holds: a case type in HQ's editor grammar, a written property and a Search
 * field's name holding hyphens, a choice value holding a quote mark, a lookup
 * tag or column name holding hyphens, and an inline choice list of one
 * option. A served schema that kept an older, narrower pattern or minimum
 * would refuse at the client a name every other surface admits, so the model
 * could never write it. Each served position is read as a client reads it and
 * handed to an independent JSON Schema validator. */
import type { Client } from "@modelcontextprotocol/client";
import Ajv2020 from "ajv/dist/2020";
import { beforeAll, describe, expect, it } from "vitest";
import { registerNovaTools } from "../server";
import { withMcpClient } from "./client";

type Json = Record<string, unknown>;
const object = (value: unknown): value is Json =>
	value !== null && typeof value === "object" && !Array.isArray(value);

/** Grammars Nova held before and holds nowhere now, each as the source text a
 * served `pattern` carried. */
const RETIRED_PATTERNS: readonly (readonly [string, string])[] = [
	[
		"the case type grammar that required a leading letter",
		"^[a-zA-Z][a-zA-Z0-9_-]*$",
	],
	["its copy bounded to 255 characters", "^[A-Za-z][A-Za-z0-9_-]{0,254}$"],
	[
		"the written property grammar without the hyphen",
		"^[A-Za-z][A-Za-z0-9_]*$",
	],
	["the choice value grammar that refused every quote mark", "^[^\\s'\"`]+$"],
];

/** The two grammars without the hyphen that a Search field's name and a
 * lookup tag or column name took, and other names still take. */
const NO_HYPHEN_PATTERNS = new Set([
	"^[a-zA-Z_][a-zA-Z0-9_]*$",
	"^[A-Za-z_][A-Za-z0-9_]*$",
]);

const NAMED_SUBSCHEMAS = ["properties", "definitions", "$defs"];
const SUBSCHEMAS = [
	"items",
	"additionalProperties",
	"not",
	"if",
	"then",
	"else",
	"allOf",
	"anyOf",
	"oneOf",
	"prefixItems",
];

/** `schema` with a local `$ref` followed to what it names in `root`. */
function resolved(root: Json, schema: Json): Json {
	const ref = schema.$ref;
	if (typeof ref !== "string" || !ref.startsWith("#/")) return schema;
	let at: unknown = root;
	for (const step of ref.slice(2).split("/"))
		at = object(at) ? at[step] : undefined;
	if (!object(at))
		throw new Error(`The reference ${ref} names nothing in its schema.`);
	return resolved(root, at);
}

/** Every schema position under `root`, references followed once each, with
 * the property name it is the value of, where it is one. */
function positions(root: Json): { schema: Json; property?: string }[] {
	const found: { schema: Json; property?: string }[] = [];
	const seen = new Map<Json, Set<string | undefined>>();
	const visit = (raw: Json, property?: string) => {
		const schema = resolved(root, raw);
		const named = seen.get(schema);
		if (named?.has(property)) return;
		found.push(property === undefined ? { schema } : { schema, property });
		if (named !== undefined) {
			// Its subschemas were visited when it was first reached.
			named.add(property);
			return;
		}
		seen.set(schema, new Set([property]));
		for (const key of NAMED_SUBSCHEMAS) {
			const entries = schema[key];
			if (!object(entries)) continue;
			for (const [name, value] of Object.entries(entries))
				if (object(value))
					visit(value, key === "properties" ? name : undefined);
		}
		for (const key of SUBSCHEMAS) {
			const value = schema[key];
			if (object(value)) visit(value, key === "items" ? undefined : property);
			else if (Array.isArray(value))
				for (const item of value) if (object(item)) visit(item, property);
		}
	};
	visit(root);
	return found;
}

let listed: Awaited<ReturnType<Client["listTools"]>>["tools"];
beforeAll(async () => {
	listed = await withMcpClient(
		(server) =>
			registerNovaTools(server, {
				userId: "member",
				scopes: ["nova.read", "nova.write"],
				authKind: "api-key",
			}),
		async (client) => (await client.listTools()).tools,
	);
});

function served(name: string): Json {
	const tool = listed.find((entry) => entry.name === name);
	if (!tool) throw new Error(`${name} is missing from tools/list`);
	return tool.inputSchema as Json;
}

/** The string schemas carrying a pattern that `tool` serves as the value of
 * a property named `property`; at least one, or a failure naming it. */
function patternedAt(tool: string, property: string): Json[] {
	const found = positions(served(tool))
		.filter(
			(position) =>
				position.property === property &&
				typeof position.schema.pattern === "string",
		)
		.map((position) => position.schema);
	if (found.length === 0)
		throw new Error(
			`${tool} serves no patterned ${property}; the test reads the grammar there, so look for where the tool's input names it now.`,
		);
	return found;
}

const validator = (schema: Json) =>
	new Ajv2020({ strict: false, validateFormats: false }).compile(schema);

/** Whether every patterned `property` of `tool` takes `value`. */
function takes(tool: string, property: string, value: string): boolean {
	return patternedAt(tool, property).every((schema) =>
		Boolean(validator(schema)(value)),
	);
}

it("serves no pattern of a grammar Nova no longer holds, on any tool", () => {
	const kept: string[] = [];
	for (const tool of listed)
		for (const { schema } of positions(tool.inputSchema as Json))
			for (const [grammar, source] of RETIRED_PATTERNS)
				if (schema.pattern === source)
					kept.push(
						`${tool.name} still serves ${grammar} (${source}); the grammar a person and the builder use is wider, so build this position's schema from the shared pattern.`,
					);
	expect(kept).toEqual([]);
});

it("serves no inline choice list that needs more than one option, on any tool", () => {
	const narrow: string[] = [];
	for (const tool of listed)
		for (const { schema, property } of positions(tool.inputSchema as Json)) {
			const items = object(schema.items) ? schema.items : undefined;
			const option =
				items !== undefined &&
				object(items.properties) &&
				object(items.properties.value);
			if (
				property === "options" &&
				option &&
				typeof schema.minItems === "number" &&
				schema.minItems > 1
			)
				narrow.push(
					`${tool.name} serves a choice list of at least ${schema.minItems} options; a select holds one option or more.`,
				);
		}
	expect(narrow).toEqual([]);
});

describe("the served grammars take the names Nova holds", () => {
	it("takes an inline choice list of one option, and a choice value holding a quote mark", () => {
		const lists = positions(served("add_fields")).filter(
			({ schema, property }) =>
				property === "options" && typeof schema.minItems === "number",
		);
		expect(lists.length).toBeGreaterThan(0);
		for (const { schema } of lists) expect(schema.minItems).toBe(1);
		expect(takes("add_fields", "value", "it's")).toBe(true);
		expect(takes("add_fields", "value", "it is")).toBe(false);
		expect(takes("update_case_property", "value", 'say"hi"')).toBe(true);
		expect(takes("update_case_property", "value", "say hi")).toBe(false);
	});

	it("takes a case type that starts with a digit and a written property holding a hyphen", () => {
		expect(takes("add_case_operations", "caseType", "1st-visit")).toBe(true);
		expect(takes("add_case_operations", "caseType", "1st visit")).toBe(false);
		expect(takes("add_case_operations", "property", "first-name")).toBe(true);
		expect(takes("add_case_operations", "property", "first name")).toBe(false);
	});

	it("takes a Search field named with a hyphen, on every tool that names one", () => {
		for (const tool of [
			"add_search_inputs",
			"update_search_input",
			"configure_case_list",
		]) {
			const names = patternedAt(tool, "name");
			for (const schema of names)
				expect(NO_HYPHEN_PATTERNS.has(schema.pattern as string)).toBe(false);
			expect(takes(tool, "name", "first-name"), tool).toBe(true);
			expect(takes(tool, "name", "first name"), tool).toBe(false);
		}
	});

	it("takes a lookup tag holding hyphens and refuses one holding a period, on every tool that names one", () => {
		for (const tool of ["create_lookup_table", "update_lookup_table"]) {
			for (const schema of patternedAt(tool, "tag"))
				expect(NO_HYPHEN_PATTERNS.has(schema.pattern as string), tool).toBe(
					false,
				);
			expect(takes(tool, "tag", "health-facility-v2"), tool).toBe(true);
			expect(takes(tool, "tag", "geo.lat"), tool).toBe(false);
			expect(takes(tool, "tag", "health facility"), tool).toBe(false);
		}
	});

	it("takes a lookup column name holding hyphens and refuses one holding a period, on every tool that names one", () => {
		for (const tool of ["create_lookup_table", "edit_lookup_columns"]) {
			for (const schema of patternedAt(tool, "wireName"))
				expect(NO_HYPHEN_PATTERNS.has(schema.pattern as string), tool).toBe(
					false,
				);
			expect(takes(tool, "wireName", "geo-lat"), tool).toBe(true);
			expect(takes(tool, "wireName", "geo.lat"), tool).toBe(false);
			expect(takes(tool, "wireName", "geo lat"), tool).toBe(false);
		}
	});
});
