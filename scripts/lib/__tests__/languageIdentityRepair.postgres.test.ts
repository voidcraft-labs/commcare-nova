import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { createExplicitBlankApp } from "@/lib/db/appGenesis";
import { loadApp } from "@/lib/db/apps";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import { runLanguageIdentityRepair } from "../languageIdentityRepair";

const h = setupAppStateTestDb("language_identity_repair_");
const PROJECT = "language-repair-project";
const OWNER = "language-repair-owner";

async function seedLegacySource(code: string, name: string) {
	await h.seedProjectMember(OWNER, PROJECT, "owner");
	const { appId } = await createExplicitBlankApp(
		OWNER,
		PROJECT,
		crypto.randomUUID(),
		{ name: "Language repair" },
	);
	const localization = {
		sourceLanguage: code,
		defaultLanguage: code,
		languageOrder: [code],
		languages: { [code]: { code, name, direction: "ltr" } },
		translations: {},
	};
	await h
		.db()
		.insertInto("app_changes")
		.values({
			app_id: appId,
			seq: 2,
			batch_id: crypto.randomUUID(),
			actor_id: OWNER,
			kind: "autosave",
			run_id: null,
			mutations: JSON.stringify([
				{
					kind: "relabelSourceLanguage",
					language: { code, name, direction: "ltr" },
				},
			]),
		})
		.execute();
	await h
		.db()
		.updateTable("apps")
		.set({ localization: JSON.stringify(localization), mutation_seq: 2 })
		.where("id", "=", appId)
		.execute();
	return appId;
}

async function persistedState(appId: string) {
	return {
		app: await h.readAppRow(appId),
		history: await h
			.db()
			.selectFrom("app_changes")
			.selectAll()
			.where("app_id", "=", appId)
			.orderBy("seq")
			.execute(),
		baselines: await h
			.db()
			.selectFrom("app_change_fold_baselines")
			.selectAll()
			.where("app_id", "=", appId)
			.orderBy("seq")
			.execute(),
		attempts: await h
			.db()
			.selectFrom("design_localization_attempts")
			.selectAll()
			.where("app_id", "=", appId)
			.orderBy("id")
			.execute(),
		batches: await h
			.db()
			.selectFrom("design_localization_batches")
			.selectAll()
			.orderBy("id")
			.execute(),
	};
}

async function seedLegacyBaseline(appId: string) {
	await h
		.db()
		.transaction()
		.execute(async (tx) => {
			await sql`ALTER TABLE app_change_fold_baselines DISABLE TRIGGER app_change_fold_baselines_immutable`.execute(
				tx,
			);
			await sql`UPDATE app_change_fold_baselines SET snapshot = snapshot || jsonb_build_object('localization',
			jsonb_build_object('sourceLanguage', 'en', 'defaultLanguage', 'en', 'languageOrder', jsonb_build_array('en'),
			'languages', jsonb_build_object('en', jsonb_build_object('code', 'en', 'name', 'English', 'direction', 'ltr')), 'translations', '{}'::jsonb))
			WHERE app_id = ${appId}`.execute(tx);
			await sql`UPDATE app_change_fold_baselines SET snapshot_digest = nova_app_change_fold_snapshot_digest(snapshot) WHERE app_id = ${appId}`.execute(
				tx,
			);
			await sql`ALTER TABLE app_change_fold_baselines ENABLE TRIGGER app_change_fold_baselines_immutable`.execute(
				tx,
			);
		});
}

async function seedLegacyTranslationState(appId: string) {
	const sessionId = await h.seedDesignSession({
		app_id: appId,
		proposed_app_id: appId,
		project_id: PROJECT,
		owner_user_id: OWNER,
		mode: "build",
		state: "materialized",
	});
	const lineage = await h.seedDesignLineage({
		existingSessionId: sessionId,
		project_id: PROJECT,
		owner_user_id: OWNER,
	});
	const attemptId = crypto.randomUUID();
	const oldIntent = {
		sourceLanguage: { code: "fr", name: "French", direction: "ltr" },
		defaultLanguage: "fr",
		targets: [
			{
				language: { code: "es", name: "Spanish", direction: "ltr" },
				seedFrom: "fr",
				strategy: "copy-only",
			},
		],
	};
	const baseline = await h
		.db()
		.selectFrom("app_change_fold_baselines")
		.select("snapshot")
		.where("app_id", "=", appId)
		.executeTakeFirstOrThrow();
	await sql`INSERT INTO design_localization_attempts (id, design_session_id, design_revision_id, design_revision_digest,
		build_plan_id, build_plan_digest, app_id, source_seq, source_snapshot_digest, intent_digest, intent, status, created_by_run_id, updated_by_run_id)
		VALUES (${attemptId}, ${sessionId}, ${lineage.designRevisionId}, ${lineage.designRevisionDigest}, ${lineage.buildPlanId}, ${lineage.buildPlanDigest},
		${appId}, 1, ${canonicalJsonDigest(baseline.snapshot)}, ${canonicalJsonDigest(oldIntent)}, ${JSON.stringify(oldIntent)}::jsonb, 'running', 'historical-run', 'historical-run')`.execute(
		h.db(),
	);
	await sql`INSERT INTO design_localization_batches (id, attempt_id, batch_index, source_language, target_language, unit_ids,
		input_digest, model_id, prompt_version, schema_version, status)
		VALUES (${crypto.randomUUID()}, ${attemptId}, 0, 'fr', 'es', '[]'::jsonb, ${canonicalJsonDigest(oldIntent)}, 'historical-model', 'historical-prompt', 'historical-schema', 'pending')`.execute(
		h.db(),
	);
}

describe("persisted language identity repair", () => {
	it.each([
		{
			code: "fr",
			name: "French",
			localization: {
				sourceLanguage: "fra",
				defaultLanguage: "fra",
				languageOrder: ["fra"],
				translations: {},
			},
		},
		{ code: "en", name: "English", localization: undefined },
	])(
		"rewrites and proves the $name root and historical row, then retries without writes",
		async ({ code, name, localization }) => {
			const appId = await seedLegacySource(code, name);
			expect(await runLanguageIdentityRepair([appId])).toMatchObject({
				scannedApps: 1,
				rewrittenApps: 1,
				rewrittenRoots: 1,
				rewrittenChangeRows: 1,
				refoldProvenApps: 1,
				verifiedApps: 1,
			});
			expect((await loadApp(appId))?.blueprint.localization).toEqual(
				localization,
			);
			const before = await h.readAppRow(appId);
			const history = await h
				.db()
				.selectFrom("app_changes")
				.selectAll()
				.where("app_id", "=", appId)
				.orderBy("seq")
				.execute();
			expect(await runLanguageIdentityRepair([appId])).toMatchObject({
				rewrittenApps: 0,
				verifiedApps: 1,
			});
			expect(await h.readAppRow(appId)).toEqual(before);
			expect(
				await h
					.db()
					.selectFrom("app_changes")
					.selectAll()
					.where("app_id", "=", appId)
					.orderBy("seq")
					.execute(),
			).toEqual(history);
		},
	);
	it("repairs an old baseline and preserves its immutable guard", async () => {
		const appId = await seedLegacySource("en", "English");
		await seedLegacyBaseline(appId);
		expect(await runLanguageIdentityRepair([appId])).toMatchObject({
			rewrittenBaselines: 1,
			refoldProvenApps: 1,
		});
		const state = await persistedState(appId);
		expect(state.app?.localization).toBeNull();
		expect(state.baselines[0]?.snapshot).not.toHaveProperty("localization");
		await expect(
			h
				.db()
				.updateTable("app_change_fold_baselines")
				.set({ snapshot_digest: "a".repeat(64) })
				.where("app_id", "=", appId)
				.execute(),
		).rejects.toThrow(/immutable/);
		expect(await persistedState(appId)).toEqual(state);
	});

	it("rolls every store back on fold mismatch, then rewrites translation identities and digests on retry", async () => {
		const appId = await seedLegacySource("fr", "French");
		await seedLegacyBaseline(appId);
		await seedLegacyTranslationState(appId);
		await h
			.db()
			.updateTable("apps")
			.set({ app_name: "Divergent head", app_name_lower: "divergent head" })
			.where("id", "=", appId)
			.execute();
		const before = await persistedState(appId);
		await expect(runLanguageIdentityRepair([appId])).rejects.toThrow(
			/fold proof failed/,
		);
		expect(await persistedState(appId)).toEqual(before);
		await h
			.db()
			.updateTable("apps")
			.set({ app_name: "Language repair", app_name_lower: "language repair" })
			.where("id", "=", appId)
			.execute();
		expect(await runLanguageIdentityRepair([appId])).toMatchObject({
			rewrittenRoots: 1,
			rewrittenChangeRows: 1,
			rewrittenBaselines: 1,
			rewrittenAttempts: 1,
			rewrittenBatchRows: 1,
			refoldProvenApps: 1,
		});
		const after = await persistedState(appId);
		const intent = {
			sourceLanguage: { language: "fra" },
			defaultLanguage: { language: "fra" },
			targets: [
				{
					language: { language: "spa" },
					seedFrom: { language: "fra" },
					strategy: "copy-only",
				},
			],
		};
		expect(after.attempts).toEqual([
			{
				...before.attempts[0],
				intent,
				intent_digest: canonicalJsonDigest(intent),
			},
		]);
		expect(after.batches).toEqual([
			{ ...before.batches[0], source_language: "fra", target_language: "spa" },
		]);
		expect(await runLanguageIdentityRepair([appId])).toMatchObject({
			rewrittenApps: 0,
			verifiedApps: 1,
		});
		expect(await persistedState(appId)).toEqual(after);
	});

	it("refuses an undecidable language before changing any persisted store", async () => {
		const appId = await seedLegacySource("zh", "Chinese");
		const before = await persistedState(appId);
		await expect(runLanguageIdentityRepair([appId])).rejects.toThrow(
			/cannot decide these stored codes/,
		);
		expect(await persistedState(appId)).toEqual(before);
	});
	it("clears an already structured English-only shell even when no history rewrite is needed", async () => {
		await h.seedProjectMember(OWNER, PROJECT, "owner");
		const { appId } = await createExplicitBlankApp(
			OWNER,
			PROJECT,
			crypto.randomUUID(),
			{ name: "Language repair" },
		);
		await h
			.db()
			.updateTable("apps")
			.set({
				localization: JSON.stringify({
					sourceLanguage: "eng",
					defaultLanguage: "eng",
					languageOrder: ["eng"],
					translations: {},
				}),
			})
			.where("id", "=", appId)
			.execute();
		expect(await runLanguageIdentityRepair([appId])).toMatchObject({
			rewrittenRoots: 1,
			rewrittenChangeRows: 0,
			refoldProvenApps: 1,
		});
		expect((await h.readAppRow(appId))?.localization).toBeNull();
	});
});
