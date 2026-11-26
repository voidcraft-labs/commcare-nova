/** Admit an import to a mapped working app before testing its release evidence. */
import { activeRemoteApp } from "../resources";
import {
	admitAppWrite,
	type DeploymentFence,
	type DeploymentScope,
	type DeploymentTargetKey,
	readDeployment,
	readTargetIdentity,
} from "../store";

export async function admitEntryPointImport(
	scope: DeploymentScope,
	target: DeploymentTargetKey,
	fence: DeploymentFence,
) {
	const view = await readDeployment(scope, target);
	const live = view && activeRemoteApp(view);
	if (!live) throw new Error("Expected a deployed working app.");
	const generation = crypto.randomUUID();
	const result = await admitAppWrite(scope, target, {
		...fence,
		firstContentGeneration: generation,
		remoteAppId: live.remoteId,
		observedPushToken: live.pushToken,
		comparedReview: live.reviewGeneration,
		compiledIdentity: await readTargetIdentity(scope, target),
		compiledAtSeq: live.pushedRevision ?? 0,
		writeKind: "import",
	});
	if (result.kind !== "admitted")
		throw new Error(`Import admission answered ${result.kind}.`);
	return { generation, writeId: result.writeId };
}
