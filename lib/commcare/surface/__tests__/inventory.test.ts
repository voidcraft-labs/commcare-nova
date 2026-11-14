/**
 * The manifest's index as server code reads it.
 *
 * Contract: `inventoryIndex()` holds exactly the entries the six area files
 * hold, each under its id, with the standing and cause `standing.ts` derives
 * and the subject, surface keys and value class the entry names; `naming(key)`
 * is every entry naming that key, in file order. Read against the test's own
 * loader (`loadManifest`, which parses the files from disk), so an entry the
 * index drops, a standing that differs from `standingOf`, or a key scan that
 * misses an entry or reorders the entries fails by the entry's id.
 */

import { describe, expect, it } from "vitest";
import { inventoryIndex } from "../inventory";
import { fixCauseOf, standingOf } from "../standing";
import { loadManifest } from "./loadManifest";

const MANIFEST = loadManifest();
const INDEX = inventoryIndex();

describe("inventoryIndex", () => {
	it("holds every entry with its derived standing, cause and subject", () => {
		for (const entry of MANIFEST.inventory) {
			const indexed = INDEX.entry(entry.id);
			expect(indexed, entry.id).toEqual({
				id: entry.id,
				disposition: entry.disposition,
				standing: standingOf(entry),
				cause: fixCauseOf(entry),
				subject: "subject" in entry ? entry.subject : null,
				surfaceKeys: entry.surfaceKeys,
				valueClass: entry.valueClass ?? null,
				noSurfaceKey: entry.noSurfaceKey !== undefined,
			});
		}
	});

	it("answers no entry for an id no area file holds", () => {
		expect(INDEX.entry("questions/no-such-entry-anywhere")).toBeUndefined();
	});

	it("names each surface key's entries in file order, as a scan finds them", () => {
		const keys = new Set(MANIFEST.inventory.flatMap((e) => e.surfaceKeys));
		expect(keys.size).toBeGreaterThan(0);
		for (const key of keys) {
			const scanned = MANIFEST.inventory
				.filter((entry) => entry.surfaceKeys.includes(key))
				.map((entry) => entry.id);
			expect(
				INDEX.naming(key).map((entry) => entry.id),
				key,
			).toEqual(scanned);
		}
		expect(INDEX.naming("schema:NoSuchClass.no_such_key")).toEqual([]);
	});

	it("is built once", () => {
		expect(inventoryIndex()).toBe(INDEX);
	});
});
