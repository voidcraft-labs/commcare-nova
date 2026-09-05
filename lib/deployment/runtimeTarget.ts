import type { RuntimeTarget } from "@/lib/commcare/runtimeTarget";
import type { CommCareServer } from "@/lib/commcare/servers";
import type { AttachmentDeploymentTarget } from "./attachmentTarget";

/** Downloads reuse a known space only on the selected server. */
export function downloadRuntimeTarget(
	deployment: AttachmentDeploymentTarget,
	server?: CommCareServer,
): RuntimeTarget | undefined {
	deployment = downloadDeploymentTarget(deployment, server);
	if (
		deployment.kind === "known" &&
		(server === undefined || server === deployment.target.server)
	) {
		return deployment.target;
	}
	return server === undefined ? undefined : { server };
}

/** Attachments and runtime requests must name the same selected deployment. */
export function downloadDeploymentTarget(
	deployment: AttachmentDeploymentTarget,
	server?: CommCareServer,
): AttachmentDeploymentTarget {
	if (server === undefined || deployment.kind === "none") return deployment;
	const candidates = (
		deployment.kind === "known" ? [deployment.target] : deployment.targets
	).filter((target) => target.server === server);
	if (candidates.length === 1) return { kind: "known", target: candidates[0] };
	return candidates.length === 0
		? { kind: "none" }
		: { kind: "ambiguous", targets: candidates };
}
