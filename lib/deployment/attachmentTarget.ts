// lib/deployment/attachmentTarget.ts
//
// The CommCare HQ address an attachment link is built from.
//
// Which project space a download names is `runtimeTarget.ts`'s rule, and
// which one a publish names is the publish's own target; both build the
// address here. The sibling `previewTarget.ts` answers a narrower question,
// which project space Preview may name: a domain slug is enough to say who
// a worker signed in as, and an address needs a whole origin as well.

import { COMMCARE_SERVERS } from "@/lib/commcare/servers";
import type { AttachmentUrlTarget } from "@/lib/commcare/xform/captureUrlNode";
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

/** The origin and domain an attachment URL is built from. */
export function attachmentUrlTarget(
	target: AttachmentTargetKey,
): AttachmentUrlTarget {
	return {
		origin: COMMCARE_SERVERS[target.server].baseUrl,
		domain: target.domain,
	};
}
