/**
 * The application JSON one publish sends to CommCare HQ's import.
 *
 * `publishAppToHq` is the one caller in production. A first publish sends
 * two imports: the empty shell (`update: null`), which holds no menu and so
 * no form id for HQ to re-mint, then the update that fills it. Every later
 * publish sends the update alone. For the update it hands this the export
 * generation preflight validated, the target, what the compatibility check
 * found there, the app's source as its last read before the import, and the
 * target's ids. The proof harness calls it with the same inputs, so the body
 * it applies to HQ is assembled by this code rather than a copy of it.
 *
 * Pure: it reads no store and sends nothing. The source read stays with the
 * caller because it is a request to HQ that can fail on its own terms, and
 * the caller decides what that failure means for the publish.
 */

import type { HqApplication } from "@/lib/commcare";
import { hasEffectiveSearch } from "@/lib/commcare/derivedProfile";
import {
	expandAppShell,
	expandDoc,
	type HqAppShell,
} from "@/lib/commcare/expander";
import type { HqAppSource } from "@/lib/commcare/hq/appSource";
import {
	type DerivedProfileTargetState,
	projectUpdatedAppProfileForTarget,
} from "@/lib/commcare/targetProfile";
import type { WireIdentity } from "@/lib/commcare/wireIdentity";
import type { PreparedExportBoundary } from "@/lib/export/boundaryValidation";
import type { ProjectSpaceCompatibilityReport } from "@/lib/publish/projectSpaceCompatibility";
import type { DeploymentTargetKey } from "./store";

/** The mapped app an update fills or replaces, and its source as HQ holds it now. */
export interface HqImportApplicationUpdate {
	readonly appId: string;
	/**
	 * The app's source, the publish's last read before the import. HQ replaces
	 * the whole profile when an import carries one, so an update may only
	 * change Nova's own derived key on top of this read's bag.
	 */
	readonly source: HqAppSource;
}

export interface HqImportApplicationInput {
	/** The exact export generation preflight validated. */
	readonly prepared: Pick<
		PreparedExportBoundary,
		"doc" | "assets" | "attachmentTarget" | "lookupNaming"
	>;
	readonly target: DeploymentTargetKey;
	/** What the publish's compatibility check found on the target. */
	readonly compatibility: Pick<ProjectSpaceCompatibilityReport, "advisories">;
	/** `null` is the empty shell a first publish creates before its update. */
	readonly update: HqImportApplicationUpdate | null;
	/** The ids this target holds for each menu and form. */
	readonly identity: WireIdentity;
}

/**
 * How the derived Search profile key meets this target. An app without an
 * effective Search does not need it; otherwise the large-Search advisory
 * decides, and anything short of a definite answer is `unverified`, which
 * leaves a target's current profile alone on an update.
 */
function derivedProfileTargetState(
	input: HqImportApplicationInput,
): DerivedProfileTargetState {
	if (!hasEffectiveSearch(input.prepared.doc)) return "not-needed";
	const advisory = input.compatibility.advisories.find(
		(item) => item.id === "large-search-performance",
	);
	return advisory?.state === "available" || advisory?.state === "missing"
		? advisory.state
		: "unverified";
}

/** The application JSON the import sends for one publish. */
export function hqImportApplication(
	input: HqImportApplicationInput & {
		readonly update: HqImportApplicationUpdate;
	},
): HqApplication;
export function hqImportApplication(
	input: HqImportApplicationInput & { readonly update: null },
): HqAppShell;
export function hqImportApplication(
	input: HqImportApplicationInput,
): HqApplication | HqAppShell;
export function hqImportApplication(
	input: HqImportApplicationInput,
): HqApplication | HqAppShell {
	const { prepared, target, update } = input;
	/* The shell meets no source read and no overlay, and holds nothing that
	 * names the target, an asset or a lookup table. */
	if (update === null) return expandAppShell(prepared.doc);
	/* The naming has to travel with the app, not just with the data. A
	 * lookup-backed select compiles to an `instance(...)` reference whichever
	 * mode is emitting, and `buildXForm` refuses without it. */
	const generated = expandDoc(prepared.doc, {
		runtimeTarget: {
			server: target.server,
			domain: target.domain,
			appId: update.appId,
		},
		identity: input.identity,
		assets: prepared.assets,
		attachmentTarget: prepared.attachmentTarget,
		...(prepared.lookupNaming && { lookupNaming: prepared.lookupNaming }),
	});
	return projectUpdatedAppProfileForTarget(
		generated,
		update.source.profile,
		derivedProfileTargetState(input),
	).application;
}
