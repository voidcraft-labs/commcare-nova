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
 * Beside the body it returns the ownership descriptor the drift baseline
 * recorded after this import keeps: what Nova owns inside the keys HQ holds
 * beside Nova's own. The overlay (`targetOverlay.ts`) computes it from what
 * Nova set, never from the body's bytes, which carry the target's values
 * too, and this is its one producer.
 *
 * Pure: it reads no store and sends nothing. The source read stays with the
 * caller because it is a request to HQ that can fail on its own terms, and
 * the caller decides what that failure means for the publish.
 */

import type { HqApplication } from "@/lib/commcare";
import { hasEffectiveSearch } from "@/lib/commcare/derivedProfile";
import {
	expandAppShell,
	expandDocSteps,
	type HqAppShell,
} from "@/lib/commcare/expander";
import type { HqAppSource } from "@/lib/commcare/hq/appSource";
import { withoutPathOnlyLogoRefs } from "@/lib/commcare/targetLogoRefs";
import {
	type DerivedProfileTargetState,
	projectApplicationForTarget,
	shellOwnership,
} from "@/lib/commcare/targetOverlay";
import type { WireIdentity } from "@/lib/commcare/wireIdentity";
import type { Uuid } from "@/lib/domain/uuid";
import type { PreparedExportBoundary } from "@/lib/export/boundaryValidation";
import type { ProjectSpaceCompatibilityReport } from "@/lib/publish/projectSpaceCompatibility";
import type { DeploymentTargetKey } from "./store";
import type { AppOwnership } from "./types";

/** One import body, and the overlay keys it writes. */
export interface HqImportApplicationResult<Body> {
	readonly application: Body;
	readonly ownership: AppOwnership;
}

/** The mapped app an update fills or replaces, and its source as HQ holds it now. */
export interface HqImportApplicationUpdate {
	readonly appId: string;
	/**
	 * The app's source, the publish's last read before the import. HQ
	 * replaces `translations`, `add_ons`, `profile` and `logo_refs` whole
	 * when an import carries one, so the overlays write Nova's part of each
	 * over this read's value and carry the rest, and `logo_refs` is sent only
	 * to take out an entry HQ's own uploader never writes.
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
	/**
	 * Whose display name each language carries: `"target"` exactly where the
	 * app mapping this publish updates in place is `adopted`, so a name the
	 * project space holds is carried and an absent one stays absent; `"nova"`
	 * otherwise, which writes Nova's label.
	 */
	readonly languageNames: "nova" | "target";
	/**
	 * Who writes a seeded setting the project space holds no value for:
	 * `"target"` exactly where the mapping this publish updates in place is
	 * `adopted`, which leaves it as it is; `"nova"` otherwise, which writes
	 * Nova's seed.
	 */
	readonly seeds: "nova" | "target";
	/**
	 * The id prefix each keyed create's cases stand under on this target, by
	 * operation (`adoption.ts::keyedCaseIdPrefixesFor` over the target's
	 * rows), so a key entered again files under the case CommCare HQ already
	 * holds for it. Empty for every target that holds none.
	 */
	readonly keyedCaseIdPrefixes: ReadonlyMap<Uuid, string>;
}

/**
 * How the derived Search profile key meets this target. An app without an
 * effective Search does not need it; otherwise the large-Search advisory
 * decides, and anything short of a definite answer is `unverified`, which
 * leaves a target's current custom properties alone on an update.
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
): HqImportApplicationResult<HqApplication>;
export function hqImportApplication(
	input: HqImportApplicationInput & { readonly update: null },
): HqImportApplicationResult<HqAppShell>;
export function hqImportApplication(
	input: HqImportApplicationInput,
): HqImportApplicationResult<HqApplication | HqAppShell>;
export function hqImportApplication(
	input: HqImportApplicationInput,
): HqImportApplicationResult<HqApplication | HqAppShell> {
	const { prepared, update } = input;
	/* The shell meets no source read and no overlay, and holds nothing that
	 * names the target, an asset or a lookup table. */
	if (update === null) {
		const shell = expandAppShell(prepared.doc);
		return { application: shell, ownership: shellOwnership(shell) };
	}
	const steps = hqImportApplicationSteps({ ...input, update });
	for (;;) {
		const step = steps.next();
		if (step.done) return step.value;
	}
}

/**
 * `hqImportApplication` of an update a part at a time: its emission stops
 * between its parts (`expander.ts::expandDocSteps`) until it is resumed, so a
 * caller on a request can let the event loop turn while an app at the
 * bring-in byte cap is emitted. The application is `hqImportApplication`'s,
 * which drives this.
 */
export function* hqImportApplicationSteps(
	input: HqImportApplicationInput & {
		readonly update: HqImportApplicationUpdate;
	},
): Generator<void, HqImportApplicationResult<HqApplication>, void> {
	const { prepared, target, update } = input;
	/* The naming has to travel with the app, not just with the data. A
	 * lookup-backed select compiles to an `instance(...)` reference whichever
	 * mode is emitting, and `buildXForm` refuses without it. */
	const generated = yield* expandDocSteps(prepared.doc, {
		runtimeTarget: {
			server: target.server,
			domain: target.domain,
			appId: update.appId,
		},
		identity: input.identity,
		assets: prepared.assets,
		attachmentTarget: prepared.attachmentTarget,
		...(prepared.lookupNaming && { lookupNaming: prepared.lookupNaming }),
		keyedCaseIdPrefixes: input.keyedCaseIdPrefixes,
	});
	yield;
	const projected = projectApplicationForTarget(
		generated,
		update.source,
		derivedProfileTargetState(input),
		{ languageNames: input.languageNames, seeds: input.seeds },
	);
	/* Publish writes no logo. The key goes out only where the target holds a
	 * path-only entry, which HQ's linked-app pull cannot read, and then
	 * carries every other entry as HQ holds it. */
	const logoRefs = withoutPathOnlyLogoRefs(update.source.logoRefs);
	if (logoRefs === null) return projected;
	const { _attachments: attachments, ...rest } = projected.application;
	return {
		application: {
			...rest,
			logo_refs: logoRefs,
			_attachments: attachments,
		} as HqApplication,
		ownership: projected.ownership,
	};
}
