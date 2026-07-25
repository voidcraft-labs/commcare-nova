/**
 * App document API — load and update individual apps.
 *
 * GET  /api/apps/{id} — load an app (full blueprint) for the builder
 * PUT  /api/apps/{id} — update an app after client-side edits (auto-save)
 *
 * Both endpoints require an authenticated session and Project membership. GET
 * uses the transactionally authorized snapshot (`view`); PUT performs its early
 * `edit` gate via `resolveAppAccess` and reauthorizes in the commit transaction.
 */

import { z } from "zod";
import {
	ApiError,
	BLUEPRINT_REQUEST_MAX_BYTES,
	handleApiError,
	readJsonBody,
} from "@/lib/apiError";
import { requireSession } from "@/lib/auth-utils";
import {
	AppAccessError,
	resolveAppAccess,
	resolveAuthorizedAppSnapshot,
} from "@/lib/db/appAccess";
import { applyBlueprintChange } from "@/lib/db/applyBlueprintChange";
import {
	AppProjectChangedError,
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
		const snapshot = await resolveAuthorizedAppSnapshot(
			id,
			session.user.id,
			"view",
		);
		const { app } = snapshot;
		/* Return only the fields the client needs for hydration — the builder
		 * hydrates off the blueprint. The authorization tuple + cursor come from
		 * the same locked transaction as that blueprint. Keep the original row
		 * names while old browser revisions can still be open. */
		return Response.json(
			{
				projectId: snapshot.projectId,
				role: snapshot.role,
				canEdit: snapshot.canEdit,
				blueprint: app.blueprint,
				baseSeq: snapshot.baseSeq,
				app_name: app.app_name,
				status: app.status,
				error_type: app.error_type,
				/* The durable mutation cursor the client keys recovery on — the head
				 * `seq` of the `acceptedMutations` stream at load time. */
				mutation_seq: snapshot.baseSeq,
			},
			{ headers: { "Cache-Control": "private, no-store" } },
		);
	} catch (err) {
		const response = handleApiError(
			err instanceof Error ? err : new ApiError("Failed to load app", 500),
		);
		response.headers.set("Cache-Control", "private, no-store");
		return response;
	}
}

export async function PUT(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	try {
		const session = await requireSession(req);
		const { id } = await params;

		/* Project-membership gate (edit). The resolver's single app load yields
		 * the `AppDoc` whose `blueprint` threads into the saga as
		 * `priorBlueprint` (no second `loadApp`). A known member with insufficient
		 * role becomes a typed 403 below; absent/non-member apps keep the shared
		 * IDOR-safe 404 posture. */
		const access = await resolveAppAccess(id, session.user.id, "edit");
		const app = access.app;

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

		/* Route through the schema saga so a property-surface mutation in
		 * this auto-save (e.g. a renamed case property) syncs the case-store
		 * `case_type_schemas` row before the blueprint commits; pure
		 * non-case-type edits fast-path through. `guard` mode re-applies the delta onto the
		 * FRESH stored blueprint and re-verdicts inside the transaction, so a
		 * co-member's concurrent committed edit MERGES instead of being erased.
		 * The pre-loaded `app.blueprint` threads through as `priorBlueprint` so
		 * the saga doesn't re-read it. */
		const result = await applyBlueprintChange({
			appId: id,
			userId: session.user.id,
			expectedProjectId: access.projectId,
			priorBlueprint: app.blueprint,
			batchId: parsed.data.batchId,
			kind: "autosave",
			guard: { mutations: parsed.data.mutations },
		});
		/* The migration outcome rides the response ONLY when the commit's
		 * row migrations actually touched saved case data — the client
		 * toasts it (a schema change silently rewriting or parking values
		 * must never be invisible to the person who caused it). */
		const migration = result.migration;
		const touchedRows =
			migration !== undefined &&
			(migration.migrated > 0 ||
				migration.reshaped > 0 ||
				migration.retyped > 0 ||
				migration.parked > 0);
		return Response.json({
			ok: true,
			seq: result.seq,
			...(touchedRows && { migration }),
		});
	} catch (err) {
		/* The early edit gate distinguishes a known member whose role is now
		 * view-only from absent/non-member apps. The former is a typed capability
		 * transition the client confirms through an atomic GET; the latter keep the
		 * shared IDOR-safe 404 posture. */
		if (err instanceof AppAccessError && err.reason === "insufficient_role") {
			log.warn(`[apps] save denied by role (403): ${err.message}`);
			return Response.json(
				{ error: err.message, type: "reauth_denied" },
				{ status: 403 },
			);
		}
		if (err instanceof AppProjectChangedError) {
			log.warn(`[apps] save scope changed (409): ${err.message}`);
			return Response.json(
				{ error: err.message, type: "app_changed" },
				{ status: 409 },
			);
		}
		if (err instanceof CommitReauthError) {
			/* The commit-time gate observed stale edit authority. The typed 403
			 * pauses client PUTs and triggers one authoritative view GET; that GET may
			 * resolve to view-only access, a new Project/editor tuple, or confirmed
			 * revocation. The rejected batch remains local across that decision. */
			log.warn(`[apps] save denied (403): ${err.message}`);
			return Response.json(
				{ error: err.message, type: "reauth_denied" },
				{ status: 403 },
			);
		}
		if (err instanceof BlueprintCommitRejectedError) {
			/* The delta is invalid against the fresh server doc — a genuine
			 * fresh-doc commit-gate rejection (often, but not exclusively, an edit
			 * colliding with a collaborator's change). Return the typed 409 with its
			 * person-to-person message; the reconciler drops only this rejected batch
			 * while its authoritative reload preserves later pending work. */
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
