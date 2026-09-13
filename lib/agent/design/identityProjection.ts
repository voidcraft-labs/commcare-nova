import { z } from "zod";
import { DESIGN_IDENTITY_SCHEMA_MARKER } from "./ids";

function object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

const schemas = new WeakMap<z.ZodType, Record<string, unknown>>();

function schemaJson(schema: z.ZodType): Record<string, unknown> {
	const cached = schemas.get(schema);
	if (cached !== undefined) return cached;
	const emitted = z.toJSONSchema(schema, { io: "input" });
	schemas.set(schema, emitted);
	return emitted;
}

function resolveRef(root: Record<string, unknown>, ref: string): unknown {
	if (!ref.startsWith("#/")) return undefined;
	let node: unknown = root;
	for (const segment of ref.slice(2).split("/")) {
		if (!object(node)) return undefined;
		node = node[segment.replaceAll("~1", "/").replaceAll("~0", "~")];
	}
	return node;
}

function matchesArm(
	arm: Record<string, unknown>,
	value: unknown,
	root: Record<string, unknown>,
): boolean {
	const resolved =
		typeof arm.$ref === "string" ? resolveRef(root, arm.$ref) : arm;
	if (!object(resolved)) return false;
	if ("const" in resolved) return value === resolved.const;
	if (resolved.type === "null") return value === null;
	if (resolved.type === "string") return typeof value === "string";
	if (resolved.type === "number" || resolved.type === "integer")
		return typeof value === "number";
	if (resolved.type === "boolean") return typeof value === "boolean";
	if (resolved.type === "array") return Array.isArray(value);
	if (resolved.type !== "object" || !object(value)) return false;
	if (!object(resolved.properties)) return true;
	return Object.entries(resolved.properties).every(
		([key, child]) =>
			!object(child) || !("const" in child) || value[key] === child.const,
	);
}

/** Transform only schema-marked values. Sibling text and foreign identities
 * retain their meaning; property names alone never select a slot.
 * This reads partial workspace candidates too; validation has its own owner. */
export function mapDesignSchemaSlots(
	schema: z.ZodType,
	value: unknown,
	marker: string,
	transform: (value: unknown, path: readonly (string | number)[]) => unknown,
): unknown {
	const root = schemaJson(schema);
	const result = structuredClone(value);
	const slots = new Map<string, readonly (string | number)[]>();
	const visit = (
		node: unknown,
		entry: unknown,
		path: readonly (string | number)[],
		seenRefs: ReadonlySet<string>,
	): void => {
		if (!object(node)) return;
		if (node[marker] === true) {
			slots.set(JSON.stringify(path), path);
			return;
		}
		if (typeof node.$ref === "string") {
			if (!seenRefs.has(node.$ref))
				visit(
					resolveRef(root, node.$ref),
					entry,
					path,
					new Set([...seenRefs, node.$ref]),
				);
			return;
		}
		for (const carrier of ["oneOf", "anyOf"] as const) {
			if (!Array.isArray(node[carrier])) continue;
			const arms = node[carrier].filter(object);
			const matches = arms.filter((arm) => matchesArm(arm, entry, root));
			for (const arm of matches.length > 0 ? matches : arms)
				visit(arm, entry, path, seenRefs);
			return;
		}
		if (Array.isArray(node.allOf))
			for (const arm of node.allOf) visit(arm, entry, path, seenRefs);
		if (Array.isArray(entry) && node.items !== undefined) {
			entry.forEach((item, index) => {
				visit(node.items, item, [...path, index], seenRefs);
			});
			return;
		}
		if (!object(entry) || !object(node.properties)) return;
		for (const [key, child] of Object.entries(node.properties)) {
			if (key in entry) visit(child, entry[key], [...path, key], seenRefs);
		}
	};
	visit(root, value, [], new Set());
	for (const path of slots.values()) {
		if (path.length === 0) return transform(result, path);
		let parent = result as Record<string | number, unknown>;
		for (const key of path.slice(0, -1))
			parent = parent[key] as Record<string | number, unknown>;
		const key = path[path.length - 1];
		parent[key] = transform(parent[key], path);
	}
	return result;
}

export function mapDesignIdentitySlots(
	schema: z.ZodType,
	value: unknown,
	transform: (value: unknown, path: readonly (string | number)[]) => unknown,
): unknown {
	return mapDesignSchemaSlots(
		schema,
		value,
		DESIGN_IDENTITY_SCHEMA_MARKER,
		transform,
	);
}

/** Readable names for model-facing state; persisted values stay canonical. */
export function projectDesignIdentityHandles(
	schema: z.ZodType,
	value: unknown,
	bindings: ReadonlyArray<{
		readonly handle: string;
		readonly designId: string;
	}>,
): unknown {
	const byId = new Map(
		bindings.map((binding) => [binding.designId, binding.handle]),
	);
	return mapDesignIdentitySlots(schema, value, (entry) =>
		typeof entry === "string" ? (byId.get(entry) ?? entry) : entry,
	);
}
