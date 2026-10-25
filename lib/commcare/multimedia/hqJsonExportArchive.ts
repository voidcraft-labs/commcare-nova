// lib/commcare/multimedia/hqJsonExportArchive.ts
//
// Assembles the HQ import file: always a ZIP. CommCare HQ has no single
// import that takes an app together with the things it depends on: media is
// a second manual step and lookup data is a third. So the archive mirrors
// that shape: the app JSON (carrying its `jr://file/commcare/<hash><ext>`
// references), the HQ bulk-upload `multimedia.zip` holding the bytes those
// references resolve to, the app's logo as `logo<ext>`, the fixture workbook
// holding the lookup tables the app reads, and a README that walks a person
// through the steps that apply.
//
// The app JSON carries no `logo_refs`, and HQ's bulk upload maps no
// app-level media (`hqmedia/models.py::ApplicationMediaMixin.all_media`), so
// the logo's file rides beside `multimedia.zip` for a person to add in the
// app's settings, and `multimedia.zip` leaves out a file only the logo uses,
// by the filter the direct upload uses (`bulkUploadAssets`).
//
// The README is the rendered manual-import guide (`lib/publish/manualImportGuide.ts`),
// which always holds at least the CommCare version step, so every app's file
// carries one. Each companion appears only when the app has one, so a README
// never lists a step for a file that is not in the archive.
//
// The direct-upload path pushes the SAME workbook through CommCare HQ's fixture
// API before it imports the app (`lib/deployment/service.ts`), so a hand-imported
// app and an API-uploaded one land the same data on the project space.
//
// One builder, two callers: the HTTP download (`app/api/compile/json`) and the
// MCP `compile_app` json tool both ship THIS archive with the guide
// `hqImportFileGuide` derives, so the manual-import and programmatic surfaces
// can't drift in format or in what they tell a person. It is pure assembly
// over already-resolved inputs: no Postgres and no expand.

import AdmZip from "adm-zip";
import { type BlueprintDoc, declaresWebApps } from "@/lib/domain";
import { carriesViaBulkUpload, walkAssetRefs } from "@/lib/domain/mediaRefs";
import {
	MANUAL_IMPORT_LOOKUP_WORKBOOK,
	MANUAL_IMPORT_MEDIA_ZIP,
	type ManualImportStep,
	manualImportGuide,
} from "@/lib/publish/manualImportGuide";
import { sanitizeArchiveMemberName } from "@/lib/utils/sanitize";
import { appEmitsConnectBlocks } from "../connectSlugs";
import { distanceSearchProperties } from "../distanceSearches";
import { readsLocationsFixture } from "../locations/readsLocationsFixture";
import type { LookupWorkbook } from "../lookup/workbook";
import { formEntrySyncReasons, requiredPlanFeatures } from "../planPrivileges";
import { requiredProjectSpaceCapabilities } from "../projectSpaceCompatibility";
import type { HqApplication } from "../types";
import { COMMCARE_VERSION_FLOOR } from "../versionFloor";
import type { AttachmentUrlTarget } from "../xform/captureUrlNode";
import type { AssetManifest } from "./assetWirePath";
import { buildMediaBulkUploadZip } from "./bulkUploadZip";

/**
 * The app JSON's member name, without its extension.
 *
 * Sanitized here, at the archive boundary, so the member is always a safe
 * relative leaf whichever caller arrives: `appName` is an owner-controlled
 * string the blueprint schema leaves unconstrained, so a name carrying `/`,
 * `\`, `:`, CR/LF, or `..` segments would otherwise become the ZIP entry
 * path a downstream extractor trusts. The archive-member sanitizer, not
 * `sanitizeFilename`: a ZIP member is UTF-8, so a non-Latin or accented app
 * name (`调查表`, `Café Survey`) keeps its identity here, while the HTTP
 * route's separate `Content-Disposition` filename stays ASCII.
 */
function appFileName(appName: string): string {
	return sanitizeArchiveMemberName(appName);
}

/**
 * The assets HQ's bulk upload carries: each one some carrier that rides the
 * upload references (`lib/domain/mediaRefs.ts::carriesViaBulkUpload`). An
 * image only the logo uses is left out; one the logo shares with a question
 * stays, for the question. The direct upload's ZIP and the import file's
 * `multimedia.zip` both read this filter.
 */
export function bulkUploadAssets(
	doc: BlueprintDoc,
	assets: AssetManifest,
): AssetManifest {
	const carried = new Set<string>();
	for (const ref of walkAssetRefs(doc)) {
		if (carriesViaBulkUpload(ref.location)) carried.add(ref.assetId);
	}
	return new Map([...assets].filter(([assetId]) => carried.has(assetId)));
}

/** The logo's file as the import file holds it, `logo<ext>`, or `undefined`
 * for an app with no logo. */
function logoMember(
	doc: BlueprintDoc,
	assets: AssetManifest,
): { readonly name: string; readonly bytes: Buffer | undefined } | undefined {
	const logo = doc.logo === undefined ? undefined : assets.get(doc.logo);
	if (logo === undefined) return undefined;
	return { name: `logo${logo.extension}`, bytes: logo.bytes };
}

/**
 * The manual-import steps for this file, from the same derivations a
 * publish's own checks read: the capabilities and plan features the document
 * needs, the workbook's tables, the media the bulk upload carries, the logo,
 * whether the app runs in Web Apps, whether the app reads places, whether it sends forms to CommCare Connect,
 * whether a publish would ask that sync on form entry is off, and the properties its searches measure distance on. An import file has no target and sends no places.
 */
export function hqImportFileGuide(input: {
	readonly appName: string;
	readonly doc: BlueprintDoc;
	readonly assets: AssetManifest;
	readonly lookupWorkbook: LookupWorkbook | undefined;
	/** The target the app JSON beside it was written for (`expandDoc`'s). */
	readonly attachmentTarget: AttachmentUrlTarget | null;
}): readonly ManualImportStep[] {
	const logo = logoMember(input.doc, input.assets);
	return manualImportGuide({
		appFileName: appFileName(input.appName),
		lookupTags: input.lookupWorkbook?.tables.map((table) => table.tag) ?? [],
		hasMedia: bulkUploadAssets(input.doc, input.assets).size > 0,
		versionFloor: `${COMMCARE_VERSION_FLOOR.major}.${COMMCARE_VERSION_FLOOR.minor}`,
		capabilities: requiredProjectSpaceCapabilities(input.doc).map(
			({ label, reasons }) => ({ label, reasons }),
		),
		planFeatures: requiredPlanFeatures(
			input.doc,
			{ lookupTables: input.lookupWorkbook !== undefined, places: false },
			input.attachmentTarget,
		).map(({ label, plans, consequence }) => ({ label, plans, consequence })),
		logo: logo === undefined ? null : { fileName: logo.name },
		runsInWebApps: declaresWebApps(input.doc),
		readsLocations: readsLocationsFixture(input.doc),
		sendsToConnect: appEmitsConnectBlocks(input.doc),
		formEntrySync: formEntrySyncReasons(input.doc).length > 0,
		distanceSearches: distanceSearchProperties(input.doc),
	});
}

/**
 * Build the `<app>.zip`: the app JSON, the HQ bulk-upload `multimedia.zip`
 * when the bulk upload carries any media, the logo as `logo<ext>` when the
 * app has one, the fixture workbook when it reads lookup tables, and
 * `README.txt`, the rendered guide its caller derived with
 * `hqImportFileGuide` over the same inputs.
 *
 * The JSON is pretty-printed: it lands as a file a person may open. The
 * `multimedia.zip` IS CommCare HQ's bulk-upload format (each entry at the
 * asset's bare `commcare/<hash><ext>` wire path), built by the one shared
 * `buildMediaBulkUploadZip` over `bulkUploadAssets`, so a manual import and
 * an API upload speak one format. The caller resolves the manifest
 * `withBytes: true` first: every entry must carry its bytes or
 * `buildMediaBulkUploadZip` throws. The workbook arrives already built, from
 * the same validated lookup generation the export boundary measured.
 */
export function buildHqJsonExportArchive(
	appName: string,
	doc: BlueprintDoc,
	hqJson: HqApplication,
	assets: AssetManifest,
	lookupWorkbook: LookupWorkbook | undefined,
	readme: string,
): Buffer {
	const bundle = new AdmZip();
	bundle.addFile(
		`${appFileName(appName)}.json`,
		Buffer.from(JSON.stringify(hqJson, null, 2), "utf-8"),
	);
	const bulk = bulkUploadAssets(doc, assets);
	if (bulk.size > 0) {
		bundle.addFile(MANUAL_IMPORT_MEDIA_ZIP, buildMediaBulkUploadZip(bulk));
	}
	const logo = logoMember(doc, assets);
	if (logo !== undefined) {
		if (logo.bytes === undefined) {
			throw new Error(
				`The HQ import file needs the logo's bytes, but "${logo.name}" arrived without any. ` +
					"Resolve the manifest with `withBytes: true` before building the import file.",
			);
		}
		bundle.addFile(logo.name, logo.bytes);
	}
	if (lookupWorkbook !== undefined) {
		bundle.addFile(
			MANUAL_IMPORT_LOOKUP_WORKBOOK,
			Buffer.from(lookupWorkbook.bytes),
		);
	}
	bundle.addFile("README.txt", Buffer.from(readme, "utf-8"));
	return bundle.toBuffer();
}
