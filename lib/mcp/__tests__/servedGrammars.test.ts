/** The name grammars a client receives from tools/list are the ones Nova
 * holds: a case type in HQ's editor grammar, a written property and a Search
 * field's name holding hyphens, a choice value holding a quote mark, a lookup
 * tag or column name holding hyphens or periods, and an inline choice list of one
 * option. A served schema that kept an older, narrower pattern or minimum
 * would refuse at the client a name every other surface admits, so the model
 * could never write it. Each served position is read as a client reads it and
 * handed to an independent JSON Schema validator. */
import type { Client } from "@modelcontextprotocol/client";
import Ajv2020 from "ajv/dist/2020";
import { beforeAll, describe, expect, it } from "vitest";
import { lookupTagSchema, lookupWireNameSchema } from "@/lib/lookup/schema";
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

	it("serves the separate Search question and address publisher name grammars", () => {
		for (const [tool, container, array] of [
			["add_search_inputs", "searchInputs", true],
			["update_search_input", "searchInput", false],
			["configure_case_list", "searchInputs", true],
		] as const) {
			const root = served(tool);
			const members = root.properties as Json;
			const body = resolved(root, members[container] as Json);
			const input = array ? resolved(root, body.items as Json) : body;
			const arms = (input.anyOf ?? input.oneOf) as Json[];
			expect(arms.length, tool).toBeGreaterThan(1);
			let addresses = 0;
			for (const arm of arms) {
				const properties = resolved(root, arm).properties as Json;
				const kind = resolved(root, properties.kind as Json);
				const name = resolved(root, properties.name as Json);
				const publishesAddress = kind.const === "address";
				if (publishesAddress) addresses++;
				expect(typeof name.pattern, tool).toBe("string");
				const accepts = validator(name);
				expect(accepts("first_name"), tool).toBe(true);
				expect(accepts("first-name"), tool).toBe(!publishesAddress);
				expect(accepts("first name"), tool).toBe(false);
			}
			expect(addresses, tool).toBe(1);
		}
	});

	// A table's export tag and a column's export name are XML names, checked
	// by Nova's own parse (a refinement, so no served pattern carries them).
	// What a client receives must not refuse a hyphen, a period or a
	// non-ASCII letter Nova admits; Nova's parse still refuses a space.
	it.each([
		["tag", lookupTagSchema, ["create_lookup_table", "update_lookup_table"]],
		[
			"wireName",
			lookupWireNameSchema,
			["create_lookup_table", "edit_lookup_columns"],
		],
	] as const)(
		"takes a lookup %s holding a hyphen, a period or a non-ASCII letter on every tool that names one",
		(property, parse, tools) => {
			const admitted = ["health-facility-v2", "geo.lat", "région"];
			for (const name of admitted)
				expect(parse.safeParse(name).success).toBe(true);
			expect(parse.safeParse("health facility").success).toBe(false);
			for (const tool of tools) {
				const named = positions(served(tool)).filter(
					(position) =>
						position.property === property &&
						(position.schema.type === "string" ||
							typeof position.schema.pattern === "string"),
				);
				expect(named.length, tool).toBeGreaterThan(0);
				for (const { schema } of named) {
					expect(NO_HYPHEN_PATTERNS.has(schema.pattern as string), tool).toBe(
						false,
					);
					const check = validator(schema);
					for (const name of admitted)
						expect(Boolean(check(name)), `${tool} ${name}`).toBe(true);
				}
			}
		},
	);
});
