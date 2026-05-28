import { type NextRequest, NextResponse } from "next/server";
import { ApiError, handleApiError } from "@/lib/apiError";
import { requireSession } from "@/lib/auth-utils";
import { expandDoc } from "@/lib/commcare/expander";
import { rebuildFieldParent } from "@/lib/doc/fieldParent";
import { blueprintDocSchema } from "@/lib/domain";
import { sanitizeFilename } from "@/lib/utils/sanitize";

/**
 * HQ-JSON export endpoint.
 *
 * Accepts the normalized `BlueprintDoc` and emits the HQ import JSON
 * directly via `expandDoc`. The output is the HQ-expected JSON file for
 * upload to CommCare HQ — an external emission boundary analogous to
 * the XForm XML emitter.
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
				parsedDoc.error.issues.map((e) => `${e.path.join(".")}: ${e.message}`),
			);
		}

		// `fieldParent` is derived on load and not persisted; rebuild it
		// here so the expander sees a fully usable doc.
		const docWithParent = { ...parsedDoc.data, fieldParent: {} };
		rebuildFieldParent(docWithParent);

		// HQ-bound JSON exports media-free: shipping `multimedia_map` +
		// `logo_refs` + media references without the matching files on
		// the HQ side would render to broken images, which is worse than
		// no images. The `.ccz` compile path keeps media-on because its
		// files ship in the archive.
		const hqJson = expandDoc(docWithParent);
		const jsonStr = JSON.stringify(hqJson, null, 2);

		return new NextResponse(jsonStr, {
			headers: {
				"Content-Type": "application/json",
				"Content-Disposition": `attachment; filename="${sanitizeFilename(docWithParent.appName)}.json"`,
			},
		});
	} catch (err) {
		return handleApiError(
			err instanceof Error ? err : new Error("JSON export failed"),
		);
	}
}
