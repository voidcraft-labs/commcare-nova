// lib/commcare/multimedia/hqJsonExportArchive.ts
//
// Assembles the HQ-importable archive Nova hands back when an exported app
// carries media. CommCare HQ has no single "app + media" import — it's two
// manual steps — so the archive mirrors that: the MEDIA-ON app JSON (carrying
// the `jr://file/commcare/<hash><ext>` references) next to the HQ bulk-upload
// `multimedia.zip` (the bytes those references resolve to) and a README that
// walks a human through the two-step import.
//
// One builder, two callers: the HTTP download (`app/api/compile/json`) and the
// MCP `compile_app` json tool both ship THIS archive when their app has media,
// so the manual-import and programmatic surfaces can't drift in format. It is
// pure assembly over an already-resolved manifest — no Firestore, no expand —
// and depends only on this package's `bulkUploadZip` plus the `HqApplication` /
// `AssetManifest` types (no `lib/media` import), so it sits inside the CommCare
// emission boundary alongside its sibling wire builders.

import AdmZip from "adm-zip";
import type { HqApplication } from "../types";
import type { AssetManifest } from "./assetWirePath";
import { buildMediaBulkUploadZip } from "./bulkUploadZip";

/**
 * Build the `<app>.zip` bundle for a media-bearing export: the MEDIA-ON app
 * JSON, the HQ bulk-upload `multimedia.zip`, and the import README.
 *
 * The JSON is pretty-printed — it lands as a file a person may open. The
 * `multimedia.zip` IS CommCare HQ's bulk-upload format (each entry at the
 * asset's bare `commcare/<hash><ext>` wire path), built by the one shared
 * `buildMediaBulkUploadZip` so a manual import and an API upload speak one
 * format. The caller resolves the manifest `withBytes: true` first — every
 * entry must carry its bytes or `buildMediaBulkUploadZip` throws.
 */
export function buildHqJsonExportArchive(
	appName: string,
	hqJson: HqApplication,
	assets: AssetManifest,
): Buffer {
	const bundle = new AdmZip();
	bundle.addFile(
		`${appName}.json`,
		Buffer.from(JSON.stringify(hqJson, null, 2), "utf-8"),
	);
	bundle.addFile("multimedia.zip", buildMediaBulkUploadZip(assets));
	bundle.addFile("README.txt", Buffer.from(importReadme(appName), "utf-8"));
	return bundle.toBuffer();
}

/**
 * The manual-import instructions bundled into the media export.
 *
 * The dummy App URL is load-bearing, not a placeholder: CommCare HQ's only
 * UI path to upload an app's JSON is "Import App from Another Server", whose
 * first screen requires a source-app URL. That screen NEVER fetches the URL —
 * it regex-validates the shape and checks the subdomain is a CommCare server
 * other than the current one (`domain/forms.py::ExtractAppInfoForm`:
 * `^https://[^/]+/a/(?P<domain>[^/]+)/apps/view/(?P<app_id>[a-f0-9]{32})/?`
 * plus a `{www|india|eu}.commcarehq.org` subdomain check that must differ from
 * `SERVER_ENVIRONMENT`). So a fixed dummy with a 32-hex app id and the `india`
 * subdomain sails past the gate; the real JSON is uploaded on the next screen.
 */
function importReadme(appName: string): string {
	return [
		`${appName} — exported from Nova for CommCare HQ`,
		"",
		"This archive has two files to load into CommCare HQ:",
		`  - ${appName}.json   the application`,
		"  - multimedia.zip    its media (CommCare bulk-upload format)",
		"",
		"=== 1. Import the app ===",
		"",
		"In CommCare HQ, open the Settings (gear) menu -> Project Settings ->",
		"Import App from Another Server:",
		"  https://www.commcarehq.org/a/<your-project>/settings/project/import_app/",
		"",
		"This is the only place CommCare's UI lets you upload an app's JSON. The",
		"first screen asks for an 'App URL' from another server, but it only",
		"checks the URL's shape and that the server differs from yours — it never",
		"opens the link. Paste this exact dummy URL and click Next:",
		"",
		"  https://india.commcarehq.org/a/x/apps/view/00000000000000000000000000000000/",
		"",
		"(If your CommCare instance IS the India server, change 'india' to 'www'.",
		" The only rule: the subdomain must be www, india, or eu — and not yours.)",
		"",
		`On the next screen, upload "${appName}.json", name the app, and import.`,
		"",
		"=== 2. Import the media ===",
		"",
		"After the app imports, CommCare shows an instructions page with a link to",
		'your new app\'s multimedia upload. Open it and upload "multimedia.zip".',
		"The files are named by content hash and match the app's references",
		"automatically, so they attach to the right places.",
		"",
	].join("\n");
}
