// A former release for the incompatible-schema rehearsal. Its persisted name
// and editor command are deliberately outside the serving grammar.
export const sourceRevision = "1".repeat(40);
export const sourceTree = "2".repeat(40);
export const sourceLockSha256 = "3".repeat(64);

export function readHead(text) {
	const doc = JSON.parse(text);
	if (typeof doc.visitTitle !== "string" || Object.hasOwn(doc, "appName"))
		throw new Error(
			"Expected a visitTitle document from the previous release.",
		);
	return doc;
}

function apply(doc, row) {
	for (const operation of JSON.parse(row.mutationsText)) {
		if (
			operation.kind !== "setVisitTitle" ||
			typeof operation.title !== "string"
		)
			throw new Error("Unrecognized source edit.");
		doc = { ...doc, visitTitle: operation.title };
	}
	return doc;
}

export function readReference(headText, { start, suffix, startSeq, headSeq }) {
	readHead(headText);
	let state;
	if (start.kind === "certificate") {
		state = JSON.parse(start.stateText);
		state.doc = readHead(JSON.stringify(state.doc));
	} else {
		const doc =
			start.kind === "head"
				? readHead(start.snapshotText)
				: start.canonical.suffix.reduce(
						apply,
						readHead(start.canonical.baselineSnapshotText),
					);
		state = {
			kind: "ok",
			doc,
			projectId:
				start.kind === "head"
					? start.projectId
					: start.canonical.baselineProjectId,
			actors: [],
			editorBefore: false,
			renamesSince: [],
		};
	}
	if (headSeq - startSeq !== suffix.length)
		throw new Error("Incomplete source history.");
	for (const row of suffix) {
		const after = apply(state.doc, row);
		if (row.kind === "blueprint-migration") state.doc = after;
		else if (row.kind === "autosave") {
			state.editorBefore = true;
			if (!state.actors.includes(row.actor_id)) state.actors.push(row.actor_id);
		} else throw new Error("Unexpected source change.");
	}
	return { ...state, published: state.doc, identity: state.doc };
}
