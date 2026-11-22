// Bootstrap for the release immediately preceding the certificate table.
// The builder exposes four private functions of this exact release in its
// temporary archive. All stored document and mutation parsing is the old code.
import {
	foldCanonicalAppChangeSuffixBounded,
	parseFoldBaselineSnapshot,
} from "@/lib/db/canonicalMutationFold";
import { parsePersistedAppChangeEnvelope } from "@/lib/db/persistedJson";
import {
	actorsOf,
	foldServerRows,
	netRenames,
	withHeadUnsent,
	withoutSecondOfASlug,
} from "@/lib/deployment/hqChanges/reference";
import {
	hydratePersistedBlueprint,
	toPersistableDoc,
} from "@/lib/doc/fieldParent";
export function readHead(text) {
	return toPersistableDoc(parseFoldBaselineSnapshot(text));
}
export function readReference(headText, evidence) {
	const { appId, start, suffix, startSeq, headSeq } = evidence;
	if (start.kind === "certificate")
		throw new Error(
			"The selected pre-certificate source revision could not have written a certificate.",
		);
	const published =
		start.kind === "head"
			? { snapshot: readHead(start.snapshotText), projectId: start.projectId }
			: foldCanonicalAppChangeSuffixBounded(start.canonical);
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
		rows.length !== headSeq - startSeq ||
		rows.some((row, index) => row.seq !== startSeq + index + 1)
	)
		throw new Error("The old deployment comparison has a gap in its history.");
	const folded = foldServerRows(
		appId,
		hydratePersistedBlueprint(published.snapshot),
		rows,
	);
	if (folded.kind !== "ok") return folded;
	let projectId = published.projectId;
	for (const row of rows)
		if (row.kind === "project-move") {
			if (row.fromProjectId !== projectId)
				throw new Error(
					"The old deployment comparison has an inconsistent Project move.",
				);
			projectId = row.toProjectId;
		}
	const projected = withHeadUnsent(
		folded.doc,
		parseFoldBaselineSnapshot(headText),
	);
	const actors = actorsOf(rows);
	return {
		kind: "ok",
		doc: toPersistableDoc(folded.doc),
		published: toPersistableDoc(projected),
		identity: toPersistableDoc(withoutSecondOfASlug(projected, folded.doc)),
		projectId,
		editorBefore: actors.length > 0,
		actors,
		renamesSince: netRenames(rows),
	};
}
