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
import type { TargetFacts } from "@/lib/commcare/targetFacts";
import type { WireIdentity } from "@/lib/commcare/wireIdentity";
import { installationArchiveIssue } from "@/lib/domain/installationProfiles";
import type { Uuid } from "@/lib/domain/uuid";
import type { PreparedExportBoundary } from "./boundaryValidation";

/**
 * The `.ccz` for a document the export boundary prepared in `ccz` mode.
 *
 * The archive is made for one published project space: `runtimeTarget`
 * names its server, its project space and the HQ app that holds the app
 * there, and `identity` gives that deployment's menu and form ids and the word
 * each case list column's field keeps there, which names the column's app
 * strings as HQ's build there names them. So no
 * archive is compiled without a target, and its profile tells a phone where
 * to sign in, sync and send forms. `deployment` gives the other facts of
 * that deployment the archive reads: whether the project space holds
 * `USH_EMPTY_CASE_LIST_TEXT`, so every case list carries the empty-list text
 * exactly where HQ's build there does; how many HQ apps the deployment held
 * before this one, which the archive's version counts; and what the project
 * space keeps of the values Nova leaves to CommCare HQ (`targetFacts`, read
 * from the deployment's baseline, or null where none was read), which the
 * archive writes as HQ's build there does; and the id prefix each keyed
 * create's cases stand under in an app Nova brought in from there
 * (`keyedCaseIdPrefixes`, empty everywhere else), so a key entered again on
 * the phone files under the case CommCare HQ already holds.
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
		readonly installationProfileUuid?: Uuid;
		readonly emptyCaseListText: boolean;
		readonly earlierHqApps: number;
		/** The deployment's live app mapping is one Nova brought in. */
		readonly adopted: boolean;
		readonly targetFacts: TargetFacts | null;
		readonly keyedCaseIdPrefixes: ReadonlyMap<Uuid, string>;
	},
): Buffer {
	if (prepared.mode !== "ccz") {
		throw new Error(
			`A local archive is built from a document the export boundary prepared for one (mode "ccz"), which embeds its lookup data; this one was prepared for "${prepared.mode}".`,
		);
	}
	const { doc, assets, attachmentTarget, compiledAtSeq } = prepared;
	const profileIssue = installationArchiveIssue(
		doc,
		deployment.installationProfileUuid,
	);
	if (profileIssue) throw new Error(profileIssue);
	const hqJson = expandDoc(doc, {
		installationProfileUuid: deployment.installationProfileUuid,
		runtimeTarget,
		identity,
		assets,
		attachmentTarget,
		...(prepared.lookupNaming !== undefined && {
			lookupNaming: prepared.lookupNaming,
		}),
		keyedCaseIdPrefixes: deployment.keyedCaseIdPrefixes,
	});
	return compileCcz(hqJson, doc.appName, doc, {
		installationProfileUuid: deployment.installationProfileUuid,
		runtimeTarget,
		identity,
		assets,
		compiledAtSeq,
		earlierHqApps: deployment.earlierHqApps,
		emptyCaseListText: deployment.emptyCaseListText,
		adopted: deployment.adopted,
		targetFacts: deployment.targetFacts,
		...(prepared.lookupWire !== undefined && { lookup: prepared.lookupWire }),
	});
}
