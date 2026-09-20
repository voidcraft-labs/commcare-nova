/** Every tool's input schema is read here the way a client receives it from
 * tools/list, then handed to consumers that do not share Nova's engine: a
 * JSON Schema validator for the dialect each schema declares, and the Rust
 * regex engine. Clients forward these schemas to model providers, which
 * refuse a pattern JavaScript forgives, and a refused schema stops the client
 * before its first tool call. JavaScript's own strict `v` mode is no stand-in:
 * it refuses patterns those providers accept. */
import type { Client } from "@modelcontextprotocol/client";
import Ajv from "ajv";
import Ajv2020 from "ajv/dist/2020";
import { RRegex } from "rregex";
import { beforeAll, expect, it } from "vitest";
import { registerNovaTools } from "../server";
import { withMcpClient } from "./client";

type Json = Record<string, unknown>;
const object = (value: unknown): value is Json =>
	value !== null && typeof value === "object" && !Array.isArray(value);

/** Keywords whose value maps author-chosen names to schemas. The names are
 * data: a property called `pattern` is not a regex. */
const NAMED_SUBSCHEMAS = [
	"properties",
	"patternProperties",
	"definitions",
	"$defs",
	"dependentSchemas",
];
const SUBSCHEMAS = [
	"items",
	"prefixItems",
	"additionalItems",
	"additionalProperties",
	"unevaluatedItems",
	"unevaluatedProperties",
	"contains",
	"propertyNames",
	"not",
	"if",
	"then",
	"else",
	"allOf",
	"anyOf",
	"oneOf",
];

/** Visit schema positions only, so literal data under enum/const/default is
 * never mistaken for a keyword. */
function visitSchemas(
	schema: Json,
	pointer: string,
	visit: (schema: Json, pointer: string) => void,
): void {
	visit(schema, pointer);
	for (const key of NAMED_SUBSCHEMAS) {
		const entries = schema[key];
		if (!object(entries)) continue;
		for (const [name, value] of Object.entries(entries))
			if (object(value))
				visitSchemas(value, `${pointer}/${key}/${name}`, visit);
	}
	for (const key of SUBSCHEMAS) {
		const value = schema[key];
		if (object(value)) visitSchemas(value, `${pointer}/${key}`, visit);
		else if (Array.isArray(value))
			value.forEach((item, index) => {
				if (object(item))
					visitSchemas(item, `${pointer}/${key}/${index}`, visit);
			});
	}
}

const reason = (error: unknown) =>
	error instanceof Error ? error.message : String(error);

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

it("publishes input schemas that a validator for their declared dialect can compile", () => {
	const refused: string[] = [];
	for (const tool of listed) {
		const schema = tool.inputSchema as Json;
		const declared = schema.$schema;
		const Validator =
			typeof declared === "string" && declared.includes("draft-07")
				? Ajv
				: Ajv2020;
		try {
			new Validator({ strict: false, validateFormats: false }).compile(schema);
		} catch (error) {
			refused.push(
				`${tool.name}: a JSON Schema validator could not compile the input schema this tool publishes (${reason(error)}). Clients hand this schema to their model provider as it is, so look for a reference that points nowhere or a keyword holding the wrong kind of value.`,
			);
		}
	}
	expect(refused).toEqual([]);
});

it("publishes only patterns that a regex engine other than JavaScript's can read", () => {
	const refused: string[] = [];
	for (const tool of listed)
		visitSchemas(tool.inputSchema as Json, "", (schema, pointer) => {
			if (typeof schema.pattern !== "string") return;
			try {
				new RRegex(schema.pattern).free();
			} catch (error) {
				refused.push(
					`${tool.name} at ${pointer}/pattern: JavaScript reads ${schema.pattern}, but the Rust regex engine cannot (${reason(error)}). Model providers check published patterns with engines like it and turn away a client that sends this one. Where the pattern is written, escape what is special inside a character class, such as [ and ], and leave out lookarounds and backreferences.`,
				);
			}
		});
	expect(refused).toEqual([]);
});
