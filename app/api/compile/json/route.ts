import { type NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/apiError";
import { expandDoc } from "@/lib/commcare/expander";
import {
	buildHqJsonExportArchive,
	hqImportFileGuide,
} from "@/lib/commcare/multimedia/hqJsonExportArchive";
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
import {
	encodeManualImportGuide,
	MANUAL_IMPORT_GUIDE_HEADER,
	renderManualImportGuide,
} from "@/lib/publish/manualImportGuide";
import { sanitizeFilename } from "@/lib/utils/sanitize";
import { prepareCompileRequest } from "../prepareCompileRequest";

/**
 * HQ import file endpoint: the manual-import twin of the HQ-upload path,
 * for people who import into CommCare HQ themselves rather than through an
 * API key. Shares the auth + parse + boundary-gate + manifest preamble with
 * the `.ccz` twin via `prepareCompileRequest`, then always answers a ZIP:
 * the app JSON, the HQ bulk-upload `multimedia.zip` and the fixture workbook
 * when the app has them, and a `README.txt` that is the rendered
 * manual-import guide. The guide's steps also ride the
 * `X-Nova-Manual-Import-Guide` header, so the publish dialog shows exactly
 * what the README says once the file has arrived.
 *
 * The file is made for no project space: it carries derived ids and no
 * runtime URL, because CommCare HQ writes its own when it builds the app, and
 * a `domain` in the request is refused. A reached deployment on the chosen
 * server scopes only its attachment links.
 *
 * The workbook is the SAME artifact the direct upload pushes through CommCare
 * HQ's fixture API, built from the generation the boundary validated, so a
 * hand-imported app carries the data an API-uploaded one gets.
 */
export async function POST(req: NextRequest) {
	try {
		const {
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
		// media-free app expands media-OFF so its JSON never depends on an
		// empty manifest reducing to the same shape.
		const hasMedia = assets.size > 0;
		const hqJson = expandDoc(doc, {
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

		// The RAW name goes to the builder and the guide: the archive's
		// Unicode-safe member sanitizer keeps non-Latin and accented names
		// intact inside the ZIP, and the README names that same member.
		const guide = hqImportFileGuide({
			appName: doc.appName,
			doc,
			assets,
			lookupWorkbook,
		});
		const archive = buildHqJsonExportArchive(
			doc.appName,
			hqJson,
			assets,
			lookupWorkbook,
			renderManualImportGuide(guide),
		);
		// The archive is the artifact the person hands to HQ, and HQ's importer
		// owns its version slots. The blueprint's `mutation_seq` rides
		// out-of-band in the `X-Compiled-At-Seq` response header so the export
		// still names its document version without perturbing the body.
		return new NextResponse(new Uint8Array(archive), {
			headers: {
				"Content-Type": "application/zip",
				"Content-Disposition": `attachment; filename="${appName}.zip"`,
				"X-Compiled-At-Seq": String(compiledAtSeq),
				[PROJECT_SPACE_COMPATIBILITY_REPORT_HEADER]:
					projectSpaceCompatibilityHeader,
				[EXPORT_ADVISORY_HEADER]: advisoryHeader,
				[MANUAL_IMPORT_GUIDE_HEADER]: encodeManualImportGuide(guide),
			},
		});
	} catch (err) {
		return handleApiError(
			err instanceof Error ? err : new Error("JSON export failed"),
		);
	}
}
