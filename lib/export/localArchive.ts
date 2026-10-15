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
import type { WireIdentity } from "@/lib/commcare/wireIdentity";
import type { PreparedExportBoundary } from "./boundaryValidation";

/**
 * The `.ccz` for a document the export boundary prepared in `ccz` mode.
 *
 * The archive is made for one published project space: `runtimeTarget`
 * names its server, its project space and the HQ app that holds the app
 * there, and `identity` gives that deployment's menu and form ids. So no
 * archive is compiled without a target, and its profile tells a phone where
 * to sign in, sync and send forms. `deployment` gives the two other facts of
 * that deployment the archive reads: whether the project space holds
 * `USH_EMPTY_CASE_LIST_TEXT`, so every case list carries the empty-list text
 * exactly where HQ's build there does, and how many HQ apps the deployment
 * held before this one, which the archive's version counts.
 *
 * The expander stamps the prepared media manifest's references, resolves
 * attachment links against the prepared target, and names lookup tables
 * as the validated snapshot does; the compiler bundles the media bytes,
 * embeds the budget-checked lookup fixtures, and writes the document's
 * `mutation_seq`, the sequence, as every form's and locale's version, so a
 * later download is newer in every resource the document changed.
 */
export function compileLocalArchive(
	prepared: PreparedExportBoundary,
	runtimeTarget: RuntimeTarget,
	identity: WireIdentity,
	deployment: {
		readonly emptyCaseListText: boolean;
		readonly earlierHqApps: number;
	},
): Buffer {
	if (prepared.mode !== "ccz") {
		throw new Error(
			`A local archive is built from a document the export boundary prepared for one (mode "ccz"), which embeds its lookup data; this one was prepared for "${prepared.mode}".`,
		);
	}
	const { doc, assets, attachmentTarget, compiledAtSeq } = prepared;
	const hqJson = expandDoc(doc, {
		runtimeTarget,
		identity,
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
		earlierHqApps: deployment.earlierHqApps,
		emptyCaseListText: deployment.emptyCaseListText,
		...(prepared.lookupWire !== undefined && { lookup: prepared.lookupWire }),
	});
}
