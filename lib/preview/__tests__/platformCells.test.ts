/**
 * The cell table holds Preview to the surface manifest: every platform cell
 * where a HELD entry reads neither `runs` nor `not-applicable` has exactly
 * one row, with evidence that Preview plays it, refuses it, states it, or
 * leaves it outside Preview; and every row's evidence holds.
 *
 * Fails when a manifest change makes a cell differ with no row (a pin
 * update that moves a reading, a flip that makes an entry HELD), when a row
 * outlives its cell, when a refusal names a feature that runs there, when a
 * stated row's note or docs heading is gone, when a scenario is missing or
 * is another platform's, and when a model check sees the other behavior.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PREVIEW_PLATFORM_SCENARIOS } from "@/e2e/lib/previewPlatformScenarios";
import { loadManifest } from "@/lib/commcare/surface/__tests__/loadManifest";
import {
	PLATFORM_FEATURES,
	type Platform,
	type PlatformBehavior,
} from "@/lib/domain/platforms";
import { PLATFORM_MODEL_CHECKS } from "./platformCellModels";
import { PLATFORM_CELLS, PREVIEW_DOCS_SECTION } from "./platformCells";

const PLATFORM_KEYS = {
	"web-apps": "webApps",
	android: "android",
} as const satisfies Readonly<Record<Platform, "webApps" | "android">>;

interface RequiredCell {
	readonly key: `${string}@${Platform}`;
	readonly entry: string;
	readonly platform: Platform;
	readonly reading: string;
	readonly surfaceKeys: readonly string[];
}

/** Every HELD per-platform cell that reads neither `runs` nor
 *  `not-applicable`, from the manifest as it stands. */
function requiredCells(): ReadonlyMap<string, RequiredCell> {
	const cells = new Map<string, RequiredCell>();
	for (const entry of loadManifest().inventory) {
		if (entry.disposition !== "HELD" || entry.platforms.kind !== "each")
			continue;
		for (const platform of Object.keys(PLATFORM_KEYS) as Platform[]) {
			const reading = entry.platforms[PLATFORM_KEYS[platform]].reading;
			if (reading === "runs" || reading === "not-applicable") continue;
			const key = `${entry.id}@${platform}` as const;
			cells.set(key, {
				key,
				entry: entry.id,
				platform,
				reading,
				surfaceKeys: entry.surfaceKeys,
			});
		}
	}
	return cells;
}

function behaviorOn(
	behaviors: {
		readonly webApps: PlatformBehavior;
		readonly android: PlatformBehavior;
	},
	platform: Platform,
): PlatformBehavior {
	return behaviors[PLATFORM_KEYS[platform]];
}

function platformOf(key: string): Platform {
	const platform = key.slice(key.lastIndexOf("@") + 1);
	if (platform !== "web-apps" && platform !== "android")
		throw new Error(`${key} names no platform after its @.`);
	return platform;
}

const required = requiredCells();

describe("the cell table", () => {
	it("has a row for every cell that reads differently, and no other", () => {
		const problems: string[] = [];
		for (const cell of required.values())
			if (!(cell.key in PLATFORM_CELLS))
				problems.push(
					`${cell.entry} reads ${cell.reading} on ${cell.platform} and the cell table has no row for it. Add one to lib/preview/__tests__/platformCells.ts with the evidence that shows Preview plays it, or the refusal that keeps it out of an app on that platform.`,
				);
		for (const key of Object.keys(PLATFORM_CELLS))
			if (!required.has(key)) {
				const at = key.lastIndexOf("@");
				problems.push(
					`lib/preview/__tests__/platformCells.ts has a row for ${key.slice(0, at)} on ${key.slice(at + 1)}, which no longer reads differently there or isn't HELD. Remove the row.`,
				);
			}
		expect(problems).toEqual([]);
	});

	describe.each(Object.entries(PLATFORM_CELLS))("%s", (key, cell) => {
		const platform = platformOf(key);
		if (cell.kind === "refused" && cell.channel !== "media") {
			it(`is refused: ${cell.feature} is unavailable there`, () => {
				const feature = PLATFORM_FEATURES[cell.feature];
				expect(behaviorOn(feature, platform).reading).toBe("unavailable");
				expect(feature.channel).toBe(
					cell.channel === "structural" ? "structure" : "expression",
				);
			});
		} else if (cell.kind === "refused") {
			it("is refused: the entry names a media format", () => {
				expect(
					required
						.get(key)
						?.surfaceKeys.some((surfaceKey) =>
							surfaceKey.startsWith("media-format:"),
						),
				).toBe(true);
			});
		} else if (cell.kind === "stated" && "feature" in cell) {
			it(`is stated: ${cell.feature} has a note there`, () => {
				expect(
					behaviorOn(PLATFORM_FEATURES[cell.feature], platform).note,
				).toBeTruthy();
			});
		} else if (cell.kind === "stated") {
			it("is stated in the public docs", () => {
				expect(cell.docs).toBe(PREVIEW_DOCS_SECTION);
				const [file] = cell.docs.split("#");
				const page = readFileSync(join(process.cwd(), file), "utf8");
				expect(page.split("\n")).toContain(
					"### Preview on Web Apps and Android",
				);
			});
		} else if (cell.kind === "browser") {
			it(`is played in the browser: ${cell.scenario}`, () => {
				expect(PREVIEW_PLATFORM_SCENARIOS[cell.scenario]?.platform).toBe(
					platform,
				);
			});
		} else if (cell.kind === "model") {
			it(`is played by the model: ${cell.check}`, async () => {
				const check: (on: Platform) => unknown =
					PLATFORM_MODEL_CHECKS[cell.check];
				await check(platform);
			});
		} else {
			it("says why it is outside Preview", () => {
				expect(cell.reason.trim()).not.toBe("");
			});
		}
	});
});
