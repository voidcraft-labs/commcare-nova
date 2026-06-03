import AdmZip from "adm-zip";
import { type NextRequest, NextResponse } from "next/server";
import { ApiError, handleApiError } from "@/lib/apiError";
import { requireSession } from "@/lib/auth-utils";
import { expandDoc } from "@/lib/commcare/expander";
import { buildMediaBulkUploadZip } from "@/lib/commcare/multimedia/bulkUploadZip";
import { errorToString } from "@/lib/commcare/validator/errors";
import { rebuildFieldParent } from "@/lib/doc/fieldParent";
import { blueprintDocSchema } from "@/lib/domain";
import { resolveMediaManifest } from "@/lib/media/manifest";
import { collectMediaValidationErrors } from "@/lib/media/mediaValidation";
import { sanitizeFilename } from "@/lib/utils/sanitize";

/**
 * HQ-JSON export endpoint.
 *
 * Emits the HQ import JSON via `expandDoc`, the external boundary
 * analogous to the XForm XML emitter. The output reproduces a
 * media-carrying CommCare app from a manual import, matching what the
 * `.ccz` and HQ-upload paths already give the API-key flow:
 *
 *   - Media-free app → a plain `<app>.json` (import via HQ → Import
 *     Application). Byte-identical to the pre-media JSON output.
 *   - App with media → a `<app>.zip` bundling the MEDIA-ON `<app>.json`
 *     (it carries the `jr://file/commcare/...` references + multimedia_map)
 *     alongside a `multimedia.zip` and a README. CommCare HQ has no single
 *     "json + media" import — it's two steps — so the bundle mirrors that:
 *     import the json, then bulk-upload the media zip.
 *
 * The `multimedia.zip` IS CommCare HQ's bulk-upload format: each file sits
 * at `commcare/<hash><ext>` (the asset's `wirePath`), which HQ's
 * `process_bulk_upload_zip` maps via `get_form_path` to
 * `jr://file/commcare/<hash><ext>` and matches against the imported app's
 * references — attaching each file to the right place automatically.
 *
 * Critically, the bytes ship WITH the references: the media-ON JSON's
 * `jr://` refs all resolve to files present in `multimedia.zip`, so the
 * imported-and-media-uploaded app has no broken references (the reason the
 * raw JSON path historically stayed media-OFF — references without bytes).
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

		// Resolve the manifest WITH bytes, then expand with it so the JSON
		// carries the media references. An empty manifest (media-free app)
		// costs no I/O and expands identically to the media-OFF output.
		const assets = await resolveMediaManifest(docWithParent, session.user.id, {
			withBytes: true,
		});
		const hqJson = expandDoc(docWithParent, { assets });
		const jsonStr = JSON.stringify(hqJson, null, 2);
		const appName = sanitizeFilename(docWithParent.appName);

		if (assets.size === 0) {
			// Media-free: the plain JSON file, unchanged.
			return new NextResponse(jsonStr, {
				headers: {
					"Content-Type": "application/json",
					"Content-Disposition": `attachment; filename="${appName}.json"`,
				},
			});
		}

		// Media-ON: bundle the json + the HQ-format multimedia zip + a README
		// describing the two-step manual import. The multimedia zip is the
		// SAME bulk-upload format the HQ-upload path POSTs, built by one shared
		// helper so a manual import and an API upload can't diverge.
		const bundle = new AdmZip();
		bundle.addFile(`${appName}.json`, Buffer.from(jsonStr, "utf-8"));
		bundle.addFile("multimedia.zip", buildMediaBulkUploadZip(assets));
		bundle.addFile("README.txt", Buffer.from(importReadme(appName), "utf-8"));

		return new NextResponse(new Uint8Array(bundle.toBuffer()), {
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

/** The manual-import instructions bundled into the media export. */
function importReadme(appName: string): string {
	return [
		`${appName} — exported from Nova for CommCare HQ`,
		"",
		"This archive has two files. Get both into CommCare HQ:",
		"",
		`  1. The app — "${appName}.json". Import it in CommCare HQ`,
		`     (Applications -> Import Application).`,
		"",
		`  2. The media — "multimedia.zip", already in CommCare's`,
		`     bulk-upload format. After the app is imported, upload it`,
		`     through that app's bulk multimedia upload.`,
		"",
		"Import the app first: the media files are named by content hash and",
		"match the app's references automatically, so they attach to the",
		"right places once the references exist.",
		"",
	].join("\n");
}
