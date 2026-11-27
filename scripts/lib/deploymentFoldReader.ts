/** Operator artifact entrypoint. A cutover bundles this against the release
 * which wrote the data. It receives exact scoped text, never a connection. */
import { parseFoldBaselineSnapshot } from "@/lib/db/canonicalMutationFold";
import type { DeploymentReferenceEvidence } from "@/lib/deployment/hqChanges/reference";
import { foldReferenceEvidence } from "@/lib/deployment/hqChanges/referenceEvidence";
import { projectDeploymentReference } from "@/lib/deployment/hqChanges/referenceFold";
import { toPersistableDoc } from "@/lib/doc/fieldParent";

export function readHead(text: string) {
	return toPersistableDoc(parseFoldBaselineSnapshot(text));
}
export function readReference(
	headText: string,
	evidence: DeploymentReferenceEvidence,
) {
	const state = foldReferenceEvidence(evidence);
	if (state.kind !== "ok") return state;
	const projected = projectDeploymentReference(
		state,
		parseFoldBaselineSnapshot(headText),
	);
	if (projected.kind !== "ok")
		throw new Error("The source projection lost a published comparison.");
	return {
		...state,
		doc: toPersistableDoc(state.doc),
		published: toPersistableDoc(projected.doc),
		identity: toPersistableDoc(projected.identityDoc),
	};
}
