/**
 * GET /api/media/library — list a Project's media assets.
 *
 * Two modes on one route:
 *
 *   - **List** (default) — cursor-paginated, newest first. Backs the
 *     asset-library picker. Optional query parameters:
 *       - `kind` — filter to a SET of asset kinds; repeat the param to allow
 *         several (`?kind=image&kind=pdf`). Media kinds (image/audio/video) back
 *         the carrier pickers; document kinds (pdf/text/docx/xlsx) back the chat
 *         file manager. A picker's "All" view passes exactly its carrier's allowed
 *         kinds, so the server returns only attachable assets rather than a page of
 *         irrelevant kinds the client would then hide. Omit it for every kind.
 *       - `cursor` — the opaque token the previous page returned in
 *         `nextCursor`; pass it back verbatim to fetch the next page.
 *         Omit it for the first page.
 *   - **Resolve** — repeated `?id=` looks up exactly those rows (Project-filtered;
 *     an id that's missing or in another Project is silently absent, so ids stay
 *     non-enumerable). Backs the browser attach budget check, which needs the
 *     byte sizes of referenced assets the session hasn't otherwise loaded.
 *     Returns ready AND pending rows (the wire shape carries `status`);
 *     `nextCursor` is always `null`. `kind`/`cursor` are ignored in this mode.
 */

import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ApiError, handleApiError } from "@/lib/apiError";
import { requireSession, resolveActiveProjectId } from "@/lib/auth-utils";
import { resolveAppScope } from "@/lib/db/appAccess";
import {
	listReadyAssetsForProject,
	loadAssetsByIds,
	MalformedCursorError,
	toWireMediaAsset,
} from "@/lib/db/mediaAssets";
import { ASSET_KINDS, MAX_MEDIA_EXPORT_ASSETS } from "@/lib/domain/multimedia";

const querySchema = z
	.object({
		// Repeated `?kind=` collects into an array; each must be an accepted kind.
		// `[]` (no param) means "every kind" — passed through as no filter.
		kinds: z.array(z.enum(ASSET_KINDS)),
		cursor: z.string().optional(),
		// Repeated `?id=` switches to resolve mode. Capped at the export-asset
		// ceiling — a doc can't reference more exportable assets than that, so
		// a larger request is malformed, and the cap bounds the Firestore
		// batch-read fan-out the same way the boundary's pre-load cap does.
		ids: z.array(z.string().min(1)).max(MAX_MEDIA_EXPORT_ASSETS),
		// Present when listing within an app context (the builder media pickers):
		// scopes to the app's Project. Absent for the personal file manager,
		// which scopes to the caller's active Project.
		appId: z.string().min(1).optional(),
	})
	.strict();

export async function GET(req: NextRequest) {
	try {
		const session = await requireSession(req);
		const url = new URL(req.url);
		const parsed = querySchema.safeParse({
			kinds: url.searchParams.getAll("kind"),
			cursor: url.searchParams.get("cursor") ?? undefined,
			ids: url.searchParams.getAll("id"),
			appId: url.searchParams.get("appId") ?? undefined,
		});
		if (!parsed.success) {
			throw new ApiError(
				"Library query couldn't be parsed — each `kind` must be one of image/audio/video/pdf/text/docx/xlsx, `cursor` must be the opaque token a prior page returned, and `id` must be repeated asset ids (at most the export-asset limit).",
				400,
				parsed.error.issues.map((e) => `${e.path.join(".")}: ${e.message}`),
			);
		}

		const { ids, kinds, cursor, appId } = parsed.data;

		// Resolve the Project to read from — the app's Project in an app context
		// (view-gated; a denied app throws AppAccessError → 404), else the
		// caller's active Project for the personal file manager.
		const project = appId
			? (await resolveAppScope(appId, session.user.id, "view")).projectId
			: await resolveActiveProjectId(session);

		if (ids.length > 0) {
			const rows = await loadAssetsByIds(ids, project);
			return NextResponse.json({
				assets: rows.map(toWireMediaAsset),
				nextCursor: null,
			});
		}

		const { assets, nextCursor } = await listReadyAssetsForProject(project, {
			kinds,
			cursor,
		}).catch((err: unknown) => {
			// A bad cursor is a client error — surface its helpful
			// message as a 400 rather than collapsing to a 500.
			if (err instanceof MalformedCursorError) {
				throw new ApiError(err.message, 400);
			}
			throw err;
		});
		return NextResponse.json({
			assets: assets.map(toWireMediaAsset),
			nextCursor,
		});
	} catch (err) {
		return handleApiError(
			err instanceof Error ? err : new ApiError("Library list failed", 500),
		);
	}
}
