/**
 * Integration coverage for the persistence boundary against the
 * Firestore emulator: every nullable nested blueprint field that the
 * reducer leaves at `undefined` after a clear must vanish from the
 * persisted document, not survive a deep merge against its prior value.
 *
 * Covers the four form-level nullable fields (`connect`,
 * `closeCondition`, `postSubmit`, `purpose`) driven through the unified
 * guarded writer (`commitGuardedBatch` → `writeCommittedSnapshot`, which
 * `update()`s the whole `blueprint` map wholesale). `completeApp`
 * (status-only, no blueprint payload) is pinned to leave the stored
 * blueprint untouched.
 *
 * Assertions check key absence (`'connect' in form === false`) rather
 * than `=== undefined`: the wire-level claim is that the key is GONE,
 * not "present with `undefined`."
 *
 * The guarded writer reauthorizes every commit against Project
 * membership (`projectRoleFor`, normally an `auth_member` Postgres read).
 * The emulator harness has no Postgres, so `projectRoleFor` is mocked to
 * grant the actor an `editor` role — the reauth path itself is exercised
 * against real Firestore in `commitGuardedBatch.integration.test.ts`.
 *
 * Auto-skipped when `FIRESTORE_EMULATOR_HOST` is unset; run via
 * `npm run test:integration`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mutation } from "@/lib/doc/types";
import type { ConnectConfig, PersistableDoc } from "@/lib/domain";

// Reauth reads the actor's role from `auth_member` (Postgres) via
// `projectRoleFor`. The emulator harness has no Postgres, so grant `editor`.
vi.mock("@/lib/db/projectMembership", () => ({
	projectRoleFor: vi.fn(async () => "editor"),
}));

const { commitGuardedBatch, completeAndSettleRun, createApp } = await import(
	"../apps"
);
const { getDb } = await import("../firestore");

const emulatorAvailable = Boolean(process.env.FIRESTORE_EMULATOR_HOST);

const TEST_OWNER = "user-blueprint-clear-test";
const TEST_PROJECT = "project-blueprint-clear-test";

const MODULE_UUID = "11111111-1111-4111-8111-111111111111";
const FORM_UUID = "22222222-2222-4222-8222-222222222222";

/** A minimal legal Connect learn-module block — enough to land on disk so a
 *  subsequent clear has somewhere to clear from. */
const CONNECT: ConnectConfig = {
	learn_module: {
		id: "lm_1",
		name: "Learn module 1",
		description: "An intro module",
		time_estimate: 5,
	},
};

/**
 * Seed the stored app doc with one module + one survey form carrying every
 * clearable nullable field populated. Written via a raw `set` (the guarded
 * writer re-applies mutations onto whatever it reads fresh — this is the
 * fresh doc it will read), with `mutation_seq: 0` so the first guarded
 * commit lands at seq 1.
 */
function populatedBlueprint(appId: string): PersistableDoc {
	const doc = {
		appId,
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
	};
	return doc as unknown as PersistableDoc;
}

/**
 * Overwrite the freshly-created app doc's blueprint with the populated
 * survey form. `createApp` writes an EMPTY blueprint; this raw `update`
 * installs the populated shape the clear will then act against, keeping
 * `mutation_seq` at 0 so the guarded commit's literal seq is 1.
 */
async function seedPopulated(appId: string): Promise<void> {
	const bp = populatedBlueprint(appId);
	await getDb().collection("apps").doc(appId).update({
		blueprint: bp,
		module_count: 1,
		form_count: 1,
	});
}

/**
 * Raw untyped read of the persisted form object — bypasses the typed
 * converter's Zod parse so the test sees the wire payload exactly as
 * Firestore stored it. The load-bearing claim is about the WIRE-level
 * key set, not the parsed object's optional-field projection.
 */
async function readPersistedForm(
	appId: string,
): Promise<Record<string, unknown>> {
	const snap = await getDb().collection("apps").doc(appId).get();
	if (!snap.exists) {
		throw new Error(`Expected app doc ${appId} to exist after seed.`);
	}
	const data = snap.data() as {
		blueprint?: { forms?: Record<string, Record<string, unknown>> };
	};
	const form = data.blueprint?.forms?.[FORM_UUID];
	if (!form) {
		throw new Error(`Expected form ${FORM_UUID} to exist in app ${appId}.`);
	}
	return form;
}

/** Raw untyped read of the persisted app doc — used for asserting the
 *  outer fields the write helpers don't pass survive untouched. */
async function readPersistedApp(
	appId: string,
): Promise<Record<string, unknown>> {
	const snap = await getDb().collection("apps").doc(appId).get();
	if (!snap.exists) {
		throw new Error(`Expected app doc ${appId} to exist after seed.`);
	}
	return snap.data() as Record<string, unknown>;
}

/** Remove the test row so cases don't pollute each other. */
async function deleteApp(appId: string): Promise<void> {
	await getDb().collection("apps").doc(appId).delete();
}

describe.skipIf(!emulatorAvailable)(
	"blueprint clear nested field (Firestore emulator)",
	() => {
		const createdAppIds: string[] = [];

		beforeEach(() => {
			createdAppIds.length = 0;
		});

		afterEach(async () => {
			await Promise.all(createdAppIds.map((id) => deleteApp(id)));
		});

		/** Materialize a fresh app row + install the populated seed, returning
		 *  its id. Every clearable field is present on disk before the clear. */
		async function seedPopulatedApp(): Promise<string> {
			const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
			const appId = await createApp(TEST_OWNER, TEST_PROJECT, runId, {
				status: "complete",
			});
			createdAppIds.push(appId);
			await seedPopulated(appId);

			const seeded = await readPersistedForm(appId);
			if (!("connect" in seeded)) {
				throw new Error(
					"Seed precondition failed: populated form has no `connect` key after seed write.",
				);
			}
			return appId;
		}

		it("the guarded writer clears every nested form field wholesale — no deep-merge survivor", async () => {
			const appId = await seedPopulatedApp();

			/* One `updateForm` mutation clearing every nullable slot. Each clear
			 * carries an explicit `null` (the wire-safe delete signal); the
			 * reducer maps `null → undefined`, and `writeCommittedSnapshot`
			 * replaces the whole `blueprint` map, so the cleared keys vanish
			 * from disk rather than surviving a deep merge. */
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
				appId,
				batchId: crypto.randomUUID(),
				mutations: clearMutations,
				actorUserId: TEST_OWNER,
				kind: "autosave",
			});
			// The commit advanced the stream from the seeded seq 0 to 1.
			expect(result.seq).toBe(1);
			expect(result.deduped).toBe(false);

			const form = await readPersistedForm(appId);
			expect("connect" in form).toBe(false);
			expect("closeCondition" in form).toBe(false);
			expect("postSubmit" in form).toBe(false);
			expect("purpose" in form).toBe(false);

			// The surviving form keys are intact — the wholesale replace didn't
			// drop non-clearable fields.
			expect(form.uuid).toBe(FORM_UUID);
			expect(form.id).toBe("f_form1");
			expect(form.name).toBe("Form 1");
			expect(form.type).toBe("survey");
		});

		it("outer doc fields the writer does not pass survive the guarded commit", async () => {
			const appId = await seedPopulatedApp();
			const before = await readPersistedApp(appId);

			await commitGuardedBatch({
				appId,
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

			const after = await readPersistedApp(appId);
			// `writeCommittedSnapshot` touches only the blueprint-snapshot fields
			// + `mutation_seq` + the stream; everything else comes back untouched.
			expect(after.owner).toBe(TEST_OWNER);
			expect(after.project_id).toBe(TEST_PROJECT);
			expect(after.error_type).toBe(null);
			expect(after.deleted_at).toBe(null);
			expect(after.recoverable_until).toBe(null);
			expect(after.status).toBe("complete");

			const createdBefore = before.created_at as {
				isEqual: (other: unknown) => boolean;
			};
			expect(createdBefore.isEqual(after.created_at)).toBe(true);
		});

		it("completeAndSettleRun flips status only — the persisted blueprint is byte-identical before and after", async () => {
			const appId = await seedPopulatedApp();
			// Put the app in a live BUILD state (the drain-end state
			// `completeAndSettleRun` acts on): `generating` with the run's UNSETTLED
			// reservation marker (every build reserved, so it has one — the writer's
			// ownership gate is `markerSettleable && mine(runId)`), owned by `build-run`.
			await getDb()
				.collection("apps")
				.doc(appId)
				.set(
					{
						status: "generating",
						reservation: {
							period: "2026-07",
							reserved: 100,
							settled: false,
							userId: TEST_OWNER,
							runId: "build-run",
						},
					},
					{ merge: true },
				);

			/* The drain-end finish carries NO blueprint payload by contract: the run's
			 * guarded commits own the blueprint, so the status flip (+ atomic settle)
			 * must not blind-overwrite a concurrent editor. */
			const before = await readPersistedApp(appId);
			await completeAndSettleRun(appId, "build-run");

			const after = await readPersistedApp(appId);
			expect(after.status).toBe("complete");
			expect(after.error_type).toBeNull();
			expect(after.blueprint).toEqual(before.blueprint);
			const form = (
				after.blueprint as { forms: Record<string, Record<string, unknown>> }
			).forms[FORM_UUID];
			if (!form) throw new Error(`Form ${FORM_UUID} missing after completion`);
			expect("connect" in form).toBe(true);
		});
	},
);
