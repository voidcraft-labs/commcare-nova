import assert from "node:assert/strict";

/** Probe the immediately preceding release against stored JSON independently
 * of the candidate document constructor. An editor's rename must stay unsent. */
export function verifyStep6Reader(reader) {
	const projectId = "clinic";
	const appId = "fold-reader-rehearsal";
	const doc = {
		appId,
		appName: "Prior published",
		connectType: null,
		caseTypes: [],
		appSettings: { showSavedForms: false, showIncompleteForms: false },
		modules: {},
		forms: {},
		fields: {},
		moduleOrder: [],
		formOrder: {},
		fieldOrder: {},
	};
	const snapshotText = JSON.stringify(doc);
	const persisted = (value) => JSON.parse(JSON.stringify(value));
	assert.deepEqual(persisted(reader.readHead(snapshotText)), doc);
	const head = { ...doc, appName: "Later head" };
	const result = reader.readReference(JSON.stringify(head), {
		appId,
		startSeq: 1,
		headSeq: 2,
		start: {
			kind: "published",
			canonical: {
				baselineSeq: 1,
				baselineProjectId: projectId,
				targetSeq: 1,
				baselineSnapshotText: snapshotText,
				suffix: [],
			},
		},
		suffix: [
			{
				seq: 2,
				batch_id: "worker-edit",
				actor_id: "author",
				run_id: null,
				kind: "autosave",
				mutationsText: JSON.stringify([
					{ kind: "setAppName", name: head.appName },
				]),
				from_project_id: null,
				to_project_id: null,
			},
		],
	});
	assert.equal(result.kind, "ok");
	assert.deepEqual(persisted(result.doc), doc);
	assert.deepEqual(persisted(result.published), doc);
	assert.deepEqual(persisted(result.identity), doc);
	assert.deepEqual(result.actors, ["author"]);
	assert.deepEqual(result.activeRenames, []);
	assert.deepEqual(result.renamesSince, []);
	assert.equal(result.projectId, projectId);
	return {
		published: doc.appName,
		head: head.appName,
		actors: result.actors,
		projectId,
	};
}
