/**
 * The capture refuses exactly the documents Nova's export boundary refuses.
 *
 * Contract: for a document and the Project state it carries, the capture's
 * verdict (`exportFindings`, which `capturePublish` and `localCcz` apply)
 * is the verdict of `lib/export/boundaryValidation.ts::prepareExportBoundary`,
 * for the direct HQ upload and for the `.ccz` download. The capture runs
 * the boundary itself over the Project state it holds in place of Nova's
 * database, so the plausible failures are in that state: a stored row the
 * capture builds from something other than the asset (the kind of the
 * slot that shows it, a nominal size), or lookup data read other than as
 * the store reads it. The cases cover each check that reads that state:
 * the media rows, a fixed-place owner, and the tags CommCare HQ's workbook
 * cannot name.
 *
 * The boundary runs as production runs it, with only its reads of Nova's
 * database served from the same Project state: `getLookupFixtureData`
 * returns the requested tables in id order, `loadAssetsByIds` the rows the
 * media store holds for each asset (written here from what each asset is,
 * not from the capture's rows), and `resolveMediaManifest`, reached only
 * once the verdict is in, nothing.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { beforeAll, expect, it, vi } from "vitest";
import { testMediaAssetId, testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import {
	wireRow,
	wireTable,
} from "@/lib/commcare/lookup/__tests__/lookupWireCorpus";
import { loadAssetsByIds, type MediaAssetRecord } from "@/lib/db/mediaAssets";
import { searchLookupMediaDocument } from "@/lib/deployment/__tests__/publishFixtures";
import {
	hydratePersistedBlueprint,
	toPersistableDoc,
} from "@/lib/doc/fieldParent";
import { blueprintDocSchema, proseText } from "@/lib/domain";
import { asMediaAssetId } from "@/lib/domain/multimedia";
import { fixedLocation, term } from "@/lib/domain/predicate";
import { prepareExportBoundary } from "@/lib/export/boundaryValidation";
import { parseLookupRevision } from "@/lib/lookup/schema";
import { getLookupFixtureData } from "@/lib/lookup/service";
import type {
	LookupFixtureDataSnapshot,
	LookupTableDefinition,
} from "@/lib/lookup/types";
import { resolveMediaManifest } from "@/lib/media/manifest";
import {
	type CaptureExportMode,
	capturePublish,
	exportFindings,
	localCcz,
	PROOF_DOMAIN,
	type PublishDocument,
	UnexportableDocumentError,
	type UploadedMedia,
} from "../publish";

vi.mock("@/lib/db/mediaAssets", () => ({ loadAssetsByIds: vi.fn() }));
vi.mock("@/lib/lookup/service", () => ({ getLookupFixtureData: vi.fn() }));
vi.mock("@/lib/media/manifest", () => ({ resolveMediaManifest: vi.fn() }));

const PROJECT = "readiness-project";
const IMAGE_ID = testMediaAssetId("readiness-image");

let png: UploadedMedia;
/** A PCM WAV Nova's upload accepts: a real audio asset. */
let wav: UploadedMedia;
beforeAll(async () => {
	png = {
		kind: "image",
		mimeType: "image/png",
		extension: ".png",
		bytes: await readFile("public/nova-icons/household.png"),
	};
	const bytes = Buffer.alloc(46);
	bytes.write("RIFF");
	bytes.writeUInt32LE(38, 4);
	bytes.write("WAVEfmt ", 8);
	bytes.writeUInt32LE(16, 16);
	bytes.writeUInt16LE(1, 20);
	bytes.writeUInt16LE(1, 22);
	bytes.writeUInt32LE(8000, 24);
	bytes.writeUInt32LE(16000, 28);
	bytes.writeUInt16LE(2, 32);
	bytes.writeUInt16LE(16, 34);
	bytes.write("data", 36);
	bytes.writeUInt32LE(2, 40);
	wav = { kind: "audio", mimeType: "audio/wav", extension: ".wav", bytes };
});

function table(tag: string): LookupTableDefinition {
	return wireTable(tag, [
		{ name: "code", type: "text" },
		{ name: "name", type: "text" },
	]);
}

/** The Search follow-up app over `lookup`, its question image uploaded as `image`. */
function searchApp(
	id: string,
	lookup: LookupTableDefinition,
	image: UploadedMedia,
): PublishDocument {
	return {
		id,
		doc: toPersistableDoc(searchLookupMediaDocument(lookup, IMAGE_ID)),
		compiledAtSeq: 1,
		lookup: {
			projectId: PROJECT,
			projectRevision: parseLookupRevision("4"),
			definitions: [lookup],
			rowsByTable: new Map([
				[lookup.id, [wireRow(lookup, "a", { code: "001", name: "Clinic" })]],
			]),
		},
		media: new Map([[IMAGE_ID, image]]),
	};
}

/** A follow-up form whose case operation sets the owner to one particular place. */
function fixedPlaceOwnerApp(): PublishDocument {
	const doc = buildDoc({
		appName: "Fixed owner",
		caseTypes: [{ name: "patient", properties: [] }],
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						name: "Visit",
						type: "followup",
						fields: [f({ kind: "text", id: "note", label: proseText("Note") })],
					},
				],
			},
		],
	});
	const [moduleUuid] = doc.moduleOrder;
	const formUuid =
		moduleUuid === undefined ? undefined : doc.formOrder[moduleUuid]?.[0];
	const form = formUuid === undefined ? undefined : doc.forms[formUuid];
	if (form === undefined) throw new Error("The app lost its form.");
	form.caseOperations = [
		{
			uuid: testUuid("readiness-owner-operation"),
			id: "set_owner",
			action: "update",
			caseType: "patient",
			target: { kind: "session" },
			owner: term(fixedLocation(testUuid("readiness-place"))),
		},
	];
	return {
		id: "fixed-place-owner",
		doc: toPersistableDoc(doc),
		compiledAtSeq: 1,
	};
}

/** The row Nova's media store holds for an uploaded asset: what the asset is. */
function storedRow(id: string, asset: UploadedMedia): MediaAssetRecord {
	const contentHash = createHash("sha256").update(asset.bytes).digest("hex");
	return {
		id: asMediaAssetId(id),
		project_id: PROJECT,
		owner: "uploader",
		contentHash,
		mimeType: asset.mimeType as MediaAssetRecord["mimeType"],
		extension: asset.extension,
		sizeBytes: asset.bytes.length,
		kind: asset.kind,
		gcsObjectKey: `projects/${PROJECT}/${contentHash}${asset.extension}`,
		originalFilename: `upload${asset.extension}`,
		status: "ready",
		created_at: new Date(0),
	};
}

/** The export boundary's finding codes for the document over the same Project state. */
async function boundaryCodes(
	source: PublishDocument,
	mode: CaptureExportMode,
): Promise<string[]> {
	vi.mocked(getLookupFixtureData).mockImplementation(
		async (scope, tableIds) => {
			expect(scope.projectId).toBe(PROJECT);
			const definitions = (source.lookup?.definitions ?? [])
				.filter((definition) => tableIds.includes(definition.id))
				.sort((left, right) => (left.id < right.id ? -1 : 1));
			return {
				projectId: PROJECT,
				projectRevision: parseLookupRevision("4"),
				definitions,
				rowsByTable: new Map(
					definitions.map((definition) => [
						definition.id,
						source.lookup?.rowsByTable.get(definition.id) ?? [],
					]),
				),
			} satisfies LookupFixtureDataSnapshot;
		},
	);
	vi.mocked(loadAssetsByIds).mockImplementation(async (ids, projectId) => {
		expect(projectId).toBe(PROJECT);
		return ids.flatMap((id) => {
			const asset = source.media?.get(id);
			return asset === undefined ? [] : [storedRow(id, asset)];
		});
	});
	vi.mocked(resolveMediaManifest).mockResolvedValue(new Map());
	const result = await prepareExportBoundary({
		mode,
		access: { projectId: PROJECT, role: "editor", actorUserId: "editor" },
		doc: hydratePersistedBlueprint(blueprintDocSchema.parse(source.doc)),
		compiledAtSeq: source.compiledAtSeq,
		attachmentTarget: null,
	});
	return result.ok
		? []
		: result.violations.map((finding) => finding.code).sort();
}

it.each([
	{
		name: "an app Nova exports both ways",
		source: () => searchApp("accepted", table("facilities"), png),
		refused: { "hq-upload": [], ccz: [] },
	},
	{
		name: "an uploaded audio asset shown as a question's image",
		source: () => searchApp("audio-as-image", table("facilities"), wav),
		refused: {
			"hq-upload": ["MEDIA_KIND_MISMATCH"],
			ccz: ["MEDIA_KIND_MISMATCH"],
		},
	},
	{
		name: "a case owner set to one particular place",
		source: fixedPlaceOwnerApp,
		refused: {
			"hq-upload": ["LOCATION_OWNER_EXPORT_NOT_ACTIVE"],
			ccz: ["LOCATION_OWNER_EXPORT_NOT_ACTIVE"],
		},
	},
	{
		name: "a lookup table tagged with the name of the workbook's own sheet",
		source: () => searchApp("types-tag", table("types"), png),
		refused: { "hq-upload": ["LOOKUP_TAG_RESERVED_BY_HQ"], ccz: [] },
	},
	{
		name: "a lookup table whose tag is longer than a sheet name",
		source: () => searchApp("long-tag", table("t".repeat(32)), png),
		refused: { "hq-upload": ["LOOKUP_TAG_TOO_LONG_FOR_HQ"], ccz: [] },
	},
])(
	"refuses what the export boundary refuses: $name",
	async ({ source, refused }) => {
		const document = source();
		for (const mode of ["hq-upload", "ccz"] as const) {
			const production = await boundaryCodes(document, mode);
			// The case exercises the refusal it names, on production's own boundary.
			expect(production, mode).toEqual(refused[mode]);
			expect(
				(await exportFindings(document, mode))
					.map((finding) => finding.code)
					.sort(),
				mode,
			).toEqual(production);
		}
	},
);

it("stops the publish and the download of a document the boundary refuses, and lets its accepted twin through", async () => {
	const refusedDocument = searchApp("audio-as-image", table("facilities"), wav);
	const configuration = {
		id: "everything",
		flags: ["SYNC_SEARCH_CASE_CLAIM", "VIEW_FORM_ATTACHMENT"],
		caseSearchEnabled: true,
		domain: PROOF_DOMAIN,
	};
	await expect(
		capturePublish({ create: refusedDocument, updates: [], configuration }),
	).rejects.toBeInstanceOf(UnexportableDocumentError);
	await expect(localCcz(refusedDocument, PROOF_DOMAIN)).rejects.toBeInstanceOf(
		UnexportableDocumentError,
	);

	const accepted = searchApp("accepted", table("facilities"), png);
	expect(
		(await capturePublish({ create: accepted, updates: [], configuration }))
			.status,
	).toBe("sent");
	expect((await localCcz(accepted, PROOF_DOMAIN)).length).toBeGreaterThan(0);
});
