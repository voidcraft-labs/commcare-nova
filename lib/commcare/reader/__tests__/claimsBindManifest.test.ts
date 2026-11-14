/**
 * Every claim the reader declares, held to the manifest.
 *
 * Contract: for each claim a reader module registers with `defineClaims`, the
 * entry it names exists in the manifest's index, the entry's standing permits
 * the claim's use (take and derived: held; drop: inert or kept; refuse:
 * not-yet, never or fix-in-hq; account: any but held), and the claim's
 * surface key is one of the entry's surface keys, or is null where the entry
 * names none. This is the test a manifest edit trips: an entry renamed or
 * flipped under a claim fails here, naming the claim and the entry, before any
 * reading admits an app wrong. Every module under `lib/commcare/reader/` is
 * imported, so a module added later registers its claims here too. The
 * checker is run over a planted registry first, so it is known to fail.
 */

import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { type InventoryIndex, inventoryIndex } from "../../surface/inventory";
import {
	account,
	type Claim,
	claimPermits,
	claimRegistry,
	drop,
	refuse,
	take,
} from "../claims";

const READER_DIR = join(process.cwd(), "lib/commcare/reader");

/** Every module of the reader, tests left out. */
function readerModules(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory())
			return entry.name === "__tests__" ? [] : readerModules(path);
		return entry.name.endsWith(".ts") ? [path] : [];
	});
}

/** Each way a registered claim disagrees with the manifest, as the sentence a person reads. */
function claimProblems(
	registry: ReadonlyMap<string, Claim>,
	index: InventoryIndex,
): string[] {
	const problems: string[] = [];
	for (const [name, claim] of registry) {
		const entry = index.entry(claim.entry);
		if (entry === undefined) {
			problems.push(
				`The claim ${name} names the entry ${claim.entry}, which no area file of lib/commcare/surface/entries holds. Check the id's spelling, or point the claim at the entry that took its place.`,
			);
			continue;
		}
		if (!claimPermits(claim.use, entry.standing))
			problems.push(
				`The claim ${name} would ${claim.use} a value under ${entry.id}, and that entry is now ${entry.standing}. Change the claim to a use its standing permits (take or derived: held; drop: inert or kept; refuse: not-yet, never or fix-in-hq; account: any but held), or put the entry back.`,
			);
		const keyed =
			claim.key === null
				? entry.noSurfaceKey
				: entry.surfaceKeys.includes(claim.key);
		if (!keyed)
			problems.push(
				`The claim ${name} reads the surface key ${claim.key ?? "(none)"}, which ${entry.id} does not list. Name one of the entry's surfaceKeys, or add the key to the entry.`,
			);
	}
	return problems;
}

describe("the checker", () => {
	it("names a missing entry, a forbidden use and a key the entry lacks", () => {
		const index = inventoryIndex();
		const planted = new Map<string, Claim>([
			["planted.gone", take("questions/no-such-entry-anywhere", null)],
			[
				"planted.flipped",
				refuse(
					"application-and-settings/doc-type-application",
					"schema:Application.doc_type",
				),
			],
			[
				"planted.wrongKey",
				take(
					"application-and-settings/doc-type-application",
					"schema:Application.planted_key",
				),
			],
			[
				"planted.fine",
				take(
					"application-and-settings/doc-type-application",
					"schema:Application.doc_type",
				),
			],
		]);
		expect(claimProblems(planted, index)).toEqual([
			"The claim planted.gone names the entry questions/no-such-entry-anywhere, which no area file of lib/commcare/surface/entries holds. Check the id's spelling, or point the claim at the entry that took its place.",
			"The claim planted.flipped would refuse a value under application-and-settings/doc-type-application, and that entry is now held. Change the claim to a use its standing permits (take or derived: held; drop: inert or kept; refuse: not-yet, never or fix-in-hq; account: any but held), or put the entry back.",
			"The claim planted.wrongKey reads the surface key schema:Application.planted_key, which application-and-settings/doc-type-application does not list. Name one of the entry's surfaceKeys, or add the key to the entry.",
		]);
	});

	it("accepts each use under each standing it is permitted", () => {
		expect(claimPermits("drop", "kept")).toBe(true);
		expect(claimPermits("account", "held")).toBe(false);
		expect(claimPermits("account", "inert")).toBe(true);
		expect(claimPermits(drop("x", null).use, "held")).toBe(false);
		expect(claimPermits(account("x", null).use, "fix-in-hq")).toBe(true);
	});
});

describe("every claim of the reader", () => {
	beforeAll(async () => {
		for (const module of readerModules(READER_DIR)) await import(module);
	});

	it("registers from the reader's own modules", () => {
		expect(
			readerModules(READER_DIR).map((path) => relative(READER_DIR, path)),
		).toContain("accounting.ts");
		expect(claimRegistry().has("accounting.comment")).toBe(true);
	});

	it("names an entry whose standing permits its use, under a key the entry lists", () => {
		expect(claimProblems(claimRegistry(), inventoryIndex())).toEqual([]);
	});
});
