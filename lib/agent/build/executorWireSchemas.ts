/** Shared authoring grammar, with accepted construction facts owned by Nova. */
import type { JSONSchema7 } from "@ai-sdk/provider";
import { z } from "zod";
import { readableToolSchema } from "@/lib/agent/authoring/readableSchema";
import { pruneDefinitions } from "@/lib/agent/authoring/schema";
import { authoringToolSchema } from "@/lib/agent/authoring/toolSchema";
import { SHARED_TOOL_REGISTRY } from "@/lib/agent/sharedToolRegistry";
import { wireToolSchema } from "@/lib/agent/wireSchemas";

type Json = Record<string, unknown>;
function dereference(root: Json, node: Json): Json {
	const seen = new Set<string>();
	while (typeof node.$ref === "string") {
		if (!node.$ref.startsWith("#/") || seen.has(node.$ref))
			throw new Error("Expected a finite local construction schema reference.");
		seen.add(node.$ref);
		let resolved: unknown = root;
		for (const token of node.$ref.slice(2).split("/"))
			resolved = (resolved as Json)[
				token.replaceAll("~1", "/").replaceAll("~0", "~")
			];
		node = resolved as Json;
	}
	return node;
}
function remove(root: Json, input: Json, keys: readonly string[]) {
	const node = dereference(root, input);
	const properties = node.properties as Json | undefined;
	if (properties) for (const key of keys) delete properties[key];
	if (Array.isArray(node.required))
		node.required = node.required.filter((key) => !keys.includes(key));
	for (const key of ["anyOf", "oneOf", "allOf"])
		if (Array.isArray(node[key]))
			for (const arm of node[key]) remove(root, arm, keys);
}
const cache = new WeakMap<
	z.ZodType,
	Map<string, { json: JSONSchema7; authored: z.ZodType }>
>();

export function executorAuthoringSchema(toolName: string, schema: z.ZodType) {
	let byName = cache.get(schema);
	if (!byName) {
		byName = new Map();
		cache.set(schema, byName);
	}
	const prior = byName.get(toolName);
	if (prior) return prior;
	let json = structuredClone(authoringToolSchema(toolName, schema).json);
	if (toolName === "createForm") remove(json, json, ["type"]);
	if (toolName === "createModule") {
		remove(json, json, [
			"parentModuleUuid",
			"case_type",
			"case_list_only",
			"selection",
		]);
		const forms = (json.properties as Json).forms as Json;
		// The nullable forms array can be a direct array or a union arm.
		const visit = (input: Json): void => {
			const node = dereference(json, input);
			if (node.items) remove(json, node.items as Json, ["type"]);
			for (const key of ["anyOf", "oneOf", "allOf"])
				if (Array.isArray(node[key])) for (const arm of node[key]) visit(arm);
		};
		visit(forms);
	}
	pruneDefinitions(json);
	json = readableToolSchema(json);
	const result = {
		json: json as JSONSchema7,
		authored: z.fromJSONSchema(json, { registry: z.registry() }),
	};
	byName.set(toolName, result);
	return result;
}

export function executorWireToolSchema(
	toolName: string,
	schema: z.ZodType,
): JSONSchema7 {
	return SHARED_TOOL_REGISTRY.some((entry) => entry.saName === toolName)
		? executorAuthoringSchema(toolName, schema).json
		: (wireToolSchema(schema).jsonSchema as JSONSchema7);
}
