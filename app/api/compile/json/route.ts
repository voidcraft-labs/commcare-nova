import { type NextRequest, NextResponse } from "next/server";
import { ApiError, handleApiError } from "@/lib/apiError";
import { requireSession } from "@/lib/auth-utils";
import { toBlueprint } from "@/lib/doc/legacyBridge";
import { blueprintDocSchema } from "@/lib/domain";
import { expandBlueprint } from "@/lib/services/hqJsonExpander";
import { sanitizeFilename } from "@/lib/utils/sanitize";

/**
 * HQ-JSON export endpoint.
 *
 * Accepts the normalized `BlueprintDoc` domain shape and converts to
 * CommCare's `AppBlueprint` wire format server-side at the boundary.
 * The output is the HQ-expected JSON file for upload to CommCare HQ —
 * this is an external emission boundary, analogous to the XForm XML
 * emitter. Domain→wire translation is legitimate here.
 */
export async function POST(req: NextRequest) {
	try {
		await requireSession(req);
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
				parsedDoc.error.issues.map(
					(e: { path: PropertyKey[]; message: string }) =>
						`${e.path.join(".")}: ${e.message}`,
				),
			);
		}

		// Domain → wire at the CommCare emission boundary. `fieldParent`
		// is derived on load and not persisted; seed empty to satisfy the
		// BlueprintDoc type without rebuilding the reverse index.
		const blueprint = toBlueprint({ ...parsedDoc.data, fieldParent: {} });
		const hqJson = expandBlueprint(blueprint);
		const jsonStr = JSON.stringify(hqJson, null, 2);

		return new NextResponse(jsonStr, {
			headers: {
				"Content-Type": "application/json",
				"Content-Disposition": `attachment; filename="${sanitizeFilename(blueprint.app_name)}.json"`,
			},
		});
	} catch (err) {
		return handleApiError(
			err instanceof Error ? err : new Error("JSON export failed"),
		);
	}
}
