import type { NextRequest } from "next/server";
import { ApiError } from "@/lib/apiError";
import { requireSession } from "@/lib/auth-utils";
import { rebuildFieldParent } from "@/lib/doc/fieldParent";
import { userFacingError } from "@/lib/doc/userFacingErrors";
import { type BlueprintDoc, blueprintDocSchema } from "@/lib/domain";
import { collectBoundaryViolations } from "@/lib/media/boundaryValidation";
import { resolveMediaManifest } from "@/lib/media/manifest";

/**
 * Everything the two CommCare export routes need once their shared front half
 * has run: the validated blueprint and its resolved media manifest. (The owner
 * id stays internal — it scopes the boundary gate and manifest here, and
 * neither route needs it again, so it isn't surfaced.)
 */
export interface PreparedCompileRequest {
	/** The validated blueprint with its derived `fieldParent` index rebuilt. */
	doc: BlueprintDoc;
	/**
	 * Resolved media assets (rows + bytes) keyed by asset id; an empty map when
	 * the doc references no media. Inferred from `resolveMediaManifest` so this
	 * module needn't import the `AssetManifest` type across the `@/lib/commcare`
	 * emission boundary.
	 */
	assets: Awaited<ReturnType<typeof resolveMediaManifest>>;
}

/**
 * The shared front half of the two CommCare export routes — `/api/compile`
 * (`.ccz`) and `/api/compile/json` (HQ JSON). Both must authenticate, parse and
 * validate the posted `BlueprintDoc`, rebuild its derived `fieldParent` index,
 * run the zero-tolerance boundary gate, and resolve the owner's media manifest
 * BEFORE they diverge on how they emit (package an archive vs. expand to
 * JSON). That whole preamble lives here so the two routes can't drift on the
 * gate ordering, the schema-error shape, or the manifest options.
 *
 * Every failure boundary throws an {@link ApiError} carrying the right status
 * and detail lines; each route's `catch` hands it to `handleApiError`. The only
 * per-route difference is the gate wording, so the caller passes the verb
 * that completes "…isn't ready to <verb>."
 */
export async function prepareCompileRequest(
	req: NextRequest,
	{ boundaryErrorVerb }: { boundaryErrorVerb: "compile" | "export" },
): Promise<PreparedCompileRequest> {
	const session = await requireSession(req);
	const body = await req.json();
	const { doc } = body;

	if (!doc) {
		throw new ApiError("doc is required", 400);
	}

	const parsedDoc = blueprintDocSchema.safeParse(doc);
	if (!parsedDoc.success) {
		throw new ApiError(
			"Invalid doc",
			400,
			parsedDoc.error.issues.map((e) => `${e.path.join(".")}: ${e.message}`),
		);
	}

	// `fieldParent` is derived, not persisted; rebuild it from
	// `moduleOrder`/`formOrder`/`fieldOrder` before any expand/compile walk
	// can traverse the doc.
	const docWithParent: BlueprintDoc = { ...parsedDoc.data, fieldParent: {} };
	rebuildFieldParent(docWithParent);

	// The transaction-boundary gate — zero tolerance, before any expensive
	// work. Every finding (soundness, completeness, media-state) rejects the
	// export with the rule's own actionable message: an invalid app must
	// never leave for a device or CommCare HQ, and a stale media reference
	// would otherwise make the media-ON `expandDoc` throw `requireAssetRef`
	// → opaque 500.
	const violations = await collectBoundaryViolations(
		docWithParent,
		session.user.id,
	);
	if (violations.length > 0) {
		// The concise builder copy on the detail lines — this is a
		// user-facing failure. (The SA's compile path reads the verbose
		// `message` through its own envelope, not this route.)
		throw new ApiError(
			`This app isn't ready to ${boundaryErrorVerb} — fix the issues below, then try again.`,
			422,
			violations.map(userFacingError),
		);
	}

	// Resolve the manifest (rows + bytes) for this owner. A media-free doc
	// resolves to an empty manifest at no byte cost.
	const assets = await resolveMediaManifest(docWithParent, session.user.id, {
		withBytes: true,
	});

	return { doc: docWithParent, assets };
}
