import { type NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/apiError";
import { expandDoc } from "@/lib/commcare/expander";
import { buildHqJsonExportArchive } from "@/lib/commcare/multimedia/hqJsonExportArchive";
import {
	encodeProjectSpaceCompatibilityReport,
	PROJECT_SPACE_COMPATIBILITY_REPORT_HEADER,
	projectSpaceCompatibilityForDownload,
} from "@/lib/commcare/projectSpaceCompatibility";
import {
	EXPORT_ADVISORY_HEADER,
	encodeExportAdvisories,
	exportAdvisories,
} from "@/lib/publish/exportAdvisories";
import { sanitizeFilename } from "@/lib/utils/sanitize";
import { prepareCompileRequest } from "../prepareCompileRequest";

/**
 * HQ-JSON export endpoint: the manual-import twin of the HQ-upload path,
 * for users who import into CommCare HQ themselves rather than via an API key.
 * Shares the auth + parse + boundary-gate + manifest preamble with the `.ccz`
 * twin via `prepareCompileRequest`, then branches on whether the app depends on
 * anything CommCare HQ imports separately:
 *
 *   - App on its own → a plain `<app>.json` (import via HQ → Settings →
 *     Import App from Another Server). Byte-identical to the pre-media output:
 *     a media-free app expands media-OFF (no manifest) so its JSON never
 *     depends on an empty manifest reducing to the same shape.
 *   - App with media or lookup tables → a `<app>.zip` bundling the JSON with
 *     the HQ bulk-upload `multimedia.zip`, the fixture workbook, and a README
 *     covering the steps that apply, assembled by the shared
 *     `buildHqJsonExportArchive` so this download and the MCP `compile_app`
 *     json tool ship one format.
 *
 * The workbook is the SAME artifact the direct upload pushes through CommCare
 * HQ's fixture API, built from the generation the boundary validated, so a
 * hand-imported app carries the data an API-uploaded one gets.
 */
export async function POST(req: NextRequest) {
	try {
		const {
			runtimeTarget,
			doc,
			assets,
			compiledAtSeq,
			attachmentTarget,
			attachmentTargetState,
			lookupNaming,
			lookupWorkbook,
		} = await prepareCompileRequest(req, {
			boundaryErrorVerb: "export",
			mode: "hq-json",
		});

		// Only a media-bearing app passes the manifest to `expandDoc`; a
		// media-free app expands media-OFF so its JSON stays byte-identical to
		// the pre-media output.
		const hasMedia = assets.size > 0;
		const hqJson = expandDoc(doc, {
			runtimeTarget,
			attachmentTarget,
			...(hasMedia && { assets }),
			...(lookupNaming && { lookupNaming }),
		});
		// ASCII-safe name for the `Content-Disposition` HEADER (a Latin-1
		// ByteString: non-ASCII would throw in the `Headers` constructor). The
		// ZIP's internal member name is sanitized separately inside the builder
		// and keeps Unicode, so the download filename can be ASCII while the
		// member preserves the app's real name.
		const appName = sanitizeFilename(doc.appName);
		const projectSpaceCompatibilityHeader =
			encodeProjectSpaceCompatibilityReport(
				projectSpaceCompatibilityForDownload(doc),
			);
		// The import file is complete and correct; the advisories say what it
		// could not carry, so they ride beside it rather than replacing it.
		const advisoryHeader = encodeExportAdvisories(
			exportAdvisories(doc, attachmentTargetState),
		);

		// The HQ-import body (plain JSON, or the zip bundle) stays byte-identical:
		// it's the artifact the user hands to HQ, and HQ's importer owns its
		// version slots. The blueprint's `mutation_seq` rides out-of-band in the
		// `X-Compiled-At-Seq` response header so the export still names its
		// document version without perturbing the body.
		if (!hasMedia && lookupWorkbook === undefined) {
			// Nothing to carry alongside: the plain JSON file.
			return new NextResponse(JSON.stringify(hqJson, null, 2), {
				headers: {
					"Content-Type": "application/json",
					"Content-Disposition": `attachment; filename="${appName}.json"`,
					"X-Compiled-At-Seq": String(compiledAtSeq),
					[PROJECT_SPACE_COMPATIBILITY_REPORT_HEADER]:
						projectSpaceCompatibilityHeader,
					[EXPORT_ADVISORY_HEADER]: advisoryHeader,
				},
			});
		}

		// Companions present: the json + whichever of the HQ-format multimedia
		// zip and the fixture workbook this app needs + the import README.
		// Pass the RAW name: the builder's Unicode-safe member sanitizer keeps
		// non-Latin/accented names intact inside the archive.
		const archive = buildHqJsonExportArchive(
			doc.appName,
			hqJson,
			assets,
			lookupWorkbook,
		);
		return new NextResponse(new Uint8Array(archive), {
			headers: {
				"Content-Type": "application/zip",
				"Content-Disposition": `attachment; filename="${appName}.zip"`,
				"X-Compiled-At-Seq": String(compiledAtSeq),
				[PROJECT_SPACE_COMPATIBILITY_REPORT_HEADER]:
					projectSpaceCompatibilityHeader,
				[EXPORT_ADVISORY_HEADER]: advisoryHeader,
			},
		});
	} catch (err) {
		return handleApiError(
			err instanceof Error ? err : new Error("JSON export failed"),
		);
	}
}
