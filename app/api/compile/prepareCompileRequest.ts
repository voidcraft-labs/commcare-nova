import type { NextRequest } from "next/server";
import {
	ApiError,
	BLUEPRINT_REQUEST_MAX_BYTES,
	readJsonBody,
} from "@/lib/apiError";
import { requireSession } from "@/lib/auth-utils";
import { resolveAppAccess } from "@/lib/db/appAccess";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import { userFacingError } from "@/lib/doc/userFacingErrors";
import type { PersistableDoc } from "@/lib/domain";
import {
	type ExportMode,
	type PreparedExportBoundary,
	prepareExportBoundary,
} from "@/lib/export/boundaryValidation";

/**
 * Everything the two CommCare export routes need once their shared front half
 * has run: the validated blueprint and its exact external-resource generation.
 * The lookup snapshot keeps its authorized Project identity because later
 * emitters must consume the generation validated here; it remains server-only.
 */
export type PreparedCompileRequest = PreparedExportBoundary;

/**
 * The shared front half of the two CommCare export routes — `/api/compile`
 * (`.ccz`) and `/api/compile/json` (HQ JSON). Both must authenticate, parse and
 * validate the posted `BlueprintDoc`, rebuild its derived `fieldParent` index,
 * run the zero-tolerance boundary gate, and resolve the app's Project resources
 * BEFORE they diverge on how they emit (package an archive vs. expand to JSON).
 * That whole preamble lives here so the routes can't drift on gate ordering,
 * schema-error shape, or external-resource generation.
 *
 * Every failure boundary throws an {@link ApiError} carrying the right status
 * and detail lines; each route's `catch` hands it to `handleApiError`. The only
 * per-route difference is the gate wording, so the caller passes the verb
 * that completes "…isn't ready to <verb>."
 */
export async function prepareCompileRequest(
	req: NextRequest,
	{
		boundaryErrorVerb,
		mode,
	}: {
		boundaryErrorVerb: "compile" | "export";
		mode: Extract<ExportMode, "ccz" | "hq-json">;
	},
): Promise<PreparedCompileRequest> {
	const session = await requireSession(req);
	// The client sends only the app id — the blueprint loads server-side, so no
	// whole doc crosses the wire. (The auto-save persists edits within ~1s, and
	// an export is an on-demand action well after the last edit, so the loaded
	// doc is the current one.)
	const body = await readJsonBody(req, BLUEPRINT_REQUEST_MAX_BYTES);
	const appId = (body as { appId?: unknown } | null)?.appId;
	if (typeof appId !== "string") {
		throw new ApiError("appId is required", 400);
	}

	// Membership gate (view) + load the persisted blueprint in one read. An
	// `AppAccessError` (absent / non-member) maps to 404 — the IDOR-safe
	// not-found posture.
	const access = await resolveAppAccess(appId, session.user.id, "view");
	const { app } = access;

	// The shared hydration chokepoint: fieldParent rebuilt + the
	// deterministic `order`/option-`uuid` backfill a legacy stored doc needs,
	// so the wire the compiler emits reflects the SAME display sequence the
	// builder shows (a partially-keyed legacy doc otherwise sorts keyed-ahead-
	// of-keyless and the export order diverges from the canvas).
	const docWithParent = hydratePersistedBlueprint(
		app.blueprint as PersistableDoc,
	);

	// The transaction-boundary gate — zero tolerance, before any expensive
	// work. Every finding (soundness, completeness, media-state) rejects the
	// export with the rule's own actionable message: an invalid app must
	// never leave for a device or CommCare HQ, and a stale media reference
	// would otherwise make the media-ON `expandDoc` throw `requireAssetRef`
	// → opaque 500.
	const boundary = await prepareExportBoundary({
		mode,
		access: {
			projectId: access.projectId,
			role: access.role,
			actorUserId: access.actorUserId,
		},
		doc: docWithParent,
		compiledAtSeq: app.mutation_seq,
	});
	if (!boundary.ok) {
		// The concise builder copy on the detail lines — this is a
		// user-facing failure. (The SA's compile path reads the verbose
		// `message` through its own envelope, not this route.)
		throw new ApiError(
			`This app isn't ready to ${boundaryErrorVerb} — fix the issues below, then try again.`,
			422,
			boundary.violations.map(userFacingError),
		);
	}

	return boundary.prepared;
}
