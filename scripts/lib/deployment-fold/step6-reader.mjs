// Bootstrap for the release immediately preceding the certificate table.
// The builder exposes the private pure functions of this exact release in its
// temporary archive. All stored document and mutation parsing is the old code.
import { buildCaseTypeMap } from "@/lib/case-store/store";
import {
	foldCanonicalAppChangeSuffixBounded,
	parseFoldBaselineSnapshot,
} from "@/lib/db/canonicalMutationFold";
import { parsePersistedAppChangeEnvelope } from "@/lib/db/persistedJson";
import {
	actorsOf,
	foldServerRows,
	netRenames,
	reduced,
	withHeadUnsent,
	withoutSecondOfASlug,
} from "@/lib/deployment/hqChanges/reference";
import {
	hydratePersistedBlueprint,
	toPersistableDoc,
} from "@/lib/doc/fieldParent";
import { isStandardCaseListProperty } from "@/lib/domain";
import { activeCasePropertyRenames } from "./step6-rename-lineage";
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
		// canonicalCommitKernel in this source release retains whole-type storage,
		// standard properties, and catalog removals backed by a surviving writer.
		activeRenames: activeCasePropertyRenames(
			rows,
			[],
			() => hydratePersistedBlueprint(published.snapshot),
			reduced,
			(editor, caseType, name) => {
				const type = buildCaseTypeMap(editor).get(caseType);
				return (
					!!type &&
					!isStandardCaseListProperty(name) &&
					!type.properties.some((property) => property.name === name)
				);
			},
		),
	};
}
