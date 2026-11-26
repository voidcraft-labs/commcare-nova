// Also compiled into the private Step 6 reader against its archived source.
// Only that release's reducer and materialized-storage predicate see its data.
import type { AdmittedDurableAppChange } from "@/lib/db/persistedJson";
import { EDITOR_APP_CHANGE_KINDS } from "@/lib/db/types";
import type { Mutation } from "@/lib/doc/types";
import type { BlueprintDoc } from "@/lib/domain";
import type { CasePropertyRename } from "@/lib/publish/hqChangesKinds";

const EDITOR_KINDS: ReadonlySet<string> = new Set(EDITOR_APP_CHANGE_KINDS);

/**
 * The `renameCaseProperties` commands of the editor rows folded in order: a
 * rename of a name an earlier rename gave continues that rename, so a rename
 * and its rename back cancel. Only still-active, non-neutral pairs survive. Two successive occupants of
 * the same spelling can have separate saved data; each live destination
 * belongs to one lineage, while multiple origins may share a spelling.
 */
export function activeCasePropertyRenames(
	rows: readonly AdmittedDurableAppChange[],
	prior: readonly CasePropertyRename[],
	editorAtStart: () => BlueprintDoc,
	reduceEditor: (
		doc: BlueprintDoc,
		mutations: readonly Mutation[],
	) => BlueprintDoc,
	retires: (doc: BlueprintDoc, caseType: string, property: string) => boolean,
): readonly CasePropertyRename[] {
	let renames = [...prior];
	// Reconstruct the editor document only as far as the last explicit removal.
	// A certificate carries the target's server-only document, while the app's
	// immutable snapshot at that same fold carries the actual editor state.
	const lastRemoval = rows.findLastIndex((row) =>
		row.mutations.some((m) => m.kind === "removeCaseProperty"),
	);
	let editor = lastRemoval < 0 ? undefined : editorAtStart();
	for (const [index, row] of rows.entries()) {
		if (editor && index <= lastRemoval)
			editor = reduceEditor(editor, row.mutations);
		for (const mutation of row.mutations) {
			if (
				mutation.kind === "removeCaseProperty" &&
				editor &&
				renames.some(
					(r) => r.caseType === mutation.caseType && r.to === mutation.property,
				)
			) {
				if (retires(editor, mutation.caseType, mutation.property))
					renames = renames.filter(
						(r) =>
							r.caseType !== mutation.caseType || r.to !== mutation.property,
					);
			}
			if (
				mutation.kind !== "renameCaseProperties" ||
				!EDITOR_KINDS.has(row.kind)
			)
				continue;
			// Sources in a simultaneous command name the facts before it. An
			// occupied destination outside those sources would have refused the
			// saved-data rename; a reused destination cannot continue an old slot.
			const previous = renames;
			const moved = mutation.renames;
			renames = previous.flatMap((prior) => {
				const move = moved.find(
					(r) => r.caseType === prior.caseType && r.from === prior.to,
				);
				if (move)
					return prior.from === move.to ? [] : [{ ...prior, to: move.to }];
				return moved.some(
					(r) => r.caseType === prior.caseType && r.to === prior.to,
				)
					? []
					: [prior];
			});
			for (const move of moved) {
				if (
					!previous.some(
						(r) => r.caseType === move.caseType && r.to === move.from,
					)
				)
					renames.push({ ...move });
			}
		}
	}
	return renames;
}
