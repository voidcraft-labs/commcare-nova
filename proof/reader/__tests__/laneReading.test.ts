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
 * no Project holds and no reading of HQ's one file can give. A path a base's
 * held file stands at is that held asset's, before any asset whose content
 * derives the same path.
 *
 * And a read back told what HQ served at each path of its media map
 * (`servedMedia`, proof 6's `saved` read) names each path by the asset whose
 * bytes HQ sent there, whatever paths the document records, and nothing where
 * HQ served no file or bytes no asset holds (`servedFiles`). The plausible
 * failure: proof 6's `saved` read naming Nova's original picture where HQ
 * serves the person's, or the person's where HQ still serves Nova's, because
 * it took the path's asset from the review it holds HQ to.
 */

import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import {
	type RetainedHqAnswer as HelperAnswer,
	retainedBodyText,
	retainedGroupRead,
	retainedReadingRead,
} from "@/__tests__/helpers/retainedHqReads";
import { readBackDifferences } from "@/lib/deployment/reading/readBack";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import { ensureReferenceIndex } from "@/lib/doc/referenceIndex";
import { type BlueprintDoc, blueprintDocSchema } from "@/lib/domain";
import { collectAssetRefs, remapAssetRefs } from "@/lib/domain/mediaRefs";
import type { MediaAssetId } from "@/lib/domain/multimedia";
import { storedDocument } from "@/proof/corpus/documents";
import {
	laneInputFor,
	loadRetainedHqApp,
	type RetainedHqAnswer,
} from "@/proof/corpus/hqAuthored";
import {
	type DocumentAsset,
	type LaneReadInput,
	publishedFiles,
	readForLane,
	type ServedFile,
	servedFiles,
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

/** An asset of the Project a person's picture is, which no reading of the base names. */
const THEIRS = "0f0e0d0c-0b0a-4908-8706-050403020100";

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
		hqAuthored: { mediaPaths: { held: "jr://file/commcare/kept-in-hq.png" } },
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

it("names a path a base's held file stands at by the held asset, before the asset whose content derives it", () => {
	const png = (bytes: number[]) => ({
		kind: "image",
		extension: ".png",
		base64: Buffer.from(bytes).toString("base64"),
	});
	const own = png([1, 2, 3]);
	const derived = publishedFiles({ doc: {}, media: { own } });
	const [ownPath] = [...derived.byPath.keys()];
	if (ownPath === undefined) throw new Error("The asset was sent at no path.");
	// HQ keeps a base's file under a path another asset's content derives: that path is the held
	// asset's, whatever order the media lists.
	for (const media of [
		{ own, theirs: png([4, 5, 6]) },
		{ theirs: png([4, 5, 6]), own },
	]) {
		const files = publishedFiles({
			doc: {},
			media,
			hqAuthored: { mediaPaths: { theirs: ownPath } },
		});
		expect(files.byPath.get(ownPath)?.assetId).toBe("theirs");
		expect([...files.sameFile]).toEqual([["own", "theirs"]]);
	}
	// Without the held path, the path is the content's own asset's.
	expect(derived.byPath.get(ownPath)?.assetId).toBe("own");
});

const sha256 = (bytes: Uint8Array) =>
	createHash("sha256").update(bytes).digest("hex");

it("names each path by the asset of the bytes HQ served there, and nothing where HQ served no asset's bytes", () => {
	const image = (assetId: string, bytes: number[]): DocumentAsset => ({
		assetId,
		kind: "image",
		contentHash: sha256(Uint8Array.from(bytes)),
	});
	const assets = [
		image("own", [1, 2, 3]),
		image("again", [1, 2, 3]),
		image("theirs", [4, 5, 6]),
	];
	const at = (path: string, bytes: number[], status = 200): ServedFile => ({
		path,
		status,
		sha256: sha256(Uint8Array.from(bytes)),
	});
	const files = servedFiles(assets, [
		at("jr://file/a.png", [4, 5, 6]),
		at("jr://file/b.png", [1, 2, 3]),
		at("jr://file/c.png", [7, 8, 9]),
		at("jr://file/d.png", [1, 2, 3], 404),
	]);
	expect(files.resolve("jr://file/a.png")).toEqual({
		kind: "asset",
		assetId: "theirs",
		mediaKind: "image",
	});
	// Two assets of one content are one file, named by the first.
	expect(files.resolve("jr://file/b.png")).toEqual({
		kind: "asset",
		assetId: "own",
		mediaKind: "image",
	});
	expect([...files.sameFile]).toEqual([["again", "own"]]);
	// Bytes no asset holds, and a file HQ did not serve, name no asset; a path HQ maps nothing at
	// has no entry.
	expect(files.resolve("jr://file/c.png")).toEqual({ kind: "unreadable" });
	expect(files.resolve("jr://file/d.png")).toEqual({ kind: "unreadable" });
	expect(files.resolve("jr://file/e.png")).toEqual({ kind: "no-entry" });
});

const MEDIA_BASE = "hq-menus";

it(
	"reads a state HQ holds back by the bytes HQ served at each path: a file other than the document's at its path differs, whatever the document records",
	async () => {
		const app = loadRetainedHqApp(MEDIA_BASE);
		const first = await readForLane(laneInputFor(app));
		if (first.kind !== "read")
			throw new Error(`The first reading of ${MEDIA_BASE} is no document.`);
		const [file] = first.media?.files ?? [];
		const retained = app.media.find((one) => file?.paths.includes(one.path));
		const [served] = app.mediaReads ?? [];
		if (file === undefined || retained === undefined || served === undefined)
			throw new Error(
				`${MEDIA_BASE}'s first reading holds no file whose bytes and read the base retains.`,
			);
		const theirs = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
		// The document records no path HQ keeps its file under: only the served bytes name it.
		const document = {
			doc: storedDocument(first.doc),
			media: {
				[file.assetId]: {
					kind: file.kind,
					extension: file.extension,
					base64: Buffer.from(retained.bytes).toString("base64"),
				},
				[THEIRS]: {
					kind: "image",
					extension: ".png",
					base64: Buffer.from(theirs).toString("base64"),
				},
			},
			hqAuthored: { identity: first.identity },
		};
		const readBack = async (servedMedia?: readonly ServedFile[]) => {
			const reading = await readForLane({
				appId: app.id,
				document,
				source: app.source,
				application: app.application,
				currentVersion: app.currentVersion,
				...(app.sourceFactoryReads && {
					sourceFactoryReads: app.sourceFactoryReads,
				}),
				...(app.projectSpaces !== undefined && {
					projectSpaces: app.projectSpaces,
				}),
				...(servedMedia !== undefined && { servedMedia }),
				identity: "match",
				claims: "counts",
			});
			if (reading.kind !== "read")
				throw new Error(
					`The read back of ${MEDIA_BASE} is no document: ${JSON.stringify(reading)}`,
				);
			return reading;
		};
		const refs = (doc: BlueprintDoc) => [...collectAssetRefs(doc)].sort();
		const naming = (doc: BlueprintDoc, from: string, to: string) => {
			const remapped = hydratePersistedBlueprint(
				remapAssetRefs(
					blueprintDocSchema.parse(storedDocument(doc)),
					new Map([[from as MediaAssetId, to as MediaAssetId]]),
				),
			);
			ensureReferenceIndex(remapped);
			return remapped;
		};

		// HQ serves the document's own bytes at the path: the read back is the document.
		const same = await readBack([served]);
		expect(refs(same.doc)).toEqual([file.assetId]);
		expect(
			readBackDifferences(first.doc, { doc: same.doc, choices: null }),
		).toEqual([]);
		// Told nothing HQ served, the read back names the path by where the document's publish sent
		// its file, which is not HQ's path: the paths the document records decide there.
		expect(refs((await readBack()).doc)).toEqual([]);

		// HQ serves another file at the path: the read back names it, so a document naming its own
		// file there differs.
		const replaced = await readBack([{ ...served, sha256: sha256(theirs) }]);
		expect(refs(replaced.doc)).toEqual([THEIRS]);
		expect(
			readBackDifferences(first.doc, { doc: replaced.doc, choices: null }),
		).not.toEqual([]);
		// And the reverse: a document naming the other file where HQ still serves the document's own.
		expect(
			readBackDifferences(naming(first.doc, file.assetId, THEIRS), {
				doc: same.doc,
				choices: null,
			}),
		).not.toEqual([]);
		expect(
			readBackDifferences(naming(first.doc, file.assetId, THEIRS), {
				doc: replaced.doc,
				choices: null,
			}),
		).toEqual([]);

		// HQ serves no file there: the read back names none.
		const gone = await readBack([{ ...served, status: 404 }]);
		expect(refs(gone.doc)).toEqual([]);
		expect(
			readBackDifferences(first.doc, { doc: gone.doc, choices: null }),
		).not.toEqual([]);
	},
	BUDGET_MS,
);
