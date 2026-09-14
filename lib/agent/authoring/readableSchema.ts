/** Keep simple values beside their arguments and share substantial structures.
 * Zod's reuse detection runs before authoring replaces storage types, leaving
 * many single-use and scalar definitions that only add indirection. */
type Json = Record<string, unknown>;
const object = (value: unknown): value is Json =>
	value !== null && typeof value === "object" && !Array.isArray(value);
const annotations = new Set(["description", "title", "$comment"]);

/** Visit schema positions only. An enum/default/const may contain ordinary
 * objects whose keys happen to be schema keywords. */
function children(schema: Json, visit: (schema: Json) => Json): Json {
	const result = { ...schema };
	for (const key of [
		"properties",
		"patternProperties",
		"$defs",
		"definitions",
	]) {
		const entries = schema[key];
		if (object(entries))
			result[key] = Object.fromEntries(
				Object.entries(entries).map(([name, value]) => [
					name,
					object(value) ? visit(value) : value,
				]),
			);
	}
	for (const key of [
		"items",
		"additionalItems",
		"additionalProperties",
		"contains",
		"propertyNames",
		"not",
		"if",
		"then",
		"else",
		"allOf",
		"anyOf",
		"oneOf",
	]) {
		const value = schema[key];
		if (object(value)) result[key] = visit(value);
		else if (Array.isArray(value))
			result[key] = value.map((item) => (object(item) ? visit(item) : item));
	}
	return result;
}

export function readableToolSchema(input: Json): Json {
	const root = structuredClone(input);
	const definitions = new Map<string, Json>();
	for (const key of ["definitions", "$defs"])
		if (object(root[key]))
			for (const [name, value] of Object.entries(root[key]))
				if (object(value))
					definitions.set(
						`#/${key}/${name.replaceAll("~", "~0").replaceAll("/", "~1")}`,
						value,
					);
	const counts = new Map<string, number>();
	const count = (schema: Json): Json => {
		if (typeof schema.$ref === "string")
			counts.set(schema.$ref, (counts.get(schema.$ref) ?? 0) + 1);
		return children(schema, count);
	};
	count(root);

	const simplify = (schema: Json, active = new Set<string>()): Json => {
		const ref = schema.$ref;
		const definition =
			typeof ref === "string" ? definitions.get(ref) : undefined;
		if (
			definition &&
			typeof ref === "string" &&
			!active.has(ref) &&
			!definition.$id &&
			Object.keys(schema).every((key) => key === "$ref" || annotations.has(key))
		) {
			const uses = counts.get(ref) ?? 0;
			const size = JSON.stringify(definition).length;
			const sharedSize =
				JSON.stringify({ $ref: ref }).length * uses + size + ref.length;
			if (uses === 1 || size * uses < sharedSize) {
				const next = new Set(active).add(ref);
				const { $ref: _ref, ...notes } = schema;
				return { ...simplify(definition, next), ...notes };
			}
		}
		const result = children(schema, (child) => simplify(child, active));
		if (
			Array.isArray(result.allOf) &&
			result.allOf.length === 1 &&
			object(result.allOf[0]) &&
			Object.keys(result).every(
				(key) => key === "allOf" || annotations.has(key),
			)
		) {
			const { allOf, ...notes } = result;
			return { ...(allOf as Json[])[0], ...notes };
		}
		return result;
	};
	const result = simplify(root);
	const live = new Set<string>();
	const mark = (schema: Json): Json => {
		const ref = schema.$ref;
		if (typeof ref === "string" && definitions.has(ref) && !live.has(ref)) {
			live.add(ref);
			const [key, escaped] = ref.slice(2).split("/");
			const name = escaped.replaceAll("~1", "/").replaceAll("~0", "~");
			mark((result[key] as Json)[name] as Json);
		}
		const { definitions: _definitions, $defs: _defs, ...body } = schema;
		return children(body, mark);
	};
	mark(result);
	for (const key of ["definitions", "$defs"]) {
		const entries = result[key];
		if (!object(entries)) continue;
		for (const name of Object.keys(entries))
			if (
				!live.has(
					`#/${key}/${name.replaceAll("~", "~0").replaceAll("/", "~1")}`,
				)
			)
				delete entries[name];
		if (Object.keys(entries).length === 0) delete result[key];
	}
	return result;
}
