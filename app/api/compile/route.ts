import { type NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/apiError";
import {
	encodeProjectSpaceCompatibilityReport,
	PROJECT_SPACE_COMPATIBILITY_REPORT_HEADER,
	projectSpaceCompatibilityForDownload,
} from "@/lib/commcare/projectSpaceCompatibility";
import { compileLocalArchive } from "@/lib/export/localArchive";
import {
	EXPORT_ADVISORY_HEADER,
	encodeExportAdvisories,
	exportAdvisories,
} from "@/lib/publish/exportAdvisories";
import { sanitizeFilename } from "@/lib/utils/sanitize";
import { prepareCompileRequest } from "./prepareCompileRequest";

/**
 * CCZ compile endpoint: the binary twin of `/api/compile/json`.
 *
 * A `.ccz` is made for one project space this app is published to, named by
 * the optional `server` and `domain` beside the app id, or the only one
 * there is. With none, or with several and no choice, the request is refused
 * with 422 and the project spaces it could name.
 *
 * Shares the auth + parse + boundary-gate + manifest preamble with the JSON twin
 * via `prepareCompileRequest`, then builds the archive with
 * `compileLocalArchive` (the one `.ccz` assembly) and returns its bytes
 * directly as the response body. Returning the bytes inline (rather than persisting them and handing back
 * a download URL) means there is no server-side artifact to store, secure, or
 * reap, and nothing that can go missing when a follow-up download request lands
 * on a different Cloud Run instance than the one that compiled it. Success comes
 * back as `application/octet-stream`; every failure throws an `ApiError` that
 * `handleApiError` renders as JSON, so the client branches on `res.ok` exactly
 * as the JSON-export twin does.
 */
export async function POST(req: NextRequest) {
	try {
		const prepared = await prepareCompileRequest(req, {
			boundaryErrorVerb: "compile",
			mode: "ccz",
		});
		const { doc, download, attachmentTargetState } = prepared;

		// Compile is always media-ON: the archive bundles whatever the manifest
		// resolved (an empty manifest simply emits no media artifacts), embeds
		// the prepared lookup fixtures, and stamps the blueprint's
		// `mutation_seq` into the profile's `cc-content-version` so the archive
		// names the exact document version it was built from. It is made for
		// the one project space the request named: its addresses, its HQ app
		// id and its recorded ids.
		const buffer = compileLocalArchive(
			prepared,
			download.runtimeTarget,
			download.identity,
			download.target,
		);

		// Stream the freshly-built archive straight back to the caller. The
		// download filename is sanitized because `appName` is user-controlled
		// and flows into a response header (`Content-Disposition`).
		const appName = sanitizeFilename(doc.appName);
		const projectSpaceCompatibility = projectSpaceCompatibilityForDownload(doc);
		// The archive is complete and correct; the advisories say what it
		// could not carry, so they ride beside the bytes rather than
		// replacing them.
		const advisories = exportAdvisories(doc, attachmentTargetState);
		return new NextResponse(new Uint8Array(buffer), {
			headers: {
				"Content-Type": "application/octet-stream",
				"Content-Disposition": `attachment; filename="${appName}.ccz"`,
				"Content-Length": buffer.length.toString(),
				[PROJECT_SPACE_COMPATIBILITY_REPORT_HEADER]:
					encodeProjectSpaceCompatibilityReport(projectSpaceCompatibility),
				[EXPORT_ADVISORY_HEADER]: encodeExportAdvisories(advisories),
			},
		});
	} catch (err) {
		// `ApiError`s (from `prepareCompileRequest`) carry their own status +
		// details; any other throw is logged server-side and returned as a
		// generic 500 by `handleApiError` (no internal paths or library details
		// leak to the client).
		return handleApiError(
			err instanceof Error ? err : new Error("CCZ compilation failed"),
		);
	}
}
