/**
 * Presence write endpoint — a collaborator's live location in the builder.
 *
 * POST   /api/apps/{id}/presence — upsert this session's presence doc (heartbeat
 *        + on selection change). The client supplies `sessionId`, `name`,
 *        `color`, and `location`; the server stamps `userId` (never client-
 *        asserted), `updatedAt`, and the TTL `expireAt`.
 * DELETE /api/apps/{id}/presence — remove this session's presence doc (tab
 *        close / unmount).
 *
 * Both require an authenticated session and Project membership (view) on the
 * app, via `resolveAppScope`. Presence is keyed per browser session
 * (`{userId}:{sessionId}`) so a user's two tabs don't clobber each other and one
 * tab's DELETE doesn't drop the other; the relay reads the roster back out (see
 * the stream route).
 *
 * Writes go through the ordinary REST `getDb()` client — only the stream route's
 * live LISTEN needs the gRPC `getListenDb()`.
 */

import { FieldValue, Timestamp } from "@google-cloud/firestore";
import { z } from "zod";
import {
	ApiError,
	handleApiError,
	PRESENCE_REQUEST_MAX_BYTES,
	readJsonBody,
} from "@/lib/apiError";
import { requireSession } from "@/lib/auth-utils";
import { resolveAppScope } from "@/lib/db/appAccess";
import { PRESENCE_TTL_MS } from "@/lib/db/constants";
import { docs, runThrottledWrite } from "@/lib/db/firestore";
import { locationSchema } from "@/lib/routing/types";

/** The per-tab session id the client mints via `crypto.randomUUID()`. Shape-
 *  pinned to a UUID because it is INTERPOLATED into the presence document
 *  path (`{userId}:{sessionId}`): Firestore's `.doc()` treats `/` as a path
 *  separator, so a freeform string could address nested junk paths (or throw
 *  synchronously on an even segment count → a 500 any member could mint at
 *  will from a heartbeat endpoint). */
const sessionIdSchema = z.string().uuid();

/** The client-supplied half of a presence upsert (`userId` is server-stamped). */
const presenceBodySchema = z
	.object({
		sessionId: sessionIdSchema,
		name: z.string(),
		color: z.string(),
		location: locationSchema,
	})
	.strict();

/** The client-supplied half of a presence delete (`userId` is server-stamped). */
const presenceDeleteSchema = z.object({ sessionId: sessionIdSchema }).strict();

export async function POST(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	try {
		const session = await requireSession(req);
		const { id } = await params;
		await resolveAppScope(id, session.user.id, "view");

		const body = await readJsonBody(req, PRESENCE_REQUEST_MAX_BYTES);
		if (body === null) throw new ApiError("Invalid JSON body", 400);
		const parsed = presenceBodySchema.safeParse(body);
		if (!parsed.success) throw new ApiError("Invalid presence body", 400);

		const userId = session.user.id;
		const { sessionId, name, color, location } = parsed.data;
		// A hot request-path write rides the write throttle (Firestore sheds
		// commits outside its documented limits and the client owns the retry) —
		// heartbeats from every member of a busy app land here every ~15s.
		await runThrottledWrite(() =>
			docs.presence(id, `${userId}:${sessionId}`).set({
				userId,
				sessionId,
				name,
				color,
				location,
				updatedAt: FieldValue.serverTimestamp(),
				expireAt: Timestamp.fromMillis(Date.now() + PRESENCE_TTL_MS),
			}),
		);
		return Response.json({ ok: true });
	} catch (err) {
		return handleApiError(
			err instanceof Error ? err : new ApiError("Failed to post presence", 500),
		);
	}
}

export async function DELETE(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	try {
		const session = await requireSession(req);
		const { id } = await params;
		await resolveAppScope(id, session.user.id, "view");

		const body = await readJsonBody(req, PRESENCE_REQUEST_MAX_BYTES);
		if (body === null) throw new ApiError("Invalid JSON body", 400);
		const parsed = presenceDeleteSchema.safeParse(body);
		if (!parsed.success) throw new ApiError("Invalid presence body", 400);

		await runThrottledWrite(() =>
			docs.presence(id, `${session.user.id}:${parsed.data.sessionId}`).delete(),
		);
		return Response.json({ ok: true });
	} catch (err) {
		return handleApiError(
			err instanceof Error
				? err
				: new ApiError("Failed to delete presence", 500),
		);
	}
}
