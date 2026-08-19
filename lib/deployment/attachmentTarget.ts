// lib/deployment/attachmentTarget.ts
//
// Which CommCare HQ address an attachment link may honestly point at.
//
// Pure, so the export boundary that resolves it and any surface that
// explains it read the same rule. The sibling `previewTarget.ts` answers a
// narrower question — which project space Preview may name — and the two
// deliberately stay apart: a domain slug is enough to say who a worker
// signed in as, and an address needs a whole origin as well.

import { COMMCARE_SERVERS } from "@/lib/commcare/servers";
import type { AttachmentUrlTarget } from "@/lib/commcare/xform/captureUrlNode";
import { deploymentDisplaysAsReached } from "./stateMachine";
import type { DeploymentRecord } from "./types";

/**
 * The origin and project space an attachment URL is built from, re-exported
 * so a caller resolving a target reads one module rather than two.
 */
export type { AttachmentUrlTarget };

/** One CommCare HQ install plus the project space on it. */
export interface AttachmentTargetKey {
	readonly server: DeploymentRecord["server"];
	readonly domain: string;
}

/** Where an attachment link would resolve, and why. */
export type AttachmentDeploymentTarget =
	| { readonly kind: "known"; readonly target: AttachmentTargetKey }
	/** No project space holds this app yet. */
	| { readonly kind: "none" }
	/** Several do, so naming one would be a guess. */
	| {
			readonly kind: "ambiguous";
			readonly targets: readonly AttachmentTargetKey[];
	  };

/**
 * A distinctness key over both halves.
 *
 * `:` separates them because a CommCare project space name cannot contain
 * one and the server ids are a closed enum, so no pair can spell another
 * pair's key.
 */
function targetKey(target: AttachmentTargetKey): string {
	return `${target.server}:${target.domain}`;
}

/**
 * Resolve the one CommCare HQ project space an attachment link can name.
 *
 * A deployment counts once its app is genuinely on that project space, so
 * a submission made against it would be there to link to. That is
 * `deploymentDisplaysAsReached` rather than the strict predicate, for the
 * same reason Preview uses it: a probe that failed did not undo the
 * upload, and letting a transient "Nova could not check" withdraw the URL
 * would silently stop a form writing case data for a reason that has
 * nothing to do with the app.
 *
 * Distinctness is over the server AND the domain, not the domain alone.
 * CommCare's US, India, and EU installations share no account database, so
 * two of them can hold unrelated project spaces of the same name; picking
 * either origin would build links that resolve for one set of workers and
 * nowhere for the other.
 */
export function resolveAttachmentDeploymentTarget(
	deployments: readonly Pick<
		DeploymentRecord,
		"state" | "resumePhase" | "server" | "domain"
	>[],
): AttachmentDeploymentTarget {
	const live = deployments.filter((deployment) =>
		deploymentDisplaysAsReached(deployment, "uploaded"),
	);
	const byKey = new Map<string, AttachmentTargetKey>();
	for (const deployment of live) {
		const target = { server: deployment.server, domain: deployment.domain };
		byKey.set(targetKey(target), target);
	}
	const targets = [...byKey.values()];
	const only = targets[0];
	if (targets.length === 1 && only !== undefined) {
		return { kind: "known", target: only };
	}
	if (targets.length === 0) return { kind: "none" };
	return { kind: "ambiguous", targets };
}

/** The origin and domain an attachment URL is built from. */
export function attachmentUrlTarget(
	target: AttachmentTargetKey,
): AttachmentUrlTarget {
	return {
		origin: COMMCARE_SERVERS[target.server].baseUrl,
		domain: target.domain,
	};
}

/**
 * The attachment URL halves, or `null` when Nova cannot honestly supply
 * them.
 *
 * `null` means the URL property is not written at all — not written empty,
 * and never written against a placeholder origin. A link that looks
 * deliberate and resolves nowhere is worse than no link.
 */
export function attachmentUrlTargetFor(
	target: AttachmentDeploymentTarget,
): AttachmentUrlTarget | null {
	return target.kind === "known" ? attachmentUrlTarget(target.target) : null;
}
