import { type NextRequest, NextResponse } from "next/server";
import { v4 as uuidv4 } from "uuid";
import { AutoFixer } from "@/lib/agent";
import { requireSession } from "@/lib/auth-utils";
import { expandDoc } from "@/lib/commcare";
import { rebuildFieldParent } from "@/lib/doc/fieldParent";
import { toBlueprint } from "@/lib/doc/legacyBridge";
import { blueprintDocSchema } from "@/lib/domain";
import { log } from "@/lib/logger";
import { CczCompiler } from "@/lib/services/cczCompiler";
import { saveCcz } from "@/lib/store";

/**
 * CCZ compile endpoint.
 *
 * Accepts the normalized `BlueprintDoc` in the body, expands it to HQ
 * JSON via `expandDoc`, runs the auto-fixer over the XForm attachments,
 * and hands the result to the CCZ compiler for packaging. The compiler
 * currently reads per-form type from the nested `AppBlueprint` shape,
 * so this route materializes one via `toBlueprint` at that single
 * boundary and passes the domain doc to `expandDoc` directly.
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
						(e: { path: PropertyKey[]; message: string }) =>
							`${e.path.join(".")}: ${e.message}`,
					),
				},
				{ status: 400 },
			);
		}

		// `fieldParent` is derived on load (not persisted); rebuild here so
		// the doc is fully usable by the expander even when the payload
		// arrived from a plain JSON body.
		const docWithParent = { ...parsedDoc.data, fieldParent: {} };
		rebuildFieldParent(docWithParent);

		// Expand domain doc to HQ JSON.
		const hqJson = expandDoc(docWithParent);

		// Auto-fix the emitted XForm XML attachments in place.
		const autoFixer = new AutoFixer();
		const attachments = hqJson._attachments || {};
		const files: Record<string, string> = {};
		for (const [key, value] of Object.entries(attachments)) {
			files[key] = value as string;
		}
		const { files: fixedFiles } = autoFixer.fix(files);
		for (const [key, value] of Object.entries(fixedFiles)) {
			hqJson._attachments[key] = value;
		}

		// `CczCompiler` reads per-form type off the nested `AppBlueprint`
		// shape, so materialize one here for that single call. Expansion
		// above consumed the domain doc directly.
		const blueprint = toBlueprint(docWithParent);
		const compiler = new CczCompiler();
		const buffer = await compiler.compile(hqJson, doc.appName, blueprint);

		// Store buffer for download.
		const compileId = uuidv4();
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
