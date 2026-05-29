/**
 * CommCare HQ app upload proxy — POST /api/commcare/upload.
 *
 * Accepts a blueprint and uploads it to CommCare HQ as a new app in the
 * caller's chosen project space. The API key stays server-side, and each
 * call creates a brand-new app — HQ has no atomic update API yet.
 *
 * Media-ON, two-phase: media references are validated first (a stale,
 * still-uploading, foreign-owned, or kind-mismatched ref returns an
 * actionable 400, never an opaque 500), then the blueprint expands
 * media-ON and imports. Once the app exists, each asset's bytes are
 * uploaded per-file against the new app id so HQ's `create_mapping`
 * resolves the references on the device. A media-byte failure never fails
 * the upload — the app is already created, so it degrades to a warning on
 * the response.
 */

import { type NextRequest, NextResponse } from "next/server";
import { ApiError, handleApiError } from "@/lib/apiError";
import { requireSession } from "@/lib/auth-utils";
import {
	importApp,
	isValidDomainSlug,
	mediaUploadAssetsFromManifest,
	uploadAppMedia,
} from "@/lib/commcare/client";
import { expandDoc } from "@/lib/commcare/expander";
import { errorToString } from "@/lib/commcare/validator/errors";
import { getCredentialsForUpload } from "@/lib/db/settings";
import { rebuildFieldParent } from "@/lib/doc/fieldParent";
import { blueprintDocSchema } from "@/lib/domain";
import { log } from "@/lib/logger";
import { resolveMediaManifest } from "@/lib/media/manifest";
import { collectMediaValidationErrors } from "@/lib/media/mediaValidation";

export async function POST(req: NextRequest) {
	try {
		const session = await requireSession(req);
		const body = (await req.json()) as {
			domain?: string;
			appName?: string;
			doc?: unknown;
		};

		/* ── Validate inputs ────────────────────────────────────────── */
		if (!body.domain?.trim()) {
			throw new ApiError("Project space is required", 400);
		}
		if (!isValidDomainSlug(body.domain.trim())) {
			throw new ApiError("Invalid project space name", 400);
		}
		if (!body.appName?.trim()) {
			throw new ApiError("App name is required", 400);
		}
		if (!body.doc) {
			throw new ApiError("App data is required", 400);
		}

		const parsedDoc = blueprintDocSchema.safeParse(body.doc);
		if (!parsedDoc.success) {
			throw new ApiError(
				"Invalid app data",
				400,
				parsedDoc.error.issues.map((e) => `${e.path.join(".")}: ${e.message}`),
			);
		}

		// `fieldParent` is derived on load and not persisted; rebuild it
		// so the expander sees a fully populated reverse index.
		const docWithParent = { ...parsedDoc.data, fieldParent: {} };
		rebuildFieldParent(docWithParent);

		/* ── Resolve credentials + authorize the requested space ──────── */
		const requested = body.domain.trim();
		const credResult = await getCredentialsForUpload(
			session.user.id,
			requested,
		);
		if (!credResult.ok) {
			if (credResult.error === "not_configured") {
				throw new ApiError(
					"CommCare HQ is not configured. Add your API key in Settings.",
					400,
				);
			}
			if (credResult.error === "not_authorized") {
				const reachable = credResult.available.map((d) => d.name).join(", ");
				throw new ApiError(
					`Your API key can't upload to "${requested}". It reaches: ${reachable}. Pick one of those project spaces.`,
					403,
				);
			}
			/* `ambiguous` shouldn't occur — the dialog always sends a chosen
			 * space — but a malformed request with no space lands here. */
			throw new ApiError("No project space selected for the upload.", 400);
		}
		const { creds } = credResult;
		const domain = credResult.domain.name;

		/* ── Validate media references before media-ON expand ─────────── */
		// This path is media-ON, so a stale media reference (deleted,
		// still-uploading, foreign-owned, or kind-mismatched asset) would
		// make `expandDoc` throw `requireAssetRef` → opaque 500. Run the
		// media rules first and surface the actionable message with the
		// carrier location instead.
		const mediaErrors = await collectMediaValidationErrors(
			docWithParent,
			session.user.id,
		);
		if (mediaErrors.length > 0) {
			throw new ApiError(
				"This app references media that isn't ready to upload.",
				400,
				mediaErrors.map(errorToString),
			);
		}

		/* ── Resolve media manifest (with bytes) ─────────────────────── */
		// The upload path is media-ON: the imported app's forms carry the
		// `jr://file/commcare/<hash><ext>` itext references, and the bytes
		// follow via the multimedia upload below. One resolution pass with
		// bytes feeds BOTH the expander (references + multimedia_map) and
		// the byte upload, so the references emitted and the files sent
		// come from the same source and cannot drift.
		const manifest = await resolveMediaManifest(
			docWithParent,
			session.user.id,
			{
				withBytes: true,
			},
		);

		/* ── Expand domain doc to HQ JSON (media-ON) ─────────────────── */
		const hqJson = expandDoc(docWithParent, { assets: manifest });

		/* ── Import the app first ───────────────────────────────────── */
		// The app must exist before any media upload — the app id goes in
		// the upload URL, and HQ records each uploaded file against this
		// new app's `multimedia_map`.
		const result = await importApp(creds, domain, body.appName.trim(), hqJson);

		if (!result.success) {
			/* Map HQ 5xx → 502 so our monitoring distinguishes upstream failures
			 * from our own errors. Client-facing message stays the same. */
			const status = result.status >= 500 ? 502 : result.status;
			throw new ApiError(uploadErrorMessage(result.status), status);
		}

		log.info("[commcare/upload] app imported", {
			domain: body.domain,
			appId: result.appId,
			userId: session.user.id,
		});

		/* ── Upload media bytes against the new app ──────────────────── */
		// The app is created; now ship each asset's bytes so HQ's
		// `create_mapping` overwrites the placeholder `multimedia_map`
		// entries with real ids and the references resolve on the device.
		// A media failure never invalidates the import (the app already
		// exists) — per-asset failures surface as warnings.
		const warnings = [...result.warnings];
		const mediaResult = await uploadAppMedia(
			creds,
			domain,
			result.appId,
			mediaUploadAssetsFromManifest(manifest),
		);
		if ("success" in mediaResult) {
			// A non-success summary means the batch couldn't start (e.g.
			// invalid domain slug — already validated above, so defensive).
			warnings.push(
				"Media upload could not be completed; the app was created but its media may not display.",
			);
			log.error("[commcare/upload] media upload batch failed", {
				domain: body.domain,
				appId: result.appId,
				status: mediaResult.status,
			});
		} else if (mediaResult.failures.length > 0) {
			warnings.push(mediaUploadWarning(mediaResult.failures.length));
			log.error("[commcare/upload] some media assets failed to upload", {
				domain: body.domain,
				appId: result.appId,
				failed: mediaResult.failures.length,
				uploaded: mediaResult.uploaded,
			});
		}

		return NextResponse.json({ ...result, warnings }, { status: 201 });
	} catch (err) {
		return handleApiError(
			err instanceof Error ? err : new Error("Upload failed"),
		);
	}
}

// ── Warnings + error messages (upload context) ────────────────────

/**
 * User-facing warning when one or more media assets failed to upload.
 * The app was still created on HQ — the affected media just won't render
 * until re-uploaded. Kept count-based (not per-asset paths) so the
 * message stays readable; server logs hold the detail.
 */
function mediaUploadWarning(failedCount: number): string {
	const noun = failedCount === 1 ? "file" : "files";
	return `${failedCount} media ${noun} could not be uploaded — the app was created, but ${
		failedCount === 1 ? "that file" : "those files"
	} won't display until re-uploaded.`;
}

/** Map CommCare HQ status codes to messages appropriate for the upload dialog. */
function uploadErrorMessage(status: number): string {
	if (status === 401)
		return "Your API key is invalid or expired. Update it in Settings.";
	if (status === 403)
		return "You don't have permission to create apps in this project space.";
	if (status === 429)
		return "Rate limited by CommCare HQ. Wait a moment and try again.";
	if (status >= 500) return "CommCare HQ is unavailable. Try again later.";
	return `Upload failed (HTTP ${status}).`;
}
