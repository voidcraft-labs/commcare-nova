import { type NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/apiError";
import { expandDoc } from "@/lib/commcare/expander";
import { buildHqJsonExportArchive } from "@/lib/commcare/multimedia/hqJsonExportArchive";
import { sanitizeFilename } from "@/lib/utils/sanitize";
import { prepareCompileRequest } from "../prepareCompileRequest";

/**
 * HQ-JSON export endpoint — the manual-import twin of the HQ-upload path,
 * for users who import into CommCare HQ themselves rather than via an API key.
 * Shares the auth + parse + boundary-gate + manifest preamble with the `.ccz`
 * twin via `prepareCompileRequest`, then branches on whether the app has media:
 *
 *   - Media-free app → a plain `<app>.json` (import via HQ → Settings →
 *     Import App from Another Server). Byte-identical to the pre-media output:
 *     a media-free app expands media-OFF (no manifest) so its JSON never
 *     depends on an empty manifest reducing to the same shape.
 *   - App with media → a `<app>.zip` bundling the MEDIA-ON JSON + the HQ
 *     bulk-upload `multimedia.zip` + a README, assembled by the shared
 *     `buildHqJsonExportArchive` so this download and the MCP `compile_app`
 *     json tool ship one format.
 */
export async function POST(req: NextRequest) {
	try {
		const { doc, assets } = await prepareCompileRequest(req, {
			boundaryErrorVerb: "export",
		});

		// Only a media-bearing app passes the manifest to `expandDoc`; a
		// media-free app expands media-OFF so its JSON stays byte-identical to
		// the pre-media output.
		const hasMedia = assets.size > 0;
		const hqJson = expandDoc(doc, hasMedia ? { assets } : {});
		// ASCII-safe name for the `Content-Disposition` HEADER (a Latin-1
		// ByteString — non-ASCII would throw in the `Headers` constructor). The
		// ZIP's internal member name is sanitized separately inside the builder
		// and keeps Unicode, so the download filename can be ASCII while the
		// member preserves the app's real name.
		const appName = sanitizeFilename(doc.appName);

		if (!hasMedia) {
			// Media-free: the plain JSON file.
			return new NextResponse(JSON.stringify(hqJson, null, 2), {
				headers: {
					"Content-Type": "application/json",
					"Content-Disposition": `attachment; filename="${appName}.json"`,
				},
			});
		}

		// Media-ON: the json + HQ-format multimedia zip + import README bundle.
		// Pass the RAW name — the builder's Unicode-safe member sanitizer keeps
		// non-Latin/accented names intact inside the archive.
		const archive = buildHqJsonExportArchive(doc.appName, hqJson, assets);
		return new NextResponse(new Uint8Array(archive), {
			headers: {
				"Content-Type": "application/zip",
				"Content-Disposition": `attachment; filename="${appName}.zip"`,
			},
		});
	} catch (err) {
		return handleApiError(
			err instanceof Error ? err : new Error("JSON export failed"),
		);
	}
}
