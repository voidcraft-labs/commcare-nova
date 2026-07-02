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

import { z } from "zod";
import {
	ApiError,
	BLUEPRINT_REQUEST_MAX_BYTES,
	handleApiError,
	readJsonBody,
} from "@/lib/apiError";
import { requireSession } from "@/lib/auth-utils";
import { resolveAppAccess } from "@/lib/db/appAccess";
import { applyBlueprintChange } from "@/lib/db/applyBlueprintChange";
import {
	BlueprintCommitRejectedError,
	CommitReauthError,
} from "@/lib/db/commitGuard";
import { mutationSchema } from "@/lib/doc/types";
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
			/* The durable mutation cursor the client keys recovery on — the head
			 * `seq` of the `acceptedMutations` stream at load time. */
			mutation_seq: app.mutation_seq,
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

		// Cap the body before materializing it. A mutation delta is far
		// smaller than the blueprint, so 2 MB rejects only the pathological;
		// a declared-oversize body throws `ApiError(413)` here.
		const body = await readJsonBody(req, BLUEPRINT_REQUEST_MAX_BYTES);
		// `readJsonBody` returns `null` for an UNPARSEABLE body — surface that as
		// "Invalid JSON body", not the misleading "Invalid mutations" the schema
		// parse below would otherwise produce.
		if (body === null) {
			throw new ApiError("Invalid JSON body", 400);
		}

		/* The client sends the MUTATION DELTA since its last save (never the
		 * whole doc — `diffDocsToMutations` in `useAutoSave`) plus a client-minted
		 * `batchId` for idempotency. Validate the shape before writing; the saga's
		 * guard mode replays the delta onto the fresh stored blueprint and re-runs
		 * the validity verdict. */
		const parsed = z
			.object({
				mutations: z.array(mutationSchema),
				batchId: z.string().uuid(),
			})
			.safeParse(body);
		if (!parsed.success) {
			/* The client only sees a generic 400. Log the Zod issues server-side
			 * so a rejected auto-save is debuggable from WHICH mutation failed. */
			log.warn("[apps] invalid mutations on save", {
				appId: id,
				issues: parsed.error.issues,
			});
			throw new ApiError("Invalid mutations", 400);
		}

		/* Route through the cross-store saga so a property-surface mutation in
		 * this auto-save (e.g. a renamed case property) syncs the Postgres
		 * `case_type_schemas` row before Firestore commits; pure non-case-type
		 * edits fast-path through. `guard` mode re-applies the delta onto the
		 * FRESH stored blueprint and re-verdicts inside the transaction, so a
		 * co-member's concurrent committed edit MERGES instead of being erased.
		 * The pre-loaded `app.blueprint` threads through as `priorBlueprint` so
		 * the saga doesn't re-read it. */
		const result = await applyBlueprintChange({
			appId: id,
			userId: session.user.id,
			priorBlueprint: app.blueprint,
			batchId: parsed.data.batchId,
			kind: "autosave",
			guard: { mutations: parsed.data.mutations },
		});
		return Response.json({
			ok: true,
			basisToken: result.basisToken,
			seq: result.seq,
		});
	} catch (err) {
		if (err instanceof CommitReauthError) {
			/* The actor lost edit access to this app (removed from its Project, or
			 * not the owner of a personal app) — TERMINAL. 403, not a 409-reload:
			 * a reload can't restore access, so a 409 would just re-PUT the same
			 * delta into the same denial. */
			log.warn(`[apps] save denied (403): ${err.message}`);
			return Response.json(
				{ error: err.message, type: "reauth_denied" },
				{ status: 403 },
			);
		}
		if (err instanceof BlueprintCommitRejectedError) {
			/* The delta is invalid against the fresh server doc — a genuine
			 * concurrent conflict (this edit targets an entity another writer
			 * changed, or the app moved Projects). 409 with the person-to-person
			 * message; the builder reloads the server doc and re-authorizes. */
			log.warn(`[apps] save rejected (409): ${err.message}`);
			return Response.json(
				{ error: err.message, type: "commit_rejected" },
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
