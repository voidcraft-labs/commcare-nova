/**
 * App document API — load and update individual apps.
 *
 * GET  /api/apps/{id} — load an app (full blueprint) for the builder
 * PUT  /api/apps/{id} — update an app after client-side edits (auto-save)
 *
 * Both endpoints require an authenticated session. The user's email is
 * derived from the session and used as the Firestore subcollection parent,
 * so users can only access their own data.
 */

import { ApiError, handleApiError } from "@/lib/apiError";
import { requireSession } from "@/lib/auth-utils";
import { loadApp, updateApp } from "@/lib/db/apps";
import { log } from "@/lib/log";
import { appBlueprintSchema } from "@/lib/schemas/blueprint";

export async function GET(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	try {
		const session = await requireSession(req);
		const { id } = await params;
		const app = await loadApp(session.user.email, id);
		if (!app) {
			throw new ApiError("App not found", 404);
		}
		/* Return only the fields the client needs for hydration. Firestore Timestamp
		 * objects on created_at/updated_at don't JSON-serialize cleanly, and the client
		 * only needs the blueprint to hydrate the builder. */
		return Response.json({
			blueprint: app.blueprint,
			app_name: app.app_name,
			status: app.status,
			error_type: app.error_type,
		});
	} catch (err) {
		return handleApiError(
			err instanceof Error ? err : new ApiError("Failed to load app", 500),
		);
	}
}

export async function PUT(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	try {
		const session = await requireSession(req);
		const { id } = await params;

		let body: unknown;
		try {
			body = await req.json();
		} catch {
			throw new ApiError("Invalid JSON body", 400);
		}

		/* Validate the blueprint before writing — prevents malformed data in Firestore. */
		const parsed = appBlueprintSchema.safeParse(
			(body as Record<string, unknown>)?.blueprint,
		);
		if (!parsed.success) {
			throw new ApiError("Invalid blueprint", 400);
		}

		await updateApp(session.user.email, id, parsed.data);
		return Response.json({ ok: true });
	} catch (err) {
		/* Save failures mean silent data loss — log every rejection so they're
		 * visible in Cloud Logging regardless of whether the client report fires.
		 * handleApiError already logs unhandled Errors; this covers ApiError (401,
		 * 400) which would otherwise be returned without any server-side trace. */
		if (err instanceof ApiError) {
			log.warn(`[apps] save rejected (${err.status}): ${err.message}`);
		}
		return handleApiError(
			err instanceof Error ? err : new ApiError("Failed to save app", 500),
		);
	}
}
