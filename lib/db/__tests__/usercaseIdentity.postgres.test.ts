/** Real app birth, authorization, worker materialization and form submission.
 * Only the authenticated request session is supplied at its external boundary. */
import { beforeEach, expect, it, vi } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { CaseNotFoundError, withProjectContext } from "@/lib/case-store";
import { createExplicitBlankApp } from "@/lib/db/appGenesis";
import { commitAppProjectMove } from "@/lib/db/apps";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { USERCASE_CASE_TYPE } from "@/lib/domain";
import { submitFormAction } from "@/lib/preview/engine/caseDataBinding";
import { resolveAuthorizedPreviewContext } from "@/lib/preview/engine/caseDataBindingHelpers";
import { FormEngine } from "@/lib/preview/engine/formEngine";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import { syncUsercaseRow } from "../syncUsercaseRow";
import { applyBlueprintChangeProposal } from "./admittedWriterTestHelpers";
import { setupAppStateTestDb } from "./appStateTestDb";

const ACTOR = "worker-in-many-apps";
const PROJECT = "worker-project-one";
const OTHER_PROJECT = "worker-project-two";
const PROPERTY = testUuid("worker-identity-visits");
const WORKER = {
	id: ACTOR,
	username: "Amara",
	personName: "Amara",
	email: "",
	locationIds: [],
};
vi.mock("@/lib/auth-utils", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/auth-utils")>()),
	getSession: async () => ({
		user: {
			id: "worker-in-many-apps",
			name: "Amara",
			email: "amara@dimagi.com",
		},
	}),
}));
const h = setupAppStateTestDb("usercase_identity_", {
	authSchema: "migrated",
	poolMax: 4,
});
beforeEach(async () => {
	await h.seedProjectMember(ACTOR, PROJECT, "owner");
	await h.seedProjectMember(ACTOR, OTHER_PROJECT, "owner");
});
async function create(projectId = PROJECT) {
	const birth = await createExplicitBlankApp(
		ACTOR,
		projectId,
		crypto.randomUUID(),
	);
	const field = Object.values(birth.blueprint.fields)[0];
	if (field.kind !== "text") throw new Error("Expected canonical text starter");
	const edited = await applyBlueprintChangeProposal({
		appId: birth.appId,
		userId: ACTOR,
		expectedProjectId: projectId,
		batchId: crypto.randomUUID(),
		kind: "autosave",
		guard: {
			mutations: [
				{
					kind: "addUserProperty",
					property: { uuid: PROPERTY, slug: "visits", label: "Visits" },
				},
				{
					kind: "updateField",
					uuid: field.uuid,
					targetKind: "text",
					patch: {
						caseWrite: { caseType: USERCASE_CASE_TYPE, property: "visits" },
					},
				},
			],
		},
	});
	return {
		appId: birth.appId,
		projectId,
		doc: edited.committedDoc,
		fieldUuid: field.uuid,
	};
}
async function ensure(app: Awaited<ReturnType<typeof create>>) {
	const store = await withProjectContext(app.projectId, ACTOR, ACTOR);
	return syncUsercaseRow(store, {
		appId: app.appId,
		worker: WORKER,
		authored: {},
		doc: app.doc,
		projectSpace: null,
		ensureOnly: true,
	});
}
async function rows(appId: string) {
	return (
		await h
			.pool()
			.query(
				"SELECT case_id, owner_id, project_id, status, properties FROM cases WHERE app_id=$1 AND case_type='commcare-user' ORDER BY case_id",
				[appId],
			)
	).rows;
}
async function workerSubmissionArgs(app: Awaited<ReturnType<typeof create>>) {
	const row = await h
		.db()
		.selectFrom("apps")
		.select("mutation_seq")
		.where("id", "=", app.appId)
		.executeTakeFirstOrThrow();
	return {
		appId: app.appId,
		ordinary: { kind: "none" as const },
		usercase: { properties: { visits: "must-not-land" } },
		submissionReceipt: {
			entryKey: crypto.randomUUID(),
			formUuid: Object.values(app.doc.forms)[0].uuid,
			expectedAppMutationSeq: Number(row.mutation_seq),
			blueprintDigest: canonicalJsonDigest(toPersistableDoc(app.doc)),
			requestDigest: canonicalJsonDigest({ visits: "must-not-land" }),
		},
	};
}

async function submit(app: Awaited<ReturnType<typeof create>>, answer: string) {
	const preview = await resolveAuthorizedPreviewContext({
		appId: app.appId,
		required: "edit",
		loadBlueprint: true,
	});
	if (preview.kind !== "ready")
		throw new Error(`Preview refused: ${preview.kind}`);
	const form = Object.values(app.doc.forms)[0];
	const engine = new FormEngine(
		{
			form,
			formUuid: form.uuid,
			fields: app.doc.fields,
			fieldOrder: app.doc.fieldOrder,
			caseTypes: app.doc.caseTypes ?? [],
			userProperties: app.doc.userProperties,
		},
		undefined,
		undefined,
		preview.identity,
	);
	const field = app.doc.fields[app.fieldUuid];
	engine.setValue(`/data/${field.id}`, answer);
	const mutation = engine.computeSubmissionMutation({
		entryKey: crypto.randomUUID(),
	});
	const result = await submitFormAction(
		mutation,
		app.appId,
		canonicalJsonDigest(toPersistableDoc(app.doc)),
	);
	expect(result.kind).toBe("survey");
	if (result.kind !== "survey") throw new Error(JSON.stringify(result));
	expect(result.caseDatabasePatch?.rows).toHaveLength(1);
	const [saved] = await rows(app.appId);
	expect(result.caseDatabasePatch?.rows[0]).toMatchObject({
		case_id: saved.case_id,
		properties: { visits: answer, hq_user_id: ACTOR },
	});
	expect(saved.properties.visits).toBe(answer);
	const refreshed = await resolveAuthorizedPreviewContext({
		appId: app.appId,
		required: "edit",
		loadBlueprint: true,
	});
	if (refreshed.kind !== "ready") throw new Error("Preview reload refused");
	expect(refreshed.identity.usercase.visits).toBe(answer);
	return { saved, result, mutation };
}

it.each([PROJECT, OTHER_PROJECT])(
	"one signed-in worker gets independent records and form values across apps in %s",
	async (secondProject) => {
		const first = await create(),
			second = await create(secondProject);
		await ensure(first);
		await ensure(second);
		const a = await submit(first, "7"),
			b = await submit(second, "19");
		expect(a.saved.case_id).not.toBe(b.saved.case_id);
		expect(a.saved.owner_id).toBe(ACTOR);
		expect(b.saved.owner_id).toBe(ACTOR);
		expect(a.saved.project_id).toBe(PROJECT);
		expect(b.saved.project_id).toBe(secondProject);
		expect((await rows(first.appId))[0].properties.visits).toBe("7");
		expect(
			await submitFormAction(
				a.mutation,
				first.appId,
				canonicalJsonDigest(toPersistableDoc(first.doc)),
			),
		).toEqual(a.result);
	},
);

it("concurrent first resolutions converge on one persisted row", async () => {
	const app = await create();
	const results = await Promise.allSettled(
		Array.from({ length: 6 }, () => ensure(app)),
	);
	expect(results.map((result) => result.status)).toEqual(
		Array(6).fill("fulfilled"),
	);
	expect(await rows(app.appId)).toHaveLength(1);
	expect(
		results.filter(
			(result) => result.status === "fulfilled" && result.value.created,
		),
	).toHaveLength(1);
	await submit(app, "23");
});

it.each([ACTOR, "retained-worker-case"])(
	"preserves existing worker row %s through ensure, Project move, and form write",
	async (legacyId) => {
		const app = await create();
		const store = await withProjectContext(PROJECT, ACTOR, ACTOR);
		await store.insert({
			appId: app.appId,
			row: {
				case_id: legacyId,
				case_type: USERCASE_CASE_TYPE,
				case_name: "Amara",
				status: "open",
				properties: { hq_user_id: ACTOR, visits: "legacy" },
			},
		});
		await ensure(app);
		expect(await rows(app.appId)).toHaveLength(1);
		expect((await rows(app.appId))[0].case_id).toBe(legacyId);
		await store.update({
			appId: app.appId,
			caseId: legacyId,
			patch: { properties: { visits: "before-move" } },
		});
		expect(
			await commitAppProjectMove(app.appId, {
				toProjectId: OTHER_PROJECT,
				expectedFromProjectId: PROJECT,
				actorUserId: ACTOR,
				assetIdMap: new Map(),
			}),
		).toEqual({ kind: "moved" });
		const moved = { ...app, projectId: OTHER_PROJECT };
		await ensure(moved);
		expect((await rows(app.appId))[0]).toMatchObject({
			case_id: legacyId,
			project_id: OTHER_PROJECT,
			properties: { visits: "before-move" },
		});
		await submit(moved, "31");
	},
);

it("keeps copied persona identities separate and closes only the removed app's record", async () => {
	const first = await create(),
		second = await create();
	const personaUuid = testUuid("shared-worker-blueprint-identity");
	for (const app of [first, second])
		await applyBlueprintChangeProposal({
			appId: app.appId,
			userId: ACTOR,
			expectedProjectId: app.projectId,
			batchId: crypto.randomUUID(),
			kind: "autosave",
			guard: {
				mutations: [
					{ kind: "addPersona", persona: { uuid: personaUuid, name: "Asha" } },
				],
			},
		});
	const [a] = await rows(first.appId),
		[b] = await rows(second.appId);
	expect(a.case_id).not.toBe(b.case_id);
	expect(a.properties.hq_user_id).toBe(personaUuid);
	expect(b.properties.hq_user_id).toBe(personaUuid);
	await applyBlueprintChangeProposal({
		appId: first.appId,
		userId: ACTOR,
		expectedProjectId: first.projectId,
		batchId: crypto.randomUUID(),
		kind: "autosave",
		guard: { mutations: [{ kind: "removePersona", uuid: personaUuid }] },
	});
	expect((await rows(first.appId))[0].status).toBe("closed");
	expect((await rows(second.appId))[0]).toEqual(b);
});

it("preserves a closed worker row and refuses duplicate semantic identities", async () => {
	const app = await create(),
		store = await withProjectContext(PROJECT, ACTOR, ACTOR);
	await store.insert({
		appId: app.appId,
		row: {
			case_id: ACTOR,
			case_type: USERCASE_CASE_TYPE,
			case_name: "Closed worker",
			status: "closed",
			closed_on: new Date(),
			properties: { hq_user_id: ACTOR, visits: "retained" },
		},
	});
	const before = await rows(app.appId);
	expect((await ensure(app)).stored.visits).toBe("retained");
	await expect(
		store.applySubmission(await workerSubmissionArgs(app)),
	).rejects.toBeInstanceOf(CaseNotFoundError);
	expect(await rows(app.appId)).toEqual(before);
	await store.insert({
		appId: app.appId,
		row: {
			case_id: "duplicate-worker-identity",
			case_type: USERCASE_CASE_TYPE,
			case_name: "Duplicate",
			status: "open",
			properties: { hq_user_id: ACTOR, visits: "other" },
		},
	});
	const duplicated = await rows(app.appId);
	await expect(ensure(app)).rejects.toThrow("More than one worker record");
	await expect(
		store.applySubmission(await workerSubmissionArgs(app)),
	).rejects.toThrow("More than one worker record");
	expect(await rows(app.appId)).toEqual(duplicated);
});

it("does not write a normal case whose id happens to equal the worker id", async () => {
	const app = await create();
	const changed = await applyBlueprintChangeProposal({
		appId: app.appId,
		userId: ACTOR,
		expectedProjectId: PROJECT,
		batchId: crypto.randomUUID(),
		kind: "autosave",
		guard: {
			mutations: [
				{ kind: "declareCaseType", caseType: "patient" },
				{
					kind: "addCaseProperty",
					caseType: "patient",
					property: {
						name: "visits",
						label: { parts: [{ kind: "text", text: "Visits" }] },
					},
				},
			],
		},
	});
	const doc = changed.committedDoc,
		store = await withProjectContext(PROJECT, ACTOR, ACTOR);
	await store.insert({
		appId: app.appId,
		row: {
			case_id: ACTOR,
			case_type: "patient",
			case_name: "Patient with colliding id",
			status: "open",
			properties: { visits: "unchanged" },
		},
	});
	const form = Object.values(doc.forms)[0];
	const engine = new FormEngine({
		form,
		formUuid: form.uuid,
		fields: doc.fields,
		fieldOrder: doc.fieldOrder,
		caseTypes: doc.caseTypes ?? [],
		userProperties: doc.userProperties,
	});
	engine.setValue(`/data/${doc.fields[app.fieldUuid].id}`, "must-not-land");
	const mutation = engine.computeSubmissionMutation({
		entryKey: crypto.randomUUID(),
	});
	const result = await submitFormAction(
		mutation,
		app.appId,
		canonicalJsonDigest(toPersistableDoc(doc)),
	);
	expect(result.kind).toBe("case-not-found");
	expect(await rows(app.appId)).toEqual([]);
	const actual = await store.query({ appId: app.appId, caseType: "patient" });
	expect(actual).toHaveLength(1);
	expect(actual[0].properties.visits).toBe("unchanged");
});

it("refuses a matching worker record owned by another worker", async () => {
	const app = await create(),
		otherOwner = await withProjectContext(PROJECT, ACTOR, "different-worker");
	await otherOwner.insert({
		appId: app.appId,
		row: {
			case_id: "wrong-owner-usercase",
			case_type: USERCASE_CASE_TYPE,
			case_name: "Wrong owner",
			status: "open",
			properties: { hq_user_id: ACTOR, visits: "retained" },
		},
	});
	const before = await rows(app.appId);
	await expect(ensure(app)).rejects.toThrow("different owner");
	const store = await withProjectContext(PROJECT, ACTOR, ACTOR);
	await expect(
		store.applySubmission(await workerSubmissionArgs(app)),
	).rejects.toBeInstanceOf(CaseNotFoundError);
	expect(await rows(app.appId)).toEqual(before);
});
