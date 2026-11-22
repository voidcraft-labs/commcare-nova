import {
	foldCanonicalAppChangeSuffixBounded,
	parseFoldBaselineSnapshot,
} from "@/lib/db/canonicalMutationFold";
import {
	parsePersistedAppChangeEnvelope,
	parsePersistedJsonText,
} from "@/lib/db/persistedJson";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import type { DeploymentReferenceEvidence } from "./reference";
import {
	type FoldedDeploymentReference,
	foldServerRows,
	storedReferenceSchema,
} from "./referenceFold";

/** The source release's complete parser and reducer boundary. It only sees
 * rows the transaction has scoped. No database access or current app head
 * can supply a substitute for a published revision. */
export function foldReferenceEvidence(
	input: DeploymentReferenceEvidence,
): FoldedDeploymentReference {
	const { start, suffix } = input;
	let state: FoldedDeploymentReference;
	if (start.kind === "certificate") {
		const stored = storedReferenceSchema.parse(
			parsePersistedJsonText(
				start.stateText,
				"app_deployment_fold_references.state",
			),
		);
		if (stored.kind !== "ok") return stored;
		state = { ...stored, doc: hydratePersistedBlueprint(stored.doc) };
	} else {
		const { doc, projectId } =
			start.kind === "head"
				? {
						doc: parseFoldBaselineSnapshot(start.snapshotText),
						projectId: start.projectId,
					}
				: (() => {
						const published = foldCanonicalAppChangeSuffixBounded(
							start.canonical,
						);
						return {
							doc: hydratePersistedBlueprint(published.snapshot),
							projectId: published.projectId,
						};
					})();
		state = {
			kind: "ok",
			doc,
			projectId,
			editorBefore: false,
			actors: [],
			renamesSince: [],
		};
	}
	const rows = suffix.map((row) =>
		parsePersistedAppChangeEnvelope({
			seq: row.seq,
			batchId: row.batch_id,
			runId: row.run_id,
			actorId: row.actor_id,
			kind: row.kind,
			mutationsText: row.mutationsText,
			fromProjectId: row.from_project_id,
			toProjectId: row.to_project_id,
		}),
	);
	if (
		rows.length !== input.headSeq - input.startSeq ||
		rows.some((row, index) => row.seq !== input.startSeq + index + 1)
	)
		throw new Error("The app history has a gap in the deployment comparison.");
	return foldServerRows(input.appId, state, rows);
}
