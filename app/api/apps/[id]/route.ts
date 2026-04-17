/**
 * App document API — load and update individual apps.
 *
 * GET  /api/apps/{id} — load an app (full blueprint) for the builder
 * PUT  /api/apps/{id} — update an app after client-side edits (auto-save)
 *
 * Both endpoints require an authenticated session. Ownership is verified
 * explicitly — the app's `owner` field must match `session.user.id`.
 */

import { ApiError, handleApiError } from "@/lib/apiError";
import { requireSession } from "@/lib/auth-utils";
import { loadApp, loadAppOwner, updateApp } from "@/lib/db/apps";
import { blueprintDocSchema } from "@/lib/domain/blueprint";
import { log } from "@/lib/log";

export async function GET(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	try {
		const session = await requireSession(req);
		const { id } = await params;
		const app = await loadApp(id);
		if (!app) {
			throw new ApiError("App not found", 404);
		}
		if (app.owner !== session.user.id) {
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

		/* Verify ownership before accepting the write. Returns 404 (not 403) to
		 * avoid leaking the existence of other users' apps. */
		const owner = await loadAppOwner(id);
		if (!owner || owner !== session.user.id) {
			throw new ApiError("App not found", 404);
		}

		let body: unknown;
		try {
			body = await req.json();
		} catch {
			throw new ApiError("Invalid JSON body", 400);
		}

		/* Validate the normalized doc before writing — prevents malformed data in
		 * Firestore. The client sends a `BlueprintDoc` (minus `fieldParent`, which
		 * is derived on load). `blueprintDocSchema` omits `fieldParent` so the
		 * parse succeeds even when the client correctly strips it. */
		const parsed = blueprintDocSchema.safeParse(
			(body as Record<string, unknown>)?.blueprint,
		);
		if (!parsed.success) {
			throw new ApiError("Invalid blueprint", 400);
		}

		await updateApp(id, parsed.data);
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
