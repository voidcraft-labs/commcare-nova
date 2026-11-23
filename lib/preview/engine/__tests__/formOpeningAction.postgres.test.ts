/** Real Project membership, worker restore, authenticated opening/submit and
 * entry receipt. The request session is the only external identity supplied. */
import { afterEach, expect, it, vi } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { reclaimExpiredFormOpeningData } from "@/lib/db/formOpeningData";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import { chosenCase } from "@/lib/domain/__tests__/chosenCaseFixture";
import { eq, prop } from "@/lib/domain/expression/builders";
import { independentChoicesBlueprint } from "@/proof/targeted/documents/independentFormChoices";
import { submitFormAction } from "../caseDataBinding";
import { blueprintRevisionDigest } from "../caseDataBindingClient";
import { readFormOpeningAction } from "../formOpeningAction";
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

async function openPracticeForm(
	count: number,
	configure?: (
		blueprint: ReturnType<typeof independentChoicesBlueprint>,
	) => void,
) {
	vi.stubEnv("BETTER_AUTH_SECRET", "synthetic signed opening secret");
	await h.seedProjectMember(member.id, project, "owner");
	const blueprint = independentChoicesBlueprint("field-visits");
	configure?.(blueprint);
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

it("rechecks a linked later choice against a filter that reads the earlier choice", async () => {
	const { request, device, doc } = await openPracticeForm(3, (blueprint) => {
		const people = blueprint.moduleOrder[0];
		const assigned = Object.values(blueprint.modules).find(
			(menu) => menu.name === "Assigned contacts",
		);
		if (!assigned?.caseListConfig) throw new Error("Missing contact list");
		assigned.caseListConfig.filter = eq(
			prop("person", "case_id"),
			chosenCase(people),
		);
	});
	const form = Object.values(doc.forms).find(
		(form) => form.name === "Visit with assigned contact",
	);
	const choices = form?.caseSelections;
	if (!form || choices?.length !== 2)
		throw new Error("Missing assigned contact route");
	const launch = {
		...request,
		form: form.uuid,
		entry: testUuid("link-with-an-earlier-menu-filter"),
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
	expect((await choose("training-2")).kind).toBe("reopen");
	const approved = await choose("training-1");
	if (approved.kind !== "opening")
		throw new Error("Could not choose the matching contact");
	expect(approved.projection.primaryCaseIds).toEqual(["training-1"]);
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
	const submit = (payload = mutation) =>
		submitFormAction(
			payload,
			app,
			request.blueprintDigest,
			undefined,
			undefined,
			undefined,
			device,
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
});
