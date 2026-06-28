/**
 * App document API — load and update individual apps.
 *
 * GET  /api/apps/{id} — load an app (full blueprint) for the builder
 * PUT  /api/apps/{id} — update an app after client-side edits (auto-save)
 *
 * Both endpoints require an authenticated session and Project membership: the
 * caller must hold the app's Project at the required capability (GET → view,
 * PUT → edit), via `resolveAppAccess`.
 */

import {
	ApiError,
	BLUEPRINT_REQUEST_MAX_BYTES,
	handleApiError,
	readJsonBody,
} from "@/lib/apiError";
import { requireSession } from "@/lib/auth-utils";
import { resolveAppAccess } from "@/lib/db/appAccess";
import { applyBlueprintChange } from "@/lib/db/applyBlueprintChange";
import { BlueprintBasisStaleError } from "@/lib/db/apps";
import { blueprintDocSchema } from "@/lib/domain/blueprint";
import { log } from "@/lib/logger";

export async function GET(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	try {
		const session = await requireSession(req);
		const { id } = await params;
		/* Project-membership gate (view). An `AppAccessError` (absent / non-member
		 * / under-privileged) maps to a 404 in `handleApiError` — the shared
		 * IDOR-safe not-found posture. */
		const app = (await resolveAppAccess(id, session.user.id, "view")).app;
		/* Return only the fields the client needs for hydration. Firestore Timestamp
		 * objects on created_at/updated_at don't JSON-serialize cleanly, and the client
		 * only needs the blueprint to hydrate the builder. `basis_token` is the
		 * optimistic-save basis the builder echoes on its PUTs. */
		return Response.json({
			blueprint: app.blueprint,
			app_name: app.app_name,
			status: app.status,
			error_type: app.error_type,
			basis_token: app.blueprint_token ?? null,
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

		/* Project-membership gate (edit). The resolver's single Firestore read
		 * yields the `AppDoc` whose `blueprint` threads into the saga as
		 * `priorBlueprint` (no second `loadApp`). An `AppAccessError` maps to 404
		 * in `handleApiError` — the shared IDOR-safe not-found posture. */
		const app = (await resolveAppAccess(id, session.user.id, "edit")).app;

		// Cap the body before materializing it. The blueprint is one
		// ~1 MiB-bounded Firestore doc, so 2 MB rejects only the pathological;
		// a declared-oversize body throws `ApiError(413)` here.
		const body = await readJsonBody(req, BLUEPRINT_REQUEST_MAX_BYTES);
		// `readJsonBody` returns `null` for an UNPARSEABLE body — surface that as
		// "Invalid JSON body", not the misleading "Invalid blueprint" the schema
		// parse below would otherwise produce (which sends a dev debugging the
		// wrong layer).
		if (body === null) {
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
			/* The client only sees a generic 400. Log the Zod issues server-side
			 * (dev console + Cloud Logging) so a rejected auto-save is debuggable
			 * from WHICH field + key failed — a swallowed error here is exactly
			 * why a bad save (e.g. a field carrying a property its kind doesn't
			 * allow) surfaced as a bare "Invalid blueprint" with no cause. */
			log.warn("[apps] invalid blueprint on save", {
				appId: id,
				issues: parsed.error.issues,
			});
			throw new ApiError("Invalid blueprint", 400);
		}

		/* Optimistic-save basis — the `blueprint_token` the client last
		 * observed (from the GET, or its previous PUT's response). Absent
		 * reads as null, which matches a never-PUT app's stored token, so
		 * first saves need no backfill. The compare runs transactionally
		 * inside the write (`updateAppGuardedByBasis`); a mismatch means a
		 * writer this client never saw advanced the doc (another tab, an
		 * MCP commit), and the overwrite is rejected instead of erasing it. */
		const rawBasis = (body as Record<string, unknown>)?.basisToken;
		const basisToken = typeof rawBasis === "string" ? rawBasis : null;

		/* Route through the cross-store saga so a property-surface
		 * mutation in this auto-save (e.g. a renamed case property
		 * landing via the doc store's mutation pipeline) syncs the
		 * Postgres `case_type_schemas` row before Firestore commits.
		 * Pure non-case-type edits (module / form / field tweaks)
		 * fast-path through the saga without touching the case
		 * store. See `lib/db/applyBlueprintChange.ts` for the
		 * compensation contract. The pre-loaded `app.blueprint`
		 * threads through as `priorBlueprint` so the saga doesn't
		 * re-read the document. */
		const result = await applyBlueprintChange({
			appId: id,
			userId: session.user.id,
			prospective: parsed.data,
			priorBlueprint: app.blueprint,
			basis: { token: basisToken },
		});
		return Response.json({ ok: true, basisToken: result.basisToken });
	} catch (err) {
		if (err instanceof BlueprintBasisStaleError) {
			/* Not a failure of this request so much as a fact about the
			 * world: the doc moved under the client. 409 with a typed body;
			 * the builder reloads the server doc and tells the user. */
			log.warn(`[apps] save rejected (409): stale basis`);
			return Response.json(
				{ error: err.message, type: "stale_basis" },
				{ status: 409 },
			);
		}
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
