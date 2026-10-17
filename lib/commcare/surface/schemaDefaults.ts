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
	const id = `schema:${docType}.${key}`;
	if (!Object.hasOwn(ITEMS, id)) return UNKNOWN;
	const item = ITEMS[id] as SchemaItem;
	if (item.declared !== true) return UNKNOWN;
	return {
		known: true,
		default: item.default,
		isMap: item.type === "DictProperty",
	};
};
