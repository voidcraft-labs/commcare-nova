/**
 * Presence write endpoint — a collaborator's live location in the builder.
 *
 * POST   /api/apps/{id}/presence — upsert this session's presence row (heartbeat
 *        + on selection change). The client supplies `sessionId`, `name`,
 *        `color`, and `location`; the server stamps `userId` (never client-
 *        asserted), the avatar/email from the session, `updated_at`, and the TTL
 *        `expire_at`. Each POST also opportunistically sweeps this app's expired
 *        rows so the table stays bounded (the roster read already filters them).
 * DELETE /api/apps/{id}/presence — remove this session's presence row (tab
 *        close / unmount).
 *
 * Both require an authenticated session and Project membership (view) on the
 * app, via `resolveAppScope`. Presence is keyed per browser session
 * (`(app_id, user_id, session_id)`) so a user's two tabs don't clobber each
 * other and one tab's DELETE doesn't drop the other; the relay reads the roster
 * back out (see the stream route). After each write the endpoint pokes the
 * `nova_presence` channel so open streams re-query the roster.
 */

import { sql } from "kysely";
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
import { getAppDb, notifyPresence } from "@/lib/db/pg";
import { locationSchema } from "@/lib/routing/types";

/** The per-tab session id the client mints via `crypto.randomUUID()`. Shape-
 *  pinned to a UUID because it is the stable per-tab key of the presence row's
 *  `(app_id, user_id, session_id)` primary key — a freeform string would let a
 *  client mint arbitrary keys, and the UUID shape keeps the roster's per-session
 *  dedup honest. */
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
		const now = new Date();
		const db = await getAppDb();
		await db
			.insertInto("presence")
			.values({
				app_id: id,
				user_id: userId,
				session_id: sessionId,
				name,
				/* Avatar + email stamped from the SESSION (authoritative), never the
				 * body — a client can't wear someone else's face or address. */
				image: session.user.image ?? null,
				email: session.user.email ?? "",
				color,
				location: JSON.stringify(location),
				updated_at: now,
				expire_at: new Date(now.getTime() + PRESENCE_TTL_MS),
			})
			.onConflict((oc) =>
				oc.columns(["app_id", "user_id", "session_id"]).doUpdateSet({
					name: (eb) => eb.ref("excluded.name"),
					image: (eb) => eb.ref("excluded.image"),
					email: (eb) => eb.ref("excluded.email"),
					color: (eb) => eb.ref("excluded.color"),
					location: (eb) => eb.ref("excluded.location"),
					updated_at: (eb) => eb.ref("excluded.updated_at"),
					expire_at: (eb) => eb.ref("excluded.expire_at"),
				}),
			)
			.execute();

		/* Opportunistic sweep — bound the table so an abandoned app's dead sessions
		 * don't accumulate. The roster read filters expired rows anyway; this keeps
		 * the row count in check. Never touches the just-written row (its
		 * `expire_at` is in the future). */
		await db
			.deleteFrom("presence")
			.where("app_id", "=", id)
			.where(sql<boolean>`expire_at < now()`)
			.execute();

		await notifyPresence(id);
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

		const db = await getAppDb();
		await db
			.deleteFrom("presence")
			.where("app_id", "=", id)
			.where("user_id", "=", session.user.id)
			.where("session_id", "=", parsed.data.sessionId)
			.execute();

		await notifyPresence(id);
		return Response.json({ ok: true });
	} catch (err) {
		return handleApiError(
			err instanceof Error
				? err
				: new ApiError("Failed to delete presence", 500),
		);
	}
}
