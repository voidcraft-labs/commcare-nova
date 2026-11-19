/**
 * Where a lane read back finds the ids CommCare HQ holds for a document's
 * menus and forms.
 *
 * Contract: a read back (`identity: "match"`) takes those ids from the
 * corpus document's `hqAuthored`, or from its top level (`identity`), which
 * proof 6 gives the document a bring-in of a person's saves left
 * (`proof/checks/proof6.py::requests_for`). Under either it reads the app
 * back to the document's own UUIDs, and with neither a menu or form HQ
 * holds under an id the document does not derive reads back under a UUID
 * the reader mints. The read back over `navigation-base`'s retained answers
 * is held to the first reading of the same answers, whose identity rows
 * name HQ's own form ids (HQ's application resource re-mints none of
 * them, and they are no id Nova derives from the reading's UUIDs).
 *
 * The plausible failure: a read back that reads the ids only under
 * `hqAuthored`, so a form CommCare HQ added that a bring-in took reads back
 * under a minted UUID and proof 6 reports the document it brought in as
 * changed.
 *
 * And each path a document's publish sent a file at is named by one asset of
 * the document's media, the first sent there, and every later asset sent at
 * that path is that file (`publishedFiles`), while an asset of other bytes, or
 * one HQ keeps at a path of its own, is not. The plausible failure: proof 6
 * holding a reading to name each of two assets of one content apart, which
 * no Project holds and no reading of HQ's one file can give. A path HQ keeps a
 * held file under is that held asset's, before any asset whose content derives
 * the same path: a picture a person replaced under Nova's path is the person's
 * file there. The plausible failure: proof 6's `saved` read naming Nova's
 * original picture where HQ serves the person's.
 */

import { expect, it } from "vitest";
import {
	type RetainedHqAnswer as HelperAnswer,
	retainedBodyText,
	retainedGroupRead,
	retainedReadingRead,
} from "@/__tests__/helpers/retainedHqReads";
import { readBackDifferences } from "@/lib/deployment/reading/readBack";
import { storedDocument } from "@/proof/corpus/documents";
import type { RetainedHqAnswer } from "@/proof/corpus/hqAuthored";
import {
	type LaneReadInput,
	publishedFiles,
	readForLane,
} from "../laneReading";

/** A reading of the retained answers is about a second, more under load. */
const BUDGET_MS = 60_000;

function asRetained(answer: HelperAnswer): RetainedHqAnswer {
	return {
		status: answer.status,
		headers: answer.headers,
		body: retainedBodyText(answer),
	};
}

const APP_ID = "navigation-base";

const ANSWERS = {
	application: asRetained(retainedReadingRead("application")),
	source: asRetained(retainedGroupRead("navigation-base/app-source")),
	currentVersion: asRetained(retainedReadingRead("current-version")),
} as const;

async function read(input: Partial<LaneReadInput>) {
	const reading = await readForLane({
		appId: APP_ID,
		...ANSWERS,
		identity: "match",
		claims: "counts",
		...input,
	});
	if (reading.kind !== "read")
		throw new Error(
			`Nova's reading of ${APP_ID} is no document: ${JSON.stringify(reading)}`,
		);
	return reading;
}

it(
	"reads a document back to its own UUIDs with HQ's ids under hqAuthored or at its top level, and mints new ones with neither",
	async () => {
		const first = await read({
			identity: "mint",
			projectData: {
				lookupTables: asRetained(retainedGroupRead("lookups/lookup-tables")),
				fixtureRows: {},
				media: [],
			},
		});
		const doc = storedDocument(first.doc);
		const ids = (
			rows: readonly { readonly uniqueId: string | null }[],
		): readonly (string | null)[] => rows.map((row) => row.uniqueId).sort();

		const underHqAuthored = await read({
			document: { doc, hqAuthored: { identity: first.identity } },
		});
		expect(
			readBackDifferences(first.doc, {
				doc: underHqAuthored.doc,
				choices: null,
			}),
		).toEqual([]);

		const atTopLevel = await read({
			document: { doc, identity: first.identity },
		});
		expect(
			readBackDifferences(first.doc, { doc: atTopLevel.doc, choices: null }),
		).toEqual([]);
		expect(ids(atTopLevel.identity)).toEqual(ids(first.identity));

		// With neither, the ids HQ holds key nothing the document holds.
		const without = await read({ document: { doc } });
		expect(
			readBackDifferences(first.doc, { doc: without.doc, choices: null }),
		).not.toEqual([]);
	},
	BUDGET_MS,
);

it("names each path a document's publish sent by one asset, and every other asset sent there as that file", () => {
	const png = (bytes: number[]) => ({
		kind: "image",
		extension: ".png",
		base64: Buffer.from(bytes).toString("base64"),
	});
	const files = publishedFiles({
		doc: {},
		media: {
			first: png([1, 2, 3]),
			again: png([1, 2, 3]),
			other: png([4, 5, 6]),
			held: png([1, 2, 3]),
		},
		mediaPaths: { held: "jr://file/commcare/kept-in-hq.png" },
	});
	expect([...files.byPath.values()].map((file) => file.assetId)).toEqual([
		"held",
		"first",
		"other",
	]);
	expect(files.byPath.get("jr://file/commcare/kept-in-hq.png")?.assetId).toBe(
		"held",
	);
	// The asset with the first's bytes is that file; another file, and one HQ keeps at a path of
	// its own, stays itself.
	expect([...files.sameFile]).toEqual([["again", "first"]]);
});

it("names a path HQ holds a replaced file under by the held asset, before the asset whose content derives it", () => {
	const png = (bytes: number[]) => ({
		kind: "image",
		extension: ".png",
		base64: Buffer.from(bytes).toString("base64"),
	});
	const own = png([1, 2, 3]);
	const derived = publishedFiles({ doc: {}, media: { own } });
	const [ownPath] = [...derived.byPath.keys()];
	if (ownPath === undefined) throw new Error("The asset was sent at no path.");
	// A person replaced Nova's picture under its path with one the Project also holds: the
	// review's reading names that path by the person's asset, whatever order the media lists.
	for (const media of [
		{ own, theirs: png([4, 5, 6]) },
		{ theirs: png([4, 5, 6]), own },
	]) {
		const files = publishedFiles({
			doc: {},
			media,
			mediaPaths: { theirs: ownPath },
		});
		expect(files.byPath.get(ownPath)?.assetId).toBe("theirs");
		expect([...files.sameFile]).toEqual([["own", "theirs"]]);
	}
	// Without the held path, the path is the content's own asset's.
	expect(derived.byPath.get(ownPath)?.assetId).toBe("own");
});
