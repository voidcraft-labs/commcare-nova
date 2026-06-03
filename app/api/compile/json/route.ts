import { type NextRequest, NextResponse } from "next/server";
import { ApiError, handleApiError } from "@/lib/apiError";
import { requireSession } from "@/lib/auth-utils";
import { expandDoc } from "@/lib/commcare/expander";
import { buildHqJsonExportArchive } from "@/lib/commcare/multimedia/hqJsonExportArchive";
import { errorToString } from "@/lib/commcare/validator/errors";
import { rebuildFieldParent } from "@/lib/doc/fieldParent";
import { blueprintDocSchema } from "@/lib/domain";
import { resolveMediaManifest } from "@/lib/media/manifest";
import { collectMediaValidationErrors } from "@/lib/media/mediaValidation";
import { sanitizeFilename } from "@/lib/utils/sanitize";

/**
 * HQ-JSON export endpoint — the manual-import twin of the HQ-upload path,
 * for users who import into CommCare HQ themselves rather than via an API key.
 *
 *   - Media-free app → a plain `<app>.json` (import via HQ → Settings →
 *     Import App from Another Server). Byte-identical to the pre-media output.
 *   - App with media → a `<app>.zip` bundling the MEDIA-ON JSON + the HQ
 *     bulk-upload `multimedia.zip` + a README, assembled by the shared
 *     `buildHqJsonExportArchive` so this download and the MCP `compile_app`
 *     json tool ship one format.
 *
 * The media gate runs before expand on the media path so a stale reference
 * surfaces as an actionable error, never a broken on-device reference.
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

		// `fieldParent` is derived on load and not persisted; rebuild it
		// here so the expander sees a fully usable doc.
		const docWithParent = { ...parsedDoc.data, fieldParent: {} };
		rebuildFieldParent(docWithParent);

		// Media-ON now bundles the bytes, so a stale media reference (deleted,
		// still-uploading, foreign-owned, kind-mismatched) would make
		// `expandDoc` throw `requireAssetRef` → opaque 500. Run the media
		// rules first and surface the actionable message, exactly as the CCZ
		// path does.
		const mediaErrors = await collectMediaValidationErrors(
			docWithParent,
			session.user.id,
		);
		if (mediaErrors.length > 0) {
			throw new ApiError(
				"This app references media that isn't ready to export.",
				400,
				mediaErrors.map(errorToString),
			);
		}

		// Resolve the manifest WITH bytes (a media-free app yields an empty
		// manifest at no byte cost), then expand. Only a media-bearing app
		// passes the manifest to `expandDoc` — a media-free app expands
		// media-OFF (no manifest), keeping its JSON byte-identical to the
		// pre-media output rather than relying on an empty manifest reducing
		// to the same shape.
		const assets = await resolveMediaManifest(docWithParent, session.user.id, {
			withBytes: true,
		});
		const hasMedia = assets.size > 0;
		const hqJson = expandDoc(docWithParent, hasMedia ? { assets } : {});
		const appName = sanitizeFilename(docWithParent.appName);

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
		const archive = buildHqJsonExportArchive(appName, hqJson, assets);
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
