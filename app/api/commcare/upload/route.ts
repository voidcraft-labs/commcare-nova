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
import { importApp } from "@/lib/commcare/client";
import { getDecryptedCredentials } from "@/lib/db/settings";
import { log } from "@/lib/log";
import { appBlueprintSchema } from "@/lib/schemas/blueprint";
import { expandBlueprint } from "@/lib/services/hqJsonExpander";

export async function POST(req: NextRequest) {
	try {
		const session = await requireSession(req);
		const body = (await req.json()) as {
			domain?: string;
			appName?: string;
			blueprint?: unknown;
		};

		/* ── Validate inputs ────────────────────────────────────────── */
		if (!body.domain?.trim()) {
			throw new ApiError("Project space is required", 400);
		}
		/* CommCare HQ domains are slug-format — validate to prevent path traversal
		 * in the URL template used by importApp(). */
		if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(body.domain.trim())) {
			throw new ApiError("Invalid project space name", 400);
		}
		if (!body.appName?.trim()) {
			throw new ApiError("App name is required", 400);
		}
		if (!body.blueprint) {
			throw new ApiError("Blueprint is required", 400);
		}

		const parsed = appBlueprintSchema.safeParse(body.blueprint);
		if (!parsed.success) {
			throw new ApiError(
				"Invalid blueprint",
				400,
				parsed.error.issues.map(
					(e: { path: PropertyKey[]; message: string }) =>
						`${e.path.join(".")}: ${e.message}`,
				),
			);
		}

		/* ── Resolve credentials ────────────────────────────────────── */
		const creds = await getDecryptedCredentials(session.user.id);
		if (!creds) {
			throw new ApiError(
				"CommCare HQ is not configured. Add your API key in Settings.",
				400,
			);
		}

		/* ── Expand blueprint to HQ JSON ────────────────────────────── */
		const hqJson = expandBlueprint(parsed.data);

		/* ── Upload to CommCare HQ ──────────────────────────────────── */
		const result = await importApp(
			creds,
			body.domain.trim(),
			body.appName.trim(),
			hqJson,
		);

		if (!result.success) {
			throw new ApiError(uploadErrorMessage(result.status), result.status);
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
