/**
 * The application JSON one publish sends to CommCare HQ's import.
 *
 * `publishAppToHq` is the one caller in production: it hands this the export
 * generation preflight validated, the target, what the compatibility check
 * found there, and, on an update, the profile it has just read from the
 * mapped app's source. The proof harness calls it with the same inputs, so
 * the body it applies to HQ is assembled by this code rather than a copy of
 * it.
 *
 * Pure: it reads no store and sends nothing. The source read stays with the
 * caller because it is a request to HQ that can fail on its own terms, and
 * the caller decides what that failure means for the publish.
 */

import type { HqApplication, HqApplicationProfile } from "@/lib/commcare";
import { hasEffectiveSearch } from "@/lib/commcare/derivedProfile";
import { expandDoc } from "@/lib/commcare/expander";
import {
	type DerivedProfileTargetState,
	projectNewAppProfileForTarget,
	projectUpdatedAppProfileForTarget,
} from "@/lib/commcare/targetProfile";
import type { PreparedExportBoundary } from "@/lib/export/boundaryValidation";
import type { ProjectSpaceCompatibilityReport } from "@/lib/publish/projectSpaceCompatibility";
import type { DeploymentTargetKey } from "./store";

/** The mapped app an update replaces, and its profile as HQ holds it now. */
export interface HqImportApplicationUpdate {
	readonly appId: string;
	/**
	 * The complete profile from the app's source, read immediately before the
	 * import. HQ replaces the whole profile when an import carries one, so an
	 * update may only change Nova's own derived key on top of this bag.
	 */
	readonly sourceProfile: HqApplicationProfile;
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
	/** `null` creates a new app on the target. */
	readonly update: HqImportApplicationUpdate | null;
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
	input: HqImportApplicationInput,
): HqApplication {
	const { prepared, target, update } = input;
	/* The naming has to travel with the app, not just with the data. A
	 * lookup-backed select compiles to an `instance(...)` reference whichever
	 * mode is emitting, and `buildXForm` refuses without it. */
	const generated = expandDoc(prepared.doc, {
		runtimeTarget: {
			server: target.server,
			domain: target.domain,
			...(update !== null && { appId: update.appId }),
		},
		assets: prepared.assets,
		attachmentTarget: prepared.attachmentTarget,
		...(prepared.lookupNaming && { lookupNaming: prepared.lookupNaming }),
	});
	const state = derivedProfileTargetState(input);
	return update === null
		? projectNewAppProfileForTarget(generated, state).application
		: projectUpdatedAppProfileForTarget(generated, update.sourceProfile, state)
				.application;
}
