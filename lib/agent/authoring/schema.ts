import { z } from "zod";
import { automationMessageTemplateSchema } from "@/lib/domain/automations";
import { localizedValueSchema } from "@/lib/domain/localization";
import * as expressions from "@/lib/domain/predicate/types";
import { proseTemplateSchema } from "@/lib/domain/prose";
import { xpathExpressionSchema } from "@/lib/domain/xpath/ast";

export type AuthoringValueFamily =
	| "text"
	| "message"
	| "localized"
	| "xpath"
	| "condition"
	| "value"
	| "reference"
	| "relationship";
export type AuthoringPath = readonly (string | number)[];
export type AuthoringValueDecoders = Record<
	AuthoringValueFamily,
	(value: unknown, path: AuthoringPath) => unknown
>;

/** Described Zod copies retain the same definition object. Identity here prevents
 * an unrelated object with a `label` or `parts` property from being rewritten. */
const families = new Map<object, AuthoringValueFamily>([
	[proseTemplateSchema._zod.def, "text"],
	[automationMessageTemplateSchema._zod.def, "message"],
	[localizedValueSchema._zod.def, "localized"],
	[xpathExpressionSchema._zod.def, "xpath"],
	[expressions.predicateSchema._zod.def, "condition"],
	[expressions.valueExpressionSchema._zod.def, "value"],
	[expressions.tableLookupExpressionSchema._zod.def, "value"],
	[expressions.idOfSchema._zod.def, "value"],
	[expressions.actingUserSchema._zod.def, "value"],
	[expressions.unownedSchema._zod.def, "value"],
	[expressions.relationPathSchema._zod.def, "relationship"],
	...[
		expressions.termSchema,
		expressions.propertyRefSchema,
		expressions.searchInputRefSchema,
		expressions.sessionUserSchema,
		expressions.sessionUserPropertySchema,
		expressions.sessionContextSchema,
		expressions.formFieldRefSchema,
		expressions.tableColumnTermSchema,
		expressions.fixedLocationTermSchema,
		expressions.ownerLocationAtLevelTermSchema,
		expressions.literalSchema,
	].map((schema) => [schema._zod.def, "reference"] as const),
]);

function familyOf(schema: z.core.$ZodType): AuthoringValueFamily | undefined {
	// Zod retains the parent of metadata/refinement clones. Extensions create
	// a new schema without this lineage; unrelated object shapes never match.
	for (
		let current: z.core.$ZodType | undefined = schema;
		current;
		current = current._zod.parent
	) {
		const family = families.get(current._zod.def);
		if (family) return family;
	}
	return undefined;
}

const valueSchemas = {
	localized: z
		.string()
		.describe("Translated text. Keep the source's inserted references."),
	message: z
		.string()
		.describe(
			"Message text. {{#case/case_name}} or {{#recipient/first_name}} inserts a value.",
		),
	text: z
		.string()
		.describe(
			"Markdown. {{field_id}} inserts an answer; \\{{ keeps literal braces.",
		),
	xpath: z
		.union([z.string(), z.boolean()])
		.describe(
			"Expression. #form/age reads an answer; #case/age reads the current record.",
		),
	condition: z
		.union([z.string(), z.boolean()])
		.describe("Condition, such as #case/age >= 18."),
	value: z
		.union([z.string(), z.number(), z.boolean()])
		.describe(
			"Value expression, such as #case/age + 1. Quote literal text inside the expression.",
		),
	reference: z
		.union([z.string(), z.number(), z.boolean()])
		.describe("A named reference or literal expression."),
	relationship: z
		.string()
		.describe(
			"Record relationship: children('Visit'), ancestor('parent'), or self().",
		),
} satisfies Record<AuthoringValueFamily, z.ZodType>;
type Json = Record<string, unknown>;

function references(value: unknown, result = new Set<string>()): Set<string> {
	if (Array.isArray(value)) for (const item of value) references(item, result);
	else if (value !== null && typeof value === "object")
		for (const [key, item] of Object.entries(value)) {
			if (key === "$ref" && typeof item === "string") result.add(item);
			else if (key !== "definitions" && key !== "$defs")
				references(item, result);
		}
	return result;
}

/** Remove definitions made unreachable when a storage family becomes text. */
function pruneDefinitions(json: Json) {
	for (const key of ["definitions", "$defs"]) {
		const definitions = json[key] as Record<string, unknown> | undefined;
		if (!definitions) continue;
		const live = references(json);
		for (const reference of live) {
			const prefix = `#/${key}/`;
			if (!reference.startsWith(prefix))
				throw new Error(`Unexpected authoring schema reference: ${reference}`);
			const name = reference
				.slice(prefix.length)
				.replaceAll("~1", "/")
				.replaceAll("~0", "~");
			if (!(name in definitions))
				throw new Error(`Missing authoring schema definition: ${name}`);
			references(definitions[name], live);
		}
		for (const name of Object.keys(definitions)) {
			const escaped = name.replaceAll("~", "~0").replaceAll("/", "~1");
			if (!live.has(`#/${key}/${escaped}`)) delete definitions[name];
		}
		if (Object.keys(definitions).length === 0) delete json[key];
	}
}

const projected = new WeakMap<z.core.$ZodType, z.ZodType>();
const jsonSchemas = new WeakMap<z.core.$ZodType, Json>();

/** Shared input grammar for model tools and MCP. Canonical refinements run only
 * after names have been bound; this schema validates the authored representation. */
export function authoringJsonSchema(schema: z.core.$ZodType): Json {
	const prior = jsonSchemas.get(schema);
	if (prior) return prior;
	const json = z.toJSONSchema(schema, {
		io: "input",
		target: "draft-7",
		override({ zodSchema, jsonSchema }) {
			const family = familyOf(zodSchema);
			if (!family) return;
			for (const key of Object.keys(jsonSchema))
				delete (jsonSchema as Json)[key];
			Object.assign(
				jsonSchema,
				z.toJSONSchema(valueSchemas[family], { target: "draft-7" }),
			);
			delete jsonSchema.$schema;
		},
	}) as Json;
	pruneDefinitions(json);
	jsonSchemas.set(schema, json);
	return json;
}

export function authoringSchema(schema: z.core.$ZodType): z.ZodType {
	const prior = projected.get(schema);
	if (prior) return prior;
	// A private registry avoids overwriting the canonical domain's named schemas.
	const result = z.fromJSONSchema(authoringJsonSchema(schema), {
		registry: z.registry(),
	});
	projected.set(schema, result);
	return result;
}

/** Walk the declared schema, not property-name guesses. The caller supplies an
 * operation scope containing all names and identities before this walk begins. */
export function decodeAuthoringValues(
	schema: z.core.$ZodType,
	input: unknown,
	decoders: AuthoringValueDecoders,
	path: AuthoringPath = [],
): unknown {
	const family = familyOf(schema);
	if (family) return decoders[family](input, path);
	if (input === null || input === undefined) return input;
	const descend = (
		child: z.core.$ZodType,
		value: unknown,
		childPath: AuthoringPath = path,
	) => decodeAuthoringValues(child, value, decoders, childPath);
	const definition = (schema as z.core.$ZodTypes)._zod.def;
	switch (definition.type) {
		case "optional":
		case "nullable":
		case "default":
		case "prefault":
		case "nonoptional":
		case "readonly":
		case "catch":
			return descend(definition.innerType, input);
		case "lazy":
			return descend(definition.getter(), input);
		case "pipe":
			return descend(definition.in, input);
		case "object": {
			if (typeof input !== "object" || Array.isArray(input)) return input;
			const shape = definition.shape;
			return Object.fromEntries(
				Object.entries(input).map(([key, value]) => [
					key,
					shape[key] ? descend(shape[key], value, [...path, key]) : value,
				]),
			);
		}
		case "array":
			return Array.isArray(input)
				? input.map((value, index) =>
						descend(definition.element, value, [...path, index]),
					)
				: input;
		case "tuple": {
			if (!Array.isArray(input)) return input;
			return input.map((value, index) => {
				const item = definition.items[index] ?? definition.rest;
				return item ? descend(item, value, [...path, index]) : value;
			});
		}
		case "record":
			return typeof input === "object" && !Array.isArray(input)
				? Object.fromEntries(
						Object.entries(input).map(([key, value]) => [
							key,
							descend(definition.valueType, value, [...path, key]),
						]),
					)
				: input;
		case "union": {
			const variants = definition.options;
			const matching = variants.filter(
				(variant) => authoringSchema(variant).safeParse(input).success,
			);
			if (matching.length !== 1)
				throw new Error(
					`Choose one valid value at ${path.join(".") || "input"}.`,
				);
			return descend(matching[0], input);
		}
		default:
			return input;
	}
}
