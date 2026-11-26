import assert from "node:assert/strict";
import { createHash } from "node:crypto";

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

/** Exercise the released decoder's private paths before publishing the bundle. */
export function verifyPrivateWorkspaceReader(reader) {
	const projectId = "clinic";
	const appId = "fold-reader-private-workspace";
	const genesis = reader.privateBase({ kind: "genesis", appId, projectId });
	assert.equal(genesis.projectId, projectId);
	assert.equal(genesis.snapshot.appId, appId);
	assert.equal(genesis.snapshot.connectType, null);
	assert.equal(Object.hasOwn(genesis.snapshot, "connectRoles"), false);

	const editedName = "Private edit before migration";
	const text = JSON.stringify([{ kind: "setAppName", name: editedName }]);
	const digest = createHash("sha256").update(text).digest("hex");
	const step = reader.privateStep(text, digest);
	assert.throws(
		() => reader.privateStep(text, "0".repeat(64)),
		/original receipt/,
	);
	const overlay = reader.privateOverlay(genesis.snapshot, step);
	assert.equal(overlay.appName, editedName);
	assert.notEqual(genesis.snapshot.appName, editedName);

	const edit = reader.privateBase({
		kind: "edit",
		canonical: {
			baselineSeq: 1,
			baselineProjectId: projectId,
			targetSeq: 1,
			baselineSnapshotText: JSON.stringify(overlay),
			suffix: [],
		},
	});
	assert.equal(edit.projectId, projectId);
	assert.deepEqual(edit.snapshot, overlay);
}
