// lib/commcare/multimedia/hqJsonExportArchive.ts
//
// Assembles the HQ-importable archive Nova hands back when an exported app
// needs more than its own JSON. CommCare HQ has no single import that takes an
// app together with the things it depends on: media is a second manual step and
// lookup data is a third. So the archive mirrors that shape — the app JSON
// (carrying its `jr://file/commcare/<hash><ext>` references), the HQ bulk-upload
// `multimedia.zip` holding the bytes those references resolve to, the fixture
// workbook holding the lookup tables the app reads, and a README that walks a
// human through the steps that apply.
//
// Each companion appears only when the app has one, so a media-free app with
// lookup tables ships exactly two files and instructions for two steps rather
// than an empty ZIP and a paragraph about nothing. An app that needs neither
// never reaches this builder at all: its caller ships the bare JSON.
//
// The direct-upload path pushes the SAME workbook through CommCare HQ's fixture
// API before it imports the app (`lib/deployment/service.ts`), so a hand-imported
// app and an API-uploaded one land the same data on the project space.
//
// One builder, two callers: the HTTP download (`app/api/compile/json`) and the
// MCP `compile_app` json tool both ship THIS archive, so the manual-import and
// programmatic surfaces can't drift in format. It is pure assembly over
// already-resolved inputs — no Postgres, no expand — and depends only on this
// package's `bulkUploadZip` plus the `HqApplication` / `AssetManifest` types (no
// `lib/media` import), so it sits inside the CommCare emission boundary
// alongside its sibling wire builders.

import AdmZip from "adm-zip";
import { sanitizeArchiveMemberName } from "@/lib/utils/sanitize";
import type { LookupWorkbook } from "../lookup/workbook";
import type { HqApplication } from "../types";
import type { AssetManifest } from "./assetWirePath";
import { buildMediaBulkUploadZip } from "./bulkUploadZip";

/** The workbook member's name, and what the README tells a human to upload. */
const LOOKUP_WORKBOOK_MEMBER = "lookup-tables.xlsx";

/**
 * Build the `<app>.zip` bundle for an export that carries companions: the app
 * JSON, the HQ bulk-upload `multimedia.zip` when the app has media, the fixture
 * workbook when it reads lookup tables, and a README covering exactly the steps
 * those companions call for.
 *
 * The JSON is pretty-printed — it lands as a file a person may open. The
 * `multimedia.zip` IS CommCare HQ's bulk-upload format (each entry at the
 * asset's bare `commcare/<hash><ext>` wire path), built by the one shared
 * `buildMediaBulkUploadZip` so a manual import and an API upload speak one
 * format. The caller resolves the manifest `withBytes: true` first — every
 * entry must carry its bytes or `buildMediaBulkUploadZip` throws. The workbook
 * arrives already built, from the same validated lookup generation the export
 * boundary measured.
 */
export function buildHqJsonExportArchive(
	appName: string,
	hqJson: HqApplication,
	assets: AssetManifest,
	lookupWorkbook?: LookupWorkbook,
): Buffer {
	// Sanitize HERE, at the archive boundary, so the `<app>.json` member is
	// always a safe relative leaf no matter which caller arrives — `appName` is
	// an owner-controlled string the blueprint schema leaves unconstrained, so a
	// name carrying `/`, `\`, `:`, CR/LF, or `..` segments would otherwise become
	// the ZIP entry path a downstream extractor trusts. Use the archive-member
	// sanitizer (NOT `sanitizeFilename`): a ZIP member is UTF-8, so a non-Latin
	// or accented app name (`调查表`, `Café Survey`) keeps its identity here,
	// while the HTTP route's separate `Content-Disposition` filename stays ASCII.
	// The README's filename references use the same safe name so its
	// instructions match the actual member.
	const safeName = sanitizeArchiveMemberName(appName);
	const hasMedia = assets.size > 0;
	const bundle = new AdmZip();
	bundle.addFile(
		`${safeName}.json`,
		Buffer.from(JSON.stringify(hqJson, null, 2), "utf-8"),
	);
	if (hasMedia) {
		bundle.addFile("multimedia.zip", buildMediaBulkUploadZip(assets));
	}
	if (lookupWorkbook !== undefined) {
		bundle.addFile(LOOKUP_WORKBOOK_MEMBER, Buffer.from(lookupWorkbook.bytes));
	}
	bundle.addFile(
		"README.txt",
		Buffer.from(importReadme(safeName, { hasMedia, lookupWorkbook }), "utf-8"),
	);
	return bundle.toBuffer();
}

/**
 * The manual-import instructions bundled into the export.
 *
 * Numbered for the companions this archive actually carries, because a README
 * that lists a step for a file that isn't there sends somebody looking for it.
 * Lookup tables go FIRST, matching the order the direct upload uses, so the
 * app finds its data the moment CommCare HQ builds it.
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
 *
 * The lookup step names the page rather than the upload URL because
 * `fixtures/urls.py` answers a GET to `edit_lookup_tables/upload/` with a
 * redirect back to the table list — the upload form lives on the list page
 * (`templates/fixtures/manage_tables.html`), and so does the "Replace existing
 * tables" box that makes CommCare HQ's copy match Nova's.
 */
function importReadme(
	appName: string,
	companions: {
		readonly hasMedia: boolean;
		readonly lookupWorkbook: LookupWorkbook | undefined;
	},
): string {
	const { hasMedia, lookupWorkbook } = companions;
	const files = [
		`  - ${appName}.json   the application`,
		...(lookupWorkbook === undefined
			? []
			: [`  - ${LOOKUP_WORKBOOK_MEMBER}   its lookup tables`]),
		...(hasMedia
			? ["  - multimedia.zip    its media (CommCare bulk-upload format)"]
			: []),
	];
	const steps: string[][] = [];

	if (lookupWorkbook !== undefined) {
		const tags = lookupWorkbook.tables.map((table) => table.tag).join(", ");
		steps.push([
			"Open the Lookup Tables page in CommCare HQ:",
			"  https://www.commcarehq.org/a/<your-project>/fixtures/",
			"",
			`Upload "${LOOKUP_WORKBOOK_MEMBER}" there, tick "Replace existing`,
			"tables\", and click Upload Tables. Replacing makes CommCare's copy of",
			"each table in the file match this export exactly. Tables the file",
			"doesn't mention are left alone.",
			"",
			`The file carries ${tags}. If your project already has a table with one`,
			"of those names, uploading replaces its rows.",
		]);
	}

	steps.push([
		"In CommCare HQ, open the Settings (gear) menu -> Project Settings ->",
		"Import App from Another Server:",
		"  https://www.commcarehq.org/a/<your-project>/settings/project/import_app/",
		"",
		"This is the only place CommCare's UI lets you upload an app's JSON. The",
		"first screen asks for an 'App URL' from another server, but it only",
		"checks the URL's shape and that the server differs from yours, it never",
		"opens the link. Paste this exact dummy URL and click Next:",
		"",
		"  https://india.commcarehq.org/a/x/apps/view/00000000000000000000000000000000/",
		"",
		"(If your CommCare instance IS the India server, change 'india' to 'www'.",
		" The only rule: the subdomain must be www, india, or eu, and not yours.)",
		"",
		`On the next screen, upload "${appName}.json", name the app, and import.`,
	]);

	if (hasMedia) {
		steps.push([
			"After the app imports, CommCare shows an instructions page with a link to",
			'your new app\'s multimedia upload. Open it and upload "multimedia.zip".',
			"The files are named by content hash and match the app's references",
			"automatically, so they attach to the right places.",
		]);
	}

	const titles = [
		...(lookupWorkbook === undefined ? [] : ["Upload the lookup tables"]),
		"Import the app",
		...(hasMedia ? ["Import the media"] : []),
	];

	return [
		`${appName}. Exported from Nova for CommCare HQ`,
		"",
		`This archive has ${files.length === 2 ? "two" : "three"} files to load into CommCare HQ:`,
		...files,
		"",
		...steps.flatMap((body, index) => [
			`=== ${index + 1}. ${titles[index]} ===`,
			"",
			...body,
			"",
		]),
	].join("\n");
}
