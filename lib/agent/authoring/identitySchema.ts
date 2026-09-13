import { CREATION_IDENTITY_SPECS } from "@/lib/agent/change-set/creationIdentities";
import {
	type AuthorableIdentityFamily,
	classifyIdentity,
} from "@/lib/agent/identitySchema";
import { CANONICAL_UUID_PATTERN, LOOKUP_UUID_V7_PATTERN } from "@/lib/domain";
import { AuthoringInputError } from "./errors";

type Json = Record<string, unknown>;
type Path = readonly (string | number)[];
const object = (value: unknown): Json | undefined =>
	value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Json)
		: undefined;

/** Names identify authored entities; anonymous items and external byte/row
 * resources retain their stable IDs. Creation IDs remain optional allocations. */
export const NAMED_IDENTITY_FAMILIES = {
	module: "Module name",
	form: "Form name",
	field: "Field path",
	"select-option": "Choice value",
	"case-list-column": "Column header",
	"search-input": "Search input name",
	"worker-property": "Worker property name",
	"user-type": "Role name",
	persona: "Persona name",
	"organization-level": "Organization level name",
	"location-property": "Place property name",
	location: "Place name or site code",
	"case-operation": "Case operation name",
	"entry-point": "Deep link external ID",
	automation: "Automation name",
	"lookup-table": "Data table name",
	"lookup-column": "Data column name",
} satisfies Partial<Record<AuthorableIdentityFamily, string>>;
export type NamedIdentityFamily = keyof typeof NAMED_IDENTITY_FAMILIES;

function isNamed(
	family: AuthorableIdentityFamily,
): family is NamedIdentityFamily {
	return Object.hasOwn(NAMED_IDENTITY_FAMILIES, family);
}
function wireName(tool: string) {
	return tool.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}
function reference(root: Json, ref: string): Json {
	if (ref === "#") return root;
	if (!ref.startsWith("#/"))
		throw new Error(`Nonlocal identity schema reference: ${ref}`);
	let value: unknown = root;
	for (const token of ref.slice(2).split("/"))
		value = object(value)?.[token.replaceAll("~1", "/").replaceAll("~0", "~")];
	const resolved = object(value);
	if (!resolved) throw new Error(`Missing identity schema reference: ${ref}`);
	return resolved;
}
function resolved(root: Json, node: Json): Json {
	const seen = new Set<string>();
	while (typeof node.$ref === "string") {
		if (seen.has(node.$ref))
			throw new Error(`Cyclic identity schema alias: ${node.$ref}`);
		seen.add(node.$ref);
		node = reference(root, node.$ref);
	}
	return node;
}
function familyAt(
	tool: string,
	node: Json,
	path: Path,
	discriminators: readonly string[],
) {
	if (
		node.pattern !== CANONICAL_UUID_PATTERN.source &&
		node.pattern !== LOOKUP_UUID_V7_PATTERN.source
	)
		return undefined;
	const property = path.findLast(
		(part) => typeof part === "string" && part !== "*",
	);
	const logicalPointer = `/${path.map((part) => (typeof part === "number" ? "*" : part.replaceAll("~", "~0").replaceAll("/", "~1"))).join("/")}`;
	const family = classifyIdentity({
		tool: wireName(tool),
		property: typeof property === "string" ? property : "unknown",
		logicalPointer,
		discriminators,
	});
	if (!family)
		throw new Error(
			`Unclassified authored identity: ${tool} ${logicalPointer}`,
		);
	return family;
}
function isCreation(tool: string, path: Path): boolean {
	return (CREATION_IDENTITY_SPECS[tool] ?? []).some(
		(spec) =>
			spec.path.length === path.length &&
			spec.path.every((part, index) => part === "*" || part === path[index]),
	);
}
function kinds(
	root: Json,
	node: Json,
	prior: readonly string[],
): readonly string[] {
	const kind = object(object(node.properties)?.kind);
	if (!kind) return prior;
	const definition = resolved(root, kind);
	const values =
		typeof definition.const === "string"
			? [definition.const]
			: Array.isArray(definition.enum)
				? definition.enum.filter(
						(value): value is string => typeof value === "string",
					)
				: [];
	return values.length ? [...prior, ...values] : prior;
}

/** Change the consuming property, not a shared UUID definition. If one shared
 * object is used with incompatible identity roles, refuse instead of silently
 * widening a creation ID or advertising a name that cannot be bound. */
export function projectNamedIdentitySchemas(tool: string, json: Json): void {
	const source = structuredClone(json);
	const decisions = new WeakMap<Json, string>();
	function visit(
		node: Json,
		output: Json,
		path: Path,
		discriminators: readonly string[],
		stack: ReadonlySet<string>,
	) {
		const definition = resolved(source, node);
		const family = familyAt(tool, definition, path, discriminators);
		if (family) {
			const named = isNamed(family) && !isCreation(tool, path);
			const decision = named ? family : "identity";
			const prior = decisions.get(output);
			if (prior && prior !== decision)
				throw new Error(
					`Shared identity schema has conflicting roles: ${tool} ${path.join(".")}`,
				);
			decisions.set(output, decision);
			if (named) {
				for (const key of Object.keys(output)) delete output[key];
				Object.assign(output, {
					type: "string",
					minLength: 1,
					description: `${NAMED_IDENTITY_FAMILIES[family]} or stable ID.`,
				});
			}
			return;
		}
		if (typeof node.$ref === "string") {
			if (stack.has(node.$ref)) return;
			visit(
				reference(source, node.$ref),
				reference(json, node.$ref),
				path,
				discriminators,
				new Set([...stack, node.$ref]),
			);
			return;
		}
		const nested = kinds(source, node, discriminators);
		for (const [key, child] of Object.entries(object(node.properties) ?? {})) {
			const childSchema = object(child),
				childOutput = object(object(output.properties)?.[key]);
			if (childSchema && childOutput)
				visit(childSchema, childOutput, [...path, key], nested, stack);
		}
		for (const key of ["items", "additionalProperties", "propertyNames"]) {
			const child = object(node[key]),
				target = object(output[key]);
			if (child && target)
				visit(
					child,
					target,
					key === "propertyNames" ? path : [...path, "*"],
					nested,
					stack,
				);
		}
		for (const key of ["anyOf", "oneOf", "allOf"]) {
			const children = node[key],
				targets = output[key];
			if (Array.isArray(children) && Array.isArray(targets))
				children.forEach((child, index) => {
					const childSchema = object(child),
						target = object(targets[index]);
					if (childSchema && target)
						visit(childSchema, target, path, nested, stack);
				});
		}
	}
	visit(source, json, [], [], new Set());
}

export interface NamedIdentityInput {
	family: NamedIdentityFamily;
	path: Path;
	value: string;
	replace(value: string): void;
}

/** Walk finite request data alongside the schema. Recursive location trees do
 * not need an arbitrary depth limit or a second hand-maintained path list. */
export function namedIdentityInputs(
	tool: string,
	json: Json,
	input: unknown,
): NamedIdentityInput[] {
	const slots: NamedIdentityInput[] = [];
	const seen = new Map<string, NamedIdentityFamily>();
	function visit(
		node: Json,
		value: unknown,
		path: Path,
		discriminators: readonly string[],
		replace: (value: string) => void,
		identityPath: Path = path,
	) {
		if (value === undefined || value === null) return;
		node = resolved(json, node);
		const family = familyAt(tool, node, identityPath, discriminators);
		if (family) {
			if (
				isNamed(family) &&
				!isCreation(tool, path) &&
				typeof value === "string"
			) {
				const key = JSON.stringify(path),
					prior = seen.get(key);
				if (prior && prior !== family)
					throw new Error(`Ambiguous identity role: ${tool} ${path.join(".")}`);
				if (!prior) {
					seen.set(key, family);
					slots.push({ family, path, value, replace });
				}
			}
			return;
		}
		const nested = kinds(json, node, discriminators);
		const values = object(value);
		if (values) {
			for (const [key, child] of Object.entries(
				object(node.properties) ?? {},
			)) {
				const schema = object(child);
				if (schema && Object.hasOwn(values, key))
					visit(schema, values[key], [...path, key], nested, (replacement) => {
						values[key] = replacement;
					});
			}
			const names = object(node.propertyNames);
			if (names)
				for (const key of Object.keys(values))
					visit(
						names,
						key,
						[...path, key],
						nested,
						(replacement) => {
							if (replacement === key) return;
							if (Object.hasOwn(values, replacement))
								throw new AuthoringInputError(
									`Two values reference the same property at ${path.join(".")}.`,
								);
							values[replacement] = values[key];
							delete values[key];
						},
						path,
					);
			const child = object(node.additionalProperties);
			if (child)
				for (const key of Object.keys(values))
					visit(child, values[key], [...path, key], nested, (replacement) => {
						values[key] = replacement;
					});
		}
		const items = object(node.items);
		if (items && Array.isArray(value))
			for (const [index, item] of value.entries())
				visit(items, item, [...path, index], nested, (replacement) => {
					value[index] = replacement;
				});
		for (const key of ["anyOf", "oneOf", "allOf"])
			if (Array.isArray(node[key]))
				for (const child of node[key]) {
					const schema = object(child);
					if (schema) visit(schema, value, path, nested, replace, identityPath);
				}
	}
	visit(json, input, [], [], () => {
		throw new Error("An authoring tool must have an object input.");
	});
	return slots;
}
