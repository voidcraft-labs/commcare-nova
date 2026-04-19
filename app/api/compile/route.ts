import { type NextRequest, NextResponse } from "next/server";
import { v4 as uuidv4 } from "uuid";
import { AutoFixer } from "@/lib/agent";
import { requireSession } from "@/lib/auth-utils";
import { toBlueprint } from "@/lib/doc/legacyBridge";
import { blueprintDocSchema } from "@/lib/domain";
import { log } from "@/lib/logger";
import { CczCompiler } from "@/lib/services/cczCompiler";
import { expandBlueprint } from "@/lib/services/hqJsonExpander";
import { saveCcz } from "@/lib/store";

/**
 * CCZ compile endpoint.
 *
 * Accepts the normalized `BlueprintDoc` (the domain shape) in the body,
 * converts to CommCare's wire `AppBlueprint` server-side via
 * `legacyBridge.toBlueprint`, then runs the HQ JSON expander → auto-fixer
 * → CCZ packager. This is an external boundary: input is domain, output
 * is CommCare's expected binary format. The translation is legitimate.
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

		// Domain → wire at the CommCare boundary. `fieldParent` is transient
		// (not persisted, not needed by the expander) — seed an empty index
		// to satisfy the type contract without rebuilding the reverse map.
		const blueprint = toBlueprint({ ...parsedDoc.data, fieldParent: {} });

		// Expand blueprint to HQ JSON
		const hqJson = expandBlueprint(blueprint);

		// Auto-fix
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

		// Compile to CCZ
		const compiler = new CczCompiler();
		const buffer = await compiler.compile(
			hqJson,
			blueprint.app_name,
			blueprint,
		);

		// Store buffer for download
		const compileId = uuidv4();
		await saveCcz(compileId, buffer);

		return NextResponse.json({
			success: true,
			compileId,
			downloadUrl: `/api/compile/${compileId}/download`,
			appName: blueprint.app_name,
		});
	} catch (err) {
		// Log the real error server-side but return a generic message to avoid
		// leaking internal paths or library details to the client.
		log.error("[compile] compilation failed", err);
		return NextResponse.json({ error: "Compilation failed" }, { status: 500 });
	}
}
