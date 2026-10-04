/**
 * The one assembly of a locally installable `.ccz` from a prepared export.
 *
 * The browser download (`app/api/compile/route.ts`), the MCP `compile_app`
 * tool and the proof harness's capture of a download all build the archive
 * here, so what a person installs, what an agent downloads and what the
 * harness checks are the same bytes for the same prepared document.
 */

import "server-only";

import { compileCcz } from "@/lib/commcare/compiler";
import { expandDoc } from "@/lib/commcare/expander";
import type { RuntimeTarget } from "@/lib/commcare/runtimeTarget";
import type { PreparedExportBoundary } from "./boundaryValidation";

/**
 * The `.ccz` for a document the export boundary prepared in `ccz` mode.
 *
 * The expander stamps the prepared media manifest's references, resolves
 * attachment links against the prepared target, and names lookup tables
 * as the validated snapshot does; the compiler bundles the media bytes,
 * embeds the budget-checked lookup fixtures, and writes the document's
 * `mutation_seq` into the profile's `cc-content-version`, so the archive
 * names the exact document version it was built from.
 */
export function compileLocalArchive(
	prepared: PreparedExportBoundary,
	runtimeTarget: RuntimeTarget,
): Buffer {
	if (prepared.mode !== "ccz") {
		throw new Error(
			`A local archive is built from a document the export boundary prepared for one (mode "ccz"), which embeds its lookup data; this one was prepared for "${prepared.mode}".`,
		);
	}
	const { doc, assets, attachmentTarget, compiledAtSeq } = prepared;
	const hqJson = expandDoc(doc, {
		runtimeTarget,
		assets,
		attachmentTarget,
		...(prepared.lookupNaming !== undefined && {
			lookupNaming: prepared.lookupNaming,
		}),
	});
	return compileCcz(hqJson, doc.appName, doc, {
		runtimeTarget,
		assets,
		compiledAtSeq,
		...(prepared.lookupWire !== undefined && { lookup: prepared.lookupWire }),
	});
}
