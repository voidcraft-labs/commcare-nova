/**
 * The surface manifest as the tests read it: every inventory entry, every
 * gate entry, and every surface item by key (the generated `surface.json`
 * with the authored `media-formats.json` beside it). Shared by the manifest's
 * own test and the platform table's binding test, so both read one manifest
 * the same way.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	type GateEntry,
	gateEntriesFileSchema,
	INVENTORY_AREAS,
	type InventoryEntry,
	inventoryEntriesFileSchema,
} from "../schema";

const SURFACE_DIR = join(process.cwd(), "lib/commcare/surface");

export function readJson(path: string): unknown {
	return JSON.parse(readFileSync(join(SURFACE_DIR, path), "utf8"));
}

export type Item = Readonly<Record<string, unknown>>;

export interface Manifest {
	readonly inventory: readonly InventoryEntry[];
	readonly gates: readonly GateEntry[];
	/** Every surface item by key: the generated surface and the authored media formats. */
	readonly items: ReadonlyMap<string, Item>;
}

export function loadManifest(): Manifest {
	const surface = readJson("surface.json") as {
		items: Readonly<Record<string, Item>>;
	};
	const media = readJson("media-formats.json") as {
		items: Readonly<Record<string, Item>>;
	};
	return {
		inventory: INVENTORY_AREAS.flatMap((area) =>
			inventoryEntriesFileSchema.parse(readJson(`entries/${area}.json`)),
		),
		gates: gateEntriesFileSchema.parse(readJson("entries/gates.json")),
		items: new Map([
			...Object.entries(surface.items),
			...Object.entries(media.items),
		]),
	};
}
