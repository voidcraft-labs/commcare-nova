/** Worker rows through real genesis, guarded edits, schema admission and storage.
 * The connection is redirected to isolated Postgres; production factories and
 * their authorization callbacks remain intact. No fixture installs the schema. */
import { beforeEach, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	buildCaseTypeMap,
	CasePropertiesValidationError,
	withProjectContext,
} from "@/lib/case-store";
import { createExplicitBlankApp } from "@/lib/db/appGenesis";
import type { Mutation } from "@/lib/doc/types";
import { USERCASE_CASE_TYPE } from "@/lib/domain";
import { syncUsercaseRow } from "../syncUsercaseRow";
import { applyBlueprintChangeProposal } from "./admittedWriterTestHelpers";
import { setupAppStateTestDb } from "./appStateTestDb";

const h = setupAppStateTestDb("usercase_lifecycle_", {
	authSchema: "migrated",
});
const ACTOR = "usercase-author";
const PROJECT = "usercase-project";
const PERSONA = testUuid("usercase-persona");
const CADRE = testUuid("usercase-cadre");
const WORKER = {
	id: PERSONA,
	username: "Amara",
	personName: "Amara",
	email: "",
	locationIds: [],
};
beforeEach(async () => {
	await h.seedProjectMember(ACTOR, PROJECT, "owner");
});
async function create() {
	return createExplicitBlankApp(ACTOR, PROJECT, crypto.randomUUID());
}
async function commit(appId: string, mutations: Mutation[]) {
	return applyBlueprintChangeProposal({
		appId,
		userId: ACTOR,
		expectedProjectId: PROJECT,
		batchId: crypto.randomUUID(),
		kind: "autosave",
		guard: { mutations },
	});
}
async function row(appId: string, worker = PERSONA) {
	const result = await h
		.pool()
		.query(
			"SELECT case_id, owner_id, project_id, case_type, case_name, status, external_id, properties, xmin::text AS version FROM cases WHERE app_id = $1 AND case_type = 'commcare-user' AND properties->>'hq_user_id' = $2",
			[appId, worker],
		);
	expect(result.rows).toHaveLength(1);
	return result.rows[0];
}
async function authoredWorker() {
	const birth = await create();
	const result = await commit(birth.appId, [
		{
			kind: "addUserProperty",
			property: { uuid: CADRE, slug: "cadre", label: "Cadre" },
		},
		{
			kind: "addPersona",
			persona: { uuid: PERSONA, name: "Amara", values: { [CADRE]: "nurse" } },
		},
	]);
	return { appId: birth.appId, doc: result.committedDoc };
}

it("births the built-in worker schema even with no authored case types, then creates, renames and closes a persona row", async () => {
	const birth = await create();
	expect(birth.blueprint.caseTypes ?? []).toEqual([]);
	const schemas = await h
		.pool()
		.query(
			"SELECT case_type, synced_seq::text FROM case_type_schemas WHERE app_id = $1 ORDER BY case_type",
			[birth.appId],
		);
	expect(schemas.rows).toEqual([
		{ case_type: "commcare-user", synced_seq: "1" },
	]);
	await commit(birth.appId, [
		{ kind: "addPersona", persona: { uuid: PERSONA, name: "Amara" } },
	]);
	const first = await row(birth.appId);
	expect({ ...first, properties: undefined, version: undefined }).toEqual({
		case_id: expect.any(String),
		owner_id: PERSONA,
		project_id: PROJECT,
		case_type: "commcare-user",
		case_name: "Amara",
		status: "open",
		external_id: null,
		properties: undefined,
		version: undefined,
	});
	expect(first.properties.hq_user_id).toBe(PERSONA);
	expect(first.properties.username).toBe("Amara");
	expect(Object.hasOwn(first.properties, "case_name")).toBe(false);
	expect(Object.hasOwn(first.properties, "external_id")).toBe(false);
	await commit(birth.appId, [
		{ kind: "updatePersona", uuid: PERSONA, patch: { name: "Amara Sow" } },
	]);
	const renamed = await row(birth.appId);
	expect(renamed.case_name).toBe("Amara Sow");
	expect(renamed.properties.username).toBe("Amara Sow");
	await commit(birth.appId, [{ kind: "removePersona", uuid: PERSONA }]);
	const closed = await row(birth.appId);
	expect(closed.status).toBe("closed");
	expect(closed.properties).toEqual(renamed.properties);
});

it("materializes a newly declared worker property before the same commit writes its persona value", async () => {
	const { appId } = await authoredWorker();
	expect((await row(appId)).properties.cadre).toBe("nurse");
	const nextProperty = testUuid("usercase-license");
	await commit(appId, [
		{
			kind: "addUserProperty",
			property: { uuid: nextProperty, slug: "license", label: "License" },
		},
		{
			kind: "updatePersona",
			uuid: PERSONA,
			patch: {},
			valuePatch: { userPropertyUuid: nextProperty, value: "L-123" },
		},
	]);
	const changed = await row(appId);
	expect(changed.properties.cadre).toBe("nurse");
	expect(changed.properties.license).toBe("L-123");
	await commit(appId, [
		{
			kind: "updatePersona",
			uuid: PERSONA,
			patch: {},
			valuePatch: { userPropertyUuid: CADRE, value: null },
		},
	]);
	const cleared = await row(appId);
	expect(cleared.properties).toEqual({ ...changed.properties, cadre: "" });
});

it("leaves runtime-written values and the physical row version unchanged on ensure-only resolution, then reports a full sync's stored result", async () => {
	const { appId, doc } = await authoredWorker();
	const store = await withProjectContext(PROJECT, ACTOR, PERSONA);
	await store.update({
		appId,
		caseId: (await row(appId)).case_id,
		patch: { properties: { cadre: "runtime-written" } },
	});
	const before = await row(appId);
	const args = { appId, worker: WORKER, authored: {}, doc, projectSpace: null };
	const ensured = await syncUsercaseRow(store, { ...args, ensureOnly: true });
	expect(ensured).toEqual({
		created: false,
		changed: 0,
		stored: before.properties,
	});
	expect(await row(appId)).toEqual(before);
	const synced = await syncUsercaseRow(store, args);
	expect(synced).toEqual({
		created: false,
		changed: 1,
		stored: { ...before.properties, cadre: "" },
	});
	const after = await row(appId);
	expect(after.properties).toEqual(synced.stored);
	expect(after.version).not.toBe(before.version);
	expect(await syncUsercaseRow(store, args)).toEqual({ ...synced, changed: 0 });
	expect(await row(appId)).toEqual(after);
});

it("ensure-only creates a missing worker with its login fallback and exposes it only in that worker's restore scope", async () => {
	const { appId, blueprint: doc } = await create();
	const store = await withProjectContext(PROJECT, ACTOR, PERSONA);
	const outcome = await syncUsercaseRow(store, {
		appId,
		worker: { ...WORKER, personName: "  " },
		authored: {},
		doc,
		projectSpace: "my-domain",
		ensureOnly: true,
	});
	expect(outcome.created).toBe(true);
	const saved = await row(appId);
	expect(saved.case_name).toBe("Amara");
	expect(saved.properties).toEqual(outcome.stored);
	const query = {
		appId,
		caseType: USERCASE_CASE_TYPE,
		caseTypeSchemas: buildCaseTypeMap(doc),
	};
	expect(
		(
			await store.query({ ...query, restoreScope: { ownerIds: [PERSONA] } })
		).map((item) => item.case_id),
	).toEqual([saved.case_id]);
	expect(
		await store.query({
			...query,
			restoreScope: { ownerIds: ["another-worker"] },
		}),
	).toEqual([]);
});

it("refuses undeclared runtime properties without changing any stored field or row version", async () => {
	const { appId } = await authoredWorker();
	const store = await withProjectContext(PROJECT, ACTOR, PERSONA);
	const before = await row(appId);
	const error = await store
		.update({
			appId,
			caseId: (await row(appId)).case_id,
			patch: { case_name: "Must not land", properties: { visits_done: "12" } },
		})
		.catch((error: unknown) => error);
	expect(error).toBeInstanceOf(CasePropertiesValidationError);
	if (!(error instanceof CasePropertiesValidationError))
		throw new Error("Expected stored-property refusal");
	expect(error.appId).toBe(appId);
	expect(error.caseType).toBe("commcare-user");
	expect(error.failures).toEqual([
		{
			path: "",
			message: "must NOT have additional property 'visits_done'",
			additionalProperty: "visits_done",
		},
	]);
	expect(await row(appId)).toEqual(before);
});

it("rolls back the entire blank-app birth when worker-schema admission fails", async () => {
	await h
		.pool()
		.query(`CREATE FUNCTION refuse_worker_schema() RETURNS trigger LANGUAGE plpgsql AS $$
		BEGIN IF NEW.case_type = 'commcare-user' THEN RAISE EXCEPTION 'worker schema admission refused'; END IF; RETURN NEW; END $$;
		CREATE TRIGGER refuse_worker_schema BEFORE INSERT ON case_type_schemas FOR EACH ROW EXECUTE FUNCTION refuse_worker_schema()`);
	await expect(create()).rejects.toThrow("worker schema admission refused");
	for (const table of [
		"apps",
		"blueprint_entities",
		"app_changes",
		"app_change_fold_baselines",
		"case_type_schemas",
	]) {
		const result = await h
			.pool()
			.query(`SELECT count(*)::int AS count FROM ${table}`);
		expect(result.rows).toEqual([{ count: 0 }]);
	}
});
