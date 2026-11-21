// lib/commcare/surface/schemaDefaults.ts
//
// The declared properties of HQ's app models, read from the generated
// surface (`surface.json`, the `schema:<doc_type>.<key>` items). The drift
// comparison reads it to tell a key HQ added to a model since a baseline was
// read from a change somebody made: HQ serializes every declared property,
// so a property a newer HQ declares appears, at its default, in every later
// read of every app.

import surface from "./surface.json";

/** What the manifest says about one stored key of one HQ document type. */
export interface SchemaPropertyDefault {
	/** The manifest lists the key as a property the model declares. */
	readonly known: boolean;
	/** Its declared default; `undefined` when the key is not known. */
	readonly default: unknown;
	/** The manifest types it `DictProperty`, so every key under it is content. */
	readonly isMap: boolean;
}

export type SchemaDefaultReader = (
	docType: string,
	key: string,
) => SchemaPropertyDefault;

interface SchemaItem {
	readonly declared?: unknown;
	readonly default?: unknown;
	readonly type?: unknown;
}

const ITEMS = (surface as { readonly items: Readonly<Record<string, unknown>> })
	.items;

const UNKNOWN: SchemaPropertyDefault = {
	known: false,
	default: undefined,
	isMap: false,
};

/**
 * The manifest's answer for `schema:<docType>.<key>`. The manifest also lists
 * Python properties and each model's undeclared-key rule under `schema:`,
 * with `declared: false`; neither is a stored key, so both read as unknown.
 */
export const schemaPropertyDefault: SchemaDefaultReader = (docType, key) => {
	const known = ANSWERS.get(docType)?.get(key);
	if (known !== undefined) return known;
	const answer = answerOf(docType, key);
	if (!answer.known) return answer;
	let byKey = ANSWERS.get(docType);
	if (byKey === undefined) {
		byKey = new Map();
		ANSWERS.set(docType, byKey);
	}
	byKey.set(key, answer);
	return answer;
};

/** Each known key's answer by document type, read once: the manifest is a
 *  module constant, so an answer never changes, and only the manifest's own
 *  keys are held, so what an app's JSON holds adds nothing here. */
const ANSWERS = new Map<string, Map<string, SchemaPropertyDefault>>();

function answerOf(docType: string, key: string): SchemaPropertyDefault {
	const id = `schema:${docType}.${key}`;
	if (!Object.hasOwn(ITEMS, id)) return UNKNOWN;
	const item = ITEMS[id] as SchemaItem;
	if (item.declared !== true) return UNKNOWN;
	return Object.freeze({
		known: true,
		default: item.default,
		isMap: item.type === "DictProperty",
	});
}

/**
 * The manifest's answer for `schema:<docType>.<key>` with its default as every
 * later read of a stored app serves it. `schemaPropertyDefault` answers what
 * HQ writes for a key a document leaves out, which is what the lane's manifest
 * check counts a use against; the next read wraps that again, and
 * `DetailPair.wrap` names its two details' `display` there
 * (`models/modules.py::DetailPair.wrap`: `short` and `long`), so a detail pair
 * an app never set is served with both named, never with the `null` its class
 * declares. A comparison of a served app with a value Nova writes without the
 * key reads this one.
 */
export const servedSchemaPropertyDefault: SchemaDefaultReader = (
	docType,
	key,
) => {
	const answer = schemaPropertyDefault(docType, key);
	return answer.known
		? { ...answer, default: servedDefault(answer.default) }
		: answer;
};

function servedDefault(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(servedDefault);
	if (value === null || typeof value !== "object") return value;
	const served: Record<string, unknown> = {};
	for (const [key, child] of Object.entries(value))
		served[key] = servedDefault(child);
	if (served.doc_type === "DetailPair")
		for (const display of ["short", "long"] as const) {
			const detail = served[display];
			if (
				detail !== null &&
				typeof detail === "object" &&
				!Array.isArray(detail)
			)
				served[display] = { ...detail, display };
		}
	return served;
}
