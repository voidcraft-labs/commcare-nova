// lib/commcare/multimedia/hqJsonExportArchive.ts
//
// Assembles the HQ import file: always a ZIP. CommCare HQ has no single
// import that takes an app together with the things it depends on: media is
// a second manual step and lookup data is a third. So the archive mirrors
// that shape: the app JSON (carrying its `jr://file/commcare/<hash><ext>`
// references), the HQ bulk-upload `multimedia.zip` holding the bytes those
// references resolve to, the fixture workbook holding the lookup tables the
// app reads, and a README that walks a person through the steps that apply.
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
import {
	MANUAL_IMPORT_LOOKUP_WORKBOOK,
	MANUAL_IMPORT_MEDIA_ZIP,
	type ManualImportStep,
	manualImportGuide,
} from "@/lib/publish/manualImportGuide";
import { sanitizeArchiveMemberName } from "@/lib/utils/sanitize";
import type { LookupWorkbook } from "../lookup/workbook";
import { requiredProjectSpaceCapabilities } from "../projectSpaceCompatibility";
import type { HqApplication } from "../types";
import { COMMCARE_VERSION_FLOOR } from "../versionFloor";
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
 * The manual-import steps for this file, from the same derivations a
 * publish's own checks read: the capabilities the document needs, the
 * workbook's tables and the prepared media.
 */
export function hqImportFileGuide(input: {
	readonly appName: string;
	readonly doc: Parameters<typeof requiredProjectSpaceCapabilities>[0];
	readonly assets: AssetManifest;
	readonly lookupWorkbook: LookupWorkbook | undefined;
}): readonly ManualImportStep[] {
	return manualImportGuide({
		appFileName: appFileName(input.appName),
		lookupTags: input.lookupWorkbook?.tables.map((table) => table.tag) ?? [],
		hasMedia: input.assets.size > 0,
		versionFloor: `${COMMCARE_VERSION_FLOOR.major}.${COMMCARE_VERSION_FLOOR.minor}`,
		capabilities: requiredProjectSpaceCapabilities(input.doc).map(
			({ label, reasons }) => ({ label, reasons }),
		),
		planFeatures: [],
		logo: null,
		readsLocations: false,
		sendsToConnect: false,
	});
}

/**
 * Build the `<app>.zip`: the app JSON, the HQ bulk-upload `multimedia.zip`
 * when the app has media, the fixture workbook when it reads lookup tables,
 * and `README.txt`, the rendered guide its caller derived with
 * `hqImportFileGuide` over the same inputs.
 *
 * The JSON is pretty-printed: it lands as a file a person may open. The
 * `multimedia.zip` IS CommCare HQ's bulk-upload format (each entry at the
 * asset's bare `commcare/<hash><ext>` wire path), built by the one shared
 * `buildMediaBulkUploadZip` so a manual import and an API upload speak one
 * format. The caller resolves the manifest `withBytes: true` first: every
 * entry must carry its bytes or `buildMediaBulkUploadZip` throws. The workbook
 * arrives already built, from the same validated lookup generation the export
 * boundary measured.
 */
export function buildHqJsonExportArchive(
	appName: string,
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
	if (assets.size > 0) {
		bundle.addFile(MANUAL_IMPORT_MEDIA_ZIP, buildMediaBulkUploadZip(assets));
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
