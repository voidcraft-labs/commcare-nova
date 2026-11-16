// lib/commcare/surface/inventory.ts
//
// The manifest's inventory entries as server code reads them: every entry of
// the six area files, each with its standing, its cause and its subject,
// derived by `standing.ts` and never authored. The reader of CommCare HQ's
// apps reads an entry's standing here to decide what a claim on it may do.

import "server-only";
import type { FixCause, ReadStanding, Subject } from "@/lib/publish/hqFindings";
import applicationAndSettings from "./entries/application-and-settings.json";
import caseSearch from "./entries/case-search.json";
import expressionsAndData from "./entries/expressions-and-data.json";
import formsAndCaseWrites from "./entries/forms-and-case-writes.json";
import menusAndCaseLists from "./entries/menus-and-case-lists.json";
import questions from "./entries/questions.json";
import {
	type Disposition,
	INVENTORY_AREAS,
	type InventoryArea,
	type InventoryEntry,
	inventoryEntriesFileSchema,
} from "./schema";
import { fixCauseOf, standingOf } from "./standing";

export interface IndexedEntry {
	readonly id: string;
	readonly disposition: Disposition;
	readonly standing: ReadStanding;
	readonly cause: FixCause | null;
	readonly subject: Subject | null;
	readonly surfaceKeys: readonly string[];
	readonly valueClass: string | null;
	/** Whether the entry says why it names no surface key. */
	readonly noSurfaceKey: boolean;
}

export interface InventoryIndex {
	entry(id: string): IndexedEntry | undefined;
	/** Every entry naming a surface key, in file order. */
	naming(key: string): readonly IndexedEntry[];
}

const AREA_FILES: Readonly<Record<InventoryArea, unknown>> = {
	"application-and-settings": applicationAndSettings,
	"menus-and-case-lists": menusAndCaseLists,
	"case-search": caseSearch,
	"forms-and-case-writes": formsAndCaseWrites,
	questions,
	"expressions-and-data": expressionsAndData,
};

function indexed(entry: InventoryEntry): IndexedEntry {
	return Object.freeze({
		id: entry.id,
		disposition: entry.disposition,
		standing: standingOf(entry),
		cause: fixCauseOf(entry),
		subject: "subject" in entry ? entry.subject : null,
		surfaceKeys: Object.freeze([...entry.surfaceKeys]),
		valueClass: entry.valueClass ?? null,
		noSurfaceKey: entry.noSurfaceKey !== undefined,
	});
}

function parseArea(area: InventoryArea): readonly InventoryEntry[] {
	const parsed = inventoryEntriesFileSchema.safeParse(AREA_FILES[area]);
	if (!parsed.success) {
		const [issue] = parsed.error.issues;
		throw new Error(
			`lib/commcare/surface/entries/${area}.json does not match the manifest schema: ${
				issue === undefined
					? parsed.error.message
					: `${issue.path.join(".")}: ${issue.message}`
			}`,
		);
	}
	return parsed.data;
}

let INDEX: InventoryIndex | undefined;

/**
 * The index over every inventory entry, parsed on the first call and kept.
 * An area file the schema refuses throws here, naming the file.
 */
export function inventoryIndex(): InventoryIndex {
	if (INDEX !== undefined) return INDEX;
	const byId = new Map<string, IndexedEntry>();
	const byKey = new Map<string, IndexedEntry[]>();
	for (const area of INVENTORY_AREAS) {
		for (const entry of parseArea(area)) {
			const one = indexed(entry);
			byId.set(one.id, one);
			for (const key of new Set(one.surfaceKeys)) {
				const list = byKey.get(key);
				if (list === undefined) byKey.set(key, [one]);
				else list.push(one);
			}
		}
	}
	const index: InventoryIndex = {
		entry: (id) => byId.get(id),
		naming: (key) => byKey.get(key) ?? [],
	};
	INDEX = index;
	return index;
}
