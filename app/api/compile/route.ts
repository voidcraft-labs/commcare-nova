import { randomUUID } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-utils";
import { compileCcz } from "@/lib/commcare/compiler";
import { expandDoc } from "@/lib/commcare/expander";
import { errorToString } from "@/lib/commcare/validator/errors";
import { rebuildFieldParent } from "@/lib/doc/fieldParent";
import { blueprintDocSchema } from "@/lib/domain";
import { log } from "@/lib/logger";
import { resolveMediaManifest } from "@/lib/media/manifest";
import { collectMediaValidationErrors } from "@/lib/media/mediaValidation";
import { saveCcz } from "@/lib/store";

/**
 * CCZ compile endpoint.
 *
 * Accepts the normalized `BlueprintDoc` in the body, expands it to HQ
 * JSON via `expandDoc`, and hands the result to `compileCcz` for
 * packaging. Both the expansion and the compile walk consume the
 * normalized doc directly — no legacy wire-shape conversion survives
 * on this path.
 */
export async function POST(req: NextRequest) {
	try {
		const session = await requireSession(req);
		const body = await req.json();
		const { doc } = body;

		if (!doc) {
			return NextResponse.json({ error: "doc is required" }, { status: 400 });
		}

		const parsedDoc = blueprintDocSchema.safeParse(doc);
		if (!parsedDoc.success) {
			return NextResponse.json(
				{
					error: "Invalid doc",
					details: parsedDoc.error.issues.map(
						(e) => `${e.path.join(".")}: ${e.message}`,
					),
				},
				{ status: 400 },
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
			return NextResponse.json(
				{
					error: "This app references media that isn't ready to compile.",
					details: mediaErrors.map(errorToString),
				},
				{ status: 400 },
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

		// Store buffer for download, owner-scoped so the download route can
		// bind access to this user — the archive bundles the app structure
		// and media bytes, so it must not be readable by id alone.
		const compileId = randomUUID();
		await saveCcz(compileId, buffer, session.user.id);

		return NextResponse.json({
			success: true,
			compileId,
			downloadUrl: `/api/compile/${compileId}/download`,
			appName: doc.appName,
		});
	} catch (err) {
		// Log the real error server-side but return a generic message to avoid
		// leaking internal paths or library details to the client.
		log.error("[compile] compilation failed", err);
		return NextResponse.json({ error: "Compilation failed" }, { status: 500 });
	}
}
