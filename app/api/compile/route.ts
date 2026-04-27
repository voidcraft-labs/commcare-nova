import { randomUUID } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";
import { AutoFixer } from "@/lib/agent";
import { requireSession } from "@/lib/auth-utils";
import { compileCcz } from "@/lib/commcare/compiler";
import { expandDoc } from "@/lib/commcare/expander";
import { rebuildFieldParent } from "@/lib/doc/fieldParent";
import { blueprintDocSchema } from "@/lib/domain";
import { log } from "@/lib/logger";
import { saveCcz } from "@/lib/store";

/**
 * CCZ compile endpoint.
 *
 * Accepts the normalized `BlueprintDoc` in the body, expands it to HQ
 * JSON via `expandDoc`, runs the auto-fixer over the XForm attachments,
 * and hands the result to `compileCcz` for packaging. Both the
 * expansion and the compile walk consume the normalized doc directly —
 * no legacy wire-shape conversion survives on this path.
 */
export async function POST(req: NextRequest) {
	try {
		await requireSession(req);
		const body = await req.json();
		const { doc } = body;

		if (!doc) {
			return NextResponse.json({ error: "doc is required" }, { status: 400 });
		}

		const parsedDoc = blueprintDocSchema.safeParse(doc);
		if (!parsedDoc.success) {
			return NextResponse.json(
				{
					error: "Invalid doc",
					details: parsedDoc.error.issues.map(
						(e) => `${e.path.join(".")}: ${e.message}`,
					),
				},
				{ status: 400 },
			);
		}

		// `fieldParent` is derived, not persisted; rebuild it from
		// `moduleOrder`/`formOrder`/`fieldOrder` before `expandDoc` can
		// walk the doc.
		const docWithParent = { ...parsedDoc.data, fieldParent: {} };
		rebuildFieldParent(docWithParent);

		// Expand domain doc to HQ JSON.
		const hqJson = expandDoc(docWithParent);

		// Auto-fix the emitted XForm XML attachments in place.
		const autoFixer = new AutoFixer();
		const { files: fixedFiles } = autoFixer.fix(hqJson._attachments);
		for (const [key, value] of Object.entries(fixedFiles)) {
			hqJson._attachments[key] = value;
		}

		const buffer = compileCcz(hqJson, doc.appName, docWithParent);

		// Store buffer for download.
		const compileId = randomUUID();
		await saveCcz(compileId, buffer);

		return NextResponse.json({
			success: true,
			compileId,
			downloadUrl: `/api/compile/${compileId}/download`,
			appName: doc.appName,
		});
	} catch (err) {
		// Log the real error server-side but return a generic message to avoid
		// leaking internal paths or library details to the client.
		log.error("[compile] compilation failed", err);
		return NextResponse.json({ error: "Compilation failed" }, { status: 500 });
	}
}
