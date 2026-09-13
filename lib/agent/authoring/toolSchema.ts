import { jsonSchema } from "ai";
import { z } from "zod";
import { CREATION_IDENTITY_SPECS } from "@/lib/agent/change-set/creationIdentities";
import { authoringJsonSchema } from "./schema";

type Json = Record<string, unknown>;
const record = (value: unknown): Json | undefined =>
	value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Json)
		: undefined;

function variants(root: Json, input: unknown): Json[] {
	const node = record(input);
	if (!node) return [];
	if (typeof node.$ref === "string") {
		if (!node.$ref.startsWith("#/"))
			throw new Error("Expected a local tool schema reference.");
		let resolved: unknown = root;
		for (const token of node.$ref.slice(2).split("/"))
			resolved =
				record(resolved)?.[token.replaceAll("~1", "/").replaceAll("~0", "~")];
		if (!resolved) throw new Error(`Missing schema ${node.$ref}.`);
		return variants(root, resolved);
	}
	return [
		node,
		...["oneOf", "anyOf", "allOf"].flatMap((key) =>
			Array.isArray(node[key])
				? node[key].flatMap((item) => variants(root, item))
				: [],
		),
	];
}

function changePath(
	root: Json,
	input: unknown,
	path: readonly string[],
	change: (parent: Json, properties: Json, key: string) => void,
) {
	const [key, ...rest] = path;
	for (const node of variants(root, input)) {
		if (key === "*") {
			changePath(root, node.items, rest, change);
			continue;
		}
		const properties = record(node.properties);
		if (!properties || !(key in properties)) continue;
		if (rest.length) changePath(root, properties[key], rest, change);
		else change(node, properties, key);
	}
}

function optional(node: Json, key: string) {
	if (Array.isArray(node.required))
		node.required = node.required.filter((value) => value !== key);
}

const cache = new WeakMap<z.ZodType, Map<string, ReturnType<typeof project>>>();
function project(toolName: string, canonical: z.ZodType) {
	const json = structuredClone(authoringJsonSchema(canonical));
	for (const spec of CREATION_IDENTITY_SPECS[toolName] ?? [])
		changePath(json, json, spec.path, (parent, properties, key) => {
			optional(parent, key);
			const property = record(properties[key]);
			if (property)
				property.description = spec.referenceIfBound
					? "Existing item identity, if this item is being retained."
					: "Nova assigns an identity when omitted. Supply one only for references within this request.";
		});
	const properties = record(json.properties);
	if (properties) {
		const createdRoots = new Set(
			(CREATION_IDENTITY_SPECS[toolName] ?? [])
				.filter((spec) => spec.path.length === 1)
				.map((spec) => spec.path[0]),
		);
		for (const [key, label] of [
			["moduleUuid", "Module"],
			["formUuid", "Form"],
			["fieldUuid", "Field"],
			["parentModuleUuid", "Parent module"],
			["parentUuid", "Parent field"],
			["beforeFieldUuid", "Before field"],
			["afterFieldUuid", "After field"],
		]) {
			if (!(key in properties) || createdRoots.has(key)) continue;
			const prior = record(properties[key]);
			const nullable = variants(json, prior).some(
				(node) =>
					node.type === "null" ||
					(Array.isArray(node.type) && node.type.includes("null")),
			);
			properties[key] = {
				type: nullable ? ["string", "null"] : "string",
				description: `${label} name or stable ID. Use a full path for nested fields.`,
			};
		}
		if ("fieldUuid" in properties && !createdRoots.has("fieldUuid")) {
			optional(json, "formUuid");
			optional(json, "moduleUuid");
		} else if ("formUuid" in properties && !createdRoots.has("formUuid"))
			optional(json, "moduleUuid");
	}
	for (const spec of CREATION_IDENTITY_SPECS[toolName] ?? [])
		if (spec.entityKind === "field") {
			changePath(
				json,
				json,
				[...spec.path.slice(0, -1), "parentUuid"],
				(_parent, properties, key) => {
					properties[key] = {
						type: ["string", "null"],
						description:
							"Parent group, repeat, or section path. May name a container in this request.",
					};
				},
			);
		}
	if (toolName === "editField")
		changePath(json, json, ["updates", "kind"], (parent, _properties, key) =>
			optional(parent, key),
		);
	if (toolName === "configureConnect")
		changePath(
			json,
			json,
			["participants", "*", "formUuid"],
			(_parent, properties, key) => {
				properties[key] = {
					type: "string",
					description: "Form name or stable ID.",
				};
			},
		);
	const authored = z.fromJSONSchema(json, { registry: z.registry() });
	return {
		json,
		authored,
		inputSchema: jsonSchema(json, {
			validate(value) {
				const parsed = authored.safeParse(value);
				return parsed.success
					? { success: true, value: parsed.data }
					: { success: false, error: parsed.error };
			},
		}),
	};
}

/** Model and MCP share this grammar. It checks authored shapes only; the full
 * canonical schema runs after scoped binding inside the authorized invocation. */
export function authoringToolSchema(toolName: string, canonical: z.ZodType) {
	let byName = cache.get(canonical);
	if (!byName) {
		byName = new Map();
		cache.set(canonical, byName);
	}
	const prior = byName.get(toolName);
	if (prior) return prior;
	const result = project(toolName, canonical);
	byName.set(toolName, result);
	return result;
}
