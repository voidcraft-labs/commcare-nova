/**
 * CommCare HQ app upload proxy — POST /api/commcare/upload.
 *
 * Accepts a blueprint and uploads it to CommCare HQ as a new app in the
 * caller's chosen project space. The API key stays server-side, and each
 * call creates a brand-new app — HQ has no atomic update API yet.
 *
 * The zero-tolerance boundary gate runs first: every validator finding
 * (soundness, completeness, or a stale media reference) returns an
 * actionable 422, never an opaque 500 — an invalid app must never reach
 * HQ. Then the upload is media-ON, two-phase: the blueprint expands
 * media-ON and imports, and once the app exists, each asset's bytes are
 * uploaded per-file against the new app id so HQ's `create_mapping`
 * resolves the references on the device. A media-byte failure never fails
 * the upload — the app is already created, so it degrades to a warning on
 * the response.
 */

import { type NextRequest, NextResponse } from "next/server";
import {
	ApiError,
	BLUEPRINT_REQUEST_MAX_BYTES,
	handleApiError,
	readJsonBody,
} from "@/lib/apiError";
import { requireSession } from "@/lib/auth-utils";
import {
	importApp,
	isValidDomainSlug,
	uploadAppMediaBundle,
} from "@/lib/commcare/client";
import { expandDoc } from "@/lib/commcare/expander";
import { buildMediaBulkUploadZip } from "@/lib/commcare/multimedia/bulkUploadZip";
import { resolveAppAccess } from "@/lib/db/appAccess";
import { getCredentialsForUpload } from "@/lib/db/settings";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import { userFacingError } from "@/lib/doc/userFacingErrors";
import type { PersistableDoc } from "@/lib/domain";
import { prepareExportBoundary } from "@/lib/export/boundaryValidation";
import { log } from "@/lib/logger";
import { assetWirePaths } from "@/lib/media/manifest";
import { reportMediaAttach } from "@/lib/media/uploadOutcome";

export async function POST(req: NextRequest) {
	try {
		const session = await requireSession(req);
		// Cap the body before materializing it (one ~1 MiB-bounded blueprint +
		// a small envelope); rejects the pathological without touching a real
		// upload.
		const body = (await readJsonBody(req, BLUEPRINT_REQUEST_MAX_BYTES)) as {
			domain?: string;
			appName?: string;
			appId?: string;
		} | null;

		if (!body) {
			throw new ApiError("App data is required", 400);
		}

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
		if (typeof body.appId !== "string") {
			throw new ApiError("App data is required", 400);
		}

		/* Membership gate (edit) + load the blueprint server-side — no whole
		 * doc crosses the wire. Uploading to CommCare HQ PUBLISHES the app, so
		 * it requires edit, not just view (matching the MCP upload tool); a
		 * viewer can't push a shared app to HQ. An `AppAccessError` maps to 404.
		 * The shared hydration chokepoint rebuilds `fieldParent` and backfills
		 * a legacy doc's `order`/option-`uuid`s, so the wire the expander emits
		 * reflects the same display sequence the builder shows. Media resolves
		 * at the app's PROJECT scope (the sharing boundary the assets live in)
		 * so a Project co-member can upload a shared app. */
		const access = await resolveAppAccess(body.appId, session.user.id, "edit");
		const { app } = access;
		const docWithParent = hydratePersistedBlueprint(
			app.blueprint as PersistableDoc,
		);

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

		/* ── Boundary gate — full validation before any expensive work ── */
		// Zero tolerance at the upload boundary: every finding (soundness,
		// completeness, media-state) rejects with the rule's actionable
		// message and the carrier location. This also covers the media-ON
		// expand's failure mode — a stale media reference would make
		// `expandDoc` throw `requireAssetRef` → opaque 500.
		const boundary = await prepareExportBoundary({
			mode: "hq-upload",
			access: {
				projectId: access.projectId,
				role: access.role,
				actorUserId: access.actorUserId,
			},
			doc: docWithParent,
			compiledAtSeq: app.mutation_seq,
		});
		if (!boundary.ok) {
			throw new ApiError(
				"This app isn't ready to upload — fix the issues below, then try again.",
				422,
				boundary.violations.map(userFacingError),
			);
		}

		/* ── Use the exact prepared resource generation ──────────────── */
		// The upload path is media-ON: the imported app's forms carry the
		// `jr://file/commcare/<hash><ext>` itext references, and the bytes
		// follow via the multimedia upload below. One resolution pass with
		// bytes feeds BOTH the expander (references + multimedia_map) and
		// the byte upload, so the references emitted and the files sent
		// come from the same source and cannot drift.
		const prepared = boundary.prepared;
		const manifest = prepared.assets;

		/* ── Expand domain doc to HQ JSON (media-ON) ─────────────────── */
		const hqJson = expandDoc(prepared.doc, { assets: manifest });

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
		// The app is created; now ship its media as ONE bulk ZIP to HQ's
		// api-key-authed `upload_multimedia_api`, which unzips and matches
		// each `commcare/<hash><ext>` entry to the app's `jr://` references
		// (the per-kind `uploaded/<kind>/` endpoints are session-only and
		// reject the API key — see `uploadAppMediaBundle`). A media failure
		// never invalidates the import (the app already exists) — it surfaces
		// as a warning. A media-free app skips the upload entirely.
		const warnings = [...result.warnings];
		if (manifest.size > 0) {
			const mediaResult = await uploadAppMediaBundle(
				creds,
				domain,
				result.appId,
				buildMediaBulkUploadZip(manifest),
			);
			if ("success" in mediaResult) {
				// The ZIP itself was rejected (auth / transport) — the app
				// exists but carries no media bytes.
				warnings.push(
					"Media upload could not be completed; the app was created but its media may not display.",
				);
				log.error("[commcare/upload] media bundle upload failed", undefined, {
					domain: body.domain,
					appId: result.appId,
					status: mediaResult.status,
				});
			} else if (mediaResult.timedOut) {
				// Accepted + queued, but HQ hadn't finished processing when we
				// stopped polling — the media should appear shortly.
				warnings.push(
					"The app was created and its media uploaded — CommCare is still processing it, so it may take a few minutes to appear.",
				);
			} else {
				// Reconcile HQ's unmatched-file report against the app: name the
				// genuine failures by their carrier, and separate the app-logo
				// case (a logo-only image is unmatched by design). The shared
				// reporter owns the warning copy + the error/warn log decision.
				warnings.push(
					...reportMediaAttach({
						result: mediaResult,
						assetWirePath: assetWirePaths(manifest),
						doc: prepared.doc,
						logPrefix: "[commcare/upload]",
						logContext: { domain: body.domain, appId: result.appId },
					}),
				);
			}
		}

		return NextResponse.json({ ...result, warnings }, { status: 201 });
	} catch (err) {
		return handleApiError(
			err instanceof Error ? err : new Error("Upload failed"),
		);
	}
}

// ── Warnings + error messages (upload context) ────────────────────

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
