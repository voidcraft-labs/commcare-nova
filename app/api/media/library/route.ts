/**
 * GET /api/media/library — list the authenticated user's media assets.
 *
 * Cursor-paginated, newest first. Backs the asset-library picker.
 *
 * Optional query parameters:
 *   - `kind` — filter to a SET of asset kinds; repeat the param to allow
 *     several (`?kind=image&kind=pdf`). Media kinds (image/audio/video) back
 *     the carrier pickers; document kinds (pdf/text/docx/xlsx) back the chat
 *     file manager. A picker's "All" view passes exactly its carrier's allowed
 *     kinds, so the server returns only attachable assets rather than a page of
 *     irrelevant kinds the client would then hide. Omit it for every kind.
 *   - `cursor` — the opaque token the previous page returned in
 *     `nextCursor`; pass it back verbatim to fetch the next page.
 *     Omit it for the first page.
 */

import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ApiError, handleApiError } from "@/lib/apiError";
import { requireSession } from "@/lib/auth-utils";
import {
	listReadyAssetsForOwner,
	MalformedCursorError,
	toWireMediaAsset,
} from "@/lib/db/mediaAssets";
import { ASSET_KINDS } from "@/lib/domain/multimedia";

const querySchema = z
	.object({
		// Repeated `?kind=` collects into an array; each must be an accepted kind.
		// `[]` (no param) means "every kind" — passed through as no filter.
		kinds: z.array(z.enum(ASSET_KINDS)),
		cursor: z.string().optional(),
	})
	.strict();

export async function GET(req: NextRequest) {
	try {
		const session = await requireSession(req);
		const url = new URL(req.url);
		const parsed = querySchema.safeParse({
			kinds: url.searchParams.getAll("kind"),
			cursor: url.searchParams.get("cursor") ?? undefined,
		});
		if (!parsed.success) {
			throw new ApiError(
				"Library query couldn't be parsed — each `kind` must be one of image/audio/video/pdf/text/docx/xlsx and `cursor` must be the opaque token a prior page returned.",
				400,
				parsed.error.issues.map((e) => `${e.path.join(".")}: ${e.message}`),
			);
		}

		const { assets, nextCursor } = await listReadyAssetsForOwner(
			session.user.id,
			parsed.data,
		).catch((err: unknown) => {
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
