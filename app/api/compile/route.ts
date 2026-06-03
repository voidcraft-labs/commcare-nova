import { type NextRequest, NextResponse } from "next/server";
import { ApiError, handleApiError } from "@/lib/apiError";
import { requireSession } from "@/lib/auth-utils";
import { compileCcz } from "@/lib/commcare/compiler";
import { expandDoc } from "@/lib/commcare/expander";
import { errorToString } from "@/lib/commcare/validator/errors";
import { rebuildFieldParent } from "@/lib/doc/fieldParent";
import { blueprintDocSchema } from "@/lib/domain";
import { resolveMediaManifest } from "@/lib/media/manifest";
import { collectMediaValidationErrors } from "@/lib/media/mediaValidation";
import { sanitizeFilename } from "@/lib/utils/sanitize";

/**
 * CCZ compile endpoint — the binary twin of `/api/compile/json`.
 *
 * Accepts the normalized `BlueprintDoc` in the body, expands it to HQ JSON via
 * `expandDoc`, packages it with `compileCcz`, and returns the `.ccz` archive
 * bytes directly as the response body. Returning the bytes inline (rather than
 * persisting them and handing back a download URL) means there is no
 * server-side artifact to store, secure, or reap — and nothing that can go
 * missing when a follow-up download request lands on a different Cloud Run
 * instance than the one that compiled it. Success comes back as
 * `application/octet-stream`; every failure comes back as JSON, so the client
 * branches on `res.ok` exactly as the JSON-export twin does.
 */
export async function POST(req: NextRequest) {
	try {
		const session = await requireSession(req);
		const body = await req.json();
		const { doc } = body;

		if (!doc) {
			throw new ApiError("doc is required", 400);
		}

		const parsedDoc = blueprintDocSchema.safeParse(doc);
		if (!parsedDoc.success) {
			throw new ApiError(
				"Invalid doc",
				400,
				parsedDoc.error.issues.map((e) => `${e.path.join(".")}: ${e.message}`),
			);
		}

		// `fieldParent` is derived, not persisted; rebuild it from
		// `moduleOrder`/`formOrder`/`fieldOrder` before `expandDoc` can
		// walk the doc.
		const docWithParent = { ...parsedDoc.data, fieldParent: {} };
		rebuildFieldParent(docWithParent);

		// This path is media-ON (the archive bundles media bytes), so a
		// stale media reference (deleted, still-uploading, foreign-owned,
		// or kind-mismatched asset) would make `expandDoc` throw
		// `requireAssetRef` → opaque 500. Run the media rules first and
		// surface the actionable message instead. Scoped to media-category
		// errors so a previously-working non-media compile isn't newly
		// blocked (this path historically ran only schema parse).
		const mediaErrors = await collectMediaValidationErrors(
			docWithParent,
			session.user.id,
		);
		if (mediaErrors.length > 0) {
			throw new ApiError(
				"This app references media that isn't ready to compile.",
				400,
				mediaErrors.map(errorToString),
			);
		}

		// Resolve the media manifest (rows + bytes) for this owner, then
		// expand + compile with it so the XForms, suite, and profile carry
		// the media references and the archive bundles the files. A
		// media-free doc resolves to an empty manifest (no I/O) and the
		// archive carries no media artifacts.
		const assets = await resolveMediaManifest(docWithParent, session.user.id, {
			withBytes: true,
		});
		const hqJson = expandDoc(docWithParent, { assets });

		const buffer = compileCcz(hqJson, doc.appName, docWithParent, { assets });

		// Stream the freshly-built archive straight back to the caller. The
		// download filename is sanitized because `appName` is user-controlled
		// and flows into a response header (`Content-Disposition`).
		const appName = sanitizeFilename(docWithParent.appName);
		return new NextResponse(new Uint8Array(buffer), {
			headers: {
				"Content-Type": "application/octet-stream",
				"Content-Disposition": `attachment; filename="${appName}.ccz"`,
				"Content-Length": buffer.length.toString(),
			},
		});
	} catch (err) {
		// `ApiError`s carry their own status/details; any other throw is logged
		// server-side and returned as a generic 500 by `handleApiError` (no
		// internal paths or library details leak to the client).
		return handleApiError(
			err instanceof Error ? err : new Error("CCZ compilation failed"),
		);
	}
}
