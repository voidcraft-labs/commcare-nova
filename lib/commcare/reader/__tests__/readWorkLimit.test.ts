/**
 * A reading's work limit has room for every app the reader is known to read.
 *
 * Contract: the limit is a function of the source's size alone
 * (`work.ts::readWorkLimit`), and every reading of a retained base made in
 * CommCare HQ (`proof/hq-apps/`) and of every document the proof lane
 * publishes (`publishedDocuments.ts`, the documents `targetedReadBack.test.ts`
 * reads back) does at most a quarter of the limit of its size: the limit's
 * constants were set at four times the most such a reading did, so a reader
 * change that moves a reading's work toward its limit fails here, in ordinary
 * CI, before an app is refused for Nova's own work. Each reading is made with
 * no limit (`ReaderOptions.workLimit`), so the units counted are the work
 * itself, and the greatest share of its limit any reading spent is printed.
 * Deterministic; no clock.
 *
 * Plausible failure: a stage that searches by printing the whole menu or
 * document once a trial, whose work grows faster than the source; or
 * constants set below what an ordinary app needs.
 */

import { expect, it } from "vitest";
import {
	RETAINED_BASES,
	retainedBase,
} from "@/__tests__/helpers/retainedHqApps";
import { readingAppStrings } from "@/lib/deployment/reading/appStrings";
import type { MediaKind } from "@/lib/domain";
import { lookupContextOf } from "@/proof/corpus/documents";
import { expandDoc } from "../../expander";
import { DERIVED_WIRE_IDENTITY } from "../../wireIdentity";
import { matchingResolver } from "../identity";
import { externalIdentityMap } from "../identityMap";
import {
	knownCaseTypesOf,
	knownPositionedCaseOperationIdsOf,
	readHqApp,
} from "../index";
import type { ReaderInput, ReaderMediaResolution } from "../types";
import { readWorkLimit, sourceCharacters } from "../work";
import { levelsAsPublished } from "../worldEntities";
import { inputFor } from "./novaExport";
import {
	hydrated,
	publishExpansion,
	publishedCorpus,
	publishRefuses,
} from "./publishedDocuments";
import { retainedSourceBody } from "./readerInput";

const MEDIA_KIND_OF_EXTENSION: Readonly<Record<string, MediaKind>> = {
	".png": "image",
	".jpg": "image",
	".jpeg": "image",
	".mp3": "audio",
	".mp4": "video",
};

interface Spent {
	readonly name: string;
	readonly characters: number;
	readonly units: number;
}

/** The units a reading of `input` spends, read with no limit. */
function spent(name: string, input: ReaderInput): Spent {
	const outcome = readHqApp(input, {
		workLimit: Number.POSITIVE_INFINITY,
	});
	return {
		name,
		characters: sourceCharacters(input.source.raw),
		units: outcome.work.units,
	};
}

/** Each reading's share of the limit of its size. */
function shareOf(one: Spent): number {
	return one.units / readWorkLimit(one.characters);
}

function report(readings: readonly Spent[]): string {
	const most = [...readings].sort((a, b) => shareOf(b) - shareOf(a))[0];
	return most === undefined
		? "no reading"
		: `the most any reading spent is ${(shareOf(most) * 100).toFixed(2)}% of its limit (${most.name}: ${most.units} units over ${most.characters} characters, ${(most.units / most.characters).toFixed(1)} a character)`;
}

it("reads every retained base made in CommCare HQ within a quarter of its limit", {
	// A reading of each retained base, a starter app the largest.
	timeout: 600_000,
}, async () => {
	const readings: Spent[] = [];
	for (const id of RETAINED_BASES) {
		const base = retainedBase(id);
		// The base's tables and files are no part of the work measured: every reading is told
		// none, and the strings Nova's build gives a document as empty, which a reading of the
		// app's own strings compares with whatever they are.
		readings.push(
			spent(
				id,
				await inputFor(JSON.parse(base.source.body ?? "null"), {
					appStrings: () => ({ languages: {}, units: {} }),
				}),
			),
		);
	}
	console.info(`Retained bases: ${report(readings)}.`);
	expect(readings.length).toBeGreaterThan(0);
	expect(
		readings.filter((one) => one.units * 4 > readWorkLimit(one.characters)),
	).toEqual([]);
});

it("reads every document the proof lane publishes within a quarter of its limit", {
	// A reading of every targeted and producer document.
	timeout: 600_000,
}, async () => {
	const readings: Spent[] = [];
	for (const document of publishedCorpus()) {
		const doc = hydrated(document);
		if (publishRefuses(document, doc)) continue;
		const { options, manifest } = publishExpansion(document, doc);
		const assetOfPath = new Map<string, string>();
		for (const [assetId, asset] of manifest) {
			const path = `jr://file/${asset.wirePath}`;
			if (!assetOfPath.has(path)) assetOfPath.set(path, assetId);
		}
		const body = {
			...retainedSourceBody("shell/app-source"),
			...(JSON.parse(JSON.stringify(expandDoc(doc, options))) as Record<
				string,
				unknown
			>),
		};
		const definitions = document.lookup?.definitions ?? [];
		const levels = levelsAsPublished(doc);
		const input = await inputFor(body, {
			resolver: matchingResolver(
				doc.appId,
				externalIdentityMap(doc, DERIVED_WIRE_IDENTITY),
			),
			knownCaseTypes: knownCaseTypesOf(doc),
			knownPositionedCaseOperationIds: knownPositionedCaseOperationIdsOf(doc),
			appStrings: readingAppStrings(lookupContextOf(document.lookup)),
			lookup: {
				table: (tag) => {
					const table = definitions.find((one) => one.tag === tag);
					return table === undefined
						? undefined
						: {
								tableId: table.id,
								column: (name) =>
									table.columns.find((column) => column.wireName === name)?.id,
							};
				},
				definitions: new Map(definitions.map((table) => [table.id, table])),
			},
			organization: { levelCodes: levels.map((level) => level.code), levels },
			media: {
				resolve: (path): ReaderMediaResolution => {
					const assetId = assetOfPath.get(path);
					if (assetId === undefined) return { kind: "no-entry" };
					const mediaKind =
						MEDIA_KIND_OF_EXTENSION[path.slice(path.lastIndexOf("."))];
					return mediaKind === undefined
						? { kind: "unreadable" }
						: { kind: "asset", assetId, mediaKind };
				},
			},
		});
		readings.push(spent(document.id, input));
	}
	console.info(`Published documents: ${report(readings)}.`);
	expect(readings.length).toBeGreaterThan(0);
	expect(
		readings.filter((one) => one.units * 4 > readWorkLimit(one.characters)),
	).toEqual([]);
});
