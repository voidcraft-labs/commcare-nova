/**
 * Admin credit reset/grant endpoint — and the reference shape for every admin
 * WRITE route in the codebase (this is the first).
 *
 * POST /api/admin/users/{userId}/credits
 *   { action: "reset" }                              → zero this period's consumed
 *   { action: "grant", amount: <positive int> }      → add bonus credits
 *   (both accept an optional `reason` recorded on the audit row)
 *
 * The admin-write shape, which later write routes copy:
 *   1. `requireAdmin(req)` gates the call (403 for non-admins and for
 *      impersonated sessions) and hands back the acting admin's `Session`.
 *   2. The body is validated up front; a bad action / amount / shape — or a
 *      body that isn't even JSON — is a 400, never a generic 500.
 *   3. The actual balance change AND its append-only audit row are owned by the
 *      called `lib/db/credits` function, which writes both in ONE Postgres
 *      transaction. This route does not touch Postgres directly — it
 *      authenticates, validates, builds the `AdminActor`, and dispatches.
 *   4. Every error path funnels through `handleApiError`, so the client always
 *      sees the `{ error, details? }` envelope with the right status.
 */

import { z } from "zod";
import { ApiError, handleApiError } from "@/lib/apiError";
import { requireAdmin } from "@/lib/auth-utils";
import { type AdminActor, grantCredits, resetCredits } from "@/lib/db/credits";

/**
 * The single human message for any bad grant `amount`. Carried on every check
 * of the grant arm's `amount` (missing, non-number, zero/negative, fractional)
 * so the failure the client reads is one uniform "send a positive whole number"
 * — not Zod's default "Expected number, received undefined" / "Too small". It
 * reaches the client through the `issues → ApiError.details` path below.
 */
const GRANT_AMOUNT_MESSAGE = "A grant needs a positive whole credit amount.";

/**
 * The request body for a reset or a grant, as a discriminated union on
 * `action`. The DU (the house idiom across `lib/domain` / `lib/db/types`) makes
 * `amount` statically a `number` on the grant arm and absent on the reset arm —
 * so the handler's grant branch passes `parsed.data.amount` with no narrowing
 * guard and no assertion, and a `{ action: "reset" }` body can't smuggle an
 * `amount` through. Credits are integer-denominated and a zero/negative grant
 * has no meaning, hence `.int().positive()`. `reason` lives on both arms — the
 * optional free-text justification stamped onto the audit row, capped so a
 * runaway paste can't bloat the document.
 */
const bodySchema = z.discriminatedUnion("action", [
	z.object({
		action: z.literal("reset"),
		reason: z.string().max(500).optional(),
	}),
	z.object({
		action: z.literal("grant"),
		// Zod 4's unified `{ error }` param (replacing v3's `required_error` /
		// `invalid_type_error` / `message`) sets the message for a missing or
		// non-number `amount`; the same string on `.int()` / `.positive()` covers
		// a fractional or zero/negative value — one human message for every "bad
		// amount" shape.
		amount: z
			.number({ error: GRANT_AMOUNT_MESSAGE })
			.int(GRANT_AMOUNT_MESSAGE)
			.positive(GRANT_AMOUNT_MESSAGE),
		reason: z.string().max(500).optional(),
	}),
]);

export async function POST(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	try {
		// Gate first: a non-admin (or an impersonated session) never gets past
		// here. The returned session is the acting admin — its identity is what
		// the audit row records.
		const admin = await requireAdmin(req);
		const { id: userId } = await params;

		// Parse the body defensively: `req.json()` throws a SyntaxError on a body
		// that isn't valid JSON, and an unguarded throw would fall through to the
		// outer catch as a generic 500. A malformed body is a client mistake — a
		// 400 — so we catch the parse failure and re-throw it as such.
		let rawBody: unknown;
		try {
			rawBody = await req.json();
		} catch {
			throw new ApiError(
				"That request body wasn't valid JSON. Send a JSON object like " +
					'{ "action": "reset" } or { "action": "grant", "amount": 500 }.',
				400,
			);
		}

		const parsed = bodySchema.safeParse(rawBody);
		if (!parsed.success) {
			// Fold the Zod issue messages into `details` for a precise client-side
			// diagnosis, with an Elm-like top-line message that says what to send.
			throw new ApiError(
				'That credit action wasn\'t valid. Send action "reset", or action ' +
					'"grant" with a positive whole `amount`.',
				400,
				parsed.error.issues.map((issue) => issue.message),
			);
		}

		// The acting admin, denormalized onto the audit row by the credit writers.
		const who: AdminActor = {
			actor: admin.user.id,
			actorEmail: admin.user.email,
			reason: parsed.data.reason ?? null,
		};

		if (parsed.data.action === "reset") {
			await resetCredits(userId, who);
		} else {
			// `parsed.data.amount` is statically a `number` on the grant arm of the
			// discriminated union — no narrowing guard, no assertion.
			await grantCredits(userId, parsed.data.amount, who);
		}

		return Response.json({ ok: true });
	} catch (err) {
		return handleApiError(
			err instanceof Error
				? err
				: new ApiError("Failed to update credits", 500),
		);
	}
}
