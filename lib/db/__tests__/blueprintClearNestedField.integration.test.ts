/**
 * Integration coverage for the persistence boundary against a REAL Postgres
 * (the per-test-database harness): every nullable nested blueprint field the
 * reducer leaves at `undefined` after a clear must VANISH from the persisted
 * document, not survive as a stale key.
 *
 * On Postgres a form is a `blueprint_entities` row whose `data` jsonb is written
 * with `JSON.stringify` — which DROPS `undefined` values — so a cleared slot
 * disappears from the stored row rather than lingering. Covers the four
 * form-level nullable fields (`connect`, `closeCondition`, `postSubmit`,
 * `purpose`) driven through `commitGuardedBatch`; `completeAndSettleRun`
 * (status-only, no blueprint payload) is pinned to leave the entity rows untouched.
 *
 * Assertions check key absence (`'connect' in data === false`) on the raw entity
 * `data`, not `=== undefined`: the claim is that the key is GONE from storage.
 *
 * The guarded writer reauthorizes every commit against Project membership
 * (`projectRoleFor`, normally an `auth_member` read). It is mocked to grant the
 * actor an `editor` role — the reauth path itself is exercised in
 * `commitGuardedBatch.integration.test.ts`.
 *
 * Runs unconditionally under `npm test`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Mutation } from "@/lib/doc/types";
import type { BlueprintDoc, ConnectConfig } from "@/lib/domain";
import { setupAppStateTestDb } from "./appStateTestDb";

// Reauth reads the actor's role from `auth_member` via `projectRoleFor`; grant
// `editor` so the commit's reauth passes without a seeded membership row.
vi.mock("@/lib/db/projectMembership", () => ({
	projectRoleFor: vi.fn(async () => "editor"),
}));

const h = setupAppStateTestDb("bp_clear_");

const TEST_OWNER = "user-blueprint-clear-test";
const TEST_PROJECT = "project-blueprint-clear-test";
const APP_ID = "app-blueprint-clear";

const MODULE_UUID = "11111111-1111-4111-8111-111111111111";
const FORM_UUID = "22222222-2222-4222-8222-222222222222";

/** A minimal legal Connect learn-module block. */
const CONNECT: ConnectConfig = {
	learn_module: {
		id: "lm_1",
		name: "Learn module 1",
		description: "An intro module",
		time_estimate: 5,
	},
};

/** One module + one survey form carrying every clearable nullable field. */
function populatedBlueprint(): BlueprintDoc {
	const doc = {
		appId: APP_ID,
		appName: "Blueprint clear test app",
		connectType: null,
		caseTypes: null,
		modules: {
			[MODULE_UUID]: {
				uuid: MODULE_UUID,
				id: "m_module1",
				name: "Module 1",
				order: "a0",
			},
		},
		forms: {
			[FORM_UUID]: {
				uuid: FORM_UUID,
				id: "f_form1",
				name: "Form 1",
				type: "survey" as const,
				order: "a0",
				connect: CONNECT,
				closeCondition: { field: "done", answer: "yes" },
				postSubmit: "app_home",
				purpose: "Captures intake data",
			},
		},
		fields: {},
		moduleOrder: [MODULE_UUID],
		formOrder: { [MODULE_UUID]: [FORM_UUID] },
		fieldOrder: {},
		fieldParent: {},
	};
	return doc as unknown as BlueprintDoc;
}

/** The RAW `data` jsonb of the persisted form entity — the wire-level key set,
 *  before any Zod projection. */
async function readPersistedFormData(): Promise<Record<string, unknown>> {
	const row = await h
		.db()
		.selectFrom("blueprint_entities")
		.select("data")
		.where("app_id", "=", APP_ID)
		.where("uuid", "=", FORM_UUID)
		.executeTakeFirst();
	if (!row) throw new Error(`Expected form entity ${FORM_UUID} to exist.`);
	return row.data as Record<string, unknown>;
}

/** Seed the populated app (its module + form entity rows) at `mutation_seq: 0`. */
async function seedPopulatedApp(): Promise<void> {
	await h.seedAppWithBlueprint(populatedBlueprint(), {
		id: APP_ID,
		owner: TEST_OWNER,
		projectId: TEST_PROJECT,
	});
	const seeded = await readPersistedFormData();
	if (!("connect" in seeded)) {
		throw new Error("Seed precondition failed: form has no `connect` key.");
	}
}

describe("blueprint clear nested field", () => {
	beforeEach(seedPopulatedApp);

	it("the guarded writer clears every nested form field wholesale — no stale-key survivor", async () => {
		const { commitGuardedBatch } = await import("../apps");
		// One `updateForm` mutation clearing every nullable slot. Each clear carries
		// an explicit `null` (the wire-safe delete signal); the reducer maps
		// `null → undefined`, and the entity-row write's `JSON.stringify` drops the
		// undefined keys, so they vanish from the stored `data`.
		const clearMutations: Mutation[] = [
			{
				kind: "updateForm",
				uuid: FORM_UUID,
				patch: {
					connect: null,
					closeCondition: null,
					postSubmit: null,
					purpose: null,
				},
			} as unknown as Mutation,
		];

		const result = await commitGuardedBatch({
			appId: APP_ID,
			batchId: crypto.randomUUID(),
			mutations: clearMutations,
			actorUserId: TEST_OWNER,
			kind: "autosave",
		});
		expect(result.seq).toBe(1);
		expect(result.deduped).toBe(false);

		const form = await readPersistedFormData();
		expect("connect" in form).toBe(false);
		expect("closeCondition" in form).toBe(false);
		expect("postSubmit" in form).toBe(false);
		expect("purpose" in form).toBe(false);
		// The surviving form keys are intact.
		expect(form.uuid).toBe(FORM_UUID);
		expect(form.id).toBe("f_form1");
		expect(form.name).toBe("Form 1");
		expect(form.type).toBe("survey");
	});

	it("outer app-row fields the writer does not pass survive the guarded commit", async () => {
		const { commitGuardedBatch } = await import("../apps");
		const before = await h.readAppRow(APP_ID);

		await commitGuardedBatch({
			appId: APP_ID,
			batchId: crypto.randomUUID(),
			mutations: [
				{
					kind: "updateForm",
					uuid: FORM_UUID,
					patch: { purpose: null },
				} as unknown as Mutation,
			],
			actorUserId: TEST_OWNER,
			kind: "autosave",
		});

		const after = await h.readAppRow(APP_ID);
		if (!before || !after) throw new Error("app row missing around the commit");
		// The committed-batch write touches only the scalar/denorm snapshot +
		// `mutation_seq` + the stream; the other columns come back untouched.
		expect(after?.owner).toBe(TEST_OWNER);
		expect(after?.project_id).toBe(TEST_PROJECT);
		expect(after?.error_type).toBe(null);
		expect(after?.deleted_at).toBe(null);
		expect(after?.recoverable_until).toBe(null);
		expect(after?.status).toBe("complete");
		expect((after.created_at as Date).getTime()).toBe(
			(before.created_at as Date).getTime(),
		);
	});

	it("completeAndSettleRun flips status only — the persisted blueprint is untouched", async () => {
		const { completeAndSettleRun } = await import("../apps");
		// Put the app in a live BUILD state (the drain-end state
		// `completeAndSettleRun` acts on): `generating` with the run's UNSETTLED
		// reservation marker owned by `build-run`.
		await h
			.db()
			.updateTable("apps")
			.set({
				status: "generating",
				res_period: "2026-07",
				res_reserved: 100,
				res_settled: false,
				res_user_id: TEST_OWNER,
				res_run_id: "build-run",
			})
			.where("id", "=", APP_ID)
			.execute();

		const before = await readPersistedFormData();
		await completeAndSettleRun(APP_ID, "build-run");

		const after = await h.readAppRow(APP_ID);
		expect(after?.status).toBe("complete");
		expect(after?.error_type).toBeNull();
		// The drain-end finish carries NO blueprint payload — the entity rows are
		// byte-identical, so the form still carries its `connect` block.
		const form = await readPersistedFormData();
		expect(form).toEqual(before);
		expect("connect" in form).toBe(true);
	});
});
