/** Real Project membership, worker restore, authenticated opening/submit and
 * entry receipt. The request session is the only external identity supplied. */
import { v7 } from "uuid";
import { afterEach, expect, it, vi } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { reclaimExpiredFormOpeningData } from "@/lib/db/formOpeningData";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import { createBlueprintDocStore } from "@/lib/doc/store";
import type { FormSelectionSource } from "@/lib/domain";
import { eq, literal, matchAll, tableLookup } from "@/lib/domain/expression";
import {
	lookupColumnIdSchema,
	lookupTableIdSchema,
} from "@/lib/domain/lookupIds";
import { applyLookupAuthoringBatchInTransaction } from "@/lib/lookup/authoringBatch";
import { getLookupTable, updateLookupRow } from "@/lib/lookup/service";
import { authorizeLookupWriteInTransaction } from "@/lib/lookup/writerTransaction";
import { independentChoicesBlueprint } from "@/proof/targeted/documents/independentFormChoices";
import { submitFormAction } from "../caseDataBinding";
import { blueprintRevisionDigest } from "../caseDataBindingClient";
import { EngineController } from "../engineController";
import { readFormOpeningAction } from "../formOpeningAction";
import {
	formNeedsOpeningEvidence,
	restoreOpeningCases,
	restoreOpeningLookup,
} from "../formOpeningSnapshot";
import { previewAsPersona } from "../identity";
import { resolveAuthorizedPreviewContext } from "../previewAuthorization";
import { webAppsDevice } from "./fixtures/previewDevices";

const member = vi.hoisted(() => ({
	id: "signed-entry-member",
	session: "signed-entry-auth-session",
}));
vi.mock("@/lib/auth-utils", async (original) => ({
	...(await original<typeof import("@/lib/auth-utils")>()),
	getSession: async () => ({
		user: {
			id: member.id,
			name: "Practice worker",
			email: "worker@example.invalid",
		},
		session: { id: member.session },
	}),
}));
const h = setupAppStateTestDb("signed_worker_opening_", {
	authSchema: "migrated",
	poolMax: 4,
});
const project = "signed-entry-project";
afterEach(() => {
	vi.unstubAllEnvs();
});

it("opens assigned lookup choices for the signed Preview worker", async () => {
	vi.stubEnv("BETTER_AUTH_SECRET", "synthetic signed lookup opening secret");
	const app = "signed-worker-lookup";
	const first = { uuid: testUuid("lookup-first-persona"), name: "Bea" };
	const second = { uuid: testUuid("lookup-second-persona"), name: "Paz" };
	const workers = [
		{ persona: first, value: "north", label: "North Clinic" },
		{ persona: second, value: "south", label: "South Clinic" },
	] as const;
	await h.seedProjectMember(member.id, project, "owner");
	const saveLookup = (
		input: Parameters<typeof applyLookupAuthoringBatchInTransaction>[2],
	) =>
		h.withTransaction(async (tx) =>
			applyLookupAuthoringBatchInTransaction(
				tx,
				await authorizeLookupWriteInTransaction(
					tx,
					{ projectId: project, actorId: member.id },
					"edit",
				),
				input,
			),
		);
	const created = await saveLookup({
		createTables: [
			{
				key: "clinics",
				tag: "clinics",
				name: "Clinics",
				columns: [
					{ key: "code", wireName: "code", label: "Code", dataType: "text" },
					{ key: "name", wireName: "name", label: "Name", dataType: "text" },
				],
				rows: workers.map(({ value, label }) => ({
					key: value,
					cells: [
						{ columnKey: "code", value },
						{ columnKey: "name", value: label },
					],
				})),
			},
		],
	});
	const table = created.tables[0];
	const tableId = lookupTableIdSchema.parse(table.tableId);
	const valueColumnId = lookupColumnIdSchema.parse(table.columnIds[0].id);
	const labelColumnId = lookupColumnIdSchema.parse(table.columnIds[1].id);
	const question = testUuid("signed-worker-clinic");
	const blueprint = buildDoc({
		appId: app,
		modules: [
			{
				name: "Visits",
				forms: [
					{
						name: "Log visit",
						type: "survey",
						fields: [
							{
								kind: "single_select",
								id: "clinic",
								uuid: question,
								label: "Clinic",
								optionsSource: {
									kind: "lookup",
									tableId,
									valueColumnId,
									labelColumnId,
								},
							},
						],
					},
				],
			},
		],
	});
	const doc = {
		...blueprint,
		personas: { [first.uuid]: first, [second.uuid]: second },
		personaOrder: [first.uuid, second.uuid],
	};
	await h.seedAppWithBlueprint(doc, {
		id: app,
		owner: member.id,
		projectId: project,
	});
	const expectedTableRevision = table.revisions?.tableRevision;
	if (!expectedTableRevision) throw new Error("Missing lookup table revision");
	await saveLookup({
		operationId: v7(),
		updateTables: [
			{
				tableId,
				expectedTableRevision,
				workerAccess: "assigned",
				rowOperations: table.rowIds.map(({ id }, index) => ({
					kind: "assign",
					rowId: id,
					assignments: [
						{ kind: "worker", appId: app, id: workers[index].persona.uuid },
					],
				})),
			},
		],
	});
	const pool = h.pool();
	await pool.query(
		`INSERT INTO auth_session (id,"userId",token,"createdAt","updatedAt","expiresAt")
		VALUES ($1,$2,$1,now(),now(),now()+interval '1 day')`,
		[member.session, member.id],
	);
	await h.seedProjectMember(member.id, project, "viewer");
	const module = doc.moduleOrder[0];
	const form = doc.formOrder[module][0];
	expect(formNeedsOpeningEvidence(doc, form)).toBe(true);
	const request = {
		app,
		module,
		form,
		run: testUuid("assigned-lookup-run"),
		entry: testUuid("assigned-lookup-entry"),
		blueprintDigest: await blueprintRevisionDigest(doc),
	};
	const device = webAppsDevice();
	for (const { persona, value, label } of workers) {
		const opened = await readFormOpeningAction(
			{ ...request, persona: persona.uuid },
			device,
		);
		if (opened.kind !== "opening" || !opened.projection.complete)
			throw new Error(`Could not open the lookup form: ${opened.kind}`);
		expect(
			opened.projection.lookup.rowsByTable[tableId]?.map(
				(row) => row.values[valueColumnId],
			),
		).toEqual([value]);
		const store = createBlueprintDocStore();
		store.getState().load(doc);
		const controller = new EngineController();
		try {
			controller.setDocStore(store);
			controller.setPreviewIdentity(
				previewAsPersona(
					{ id: member.id, name: "Builder", email: "builder@example.invalid" },
					persona,
					doc,
				),
			);
			await controller.activateFormAsync(
				form,
				undefined,
				restoreOpeningCases(opened.projection.cases),
				undefined,
				{
					appId: app,
					boundCases: [],
					menuSelections: {},
					openedEntryKey: request.entry,
					heldEntryValues: opened.projection.resolvedEntries,
					openingLookup: restoreOpeningLookup(opened.projection.lookup),
				},
			);
			expect(controller.entryStore.getState()).toMatchObject({
				ready: true,
				fault: undefined,
				refusal: undefined,
			});
			expect(controller.store.getState()[question].choices).toEqual([
				expect.objectContaining({ value, label }),
			]);
		} finally {
			controller.dispose();
			await controller.awaitSettled();
		}
		if (persona.uuid === first.uuid)
			expect(
				await readFormOpeningAction(
					{
						...request,
						persona: second.uuid,
						previous: opened.evidence,
						restore: true,
					},
					device,
				),
			).toMatchObject({ kind: "reopen" });
	}

	await pool.query(
		'UPDATE auth_session SET "expiresAt" = now() WHERE id = $1',
		[member.session],
	);
	expect(
		await readFormOpeningAction({ ...request, persona: first.uuid }, device),
	).toMatchObject({
		kind: "error",
		message:
			"This data is no longer available with this connection. You can sign in and refresh it.",
	});
});

async function openPracticeForm(
	count: number,
	configure?: (
		blueprint: ReturnType<typeof independentChoicesBlueprint>,
	) => void | Promise<void>,
	withOpeningValues = false,
) {
	vi.stubEnv("BETTER_AUTH_SECRET", "synthetic signed opening secret");
	await h.seedProjectMember(member.id, project, "owner");
	const blueprint = independentChoicesBlueprint(
		"field-visits",
		withOpeningValues,
	);
	await configure?.(blueprint);
	const app = await h.seedAppWithBlueprint(blueprint, {
		id: "signed-opening-practice",
		owner: member.id,
		projectId: project,
	});
	const pool = h.pool();
	await pool.query(
		`INSERT INTO auth_session (id,"userId",token,"createdAt","updatedAt","expiresAt")
		VALUES ($1,$2,$1,now(),now(),now()+interval '1 day')`,
		[member.session, member.id],
	);
	// Distinct synthetic note values survive ordinary transport compression.
	await pool.query(
		`INSERT INTO cases (app_id,project_id,case_id,case_type,case_name,status,owner_id,properties)
		SELECT $1,$2,'training-'||i,'person','Member '||i,'open',$3,
			jsonb_build_object('first_note',(SELECT string_agg(md5(i::text||'/'||j::text),'') FROM generate_series(1,40) AS j))
		FROM generate_series(1,$4::int) AS i`,
		[app, project, member.id, count],
	);
	await pool.query(
		`INSERT INTO cases (app_id,project_id,case_id,case_type,case_name,status,owner_id,properties)
		VALUES ($1,$2,'worker-record','commcare-user','Practice worker','open',$3,jsonb_build_object('hq_user_id',$3::text)),
			($1,$2,'protected-other-worker','person','Unavailable','open','another-worker','{"first_note":"outside this restore"}')`,
		[app, project, member.id],
	);
	const device = webAppsDevice();
	const context = await resolveAuthorizedPreviewContext({
		appId: app,
		required: "edit",
		loadBlueprint: true,
		device,
	});
	if (context.kind !== "ready" || !context.blueprint)
		throw new Error("Fixture has no authorized document");
	const doc = context.blueprint;
	const form = Object.values(doc.forms).find(
		(form) => form.name === "Visit two people",
	);
	if (!form) throw new Error("Fixture is missing the worker form");
	const module = doc.moduleOrder[0];
	const request = {
		app,
		module,
		form: form.uuid,
		blueprintDigest: await blueprintRevisionDigest(
			hydratePersistedBlueprint(doc),
		),
		run: testUuid("visit-run"),
		entry: testUuid("visit-entry"),
	};
	const first = await readFormOpeningAction(request, device);
	if (first.kind !== "opening" || !first.next)
		throw new Error(`Could not open first choice: ${first.kind}`);
	return { app, pool, device, doc, module, request, first, next: first.next };
}

it("restores a signed projection above one MiB only for the original entry, run and device", async () => {
	const { pool, device, request, first, app } = await openPracticeForm(1850);
	expect(Buffer.byteLength(JSON.stringify(first.projection))).toBeGreaterThan(
		1024 * 1024,
	);
	expect(JSON.parse(first.evidence.content).data.kind).toBe("stored");
	const bytes = await pool.query(
		"SELECT octet_length(data) AS bytes,encode(sha256(data),'hex') AS digest FROM form_opening_data",
	);
	expect(bytes.rows).toHaveLength(1);
	expect(bytes.rows[0].bytes).toBeGreaterThan(1024 * 1024);
	expect(bytes.rows[0].digest).toBe(
		JSON.parse(first.evidence.content).data.digest,
	);
	expect(
		first.projection.cases.rows.some(
			(row) => row.case_id === "protected-other-worker",
		),
	).toBe(false);
	expect(JSON.stringify(first.evidence).length).toBeLessThan(4096);
	const restored = await readFormOpeningAction(
		{ ...request, previous: first.evidence, restore: true },
		device,
	);
	expect(restored.kind).toBe("opening");
	if (restored.kind === "opening")
		expect(restored.evidence).toEqual(first.evidence);
	for (const change of [
		{ entry: testUuid("other-entry") },
		{ run: testUuid("other-run") },
	])
		expect(
			(
				await readFormOpeningAction(
					{ ...request, ...change, previous: first.evidence, restore: true },
					device,
				)
			).kind,
		).toBe("reopen");
	expect(
		(
			await readFormOpeningAction(
				{ ...request, previous: first.evidence, restore: true },
				{ ...device, androidDeviceId: testUuid("new-device") },
			)
		).kind,
	).toBe("reopen");
	await pool.query(
		"UPDATE cases SET owner_id='another-worker' WHERE app_id=$1 AND case_id='training-3'",
		[app],
	);
	expect(
		(
			await readFormOpeningAction(
				{ ...request, previous: first.evidence, restore: true },
				device,
			)
		).kind,
	).toBe("reopen");
	await pool.query("DELETE FROM auth_session WHERE id=$1", [member.session]);
	expect(
		(await pool.query("SELECT count(*)::int AS n FROM form_opening_data"))
			.rows[0],
	).toEqual({ n: 0 });
});

it("checks current project membership and restored record access on every entry continuation", async () => {
	const { pool, device, request, first, app, next } = await openPracticeForm(3);
	expect(
		(
			await readFormOpeningAction(
				{
					...request,
					previous: first.evidence,
					choice: {
						selection: next.selectionUuid,
						caseId: "protected-other-worker",
					},
				},
				device,
			)
		).kind,
	).toBe("reopen");
	// Returning a previous projection requires membership now. Even the
	// author loses its historical contents when their Project access ends.
	await pool.query(
		'DELETE FROM auth_member WHERE "organizationId"=$1 AND "userId"=$2',
		[project, member.id],
	);
	expect(
		await readFormOpeningAction(
			{ ...request, previous: first.evidence, restore: true },
			device,
		),
	).toMatchObject({ kind: "error" });
	await h.seedProjectMember(member.id, project, "owner");
	const otherApp = await h.seedAppWithBlueprint(
		independentChoicesBlueprint("foreign-practice"),
		{ owner: "another-member", projectId: "another-project" },
	);
	expect(
		await readFormOpeningAction(
			{ ...request, app: otherApp, previous: first.evidence, restore: true },
			device,
		),
	).toMatchObject({ kind: "error" });
	// Losing even one formerly visible row must not re-deliver its old
	// values to the browser. The current worker can reopen normally.
	await pool.query(
		"UPDATE cases SET owner_id='another-worker' WHERE app_id=$1 AND case_id='training-3'",
		[app],
	);
	expect(
		(
			await readFormOpeningAction(
				{ ...request, previous: first.evidence, restore: true },
				device,
			)
		).kind,
	).toBe("reopen");
	await pool.query(
		"UPDATE cases SET owner_id=$2 WHERE app_id=$1 AND case_id='training-3'",
		[app, member.id],
	);
	const nextDevice = {
		...device,
		androidDeviceId: testUuid("next-preview-device"),
	};
	const nextRun = {
		...request,
		entry: testUuid("next-working-form"),
		run: testUuid("next-preview-run"),
	};
	const current = await readFormOpeningAction(nextRun, nextDevice);
	if (current.kind !== "opening")
		throw new Error(
			`Current session could not reopen the form: ${current.kind}`,
		);
	expect(
		(
			await readFormOpeningAction(
				{ ...nextRun, previous: current.evidence, restore: true },
				nextDevice,
			)
		).kind,
	).toBe("opening");
});

it("holds a later linked choice until the worker picks the earlier record from the same list", async () => {
	const { request, device, doc, next } = await openPracticeForm(3);
	const manual = doc.forms[request.form].caseSelections?.filter(
		(choice) => choice.source.kind === "choose",
	);
	if (manual?.length !== 2) throw new Error("Missing the two opening choices");
	const second = manual[1].uuid;
	const link = {
		...request,
		entry: testUuid("linked-form-entry"),
		carried: [{ selection: second, caseId: "training-2" }],
	};
	const opening = await readFormOpeningAction(link, device);
	if (opening.kind !== "opening")
		throw new Error("Could not start the linked form");
	expect(opening.next?.selectionUuid).toBe(next.selectionUuid);
	const completed = await readFormOpeningAction(
		{
			...request,
			entry: link.entry,
			previous: opening.evidence,
			choice: { selection: next.selectionUuid, caseId: "training-1" },
		},
		device,
	);
	if (completed.kind !== "opening")
		throw new Error("Could not continue the linked form");
	expect(completed.next).toBeUndefined();
	expect(completed.projection.choices).toEqual([
		{ selection: next.selectionUuid, caseId: "training-1" },
		...link.carried,
	]);
	expect(completed.projection.primaryCaseIds).toEqual(["training-2"]);
});

it("rechecks a restored linked record against the list's excluded owners at its own step", async () => {
	const { pool, request, app, device, next } = await openPracticeForm(3);
	await pool.query(
		"UPDATE cases SET owner_id=$3 WHERE app_id=$1 AND case_id=$2",
		[app, "training-2", "proof-excluded-person-owner"],
	);
	const context = await resolveAuthorizedPreviewContext({
		appId: app,
		required: "edit",
		device,
	});
	if (context.kind !== "ready") throw new Error("Practice worker is missing");
	await context.store.claimCases({ appId: app, caseIds: ["training-2"] });
	const reissued = {
		...request,
		entry: testUuid("after-restoring-the-claimed-case"),
	};
	const snapshot = await readFormOpeningAction(reissued, device);
	if (snapshot.kind !== "opening")
		throw new Error("Could not open the worker's restored cases");
	expect(
		snapshot.projection.cases.rows.some((row) => row.case_id === "training-2"),
	).toBe(true);
	const selection = next.selectionUuid;
	expect(
		(
			await readFormOpeningAction(
				{
					...reissued,
					previous: snapshot.evidence,
					choice: { selection, caseId: "training-2" },
				},
				device,
			)
		).kind,
	).toBe("reopen");
	expect(
		(
			await readFormOpeningAction(
				{ ...reissued, carried: [{ selection, caseId: "training-2" }] },
				device,
			)
		).kind,
	).toBe("reopen");
	const allowed = await readFormOpeningAction(
		{ ...reissued, carried: [{ selection, caseId: "training-1" }] },
		device,
	);
	if (allowed.kind !== "opening")
		throw new Error("Could not open the allowed linked record");
	expect(allowed.projection.choices).toEqual([
		{ selection, caseId: "training-1" },
	]);
});

// A menu's own list cannot read another menu's choice (it is reachable on its
// own), so a later choice depends on an earlier one through `under`.
it("rechecks a linked later choice against the earlier choice it is chosen under", async () => {
	const { request, device, doc, pool } = await openPracticeForm(
		3,
		(blueprint) => {
			const assigned = Object.values(blueprint.modules).find(
				(menu) => menu.name === "Assigned contacts",
			);
			if (!assigned?.caseListConfig) throw new Error("Missing contact list");
			delete assigned.caseListConfig.filter;
			const quick = Object.values(blueprint.forms).find(
				(form) => form.name === "Visit with assigned contact",
			);
			const [person, contact] = quick?.caseSelections ?? [];
			if (!person || contact?.source.kind !== "choose")
				throw new Error("Missing assigned contact route");
			contact.source = {
				...contact.source,
				under: { selection: person.uuid, identifier: "parent" },
			};
		},
	);
	await pool.query(
		`INSERT INTO case_indices (case_id, ancestor_id, target_case_type, identifier, relationship, depth)
		VALUES ('training-2','training-1','person','parent','child',1)`,
	);
	const form = Object.values(doc.forms).find(
		(form) => form.name === "Visit with assigned contact",
	);
	const choices = form?.caseSelections;
	if (!form || choices?.length !== 2)
		throw new Error("Missing assigned contact route");
	const launch = {
		...request,
		form: form.uuid,
		entry: testUuid("link-under-the-earlier-choice"),
	};
	const first = await readFormOpeningAction(
		{
			...launch,
			carried: [{ selection: choices[0].uuid, caseId: "training-1" }],
		},
		device,
	);
	if (first.kind !== "opening")
		throw new Error("Could not start contact selection");
	expect(first.next?.chosenCaseIds[request.module]).toBe("training-1");
	const choose = (caseId: string) =>
		readFormOpeningAction(
			{
				...launch,
				previous: first.evidence,
				choice: { selection: choices[1].uuid, caseId },
			},
			device,
		);
	expect((await choose("training-3")).kind).toBe("reopen");
	const approved = await choose("training-2");
	if (approved.kind !== "opening")
		throw new Error("Could not choose the contact under the first person");
	expect(approved.projection.choices).toEqual([
		{ selection: choices[0].uuid, caseId: "training-1" },
		{ selection: choices[1].uuid, caseId: "training-2" },
	]);
});

it("writes each chosen record and replays the committed receipt after the saved snapshot expires", async () => {
	const { pool, device, request, first, app, next, doc, module } =
		await openPracticeForm(420);
	expect(JSON.parse(first.evidence.content).data.kind).toBe("stored");
	const second = await readFormOpeningAction(
		{
			...request,
			previous: first.evidence,
			choice: { selection: next.selectionUuid, caseId: "training-1" },
		},
		device,
	);
	if (second.kind !== "opening" || !second.next)
		throw new Error(`Could not open second choice: ${second.kind}`);
	const opened = await readFormOpeningAction(
		{
			...request,
			previous: second.evidence,
			choice: { selection: second.next.selectionUuid, caseId: "training-2" },
		},
		device,
	);
	if (opened.kind !== "opening" || opened.next)
		throw new Error(`Could not finish choices: ${opened.kind}`);
	expect(opened.projection.primaryCaseIds).toEqual(["training-2"]);
	const field = Object.values(doc.fields).find((field) => field.id === "note");
	if (!field) throw new Error("Fixture is missing its visit note");
	const mutation = {
		kind: "followup" as const,
		caseIds: ["training-2"],
		entryKey: request.entry,
		formUuid: request.form,
		attachmentRefs: [],
		formOpening: { run: request.run, module, evidence: opened.evidence },
		operationAnswers: {
			root: [{ fieldUuid: field.uuid, value: "Both visits confirmed" }],
			repeats: [],
		},
	};
	const submit = (payload = mutation, run = request.run) =>
		submitFormAction(
			payload,
			app,
			request.blueprintDigest,
			undefined,
			undefined,
			undefined,
			device,
			undefined,
			run,
		);
	expect((await submit({ ...mutation, caseIds: ["training-3"] })).kind).toBe(
		"error",
	);
	const result = await submit();
	expect(result.kind).toBe("followup");
	const rows = await pool.query(
		`SELECT case_id, properties->>'first_note' AS first, properties->>'second_note' AS second
		FROM cases WHERE app_id=$1 AND case_id IN ('training-1','training-2','protected-other-worker') ORDER BY case_id`,
		[app],
	);
	expect(rows.rows).toEqual([
		{
			case_id: "protected-other-worker",
			first: "outside this restore",
			second: null,
		},
		{ case_id: "training-1", first: "Both visits confirmed", second: null },
		{
			case_id: "training-2",
			first: expect.not.stringMatching(/confirmed/),
			second: "Both visits confirmed",
		},
	]);
	expect(
		(await pool.query("SELECT count(*)::int AS n FROM form_opening_data"))
			.rows[0],
	).toEqual({ n: 1 });
	await pool.query(
		"UPDATE form_opening_data SET expires_at=clock_timestamp()-interval '1 second'",
	);
	expect(
		(
			await readFormOpeningAction(
				{ ...request, previous: opened.evidence, restore: true },
				device,
			)
		).kind,
	).toBe("reopen");
	expect(await reclaimExpiredFormOpeningData()).toBe(1);
	expect(await submit()).toEqual(result);
	expect(await submit(mutation, testUuid("replay-in-another-run"))).toEqual({
		...result,
		receiptOutsideRun: true,
	});
});

it("saves the rich lookup value from the signed opening after its live row changes", async () => {
	const scope = { projectId: project, actorId: member.id, role: "owner" };
	const liveEdit: { apply?: () => Promise<unknown> } = {};
	const { pool, device, request, first, app, next, doc, module } =
		await openPracticeForm(3, async (blueprint) => {
			const { tables } = await h
				.db()
				.transaction()
				.execute(async (tx) =>
					applyLookupAuthoringBatchInTransaction(
						tx,
						await authorizeLookupWriteInTransaction(tx, scope, "edit"),
						{
							createTables: [
								{
									key: "visits",
									name: "Visits",
									tag: "visits",
									columns: [],
									attributes: [{ wireName: "note", label: "Note" }],
									rows: [
										{
											key: "row",
											cells: [],
											content: { attributes: { note: "At form opening" } },
										},
									],
								},
							],
						},
					),
				);
			const [created] = tables;
			const { tableId } = created;
			const table = await getLookupTable(scope, tableId);
			const attribute = table.attributes?.[0];
			const row = created.rowIds[0];
			const visit = Object.values(blueprint.forms).find(
				(form) => form.name === "Visit two people",
			);
			const write = visit?.caseOperations?.[0].writes?.[0];
			if (!attribute || !row || !write)
				throw new Error("Missing the signed lookup fixture.");
			write.value = tableLookup(
				tableId,
				{ attributeId: attribute.id },
				matchAll(),
			);
			liveEdit.apply = () =>
				updateLookupRow(scope, {
					tableId,
					rowId: row.id,
					expectedTableRevision: table.tableRevision,
					values: {},
					content: { attributes: { [attribute.id]: "Edited while open" } },
				});
		});
	const second = await readFormOpeningAction(
		{
			...request,
			previous: first.evidence,
			choice: { selection: next.selectionUuid, caseId: "training-1" },
		},
		device,
	);
	if (second.kind !== "opening" || !second.next)
		throw new Error("Could not open the second case choice.");
	const opened = await readFormOpeningAction(
		{
			...request,
			previous: second.evidence,
			choice: { selection: second.next.selectionUuid, caseId: "training-2" },
		},
		device,
	);
	const note = Object.values(doc.fields).find((field) => field.id === "note");
	if (opened.kind !== "opening" || opened.next || !note || !liveEdit.apply)
		throw new Error("Could not finish the form opening.");
	await liveEdit.apply();
	const result = await submitFormAction(
		{
			kind: "followup",
			caseIds: ["training-2"],
			entryKey: request.entry,
			formUuid: request.form,
			attachmentRefs: [],
			formOpening: { run: request.run, module, evidence: opened.evidence },
			operationAnswers: {
				root: [{ fieldUuid: note.uuid, value: "Seen today" }],
				repeats: [],
			},
		},
		app,
		request.blueprintDigest,
		undefined,
		undefined,
		undefined,
		device,
	);
	expect(result).toMatchObject({ kind: "followup" });
	const saved = await pool.query(
		"SELECT properties->>'second_note' AS note FROM cases WHERE app_id=$1 AND case_id='training-2'",
		[app],
	);
	expect(saved.rows).toEqual([{ note: "At form opening" }]);
});

it("pins the original form's write with each entry's own lookup choice", async () => {
	const scope = { projectId: project, actorId: member.id, role: "owner" };
	const shared = testUuid("shared-lookup-entry");
	const tableIds: string[] = [];
	const { pool, device, request, first, app, doc, module } =
		await openPracticeForm(3, async (blueprint) => {
			const { tables } = await h
				.db()
				.transaction()
				.execute(async (tx) =>
					applyLookupAuthoringBatchInTransaction(
						tx,
						await authorizeLookupWriteInTransaction(tx, scope, "edit"),
						{
							createTables: [
								["write", "Pinned write"],
								["original", "training-1"],
								["shared", "training-3"],
								["next_step", "enabled"],
							].map(([key, value]) => ({
								key,
								name: key,
								tag: key,
								columns: [
									{
										key: "value",
										wireName: "value",
										label: "Value",
										dataType: "text",
									},
								],
								rows: [{ key: "row", cells: [{ columnKey: "value", value }] }],
							})),
						},
					),
				);
			const definitions = await Promise.all(
				tables.map(({ tableId }) => getLookupTable(scope, tableId)),
			);
			const [writeTable, originalTable, sharedTable, linkTable] = definitions;
			tableIds.push(...definitions.map((table) => table.id));
			const uses = (table: typeof originalTable): FormSelectionSource => ({
				kind: "table",
				table: table.id,
				column: table.columns[0].id,
			});
			const visit = Object.values(blueprint.forms).find(
				(form) => form.name === "Visit two people",
			);
			const choices = visit?.caseSelections;
			const firstPerson = choices?.find((row) => row.tag === "first");
			const write = visit?.caseOperations?.[0].writes?.[0];
			if (!visit || !choices || !firstPerson || !write)
				throw new Error("Missing the form shared by both lookup routes.");
			firstPerson.source = uses(originalTable);
			// The base fixture supplies this choice through a link. Once it
			// comes from a table, that link can carry only the other choice.
			const incoming = Object.values(blueprint.forms).find(
				(form) => form.name === "Open the assigned pair",
			)?.formLinks?.[0];
			if (incoming?.datums === undefined)
				throw new Error("Missing the original form's incoming link.");
			incoming.datums = incoming.datums.filter(
				({ name }) =>
					name.kind !== "form-selection" || name.selection !== firstPerson.uuid,
			);
			write.value = tableLookup(
				writeTable.id,
				writeTable.columns[0].id,
				matchAll(),
			);
			const menu = blueprint.moduleOrder[0];
			visit.formLinks = [
				{
					uuid: testUuid("original-lookup-next-step"),
					target: { type: "module", moduleUuid: menu },
					condition: eq(
						tableLookup(linkTable.id, linkTable.columns[0].id, matchAll()),
						literal("enabled"),
					),
				},
			];
			blueprint.forms[shared] = {
				uuid: shared,
				name: "Shared visits",
				id: "shared_visits",
				type: visit.type,
				shadowOf: {
					form: visit.uuid,
					selections: choices.map((row) => ({
						kind: "replace",
						selection: row.uuid,
						caseType: row.caseType,
						source:
							row === firstPerson
								? {
										kind: "expression",
										value: tableLookup(
											sharedTable.id,
											sharedTable.columns[0].id,
											matchAll(),
										),
									}
								: row.source,
					})),
				},
			};
			blueprint.formOrder[menu].push(shared);
			blueprint.fieldOrder[shared] = [];
		});
	const sharedRequest = {
		...request,
		form: shared,
		entry: testUuid("the-shared-lookup-visit"),
	};
	const sharedOpening = await readFormOpeningAction(sharedRequest, device);
	if (sharedOpening.kind !== "opening")
		throw new Error(`Could not open the shared form: ${sharedOpening.kind}`);
	const note = Object.values(doc.fields).find((field) => field.id === "note");
	if (!note) throw new Error("Missing the shared form's original question.");
	const [writeTableId, originalTableId, sharedTableId, linkTableId] = tableIds;
	const firstSelection = doc.forms[request.form].caseSelections?.find(
		(row) => row.tag === "first",
	);
	if (!firstSelection) throw new Error("Missing the route's automatic choice.");
	let originalEvidence: typeof first.evidence | undefined;
	for (const [launch, opening, routeTables, firstCase, ownCase, answer] of [
		[
			request,
			first,
			[originalTableId, linkTableId],
			"training-1",
			"training-2",
			"Original route",
		],
		[
			sharedRequest,
			sharedOpening,
			[sharedTableId],
			"training-3",
			"training-1",
			"Shared route",
		],
	] as const) {
		expect(Object.keys(opening.projection.lookup.rowsByTable).sort()).toEqual(
			[writeTableId, ...routeTables].sort(),
		);
		if (!opening.next) throw new Error("Missing the remaining manual choice.");
		const completed = await readFormOpeningAction(
			{
				...launch,
				previous: opening.evidence,
				choice: { selection: opening.next.selectionUuid, caseId: ownCase },
			},
			device,
		);
		if (completed.kind !== "opening" || completed.next)
			throw new Error("Could not complete the form's route.");
		expect(completed.projection.resolvedEntries[firstSelection.uuid]).toBe(
			firstCase,
		);
		const submit = (evidence: typeof completed.evidence) =>
			submitFormAction(
				{
					kind: "followup",
					caseIds: [ownCase],
					entryKey: launch.entry,
					formUuid: launch.form,
					attachmentRefs: [],
					formOpening: { run: launch.run, module, evidence },
					operationAnswers: {
						root: [{ fieldUuid: note.uuid, value: answer }],
						repeats: [],
					},
				},
				app,
				launch.blueprintDigest,
				undefined,
				undefined,
				undefined,
				device,
			);
		if (originalEvidence)
			expect(await submit(originalEvidence)).toEqual({
				kind: "error",
				message:
					"This form's opening records could not be verified. Reopen the form to load them again.",
			});
		expect(await submit(completed.evidence)).toMatchObject({
			kind: "followup",
		});
		originalEvidence = completed.evidence;
	}
	const saved = await pool.query(
		`SELECT case_id, properties->>'first_note' AS first, properties->>'second_note' AS second
		FROM cases WHERE app_id=$1 AND case_id IN ('training-1','training-2','training-3')
		ORDER BY case_id`,
		[app],
	);
	expect(saved.rows.map((row) => [row.case_id, row.second])).toEqual([
		["training-1", "Pinned write"],
		["training-2", "Pinned write"],
		["training-3", null],
	]);
	expect(saved.rows[0].first).toBe("Original route");
	expect(saved.rows[2].first).toBe("Shared route");
});

it("opens the next form on the device its submission left, a case the restore no longer holds among it", async () => {
	const otherWorker = testUuid("carry-other-worker");
	const { pool, device, request, first, app, next, doc, module } =
		await openPracticeForm(
			3,
			(blueprint) => {
				blueprint.personas = {
					[otherWorker]: { uuid: otherWorker, name: "Another worker" },
				};
				blueprint.personaOrder = [otherWorker];
			},
			true,
		);
	const second = await readFormOpeningAction(
		{
			...request,
			previous: first.evidence,
			choice: { selection: next.selectionUuid, caseId: "training-1" },
		},
		device,
	);
	if (second.kind !== "opening" || !second.next)
		throw new Error(`Could not open second choice: ${second.kind}`);
	const opened = await readFormOpeningAction(
		{
			...request,
			previous: second.evidence,
			choice: { selection: second.next.selectionUuid, caseId: "training-2" },
		},
		device,
	);
	if (opened.kind !== "opening") throw new Error("Could not finish choices");
	const note = Object.values(doc.fields).find((field) => field.id === "note");
	if (!note) throw new Error("Fixture is missing its visit note");
	const result = await submitFormAction(
		{
			kind: "followup" as const,
			caseIds: ["training-2"],
			entryKey: request.entry,
			formUuid: request.form,
			attachmentRefs: [],
			formOpening: { run: request.run, module, evidence: opened.evidence },
			operationAnswers: {
				root: [{ fieldUuid: note.uuid, value: "Seen today" }],
				repeats: [],
			},
		},
		app,
		request.blueprintDigest,
		undefined,
		undefined,
		undefined,
		device,
	);
	expect(result.kind).toBe("followup");
	// The case leaves this worker's restore, as a case the entry closed does;
	// the device keeps it until it syncs.
	await pool.query(
		"UPDATE cases SET owner_id='another-worker' WHERE app_id=$1 AND case_id='training-2'",
		[app],
	);
	// A follow-up of the review menu, which opens on the case it is given.
	const review = Object.values(doc.forms).find(
		(form) => form.name === "Review a visit",
	);
	const reviewMenu = doc.moduleOrder.find((uuid) =>
		doc.formOrder[uuid]?.includes(review?.uuid as never),
	);
	if (!review || !reviewMenu) throw new Error("Fixture is missing its review");
	const following = {
		...request,
		module: reviewMenu,
		form: review.uuid,
		entry: testUuid("following-entry"),
		bound: ["training-2"],
	};
	expect((await readFormOpeningAction(following, device)).kind).toBe(
		"record-unavailable",
	);
	const afterSubmission = await readFormOpeningAction(
		{ ...following, afterSubmission: [request.entry] },
		device,
	);
	if (afterSubmission.kind !== "opening")
		throw new Error(
			`Could not open after the submission: ${afterSubmission.kind}`,
		);
	expect(afterSubmission.projection.primaryCaseIds).toEqual(["training-2"]);
	expect(afterSubmission.projection.submittedCaseIds).toContain("training-2");
	for (const wrongScope of [
		{ run: testUuid("new-run") },
		{ persona: otherWorker },
	]) {
		expect(
			(
				await readFormOpeningAction(
					{
						...following,
						...wrongScope,
						afterSubmission: [request.entry],
					},
					device,
				)
			).kind,
		).toBe("reopen");
	}
	const originalSession = member.session;
	try {
		member.session = "separate-signed-entry-auth-session";
		await pool.query(
			`INSERT INTO auth_session (id,"userId",token,"createdAt","updatedAt","expiresAt")
			VALUES ($1,$2,$1,now(),now(),now()+interval '1 day')`,
			[member.session, member.id],
		);
		expect(
			(
				await readFormOpeningAction(
					{ ...following, afterSubmission: [request.entry] },
					device,
				)
			).kind,
		).toBe("reopen");
	} finally {
		member.session = originalSession;
	}
	const anotherVisit = await readFormOpeningAction(
		{
			...following,
			entry: testUuid("following-entry-in-same-form"),
			afterSubmission: [request.entry],
		},
		device,
	);
	expect(anotherVisit).toMatchObject({
		kind: "opening",
		projection: { primaryCaseIds: ["training-2"], complete: true },
	});
	const linkedChoices = await readFormOpeningAction(
		{
			...request,
			entry: testUuid("linked-entry-to-the-same-form"),
			carried: [...opened.projection.choices],
			afterSubmission: [request.entry],
		},
		device,
	);
	expect(linkedChoices).toMatchObject({
		kind: "opening",
		projection: {
			choices: opened.projection.choices,
			primaryCaseIds: ["training-2"],
			complete: true,
		},
	});
	await pool.query(
		"UPDATE cases SET case_name='Standalone list only' WHERE app_id=$1 AND case_id='training-1'",
		[app],
	);
	const newChoice = {
		...request,
		entry: testUuid("new-choice-after-submission"),
	};
	const newChoiceOpening = await readFormOpeningAction(
		{ ...newChoice, afterSubmission: [request.entry] },
		device,
	);
	if (newChoiceOpening.kind !== "opening" || !newChoiceOpening.next)
		throw new Error("Could not open a new choice after the submission");
	expect(
		(
			await readFormOpeningAction(
				{
					...newChoice,
					previous: newChoiceOpening.evidence,
					choice: {
						selection: newChoiceOpening.next.selectionUuid,
						caseId: "training-1",
					},
				},
				device,
			)
		).kind,
	).toBe("reopen");
	// Restoring that entry keeps the case its submission left.
	expect(
		(
			await readFormOpeningAction(
				{
					...following,
					bound: undefined,
					previous: afterSubmission.evidence,
					restore: true,
				},
				device,
			)
		).kind,
	).toBe("opening");
	// Another entry's key opens nothing this actor did not commit.
	expect(
		(
			await readFormOpeningAction(
				{ ...following, afterSubmission: [request.entry, "never-submitted"] },
				device,
			)
		).kind,
	).toBe("reopen");
});
