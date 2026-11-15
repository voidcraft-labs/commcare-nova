/**
 * The export boundary a birth computes its baseline over is the one the
 * first publish to the adopted deployment prepares.
 *
 * Contract: over a reading of an app that reads a lookup table and holds two
 * media files, `expandDoc` under `adoptionExportBoundary`'s options is byte
 * for byte `expandDoc` under the options `prepareExportBoundary` gives a
 * direct upload to that deployment once the app is born: the same document,
 * the project space it came from, the tables under the names CommCare HQ
 * holds, and each file at the path `assignMediaPaths` keeps for it, as the
 * deployment's held media paths hand it to the publish's media manifest.
 *
 * Plausible failure: a baseline's ownership descriptor computed over a body
 * the first publish does not send (another path for a file, a table under
 * another name, a capture's link against another project space), so the
 * first publish meets a change in CommCare HQ that nobody made.
 */

import { describe, expect, it, vi } from "vitest";
import { testMediaAssetId } from "@/__tests__/helpers/uuid";
import { expandDoc } from "@/lib/commcare/expander";
import { readHqApp } from "@/lib/commcare/reader";
import {
	hydrated,
	publishedCorpus,
} from "@/lib/commcare/reader/__tests__/publishedDocuments";
import { mintingResolver } from "@/lib/commcare/reader/identity";
import { targetWireIdentity } from "@/lib/commcare/wireIdentity";
import { loadAssetsByIds, type MediaAssetRecord } from "@/lib/db/mediaAssets";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { type BlueprintDoc, isContainer } from "@/lib/domain";
import type { MediaAssetId } from "@/lib/domain/multimedia";
import { prepareExportBoundaryWithReads } from "@/lib/export/boundaryValidation";
import { resolveMediaManifest } from "@/lib/media/manifest";
import {
	type AdoptedMediaFile,
	adoptedIdentityRows,
	assignMediaPaths,
} from "../../adoption";
import { attachmentUrlTarget } from "../../attachmentTarget";
import { adoptionExportBoundary } from "../adoptionBoundary";
import {
	lookupContextOf,
	NOVA_DOMAIN,
	NOVA_ORIGIN,
	readBackInput,
	servedExport,
} from "./novaReading";

vi.mock("@/lib/db/mediaAssets", () => ({ loadAssetsByIds: vi.fn() }));

const PICTURES = [
	testMediaAssetId("boundary-a"),
	testMediaAssetId("boundary-b"),
];

/** The corpus app that reads a table, with a picture on each of its first two questions. */
function tableAndPictures(): {
	readonly doc: BlueprintDoc;
	readonly lookup: NonNullable<
		ReturnType<typeof publishedCorpus>[number]["lookup"]
	>;
} {
	const document = publishedCorpus().find((one) => one.id === "lookup-app");
	if (document?.lookup === undefined)
		throw new Error("The corpus holds lookup-app with its table.");
	const doc = hydrated(document);
	const questions = Object.values(doc.fields).filter(
		(field) => field.kind !== "hidden" && !isContainer(field),
	);
	const pictured = structuredClone(doc);
	for (const [index, assetId] of PICTURES.entries()) {
		const question = questions[index];
		if (question === undefined) throw new Error("The app holds two questions.");
		(pictured.fields[question.uuid] as { label_media?: unknown }).label_media =
			{ image: assetId };
	}
	return { doc: pictured, lookup: document.lookup };
}

describe("adoptionExportBoundary", () => {
	it("prints the body the first publish to the adopted deployment prints", async () => {
		const { doc, lookup } = tableAndPictures();
		const served = servedExport(doc, { lookup });
		const input = {
			...(await readBackInput(doc, served, { lookup })),
			resolver: mintingResolver(doc.appId),
		};
		const reading = readHqApp(input);
		if (reading.kind !== "read")
			throw new Error(
				`The app read to an account: ${reading.findings.map((one) => one.code).join(", ")}`,
			);
		const { draft } = reading;
		const declaration = draft.declaration;
		if (declaration.kind !== "choices") throw new Error("No declaration runs.");
		const choice = declaration.choices[declaration.proposed];
		if (choice === undefined) throw new Error("No proposed declaration.");
		const born = mutationCommitVerdict(
			draft.doc,
			choice.mutations,
			lookupContextOf(lookup),
		);
		if (!born.ok) throw new Error("The birth's document is refused.");
		const birth = born.nextDoc;

		// The two files, as the reading resolved their paths.
		const files: AdoptedMediaFile[] = draft.facts.mediaReferences.map(
			(reference) => {
				const asset = served.manifest.get(reference.assetId as MediaAssetId);
				if (asset === undefined) throw new Error("A reference names no file.");
				return {
					hqPath: reference.path,
					assetId: reference.assetId as MediaAssetId,
					contentHash: asset.contentHash,
					extension: asset.extension,
				};
			},
		);
		expect(new Set(files.map((file) => file.assetId)).size).toBe(2);
		const target = { origin: NOVA_ORIGIN, domain: NOVA_DOMAIN };
		const adopted = adoptionExportBoundary(
			birth,
			lookup.definitions,
			files,
			target,
		);

		// What a publish to the deployment prepares once the app is born: its
		// held paths are the rows the birth records, and the media manifest is
		// the production one over the Project's rows of the two files.
		const rows: MediaAssetRecord[] = files.map((file) => ({
			id: file.assetId,
			project_id: lookup.projectId,
			owner: "user-1",
			contentHash: file.contentHash,
			mimeType: "image/png",
			extension: file.extension,
			sizeBytes: 100,
			mediaFormat: "png",
			kind: "image",
			gcsObjectKey: `projects/${lookup.projectId}/${file.assetId}`,
			originalFilename: "picture.png",
			status: "ready",
			created_at: new Date(0),
		})) as MediaAssetRecord[];
		vi.mocked(loadAssetsByIds).mockResolvedValue(rows);
		const heldMediaPaths = new Map(
			assignMediaPaths(files).rows.map((row) => [row.assetId, row.wirePath]),
		);
		const prepared = await prepareExportBoundaryWithReads(
			{
				mode: "hq-upload",
				access: {
					projectId: lookup.projectId,
					role: "owner",
					actorUserId: "user-1",
				},
				doc: birth,
				compiledAtSeq: 1,
				attachmentTarget: attachmentUrlTarget({
					server: "india",
					domain: NOVA_DOMAIN,
				}),
				heldMediaPaths,
			},
			{
				lookupFixtureData: async () => lookup,
				mediaRows: async () => rows,
				mediaManifest: (manifestDoc, projectId, heldPaths) =>
					resolveMediaManifest(manifestDoc, projectId, {
						withBytes: false,
						...(heldPaths !== undefined && { heldPaths }),
					}),
			},
		);
		if (!prepared.ok)
			throw new Error(
				`The publish is refused: ${prepared.violations.map((one) => one.code).join(", ")}`,
			);

		const aligned = adoptedIdentityRows(draft.identities, input.modules);
		if (!aligned.ok) throw new Error(`No real id at ${aligned.at}.`);
		const identity = targetWireIdentity(aligned.rows);
		const first = JSON.stringify(
			expandDoc(birth, {
				identity,
				assets: prepared.prepared.assets,
				attachmentTarget: prepared.prepared.attachmentTarget,
				...(prepared.prepared.lookupNaming !== undefined && {
					lookupNaming: prepared.prepared.lookupNaming,
				}),
			}),
		);
		expect(adopted.doc).toBe(birth);
		expect(adopted.lookupNaming).toBeDefined();
		expect(JSON.stringify(expandDoc(birth, { identity, ...adopted }))).toBe(
			first,
		);
		// The body names each file at the path the deployment keeps for it.
		for (const path of heldMediaPaths.values())
			expect(first).toContain(`jr://file/${path}`);
		expect(PICTURES.every((id) => heldMediaPaths.has(id))).toBe(true);
	});
});
