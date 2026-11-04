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
			/* A schema publishes a regex in two places: the `pattern` keyword,
			 * and each key of `patternProperties`. */
			const published: [string, string][] = [];
			if (typeof schema.pattern === "string")
				published.push([`${pointer}/pattern`, schema.pattern]);
			if (object(schema.patternProperties))
				for (const key of Object.keys(schema.patternProperties))
					published.push([`${pointer}/patternProperties`, key]);
			for (const [where, pattern] of published)
				try {
					new RRegex(pattern).free();
				} catch (error) {
					refused.push(
						`${tool.name} at ${where}: JavaScript reads ${pattern}, but the Rust regex engine cannot (${reason(error)}). Model providers check published patterns with engines like it and turn away a client that sends this one. Where the pattern is written, escape what is special inside a character class, such as [ and ], and leave out lookarounds and backreferences.`,
					);
				}
		});
	expect(refused).toEqual([]);
});

it("publishes an exact choice between saved and private read targets", () => {
	const tool = listed.find((entry) => entry.name === "get_form");
	if (!tool) throw new Error("get_form is missing");
	const validate = new Ajv({
		strict: false,
		validateFormats: false,
	}).compile(tool.inputSchema);
	const address = { moduleUuid: "Intake", formUuid: "Patient intake" };
	expect(validate({ ...address, app_id: "saved-app" })).toBe(true);
	expect(
		validate({ ...address, work_id: "00000000-0000-4000-8000-000000000001" }),
	).toBe(true);
	expect(
		validate({
			...address,
			app_id: "saved-app",
			work_id: "00000000-0000-4000-8000-000000000001",
		}),
	).toBe(false);
	expect(validate(address)).toBe(false);
});

it("rejects malformed work IDs in lifecycle and shared schemas", () => {
	for (const tool of listed) {
		const properties = (tool.inputSchema as Json).properties;
		if (!object(properties) || !properties.work_id) continue;
		const validate = new Ajv2020({
			strict: false,
			validateFormats: false,
		}).compile(properties.work_id as Json);
		expect(validate("placeholder"), tool.name).toBe(false);
		expect(validate("00000000-0000-4000-8000-000000000001"), tool.name).toBe(
			true,
		);
	}
});

/** A served tool by name, or a failure naming it. */
function served(name: string) {
	const tool = listed.find((entry) => entry.name === name);
	if (!tool) throw new Error(`${name} is missing from tools/list`);
	return tool;
}

it("serves accept_placement_moves as exactly a reason and a 64-hex digest", () => {
	const properties = (served("upload_app_to_hq").inputSchema as Json)
		.properties;
	if (!object(properties) || !object(properties.accept_placement_moves))
		throw new Error("upload_app_to_hq serves no accept_placement_moves");
	const accept = properties.accept_placement_moves;
	expect(accept.description).toBe(
		"Send only after a refusal returned placement_moves, with its reason and digest, once the user agreed to move those case changes.",
	);
	const validate = new Ajv2020({
		strict: false,
		validateFormats: false,
	}).compile(accept);
	const digest = "ab".repeat(32);
	expect(validate({ reason: "save-to-case", digest })).toBe(true);
	expect(validate({ reason: "same-type-child-links", digest })).toBe(true);
	expect(validate({ reason: "save-to-case", digest: "AB".repeat(32) })).toBe(
		false,
	);
	expect(validate({ reason: "save-to-case", digest: "ab" })).toBe(false);
	expect(validate({ reason: "somewhere-else", digest })).toBe(false);
	expect(validate({ reason: "save-to-case" })).toBe(false);
	expect(
		validate({ reason: "save-to-case", digest, moves: ["In Visit"] }),
	).toBe(false);
});

it("tells a client what an upload records and what a move offer asks of the user", () => {
	expect(served("upload_app_to_hq").description).toContain(
		"The first upload of a case change records where CommCare HQ keeps it, which changes the saved app (`placements.recorded`); work begun with `begin_work` before then has to begin again. If a refusal carries `placement_moves`, show the user each move's `sentence`, and send `accept_placement_moves` with its `reason` and `digest` only when the user agrees: the move changes where CommCare HQ keeps those answers in every project space the app is published to. `hq_placement_moves_changed` means the offer changed since; show the new one. `app_changed_while_publishing` means the app kept changing while Nova prepared the upload; upload again.",
	);
	expect(served("check_project_space_compatibility").description).toContain(
		"`placement_moves`, where present, lists the case changes Nova can move so the app doesn't need Save to Case.",
	);
});

it("serves the CommCare Supply confirmation on upload and withdrawal, and names it in the compatibility check", () => {
	const upload = (served("upload_app_to_hq").inputSchema as Json).properties;
	if (!object(upload) || !object(upload.confirm_commtrack_off))
		throw new Error("upload_app_to_hq serves no confirm_commtrack_off");
	expect(upload.confirm_commtrack_off.type).toBe("boolean");
	expect(upload.confirm_commtrack_off.description).toBe(
		"Send only after an `hq_confirmation_needed` refusal named them and the user said yes to each.",
	);
	expect(served("upload_app_to_hq").description).toContain(
		"(a plan feature, the flat location list, a Connect forwarder, Sync Cases On Form Entry turned off, CommCare Supply turned off)",
	);
	expect(served("upload_app_to_hq").description).toContain(
		"`confirm_form_entry_sync_off` and `confirm_commtrack_off`",
	);

	const withdraw = (
		served("withdraw_deployment_confirmation").inputSchema as Json
	).properties;
	if (!object(withdraw) || !object(withdraw.kind))
		throw new Error("withdraw_deployment_confirmation serves no kind");
	const validateKind = new Ajv2020({
		strict: false,
		validateFormats: false,
	}).compile(withdraw.kind);
	expect(validateKind("commtrack-off")).toBe(true);
	expect(validateKind("commcare-supply")).toBe(false);
	expect(withdraw.kind.description).toContain("`commtrack-off`");

	expect(served("check_project_space_compatibility").description).toContain(
		"`commtrack_off` says whether the project space's CommCare Supply setting needs confirming, and `placement_moves`, where present, lists the case changes Nova can move so the app doesn't need Save to Case.",
	);
});
