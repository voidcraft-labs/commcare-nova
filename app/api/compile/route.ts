import { type NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/apiError";
import { compileCcz } from "@/lib/commcare/compiler";
import { expandDoc } from "@/lib/commcare/expander";
import { sanitizeFilename } from "@/lib/utils/sanitize";
import { prepareCompileRequest } from "./prepareCompileRequest";

/**
 * CCZ compile endpoint — the binary twin of `/api/compile/json`.
 *
 * Shares the auth + parse + boundary-gate + manifest preamble with the JSON twin
 * via `prepareCompileRequest`, then expands the doc to HQ JSON, packages it with
 * `compileCcz`, and returns the `.ccz` archive bytes directly as the response
 * body. Returning the bytes inline (rather than persisting them and handing back
 * a download URL) means there is no server-side artifact to store, secure, or
 * reap — and nothing that can go missing when a follow-up download request lands
 * on a different Cloud Run instance than the one that compiled it. Success comes
 * back as `application/octet-stream`; every failure throws an `ApiError` that
 * `handleApiError` renders as JSON, so the client branches on `res.ok` exactly
 * as the JSON-export twin does.
 */
export async function POST(req: NextRequest) {
	try {
		const { doc, assets } = await prepareCompileRequest(req, {
			boundaryErrorVerb: "compile",
		});

		// Compile is always media-ON — the archive bundles whatever the manifest
		// resolved (an empty manifest simply emits no media artifacts).
		const hqJson = expandDoc(doc, { assets });
		const buffer = compileCcz(hqJson, doc.appName, doc, { assets });

		// Stream the freshly-built archive straight back to the caller. The
		// download filename is sanitized because `appName` is user-controlled
		// and flows into a response header (`Content-Disposition`).
		const appName = sanitizeFilename(doc.appName);
		return new NextResponse(new Uint8Array(buffer), {
			headers: {
				"Content-Type": "application/octet-stream",
				"Content-Disposition": `attachment; filename="${appName}.ccz"`,
				"Content-Length": buffer.length.toString(),
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
