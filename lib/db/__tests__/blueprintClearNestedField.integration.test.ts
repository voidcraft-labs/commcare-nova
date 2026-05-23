/**
 * Integration coverage for the persistence boundary against the
 * Firestore emulator: every nullable nested blueprint field that the
 * reducer leaves at `undefined` after a clear must vanish from the
 * persisted document, not survive a deep merge against its prior value.
 *
 * Covers the four form-level nullable fields (`connect`,
 * `closeCondition`, `postSubmit`, `purpose`) and the three persistence
 * helpers (`updateApp`, `updateAppForRun`, `completeApp`).
 *
 * Assertions check key absence (`'connect' in form === false`) rather
 * than `=== undefined`: the wire-level claim is that the key is GONE,
 * not "present with `undefined`."
 *
 * Auto-skipped when `FIRESTORE_EMULATOR_HOST` is unset; run via
 * `npm run test:integration`.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
	ConnectConfig,
	PersistableDoc,
	PostSubmitDestination,
} from "@/lib/domain";
import { completeApp, createApp, updateApp, updateAppForRun } from "../apps";
import { getDb } from "../firestore";

const emulatorAvailable = Boolean(process.env.FIRESTORE_EMULATOR_HOST);

const TEST_OWNER = "user-blueprint-clear-test";

/**
 * The slice of `Form` that carries clearable nullable fields. Every
 * `undefined` entry models exactly what the reducer's `Object.assign(
 * form, { connect: undefined, ... })` leaves behind after a clear, and
 * what the persistence helper sees. Typed as `Partial<...>` so the
 * skeleton builder accepts either a populated or all-`undefined` slice
 * without rebuilding the rest of the doc. Adding a new clearable field
 * to the bug-class family means adding one property here.
 */
type FormNullableSlice = Partial<{
	connect: ConnectConfig | undefined;
	closeCondition: { field: string; answer: string } | undefined;
	postSubmit: PostSubmitDestination | undefined;
	purpose: string | undefined;
}>;

/**
 * The populated slice every test seeds with. Each value is the minimum
 * legal shape per `lib/domain/forms.ts` — enough to land on disk so a
 * subsequent "clear all" write has somewhere to clear from.
 */
const POPULATED_FORM_SLICE: FormNullableSlice = {
	connect: {
		learn_module: {
			id: "lm_1",
			name: "Learn module 1",
			description: "An intro module",
			time_estimate: 5,
		},
	},
	closeCondition: { field: "done", answer: "yes" },
	postSubmit: "app_home",
	purpose: "Captures intake data",
};

/**
 * The "everything cleared" slice — every clearable field set to
 * `undefined`. The Firestore client strips these from the payload at
 * write time; the test verifies the persisted doc no longer carries
 * the keys.
 */
const CLEARED_FORM_SLICE: FormNullableSlice = {
	connect: undefined,
	closeCondition: undefined,
	postSubmit: undefined,
	purpose: undefined,
};

/**
 * Build a `PersistableDoc` snapshot with one module and one form. The
 * caller supplies the form's nullable slice (populated vs. cleared) —
 * the surrounding app/module/form skeleton is identical across cases,
 * so it lives here once.
 *
 * The doc is cast through `unknown` because `blueprintDocSchema` only
 * validates string SHAPE at runtime; the `Uuid` brand on uuid-typed
 * record keys is a compile-time tag the persistence helpers never
 * check, and dressing the test fixtures with `asUuid` would obscure
 * the load-bearing thing being tested.
 */
function buildDoc(
	appId: string,
	moduleUuid: string,
	formUuid: string,
	formNullable: FormNullableSlice,
): PersistableDoc {
	const doc = {
		appId,
		appName: "Blueprint clear test app",
		connectType: null,
		caseTypes: null,
		modules: {
			[moduleUuid]: {
				uuid: moduleUuid,
				id: "m_module1",
				name: "Module 1",
			},
		},
		forms: {
			[formUuid]: {
				uuid: formUuid,
				id: "f_form1",
				name: "Form 1",
				type: "survey" as const,
				...formNullable,
			},
		},
		fields: {},
		moduleOrder: [moduleUuid],
		formOrder: { [moduleUuid]: [formUuid] },
		fieldOrder: {},
	};
	return doc as unknown as PersistableDoc;
}

/** Populated-seed wrapper around the shared skeleton. */
function buildPopulatedDoc(
	appId: string,
	moduleUuid: string,
	formUuid: string,
): PersistableDoc {
	return buildDoc(appId, moduleUuid, formUuid, POPULATED_FORM_SLICE);
}

/** Cleared wrapper around the shared skeleton — every nullable form
 *  field is `undefined`, modeling the reducer's post-clear state. */
function buildClearedDoc(
	appId: string,
	moduleUuid: string,
	formUuid: string,
): PersistableDoc {
	return buildDoc(appId, moduleUuid, formUuid, CLEARED_FORM_SLICE);
}

/**
 * Raw untyped read of the persisted form object — bypasses the typed
 * converter's Zod parse so the test sees the wire payload exactly as
 * Firestore stored it. The load-bearing claim is about the WIRE-level
 * key set, not the parsed object's optional-field projection.
 */
async function readPersistedForm(
	appId: string,
	formUuid: string,
): Promise<Record<string, unknown>> {
	const snap = await getDb().collection("apps").doc(appId).get();
	if (!snap.exists) {
		throw new Error(`Expected app doc ${appId} to exist after seed.`);
	}
	const data = snap.data() as {
		blueprint?: { forms?: Record<string, Record<string, unknown>> };
	};
	const form = data.blueprint?.forms?.[formUuid];
	if (!form) {
		throw new Error(`Expected form ${formUuid} to exist in app ${appId}.`);
	}
	return form;
}

/**
 * Raw untyped read of the persisted app doc — used for asserting that
 * outer fields (`owner`, `created_at`, etc.) the write helpers don't
 * pass survive untouched after the write.
 */
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
		/* Track every app id this suite materializes so the afterEach
		 * cleanup can purge them — `createApp` writes to a root-level
		 * collection and there's no cheap "delete everything I own"
		 * primitive. Each case gets its own row. */
		const createdAppIds: string[] = [];

		beforeEach(() => {
			createdAppIds.length = 0;
		});

		afterEach(async () => {
			await Promise.all(createdAppIds.map((id) => deleteApp(id)));
		});

		/**
		 * Helper: materialize a fresh app row + install the populated
		 * seed via the real `updateAppForRun` helper (the same path
		 * the MCP tool calls take). Returns the ids the case needs to
		 * address the form on its second write.
		 *
		 * Using `updateAppForRun` for the seed (not raw `set`) exercises
		 * the real production write path twice — once to populate, once
		 * to clear — so any helper-internal regression that breaks the
		 * populated write also fails this test, not silently passes
		 * because the seed used a different code path.
		 */
		async function seedPopulatedApp(): Promise<{
			appId: string;
			moduleUuid: string;
			formUuid: string;
			runId: string;
		}> {
			const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
			const appId = await createApp(TEST_OWNER, runId);
			createdAppIds.push(appId);
			/* `createApp` mints the doc id but the brand-typed `Uuid`
			 * shape isn't actually enforced at runtime — the schema
			 * accepts any string. We use ASCII fixtures so test failures
			 * are readable. */
			const moduleUuid = "11111111-1111-4111-8111-111111111111";
			const formUuid = "22222222-2222-4222-8222-222222222222";
			const populated = buildPopulatedDoc(appId, moduleUuid, formUuid);
			await updateAppForRun(appId, populated, runId);

			/* Sanity: the seed write actually installed the populated
			 * shape. If this fails, the bug is upstream of what this
			 * suite tests and the rest of the assertions are unreliable. */
			const seeded = await readPersistedForm(appId, formUuid);
			if (!("connect" in seeded)) {
				throw new Error(
					"Seed precondition failed: populated form has no `connect` key after seed write.",
				);
			}

			return { appId, moduleUuid, formUuid, runId };
		}

		it("updateAppForRun: clearing multiple nested form fields removes every key from the persisted doc", async () => {
			const { appId, moduleUuid, formUuid, runId } = await seedPopulatedApp();

			/* The bug-trigger write: every clearable field is `undefined`
			 * in the in-memory doc. With the buggy `set + merge:true`
			 * the wire payload strips them and Firestore's deep-merge
			 * preserves the prior values; with the fixed `update()` the
			 * `blueprint` map is replaced wholesale and the keys vanish. */
			const cleared = buildClearedDoc(appId, moduleUuid, formUuid);
			await updateAppForRun(appId, cleared, runId);

			const form = await readPersistedForm(appId, formUuid);

			/* Key-absence assertions, not `=== undefined`. The bug
			 * leaves the OLD value present — `'connect' in form` would
			 * return `true` and the assertion fails loud, while `form.
			 * connect === undefined` would falsely pass against a
			 * subtler "present but null" variant. */
			expect("connect" in form).toBe(false);
			expect("closeCondition" in form).toBe(false);
			expect("postSubmit" in form).toBe(false);
			expect("purpose" in form).toBe(false);

			/* And the surviving form keys are intact — proves the
			 * wholesale `blueprint`-replace didn't accidentally drop
			 * non-clearable fields. */
			expect(form.uuid).toBe(formUuid);
			expect(form.id).toBe("f_form1");
			expect(form.name).toBe("Form 1");
			expect(form.type).toBe("survey");
		});

		it("updateAppForRun: outer doc fields the helper does not pass are preserved", async () => {
			const { appId, moduleUuid, formUuid, runId } = await seedPopulatedApp();

			/* Capture the seed-time outer-field state — `update()` only
			 * touches the keys the helper passes (`app_name`,
			 * `app_name_lower`, `connect_type`, `module_count`,
			 * `form_count`, `blueprint`, `run_id`, `updated_at`), so
			 * everything else must come back byte-for-byte. */
			const before = await readPersistedApp(appId);

			const cleared = buildClearedDoc(appId, moduleUuid, formUuid);
			await updateAppForRun(appId, cleared, runId);

			const after = await readPersistedApp(appId);

			/* The outer-field guard: `update()` doesn't widen to clobber
			 * fields the helper doesn't pass. Each of these has a
			 * concrete expected value from `createApp`'s seed; we don't
			 * compare timestamps (different Firestore writes produce
			 * different `updated_at` server timestamps — that's the
			 * intended behavior of `serverTimestamp()`). */
			expect(after.owner).toBe(TEST_OWNER);
			expect(after.error_type).toBe(null);
			expect(after.deleted_at).toBe(null);
			expect(after.recoverable_until).toBe(null);
			expect(after.status).toBe("generating");

			/* `created_at` is a Firestore `Timestamp` instance — equality
			 * by `.isEqual()` proves the write didn't reset it to a
			 * fresh server timestamp. */
			const createdBefore = before.created_at as {
				isEqual: (other: unknown) => boolean;
			};
			expect(createdBefore.isEqual(after.created_at)).toBe(true);
		});

		it("updateApp: clearing multiple nested form fields removes every key from the persisted doc", async () => {
			const { appId, moduleUuid, formUuid } = await seedPopulatedApp();

			/* `updateApp` is the auto-save path (no runId). Shares the
			 * same bug as `updateAppForRun` because both used
			 * `.set(..., { merge: true })`. */
			const cleared = buildClearedDoc(appId, moduleUuid, formUuid);
			await updateApp(appId, cleared);

			const form = await readPersistedForm(appId, formUuid);
			expect("connect" in form).toBe(false);
			expect("closeCondition" in form).toBe(false);
			expect("postSubmit" in form).toBe(false);
			expect("purpose" in form).toBe(false);
		});

		it("completeApp: clearing nested fields removes them AND status flips to complete", async () => {
			const { appId, moduleUuid, formUuid, runId } = await seedPopulatedApp();

			/* `completeApp` is the generation-success boundary — the
			 * SA emits it via fire-and-forget at end of `validateApp`.
			 * Seed leaves the app at `status: "generating"` (the
			 * `createApp` default); after `completeApp` it MUST flip
			 * to `"complete"` AND the cleared fields must vanish. */
			const cleared = buildClearedDoc(appId, moduleUuid, formUuid);
			await completeApp(appId, cleared, runId);

			const after = await readPersistedApp(appId);
			expect(after.status).toBe("complete");
			expect(after.run_id).toBe(runId);

			const form = (
				after.blueprint as { forms: Record<string, Record<string, unknown>> }
			).forms[formUuid];
			if (!form) throw new Error(`Form ${formUuid} missing after completeApp`);
			expect("connect" in form).toBe(false);
			expect("closeCondition" in form).toBe(false);
			expect("postSubmit" in form).toBe(false);
			expect("purpose" in form).toBe(false);
		});
	},
);
