import "server-only";

import { hqNestedSelectionFindings } from "@/lib/commcare/hqNestedSelection";
import type { RuntimeTarget } from "@/lib/commcare/runtimeTarget";
import type { CommCareServer } from "@/lib/commcare/servers";
import {
	targetWireIdentity,
	type WireIdentity,
} from "@/lib/commcare/wireIdentity";
import { userFacingError } from "@/lib/doc/userFacingErrors";
import type { BlueprintDoc } from "@/lib/domain";
import type { AttachmentTargetState } from "@/lib/publish/exportAdvisories";
import {
	type AttachmentUrlTarget,
	attachmentUrlTarget,
} from "./attachmentTarget";
import {
	chooseDownloadTarget,
	type DownloadTargetRefusal,
	type ReachedDeploymentTarget,
} from "./runtimeTarget";
import {
	type DeploymentScope,
	readDeploymentIdentityOverrides,
	readReachedDeploymentTargets,
} from "./store";

/**
 * What a download is made for, read from the app's deployments.
 *
 * Its own module rather than a member of `service.ts`, as `previewSpace.ts`
 * is: the compile routes and the publish dialog's action ask one question
 * of the ledger and should not take the publish lifecycle's expander, media
 * bundler and HQ client into their import graph to do it.
 */
export type DownloadTarget =
	| {
			readonly format: "ccz";
			/** The deployment the archive is made for. */
			readonly target: ReachedDeploymentTarget;
			readonly runtimeTarget: RuntimeTarget;
			/** That deployment's overrides over the derivation. */
			readonly identity: WireIdentity;
			readonly attachmentTarget: AttachmentUrlTarget;
			readonly reached: readonly ReachedDeploymentTarget[];
	  }
	| {
			readonly format: "json";
			readonly attachmentTarget: AttachmentUrlTarget | null;
			/** The reached deployments on the chosen server, or all of them. */
			readonly reached: readonly ReachedDeploymentTarget[];
	  };

export type { DownloadTargetRefusal };

/**
 * Whether the download's attachment links name a project space, and if not
 * why: no project space holds the app on the chosen server, or several do.
 */
export function downloadAttachmentState(
	download: DownloadTarget,
): AttachmentTargetState {
	if (download.attachmentTarget !== null) return "known";
	return download.reached.length > 1 ? "ambiguous" : "none";
}

/** One line per selection of `doc` that CommCare HQ cannot take, in the builder's words. */
export function selectionsHeldFromHq(doc: BlueprintDoc): string[] {
	/* Called without lookup naming, so the answer reads which menu's
	 * selection feeds which and never a table's name or rows. */
	return hqNestedSelectionFindings(doc, "hq-upload").map(userFacingError);
}

/**
 * Resolve the project space a download is made for.
 *
 * A read that faults throws rather than answering "no target": a download
 * that silently lost its target would send its forms nowhere and drop a
 * case write from its attachment links. An export is a deliberate action
 * the person can repeat, so failing it and saying so is the honest answer.
 */
export async function resolveDownloadTarget(
	scope: DeploymentScope,
	input: {
		readonly format: "ccz" | "json";
		readonly server?: CommCareServer;
		readonly domain?: string;
		readonly doc: BlueprintDoc;
	},
): Promise<DownloadTarget | DownloadTargetRefusal> {
	const { format, server, domain, doc } = input;
	const reached = await readReachedDeploymentTargets(scope);
	const heldFromHq =
		format === "ccz" && reached.length === 0 ? selectionsHeldFromHq(doc) : [];
	const choice = chooseDownloadTarget(reached, {
		format,
		...(server !== undefined && { server }),
		...(domain !== undefined && { domain }),
		heldFromHq,
	});
	if (choice.kind === "refused") return choice;
	if (format === "json") {
		return {
			format,
			attachmentTarget:
				choice.kind === "project-space"
					? attachmentUrlTarget(choice.target)
					: null,
			reached: reached.filter(
				(target) => server === undefined || target.server === server,
			),
		};
	}
	if (choice.kind !== "project-space") {
		throw new Error(
			"A CCZ is always made for one project space, and the choice named none.",
		);
	}
	const { target } = choice;
	const overrides = await readDeploymentIdentityOverrides(scope, target);
	return {
		format,
		target,
		runtimeTarget: {
			server: target.server,
			domain: target.domain,
			appId: target.hqAppId,
		},
		identity: targetWireIdentity(overrides),
		attachmentTarget: attachmentUrlTarget(target),
		reached,
	};
}
