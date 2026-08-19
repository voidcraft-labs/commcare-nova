import "server-only";

import {
	type AttachmentDeploymentTarget,
	resolveAttachmentDeploymentTarget,
} from "./attachmentTarget";
import { type DeploymentScope, readDeploymentPreviewRecords } from "./store";

/**
 * The CommCare HQ project space an app's attachment links may point at.
 *
 * Its own module rather than a member of `service.ts` for the reason
 * `previewSpace.ts` gives: the compile routes ask one question of one
 * table and should not drag the publish lifecycle's expander, media
 * bundler, and HQ client into their import graph to do it.
 *
 * Unlike `previewProjectSpaceFor`, a read that faults is NOT swallowed.
 * Degrading to "no target" would silently drop a case write from the
 * exported app — the app would compile, download, and quietly stop
 * recording where its photos went. An export is a deliberate action the
 * author can repeat, so failing it and saying so is the honest answer to a
 * database that could not be reached.
 */
export async function attachmentDeploymentTargetFor(
	scope: DeploymentScope,
): Promise<AttachmentDeploymentTarget> {
	return resolveAttachmentDeploymentTarget(
		await readDeploymentPreviewRecords(scope),
	);
}
