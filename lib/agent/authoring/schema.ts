import { z } from "zod";
import { automationMessageTemplateSchema } from "@/lib/domain/automations";
import {
	FORM_ICON_SLUGS,
	formIconRefSchema,
	MODULE_ICON_SLUGS,
	moduleIconRefSchema,
} from "@/lib/domain/builtinIcons";
import * as expressions from "@/lib/domain/expression/types";
import { localizedValueSchema } from "@/lib/domain/localization";
import { mediaAssetIdSchema } from "@/lib/domain/multimedia";
import { proseTemplateSchema } from "@/lib/domain/prose";
import { AuthoringInputError } from "./errors";

export type AuthoringValueFamily =
	| "text"
	| "message"
	| "localized"
	| "xpath"
	| "condition"
	| "value"
	| "reference"
	| "relationship"
	| "moduleIcon"
	| "formIcon"
	| "datum";
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
	[expressions.formLogicSchema._zod.def, "xpath"],
	[expressions.conditionSchema._zod.def, "condition"],
	[expressions.valueSchema._zod.def, "value"],
	[expressions.tableLookupExpressionSchema._zod.def, "value"],
	[expressions.idOfSchema._zod.def, "value"],
	[expressions.actingUserSchema._zod.def, "value"],
	[expressions.unownedSchema._zod.def, "value"],
	[expressions.relationPathSchema._zod.def, "relationship"],
	[expressions.formLinkDatumNameSchema._zod.def, "datum"],
	[(moduleIconRefSchema as z.core.$ZodType)._zod.def, "moduleIcon"],
	[(formIconRefSchema as z.core.$ZodType)._zod.def, "formIcon"],
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
	datum: z
		.string()
		.min(1)
		.describe(
			"The session value the target reads, usually its case id datum such as case_id.",
		),
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
	moduleIcon: z
		.union([z.enum(MODULE_ICON_SLUGS), mediaAssetIdSchema])
		.describe("A built-in topic icon name, or an uploaded image's asset id."),
	formIcon: z
		.union([z.enum(FORM_ICON_SLUGS), mediaAssetIdSchema])
		.describe("A built-in action icon name, or an uploaded image's asset id."),
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

/** Remove definitions made unreachable by an authoring projection. */
export function pruneDefinitions(json: Json) {
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

/** Replace content before Zod visits it. An override runs after that visit,
 * when canonical children have already consumed reusable-definition numbers.
 *
 * Preserve the source graph's sharing and refinement parents, but point every
 * edge into the projected graph. Metadata belongs to a private registry: the
 * canonical domain's registered ids must keep naming its original schemas.
 */
function projectAuthoringGraph(root: z.core.$ZodType) {
	const metadata = z.registry<z.core.JSONSchemaMeta>();
	const schemas = new Map<z.core.$ZodType, z.core.$ZodType>();
	const map = (source: z.core.$ZodType): z.core.$ZodType => {
		const prior = schemas.get(source);
		if (prior) return prior;
		const family = familyOf(source);
		const definition = family
			? undefined
			: mapDefinition((source as z.core.$ZodTypes)._zod.def);
		// Supplying a definition prevents clone from attaching the canonical
		// template as its parent. Zod's JSON emitter walks that edge too.
		const result = family
			? copyFamily(valueSchemas[family])
			: z.core.clone(source, definition);
		schemas.set(source, result);
		if (!family && source._zod.parent)
			result._zod.parent = map(source._zod.parent);
		const originalMetadata = z.globalRegistry.get(source);
		const projectedMetadata = family
			? {
					...z.globalRegistry.get(valueSchemas[family]),
					...(originalMetadata?.id !== undefined && {
						id: originalMetadata.id,
					}),
				}
			: originalMetadata;
		// Registry.get intentionally omits an inherited id. Copying a parent's
		// id onto described/refined children would create duplicate definitions.
		if (projectedMetadata) metadata.add(result, projectedMetadata);
		return result;
	};
	const mapDefinition = (
		definition: z.core.$ZodTypes["_zod"]["def"],
		child: (schema: z.core.$ZodType) => z.core.$ZodType = map,
	): z.core.$ZodTypeDef & Record<string, unknown> => {
		switch (definition.type) {
			case "object": {
				let shape: z.core.$ZodShape | undefined;
				// Keep shape resolution lazy so recursive getter-based objects can
				// refer back to the clone after it has entered the graph map.
				return {
					...definition,
					get shape() {
						shape ??= Object.fromEntries(
							Reflect.ownKeys(definition.shape).map((key) => [
								key,
								child(Reflect.get(definition.shape, key) as z.core.$ZodType),
							]),
						);
						return shape;
					},
					...(definition.catchall && { catchall: child(definition.catchall) }),
				};
			}
			case "lazy": {
				// Zod 4 caches the resolved getter on the shared definition. A
				// previously parsed lazy must not reconnect its canonical child.
				const copied = {
					...definition,
					getter: () => child(definition.getter()),
				};
				Reflect.deleteProperty(copied, "_cachedInner");
				return copied;
			}
			case "array":
				return { ...definition, element: child(definition.element) };
			case "union":
				return { ...definition, options: definition.options.map(child) };
			case "intersection":
				return {
					...definition,
					left: child(definition.left),
					right: child(definition.right),
				};
			case "tuple":
				return {
					...definition,
					items: definition.items.map(child),
					...(definition.rest && { rest: child(definition.rest) }),
				};
			case "record":
			case "map":
				return {
					...definition,
					keyType: child(definition.keyType),
					valueType: child(definition.valueType),
				};
			case "set":
				return { ...definition, valueType: child(definition.valueType) };
			case "pipe":
				return {
					...definition,
					in: child(definition.in),
					out: child(definition.out),
				};
			case "optional":
			case "nullable":
			case "default":
			case "prefault":
			case "nonoptional":
			case "readonly":
			case "catch":
			case "promise":
			case "success":
				return { ...definition, innerType: child(definition.innerType) };
			case "template_literal":
				return {
					...definition,
					parts: definition.parts.map((part) =>
						part instanceof z.core.$ZodType ? child(part) : part,
					),
				};
			case "function":
				return {
					...definition,
					...(definition.input && { input: child(definition.input) }),
					...(definition.output && { output: child(definition.output) }),
				};
			default:
				return { ...definition };
		}
	};
	// A replaced family has no canonical parent or shared canonical children.
	// Each authored body is independent, as the old override emitted it; reuse
	// remains at the source family node, not at its primitive union members.
	const copyFamily = (template: z.core.$ZodType): z.core.$ZodType => {
		const result = z.core.clone(
			template,
			mapDefinition((template as z.core.$ZodTypes)._zod.def, copyFamily),
		);
		const meta = z.globalRegistry.get(template);
		if (meta) metadata.add(result, meta);
		return result;
	};
	return { schema: map(root), metadata };
}

/** Shared input grammar for model tools and MCP. Canonical refinements run only
 * after names have been bound; this schema validates the authored representation. */
export function authoringJsonSchema(schema: z.core.$ZodType): Json {
	const prior = jsonSchemas.get(schema);
	if (prior) return prior;
	const graph = projectAuthoringGraph(schema);
	const json = z.toJSONSchema(graph.schema, {
		io: "input",
		target: "draft-7",
		reused: "ref",
		metadata: graph.metadata,
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
	return transformValues(schema, input, decoders, path, "authored");
}

/** Read projection walks the same content families, selecting union variants
 * against the canonical values that were already admitted to the document. */
export function encodeAuthoringValues(
	schema: z.core.$ZodType,
	input: unknown,
	encoders: AuthoringValueDecoders,
	path: AuthoringPath = [],
): unknown {
	return transformValues(schema, input, encoders, path, "canonical");
}

function transformValues(
	schema: z.core.$ZodType,
	input: unknown,
	decoders: AuthoringValueDecoders,
	path: AuthoringPath,
	representation: "authored" | "canonical",
): unknown {
	const family = familyOf(schema);
	if (family) return decoders[family](input, path);
	if (input === null || input === undefined) return input;
	const descend = (
		child: z.core.$ZodType,
		value: unknown,
		childPath: AuthoringPath = path,
	) => transformValues(child, value, decoders, childPath, representation);
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
			if (representation === "canonical")
				return descend(canonicalVariant(definition, input, path), input);
			const matching = definition.options.filter((variant) =>
				authoringSchema(variant).validate(input),
			);
			if (matching.length !== 1)
				throw new AuthoringInputError(
					`Choose one valid value at ${path.join(".") || "input"}.`,
				);
			return descend(matching[0], input);
		}
		default:
			return input;
	}
}

/** A stored value already belongs to exactly one variant. A tagged union names
 * it by its discriminator, so reading never re-runs every variant's
 * refinements; an untagged union is matched by validation. Anything else means
 * the value handed to the read projection is not canonical, which is a defect
 * in Nova rather than something the caller can correct. */
function canonicalVariant(
	definition: z.core.$ZodUnionDef,
	input: unknown,
	path: AuthoringPath,
): z.core.$ZodType {
	const discriminator =
		"discriminator" in definition ? definition.discriminator : undefined;
	if (
		typeof discriminator === "string" &&
		typeof input === "object" &&
		input !== null &&
		!Array.isArray(input)
	) {
		const tag = (input as Record<string, unknown>)[discriminator];
		const tagged = definition.options.filter((variant) =>
			variant._zod.propValues?.[discriminator]?.has(
				tag as z.core.util.Primitive,
			),
		);
		if (tagged.length === 1) return tagged[0];
	}
	const matching = definition.options.filter((variant) =>
		z.validate(variant, input),
	);
	if (matching.length !== 1)
		throw new Error(
			`The stored value at ${path.join(".") || "the root"} matches ${matching.length} of ${definition.options.length} canonical variants, so it cannot be read as authored content.`,
		);
	return matching[0];
}
