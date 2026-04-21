/**
 * CommCare HQ app upload proxy — POST /api/commcare/upload.
 *
 * Accepts a blueprint, expands it to HQ JSON, and uploads it to
 * CommCare HQ's import API. The API key stays server-side.
 *
 * Each call creates a brand-new app in the target project space —
 * there is no atomic update API in CommCare HQ yet.
 */

import { type NextRequest, NextResponse } from "next/server";
import { ApiError, handleApiError } from "@/lib/apiError";
import { requireSession } from "@/lib/auth-utils";
import { importApp, isValidDomainSlug } from "@/lib/commcare/client";
import { expandDoc } from "@/lib/commcare/expander";
import { getDecryptedCredentialsWithDomain } from "@/lib/db/settings";
import { rebuildFieldParent } from "@/lib/doc/fieldParent";
import { blueprintDocSchema } from "@/lib/domain";
import { log } from "@/lib/logger";

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

		/* ── Resolve credentials + verify domain authorization ──────── */
		const settings = await getDecryptedCredentialsWithDomain(session.user.id);
		if (!settings) {
			throw new ApiError(
				"CommCare HQ is not configured. Add your API key in Settings.",
				400,
			);
		}
		if (settings.domain.name !== body.domain.trim()) {
			throw new ApiError(
				"You can only upload to your authorized project space.",
				403,
			);
		}
		const { creds } = settings;

		/* ── Expand domain doc to HQ JSON ────────────────────────────── */
		const hqJson = expandDoc(docWithParent);

		/* ── Upload to CommCare HQ ──────────────────────────────────── */
		const result = await importApp(
			creds,
			body.domain.trim(),
			body.appName.trim(),
			hqJson,
		);

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

		return NextResponse.json(result, { status: 201 });
	} catch (err) {
		return handleApiError(
			err instanceof Error ? err : new Error("Upload failed"),
		);
	}
}

// ── Error messages (upload context) ───────────────────────────────

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
