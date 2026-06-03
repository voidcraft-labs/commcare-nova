import type { NextRequest } from "next/server";
import { ApiError } from "@/lib/apiError";
import { requireSession } from "@/lib/auth-utils";
import { errorToString } from "@/lib/commcare/validator/errors";
import { rebuildFieldParent } from "@/lib/doc/fieldParent";
import { type BlueprintDoc, blueprintDocSchema } from "@/lib/domain";
import { resolveMediaManifest } from "@/lib/media/manifest";
import { collectMediaValidationErrors } from "@/lib/media/mediaValidation";

/**
 * Everything the two CommCare export routes need once their shared front half
 * has run: the authenticated owner, the validated blueprint, and its resolved
 * media manifest.
 */
export interface PreparedCompileRequest {
	/** The authenticated caller's user id — the owner all media is scoped to. */
	ownerId: string;
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
 * run the media-readiness gate, and resolve the owner's media manifest BEFORE
 * they diverge on how they emit (package an archive vs. expand to JSON). That
 * whole preamble lives here so the two routes can't drift on the gate ordering,
 * the schema-error shape, or the manifest options.
 *
 * Every failure boundary throws an {@link ApiError} carrying the right status
 * and detail lines; each route's `catch` hands it to `handleApiError`. The only
 * per-route difference is the media-gate wording, so the caller passes the verb
 * that completes "…references media that isn't ready to <verb>."
 */
export async function prepareCompileRequest(
	req: NextRequest,
	{ mediaErrorVerb }: { mediaErrorVerb: "compile" | "export" },
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

	// Both export paths are media-ON (the `.ccz` bundles the bytes; the JSON
	// export ships a multimedia zip), so a stale media reference (deleted,
	// still-uploading, foreign-owned, or kind-mismatched asset) would make
	// `expandDoc` throw `requireAssetRef` → opaque 500. Run the media rules
	// first and surface the actionable message instead.
	const mediaErrors = await collectMediaValidationErrors(
		docWithParent,
		session.user.id,
	);
	if (mediaErrors.length > 0) {
		throw new ApiError(
			`This app references media that isn't ready to ${mediaErrorVerb}.`,
			400,
			mediaErrors.map(errorToString),
		);
	}

	// Resolve the manifest (rows + bytes) for this owner. A media-free doc
	// resolves to an empty manifest at no byte cost.
	const assets = await resolveMediaManifest(docWithParent, session.user.id, {
		withBytes: true,
	});

	return { ownerId: session.user.id, doc: docWithParent, assets };
}
