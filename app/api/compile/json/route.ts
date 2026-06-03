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
 *   - Media-free app → a plain `<app>.json` (import via HQ → Settings →
 *     Import App from Another Server). Byte-identical to the pre-media JSON
 *     output.
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

/**
 * The manual-import instructions bundled into the media export.
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
 */
function importReadme(appName: string): string {
	return [
		`${appName} — exported from Nova for CommCare HQ`,
		"",
		"This archive has two files to load into CommCare HQ:",
		`  - ${appName}.json   the application`,
		"  - multimedia.zip    its media (CommCare bulk-upload format)",
		"",
		"=== 1. Import the app ===",
		"",
		"In CommCare HQ, open the Settings (gear) menu -> Project Settings ->",
		"Import App from Another Server:",
		"  https://www.commcarehq.org/a/<your-project>/settings/project/import_app/",
		"",
		"This is the only place CommCare's UI lets you upload an app's JSON. The",
		"first screen asks for an 'App URL' from another server, but it only",
		"checks the URL's shape and that the server differs from yours — it never",
		"opens the link. Paste this exact dummy URL and click Next:",
		"",
		"  https://india.commcarehq.org/a/x/apps/view/00000000000000000000000000000000/",
		"",
		"(If your CommCare instance IS the India server, change 'india' to 'www'.",
		" The only rule: the subdomain must be www, india, or eu — and not yours.)",
		"",
		`On the next screen, upload "${appName}.json", name the app, and import.`,
		"",
		"=== 2. Import the media ===",
		"",
		"After the app imports, CommCare shows an instructions page with a link to",
		'your new app\'s multimedia upload. Open it and upload "multimedia.zip".',
		"The files are named by content hash and match the app's references",
		"automatically, so they attach to the right places.",
		"",
	].join("\n");
}
