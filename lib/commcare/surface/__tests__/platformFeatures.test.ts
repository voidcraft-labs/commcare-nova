/**
 * The platform table against the surface manifest.
 *
 * Contract: `lib/domain/platforms.ts::PLATFORM_FEATURES` stands for the
 * manifest's per-platform readings of what Nova authors. Every feature names
 * the entries it stands for (`platformFeatureEntries.ts`), each a HELD entry
 * read per platform that reads exactly as the feature does; every HELD entry
 * that differs by platform is a feature's or ambient (no author choice
 * reaches it, with the reason); each entry is named once; and a HELD media
 * entry reads as the formats it names. So an authored reading that changes
 * in `entries/*.json` without the table, as the review after a pin update may
 * change one, a new HELD entry that differs by platform with no row, a flip
 * that leaves a feature naming an entry that is not HELD, and an entry two
 * rows claim each fail here until the table moves.
 *
 * Each rule is one function over the manifest and the two tables, which the
 * real inputs pass; each rule then has a planted failing case beside it, a
 * copy of the real input with one deliberate fault, so a rule that stops
 * reading its field fails here. The table's internal contract, which no
 * manifest reading states, is asserted at the end: the frame every sentence
 * builder of `platforms.ts` builds on.
 */

import { describe, expect, it } from "vitest";
import {
	PLATFORM_FEATURE_IDS,
	PLATFORM_FEATURES,
	type PlatformFeature,
	REFUSABLE_PLATFORM_FEATURE_IDS,
} from "@/lib/domain/platforms";
import {
	AMBIENT_PLATFORM_ENTRIES,
	PLATFORM_FEATURE_ENTRIES,
} from "../platformFeatureEntries";
import type { InventoryEntry } from "../schema";
import { type Item, loadManifest, type Manifest } from "./loadManifest";

interface Tables {
	readonly features: Readonly<
		Record<string, Pick<PlatformFeature, "webApps" | "android">>
	>;
	readonly entries: Readonly<Record<string, readonly string[]>>;
	readonly ambient: Readonly<Record<string, string>>;
}

const REAL: Tables = {
	features: PLATFORM_FEATURES,
	entries: PLATFORM_FEATURE_ENTRIES,
	ambient: AMBIENT_PLATFORM_ENTRIES,
};
const MANIFEST = loadManifest();

type EachPlatforms = Extract<InventoryEntry["platforms"], { kind: "each" }>;

function readingsOf(entry: InventoryEntry): EachPlatforms | undefined {
	return entry.disposition === "HELD" && entry.platforms.kind === "each"
		? entry.platforms
		: undefined;
}

function isMediaEntry(entry: InventoryEntry): boolean {
	return entry.surfaceKeys.some((key) => key.startsWith("media-format:"));
}

/** Rule 4's and rule 6's "differs": HELD, read per platform, and not
 * `(runs, runs)`. */
function differs(entry: InventoryEntry): boolean {
	const readings = readingsOf(entry);
	return (
		readings !== undefined &&
		!(
			readings.webApps.reading === "runs" && readings.android.reading === "runs"
		)
	);
}

function byId(manifest: Manifest): ReadonlyMap<string, InventoryEntry> {
	return new Map(manifest.inventory.map((entry) => [entry.id, entry]));
}

/** Rule 1: every feature names its entries, and only features name them. */
function unmatchedFeatures(_manifest: Manifest, tables: Tables): string[] {
	const features = Object.keys(tables.features);
	const named = Object.keys(tables.entries);
	return [
		...features
			.filter((id) => !named.includes(id))
			.map(
				(id) =>
					`The platform feature ${id} is in lib/domain/platforms.ts but names no manifest entry in lib/commcare/surface/platformFeatureEntries.ts. Name the entries whose readings it stands for.`,
			),
		...named
			.filter((id) => !features.includes(id))
			.map(
				(id) =>
					`platformFeatureEntries.ts names entries for ${id}, which lib/domain/platforms.ts doesn't hold. Add the feature there, or remove its entries here.`,
			),
	];
}

/** Every (owner, entry) pair the two tables name. */
function namings(tables: Tables): Array<{ owner: string; entry: string }> {
	return [
		...Object.entries(tables.entries).flatMap(([owner, entries]) =>
			entries.map((entry) => ({ owner, entry })),
		),
		...Object.keys(tables.ambient).map((entry) => ({
			owner: "AMBIENT_PLATFORM_ENTRIES",
			entry,
		})),
	];
}

/** Rule 2: a feature or ambient entry names a HELD entry read per platform. */
function namesUnheldEntries(manifest: Manifest, tables: Tables): string[] {
	const entries = byId(manifest);
	return namings(tables).flatMap(({ owner, entry }) => {
		const found = entries.get(entry);
		if (found === undefined)
			return [
				`${owner} names ${entry}, which the manifest doesn't hold. Check the id against lib/commcare/surface/entries/.`,
			];
		if (found.disposition !== "HELD")
			return [
				`${owner} names ${entry}, which is ${found.disposition}. A platform feature stands for content Nova holds, so name only HELD entries.`,
			];
		if (found.platforms.kind !== "each")
			return [
				`${owner} names ${entry}, whose platforms are ${found.platforms.kind}, not read per platform.`,
			];
		return [];
	});
}

/** Rule 3: a feature reads as its entries read. */
function readsUnlikeItsEntries(manifest: Manifest, tables: Tables): string[] {
	const entries = byId(manifest);
	return Object.entries(tables.entries).flatMap(([feature, named]) => {
		const row = tables.features[feature];
		if (row === undefined) return [];
		return named.flatMap((entry) => {
			const readings = (() => {
				const found = entries.get(entry);
				return found === undefined ? undefined : readingsOf(found);
			})();
			if (readings === undefined) return [];
			const ewa = readings.webApps.reading;
			const ean = readings.android.reading;
			return ewa === row.webApps.reading && ean === row.android.reading
				? []
				: [
						`${feature} reads ${row.webApps.reading} on Web Apps and ${row.android.reading} on Android in lib/domain/platforms.ts, but ${entry} reads ${ewa} and ${ean}. Bring the feature's readings to the entry's, or move the entry to a feature that reads as it does.`,
					];
		});
	});
}

/** Rule 4: every HELD entry that differs by platform is a feature's or ambient. */
function unnamedDifferences(manifest: Manifest, tables: Tables): string[] {
	const named = new Set(namings(tables).map(({ entry }) => entry));
	return manifest.inventory.flatMap((entry) => {
		const readings = readingsOf(entry);
		if (
			readings === undefined ||
			!differs(entry) ||
			isMediaEntry(entry) ||
			named.has(entry.id)
		)
			return [];
		return [
			`${entry.id} reads ${readings.webApps.reading} on Web Apps and ${readings.android.reading} on Android, and no platform feature or ambient entry names it. Name it in the feature that offers it (lib/commcare/surface/platformFeatureEntries.ts), or add it to AMBIENT_PLATFORM_ENTRIES with the reason no author choice reaches it.`,
		];
	});
}

/** Rule 5: each entry is named once. */
function namedTwice(_manifest: Manifest, tables: Tables): string[] {
	const owners = new Map<string, string>();
	return namings(tables).flatMap(({ owner, entry }) => {
		const first = owners.get(entry);
		if (first === undefined) {
			owners.set(entry, owner);
			return [];
		}
		return [
			`${entry} is named by ${first} and by ${owner}. Name each entry once.`,
		];
	});
}

/** Rule 6: an ambient entry differs by platform and gives a reason. */
function ambientProblems(manifest: Manifest, tables: Tables): string[] {
	const entries = byId(manifest);
	return Object.entries(tables.ambient).flatMap(([entry, reason]) => {
		const found = entries.get(entry);
		const problems: string[] = [];
		if (found !== undefined && !differs(found))
			problems.push(
				`AMBIENT_PLATFORM_ENTRIES names ${entry}, which reads runs on both platforms or isn't HELD and read per platform. Remove it from the list.`,
			);
		if (reason.trim().length === 0)
			problems.push(
				`AMBIENT_PLATFORM_ENTRIES gives ${entry} no reason. Say why no author choice reaches it.`,
			);
		return problems;
	});
}

/** Rule 7: a HELD media entry reads as its formats. */
function mediaUnlikeItsFormats(manifest: Manifest, _tables: Tables): string[] {
	const readingOf = (item: Item | undefined, side: "webApps" | "android") =>
		(item?.[side] as { reading?: string } | undefined)?.reading;
	return manifest.inventory.flatMap((entry) => {
		const readings = readingsOf(entry);
		if (readings === undefined) return [];
		const wa = readings.webApps.reading;
		const an = readings.android.reading;
		return entry.surfaceKeys
			.filter((key) => key.startsWith("media-format:"))
			.flatMap((key) => {
				const item = manifest.items.get(key);
				const fwa = readingOf(item, "webApps");
				const fan = readingOf(item, "android");
				return fwa === wa && fan === an
					? []
					: [
							`${entry.id} reads ${wa} / ${an}, but the format ${key} it names reads ${fwa} / ${fan} in media-formats.json. Split the entry so each reads as its formats do.`,
						];
			});
	});
}

const RULES = {
	"every feature names its entries": unmatchedFeatures,
	"a feature or ambient entry names a HELD entry read per platform":
		namesUnheldEntries,
	"a feature reads as its entries read": readsUnlikeItsEntries,
	"every HELD entry that differs by platform is a feature's or ambient":
		unnamedDifferences,
	"each entry is named once": namedTwice,
	"an ambient entry differs by platform and gives a reason": ambientProblems,
	"a HELD media entry reads as its formats": mediaUnlikeItsFormats,
} as const satisfies Record<
	string,
	(manifest: Manifest, tables: Tables) => string[]
>;
type Rule = keyof typeof RULES;

describe("the platform table holds to the real manifest", () => {
	for (const [rule, check] of Object.entries(RULES))
		it(rule, () => {
			expect(check(MANIFEST, REAL)).toEqual([]);
		});
});

/** The manifest with one entry's readings replaced. */
function withReadings(
	id: string,
	edit: (platforms: EachPlatforms) => EachPlatforms,
): Manifest {
	return {
		...MANIFEST,
		inventory: MANIFEST.inventory.map((entry) => {
			const readings = readingsOf(entry);
			return entry.id === id && readings !== undefined
				? ({ ...entry, platforms: edit(readings) } as InventoryEntry)
				: entry;
		}),
	};
}

function withoutEntry(feature: string, entry: string): Tables {
	return {
		...REAL,
		entries: {
			...REAL.entries,
			[feature]: (REAL.entries[feature] ?? []).filter((id) => id !== entry),
		},
	};
}

describe("each rule refuses a planted fault the real inputs lack", () => {
	const { "datetime-question": _dropped, ...entriesWithoutOne } = REAL.entries;
	const cases: ReadonlyArray<{
		readonly rule: Rule;
		readonly manifest?: Manifest;
		readonly tables?: Tables;
		readonly problem: string;
	}> = [
		{
			rule: "every feature names its entries",
			tables: { ...REAL, entries: entriesWithoutOne },
			problem:
				"The platform feature datetime-question is in lib/domain/platforms.ts but names no manifest entry in lib/commcare/surface/platformFeatureEntries.ts. Name the entries whose readings it stands for.",
		},
		{
			rule: "every feature names its entries",
			tables: {
				...REAL,
				entries: {
					...REAL.entries,
					"planted-feature": ["questions/gps-geopoint"],
				},
			},
			problem:
				"platformFeatureEntries.ts names entries for planted-feature, which lib/domain/platforms.ts doesn't hold. Add the feature there, or remove its entries here.",
		},
		{
			rule: "a feature or ambient entry names a HELD entry read per platform",
			tables: {
				...REAL,
				entries: {
					...REAL.entries,
					"barcode-question": ["questions/barcode-barcod"],
				},
			},
			problem:
				"barcode-question names questions/barcode-barcod, which the manifest doesn't hold. Check the id against lib/commcare/surface/entries/.",
		},
		{
			rule: "a feature or ambient entry names a HELD entry read per platform",
			tables: {
				...REAL,
				ambient: {
					...REAL.ambient,
					"expressions-and-data/session-data-fingerprintquery": "Planted.",
				},
			},
			problem:
				"AMBIENT_PLATFORM_ENTRIES names expressions-and-data/session-data-fingerprintquery, which is HELD-NEW. A platform feature stands for content Nova holds, so name only HELD entries.",
		},
		{
			rule: "a feature or ambient entry names a HELD entry read per platform",
			tables: {
				...REAL,
				ambient: {
					...REAL.ambient,
					"application-and-settings/doc-type-application": "Planted.",
				},
			},
			problem:
				"AMBIENT_PLATFORM_ENTRIES names application-and-settings/doc-type-application, whose platforms are not-applicable, not read per platform.",
		},
		{
			rule: "a feature reads as its entries read",
			tables: {
				...REAL,
				features: {
					...REAL.features,
					"datetime-question": {
						...PLATFORM_FEATURES["datetime-question"],
						android: { reading: "different" },
					},
				},
			},
			problem:
				"datetime-question reads unavailable on Web Apps and different on Android in lib/domain/platforms.ts, but questions/date-and-time-xsd-datetime reads unavailable and runs. Bring the feature's readings to the entry's, or move the entry to a feature that reads as it does.",
		},
		{
			rule: "every HELD entry that differs by platform is a feature's or ambient",
			tables: withoutEntry("barcode-question", "questions/barcode-barcode"),
			problem:
				"questions/barcode-barcode reads different on Web Apps and runs on Android, and no platform feature or ambient entry names it. Name it in the feature that offers it (lib/commcare/surface/platformFeatureEntries.ts), or add it to AMBIENT_PLATFORM_ENTRIES with the reason no author choice reaches it.",
		},
		{
			rule: "each entry is named once",
			tables: {
				...REAL,
				ambient: {
					...REAL.ambient,
					"questions/hq-generated-pollsensor": "Planted.",
				},
			},
			problem:
				"questions/hq-generated-pollsensor is named by connect-location-capture and by AMBIENT_PLATFORM_ENTRIES. Name each entry once.",
		},
		{
			rule: "an ambient entry differs by platform and gives a reason",
			tables: {
				...REAL,
				ambient: {
					...REAL.ambient,
					"application-and-settings/13-properties-cc-autosync-freq": "Planted.",
				},
			},
			problem:
				"AMBIENT_PLATFORM_ENTRIES names application-and-settings/13-properties-cc-autosync-freq, which reads runs on both platforms or isn't HELD and read per platform. Remove it from the list.",
		},
		{
			rule: "an ambient entry differs by platform and gives a reason",
			tables: {
				...REAL,
				ambient: { ...REAL.ambient, "questions/hint-text": " " },
			},
			problem:
				"AMBIENT_PLATFORM_ENTRIES gives questions/hint-text no reason. Say why no author choice reaches it.",
		},
		{
			rule: "a HELD media entry reads as its formats",
			manifest: withReadings(
				"expressions-and-data/image-png-jpeg-gif-webp",
				(platforms) => ({
					...platforms,
					android: { reading: "unavailable" },
				}),
			),
			problem:
				"expressions-and-data/image-png-jpeg-gif-webp reads runs / unavailable, but the format media-format:image/png it names reads runs / runs in media-formats.json. Split the entry so each reads as its formats do.",
		},
	];
	for (const planted of cases)
		it(`${planted.rule}: ${planted.problem.slice(0, 60)}`, () => {
			expect(
				RULES[planted.rule](
					planted.manifest ?? MANIFEST,
					planted.tables ?? REAL,
				),
			).toContain(planted.problem);
		});
});

describe("the table's own contract", () => {
	const rows = PLATFORM_FEATURE_IDS.map(
		(id) => [id, PLATFORM_FEATURES[id]] as const,
	);
	const unavailable = (row: PlatformFeature) =>
		[row.webApps, row.android].filter((side) => side.reading === "unavailable");

	it("carries refusal copy exactly on a row with an unavailable reading, and lists those rows as refusable in order", () => {
		for (const [id, row] of rows)
			expect([id, row.refusal !== undefined]).toEqual([
				id,
				unavailable(row).length > 0,
			]);
		expect(REFUSABLE_PLATFORM_FEATURE_IDS).toEqual(
			PLATFORM_FEATURE_IDS.filter((id) => PLATFORM_FEATURES[id].refusal),
		);
	});

	it("reads unavailable on at most one platform per row", () => {
		for (const [id, row] of rows)
			expect([id, unavailable(row).length <= 1]).toEqual([id, true]);
	});

	it("gives each question kind to one row", () => {
		const kinds = rows.flatMap(([, row]) =>
			row.fieldKind === undefined ? [] : [row.fieldKind],
		);
		expect(new Set(kinds).size).toBe(kinds.length);
	});

	it("writes notes, remedies and picker lines in the frame the sentence builders read", () => {
		for (const [id, row] of rows) {
			for (const side of [row.webApps, row.android]) {
				if (side.note !== undefined) {
					expect([id, side.note]).not.toContainEqual(
						expect.stringContaining("—"),
					);
					expect([id, side.note.charAt(0)]).toEqual([
						id,
						side.note.charAt(0).toLowerCase(),
					]);
					expect([id, side.note.endsWith(".")]).toEqual([id, false]);
				}
				if (side.reading === "unavailable" && side.remedy !== undefined) {
					expect([id, side.remedy]).not.toContainEqual(
						expect.stringContaining("—"),
					);
					expect([id, /^[A-Z].*\.$/.test(side.remedy)]).toEqual([id, true]);
				}
			}
			const pickerLine = row.refusal?.pickerLine;
			if (pickerLine !== undefined) {
				expect([id, pickerLine]).not.toContainEqual(
					expect.stringContaining("—"),
				);
				expect([id, /^[^.]+\. [^.]+\.$/.test(pickerLine)]).toEqual([id, true]);
			}
		}
	});
});
