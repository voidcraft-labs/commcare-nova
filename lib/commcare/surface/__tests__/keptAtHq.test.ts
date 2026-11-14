/**
 * `KEPT_AT_HQ` against the manifest and the code its cells name.
 *
 * Contract: the table holds one row for every TARGET-OWNED entry and a row
 * for nothing else, so a value Nova leaves at CommCare HQ's always says what
 * a `.ccz`, Preview and another project space do with it, and a row never
 * outlives its entry's flip. Each labelled setting row reaches the kept list
 * (`keptListFor`) for some project space, so no label is one a person can
 * never be shown; each advisory a cell names is one the export can give; and
 * each `by` names a symbol its module exports, so a cell never points at code
 * that was renamed or removed.
 *
 * The binding is one function over the manifest and the table, which the real
 * pair passes; a planted entry with no row and a planted row with no kept
 * entry each fail it.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import type { TargetFacts } from "@/lib/commcare/targetFacts";
import { keptListFor } from "@/lib/deployment/targetFacts";
import { exportAdvisories } from "@/lib/publish/exportAdvisories";
import { KEPT_AT_HQ, type KeptRow } from "../keptAtHq";
import type { InventoryEntry } from "../schema";
import { loadManifest } from "./loadManifest";

const MANIFEST = loadManifest();

/** Every TARGET-OWNED entry has a row, and every row names one. */
function keptBindingProblems(
	inventory: readonly InventoryEntry[],
	table: Readonly<Record<string, KeptRow>>,
): string[] {
	const disposition = new Map(
		inventory.map((entry) => [entry.id, entry.disposition]),
	);
	const unrowed = inventory
		.filter(
			(entry) =>
				entry.disposition === "TARGET-OWNED" && !Object.hasOwn(table, entry.id),
		)
		.map(
			(entry) =>
				`${entry.id} is TARGET-OWNED and has no row in KEPT_AT_HQ. Add its row (lib/commcare/surface/keptAtHq.ts): what a .ccz, Preview and another project space do with the value it keeps.`,
		);
	const unkept = Object.keys(table)
		.filter((id) => disposition.get(id) !== "TARGET-OWNED")
		.map((id) => {
			const held = disposition.get(id);
			return held === undefined
				? `KEPT_AT_HQ has a row for ${id}, which no manifest entry holds. Rename the row to the entry's id, or remove it.`
				: `KEPT_AT_HQ has a row for ${id}, which is ${held}, not TARGET-OWNED. Remove the row: Nova does not leave this value at CommCare HQ's.`;
		});
	return [...unrowed, ...unkept];
}

describe("KEPT_AT_HQ and the manifest", () => {
	it("holds one row for each TARGET-OWNED entry and none for any other", () => {
		expect(keptBindingProblems(MANIFEST.inventory, KEPT_AT_HQ)).toEqual([]);
	});

	it("refuses a TARGET-OWNED entry with no row", () => {
		const kept = MANIFEST.inventory.find(
			(entry) => entry.disposition === "TARGET-OWNED",
		);
		if (kept === undefined)
			throw new Error("The manifest holds no TARGET-OWNED entry to plant on.");
		const planted = { ...kept, id: `${kept.area}/planted-kept-value` };
		expect(
			keptBindingProblems([...MANIFEST.inventory, planted], KEPT_AT_HQ),
		).toEqual([
			`${planted.id} is TARGET-OWNED and has no row in KEPT_AT_HQ. Add its row (lib/commcare/surface/keptAtHq.ts): what a .ccz, Preview and another project space do with the value it keeps.`,
		]);
	});

	it("refuses a row whose entry is not TARGET-OWNED, or is no entry", () => {
		const held = MANIFEST.inventory.find(
			(entry) => entry.disposition === "HELD",
		);
		const row = Object.values(KEPT_AT_HQ)[0];
		if (held === undefined || row === undefined)
			throw new Error("The manifest or the table is empty.");
		expect(
			keptBindingProblems(MANIFEST.inventory, {
				...KEPT_AT_HQ,
				[held.id]: row,
				"questions/planted-no-entry": row,
			}),
		).toEqual([
			`KEPT_AT_HQ has a row for ${held.id}, which is HELD, not TARGET-OWNED. Remove the row: Nova does not leave this value at CommCare HQ's.`,
			"KEPT_AT_HQ has a row for questions/planted-no-entry, which no manifest entry holds. Rename the row to the entry's id, or remove it.",
		]);
	});
});

/** The HQ-authored apps the rows name, each holding its rows' values away from the default. */
const BASES = new Set(["hq-new-app", "hq-kept-settings", "starter-health"]);

describe("KEPT_AT_HQ's rows", () => {
	const rows = Object.entries(KEPT_AT_HQ);

	it("name a base that holds them", () => {
		expect(
			rows.filter(([, row]) => !BASES.has(row.base)).map(([id]) => id),
		).toEqual([]);
	});

	it("give each label to one row, and a label only to a setting", () => {
		const labels = rows.flatMap(([, row]) =>
			row.label === undefined ? [] : [row.label],
		);
		expect(new Set(labels).size).toBe(labels.length);
		expect(
			rows
				.filter(([, row]) => row.label !== undefined && row.kind !== "setting")
				.map(([id]) => id),
		).toEqual([]);
	});
});

/** A project space that holds every kept value away from what a new app holds. */
const EVERY_VALUE_KEPT: TargetFacts = {
	observedAt: "2026-11-10T09:00:00.000Z",
	profileProperties: {
		"cc-autoup-freq": "freq-daily",
		"cc-days-form-retain": "30",
		logenabled: "Disabled",
		"cc-autosync-freq": "freq-daily",
		"cc-content-valid": "yes",
		"unsent-number-limit": "10",
		"unsent-time-limit": "10",
		"cc-resize-images": "full",
		"cc-fuzzy-search-enabled": "yes",
		"cc-login-duration-seconds": "3600",
		"cc-inflation-target-density": "DENSITY_HIGH",
		"cc-gps-auto-capture-accuracy": "20",
		"cc-maps-default-layer": "satellite",
		"cc-enable-tts": "yes",
		"cc-label-required-questions-with-asterisk": "yes",
		"cc-log-entity-detail-enabled": "on",
	},
	uiText: { en: { "home.start": "Begin" } },
	uiTextKeys: ["home.start"],
	secureSubmissions: true,
	customBaseUrl: "https://hq.example.org",
	autoGpsCapture: true,
	androidLogos: ["home"],
	practiceWorker: true,
	persistentMenu: true,
	breadcrumbs: false,
	mobileReportVersion: "1.0",
	credentialLevel: "3MON_ACTIVE",
	languageNames: { en: { en: "English" } },
	seeds: "target",
};

/** A project space that holds what a first publish of a new app gives. */
const NOTHING_KEPT: TargetFacts = {
	observedAt: "2026-11-10T09:00:00.000Z",
	profileProperties: {},
	uiText: {},
	uiTextKeys: [],
	secureSubmissions: false,
	customBaseUrl: null,
	autoGpsCapture: false,
	androidLogos: [],
	practiceWorker: false,
	persistentMenu: false,
	breadcrumbs: true,
	mobileReportVersion: "2.0",
	credentialLevel: null,
	languageNames: null,
	seeds: "nova",
};

describe("the kept list over KEPT_AT_HQ", () => {
	it("lists every labelled setting row, in the table's order, for a project space that holds each away from a new app", () => {
		const labelled = Object.values(KEPT_AT_HQ).flatMap((row) =>
			row.kind === "setting" && row.label !== undefined ? [row.label] : [],
		);
		expect(keptListFor(EVERY_VALUE_KEPT)).toEqual(labelled);
	});

	it("lists nothing for a project space that holds what a new app holds", () => {
		expect(keptListFor(NOTHING_KEPT)).toEqual([]);
	});
});

describe("the advisories KEPT_AT_HQ names", () => {
	it("are advisories a download made with kept values can give", () => {
		const named = Object.values(KEPT_AT_HQ).flatMap((row) =>
			(row.ccz.does === "states" || row.ccz.does === "mirrors") &&
			row.ccz.advisory !== undefined
				? [row.ccz.advisory]
				: [],
		);
		expect(named.length).toBeGreaterThan(0);
		const given = new Set(
			exportAdvisories(buildDoc({ appName: "Kept values" }), "known", {
				uiTextFallsBack: true,
				androidLogos: true,
				practiceWorker: true,
				languageNames: true,
			}).map((advisory) => advisory.id),
		);
		expect(named.filter((id) => !given.has(id))).toEqual([]);
	});
});

const REPOSITORY = resolve(import.meta.dirname, "../../../..");

/**
 * The names a module's top-level declarations export, read from its source:
 * each line that opens `export` and declares a function, class, constant or
 * variable. Reading the source rather than importing the module keeps a
 * component's module graph out of this test.
 */
function exportedDeclarations(path: string): ReadonlySet<string> {
	const declared = new Set<string>();
	for (const line of readFileSync(resolve(REPOSITORY, path), "utf8").split(
		"\n",
	)) {
		const match =
			/^export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)/.exec(
				line,
			);
		if (match?.[1] !== undefined) declared.add(match[1]);
	}
	return declared;
}

describe("the code KEPT_AT_HQ's cells name", () => {
	const named = [
		...new Set(
			Object.values(KEPT_AT_HQ).flatMap((row) => [
				...(row.ccz.does === "mirrors" ? [row.ccz.by] : []),
				...(row.preview.does === "reads" ? [row.preview.by] : []),
			]),
		),
	];

	it.each(named)("%s is a symbol its module exports", (by) => {
		const [path, symbol, ...rest] = by.split("::");
		expect(rest).toEqual([]);
		if (path === undefined || symbol === undefined)
			throw new Error(`${by} names no module and symbol as path::symbol.`);
		expect(existsSync(resolve(REPOSITORY, path)), `${path} is no file`).toBe(
			true,
		);
		expect([...exportedDeclarations(path)]).toContain(symbol);
	});
});
