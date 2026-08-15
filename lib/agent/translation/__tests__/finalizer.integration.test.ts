import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	cloneContract,
	makeContract,
} from "@/lib/agent/design/__tests__/fixtures";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { loadApp } from "@/lib/db/apps";
import { writeRunSummaryWithDurableContributions } from "@/lib/db/runSummary";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { effectiveAppLocalization } from "@/lib/domain";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import { finalizeInitialBuildLocalization } from "../finalizer";
import {
	beginOrRecoverLocalizationAttempt,
	claimTranslationBatch,
} from "../store";
import type { TranslationBatchInput } from "../translator";

const APP = "localization-finalizer-app";
const PROJECT = "project-test";
const ACTOR = "owner-test";
const RUN = "translation-run";
const NONCE = "99999999-9999-4999-8999-999999999999";
const h = setupAppStateTestDb("translation_finalizer_");

let lineage: Awaited<ReturnType<typeof h.seedDesignLineage>>;
let source = buildDoc();

beforeEach(async () => {
	source = buildDoc({
		appId: APP,
		appName: "Clinic",
		modules: [
			{
				name: "Patients",
				forms: [
					{
						name: "Intake",
						type: "survey",
						fields: [f({ kind: "text", id: "patient_name", label: "Name" })],
					},
				],
			},
		],
	});
	await h.seedAppWithBlueprint(source, {
		id: APP,
		owner: ACTOR,
		projectId: PROJECT,
	});
	/* Materialization normally creates sequence 1. This fixture starts from the
	 * same canonical document and stamps that already-committed source head so
	 * the localization receipt can prove it descends at sequence 2. */
	await h
		.db()
		.updateTable("apps")
		.set({
			mutation_seq: 1,
			status: "generating",
			run_id: RUN,
			run_holder_nonce: NONCE,
			updated_at: new Date(),
		})
		.where("id", "=", APP)
		.execute();
	const designSessionId = await h.seedDesignSession({
		mode: "build",
		project_id: PROJECT,
		owner_user_id: ACTOR,
		proposed_app_id: APP,
		app_id: APP,
		state: "materialized",
	});
	lineage = await h.seedDesignLineage({
		existingSessionId: designSessionId,
		project_id: PROJECT,
		owner_user_id: ACTOR,
	});
});

describe("initial-build localization finalizer", () => {
	it("commits copy-only localization and its receipt as one canonical revision", async () => {
		const contract = cloneContract(makeContract());
		contract.charter.localization = {
			sourceLanguage: { code: "en", name: "English", direction: "ltr" },
			defaultLanguage: "es",
			targets: [
				{
					language: { code: "es", name: "Español", direction: "ltr" },
					seedFrom: "en",
					strategy: "copy-only",
				},
			],
		};
		const runBatch = vi.fn(() => {
			throw new Error("copy-only localization must not call the model");
		});
		const onLanguage = vi.fn();
		const args = {
			lineage: {
				designSessionId: lineage.designSessionId,
				designRevisionId: lineage.designRevisionId,
				designRevisionDigest: lineage.designRevisionDigest,
				buildPlanId: lineage.buildPlanId,
				buildPlanDigest: lineage.buildPlanDigest,
				appId: APP,
			},
			authority: {
				actorUserId: ACTOR,
				projectId: PROJECT,
				runId: RUN,
				holderNonce: NONCE,
			},
			contract,
			sourceBlueprint: toPersistableDoc(source),
			sourceSeq: 1,
			meter: undefined,
			signal: new AbortController().signal,
			onLanguage,
		};
		const receipt = await finalizeInitialBuildLocalization(args, {
			runBatch,
			automaticTranslationAvailable: () => false,
		});
		expect(runBatch).not.toHaveBeenCalled();
		expect(onLanguage).toHaveBeenCalledWith({
			code: "es",
			name: "Español",
			batch: 1,
			batchCount: 1,
		});
		expect(receipt).toMatchObject({
			buildPlanId: lineage.buildPlanId,
			appId: APP,
			sourceSeq: 1,
			seq: 2,
		});
		const app = await loadApp(APP);
		if (app === null) throw new Error("localized app missing");
		const localization = effectiveAppLocalization(app.blueprint.localization);
		expect(localization.defaultLanguage).toBe("es");
		expect(localization.languages.es).toMatchObject({ name: "Español" });
		const attempt = await h
			.db()
			.selectFrom("design_localization_attempts")
			.select(["status", "committed_seq", "committed_batch_id"])
			.where("build_plan_id", "=", lineage.buildPlanId)
			.executeTakeFirstOrThrow();
		expect(attempt).toMatchObject({
			status: "committed",
			committed_seq: "2",
		});
		expect(attempt.committed_batch_id).toBe(receipt?.batchId);

		/* A response-loss retry adopts the immutable receipt and never creates a
		 * second canonical revision. The current blueprint is deliberately passed
		 * here: recovery must not need the pre-commit source bytes again. */
		const recovered = await finalizeInitialBuildLocalization(
			{
				...args,
				sourceBlueprint: app.blueprint,
			},
			{
				runBatch,
				automaticTranslationAvailable: () => false,
			},
		);
		expect(recovered).toEqual(receipt);
		expect((await loadApp(APP))?.mutation_seq).toBe(2);
	});

	it("persists automatic batches before commit and reuses them after response loss", async () => {
		const contract = cloneContract(makeContract());
		contract.charter.localization = {
			sourceLanguage: { code: "en", name: "English", direction: "ltr" },
			defaultLanguage: "en",
			targets: [
				{
					language: { code: "es", name: "Español", direction: "ltr" },
					seedFrom: "en",
					strategy: "translate-with-nova",
				},
			],
		};
		const runBatch = vi.fn(async (input: TranslationBatchInput) => ({
			object: {
				translations: input.units.map((unit) => ({
					unitId: unit.unitId,
					translatedText: `ES: ${unit.sourceText}`,
				})),
			},
			usage: {
				inputTokens: 100,
				inputTokenDetails: {
					noCacheTokens: 80,
					cacheReadTokens: 20,
					cacheWriteTokens: 0,
				},
				outputTokens: 40,
				outputTokenDetails: { textTokens: 30, reasoningTokens: 10 },
				totalTokens: 140,
			},
			warnings: undefined,
			finishReason: "stop" as const,
		}));
		const trackDurable = vi.fn();
		const args = {
			lineage: {
				designSessionId: lineage.designSessionId,
				designRevisionId: lineage.designRevisionId,
				designRevisionDigest: lineage.designRevisionDigest,
				buildPlanId: lineage.buildPlanId,
				buildPlanDigest: lineage.buildPlanDigest,
				appId: APP,
			},
			authority: {
				actorUserId: ACTOR,
				projectId: PROJECT,
				runId: RUN,
				holderNonce: NONCE,
			},
			contract,
			sourceBlueprint: toPersistableDoc(source),
			sourceSeq: 1,
			meter: { track: vi.fn(), trackDurable },
			signal: new AbortController().signal,
		};
		const receipt = await finalizeInitialBuildLocalization(args, {
			runBatch,
			automaticTranslationAvailable: () => true,
		});
		expect(receipt?.seq).toBe(2);
		const batches = await h
			.db()
			.selectFrom("design_localization_batches")
			.select(["id", "model_id", "status", "usage"])
			.orderBy("batch_index", "asc")
			.execute();
		expect(batches.length).toBeGreaterThan(0);
		expect(batches.every((batch) => batch.status === "accepted")).toBe(true);
		expect(trackDurable).toHaveBeenCalledTimes(batches.length);
		expect(
			trackDurable.mock.calls.map((call) => call[0].translationBatchId),
		).toEqual(batches.map((batch) => batch.id));
		expect(trackDurable.mock.calls.map((call) => call[2]?.model)).toEqual(
			batches.map((batch) => batch.model_id),
		);
		const callCount = runBatch.mock.calls.length;
		const firstBatch = batches[0];
		if (firstBatch === undefined) throw new Error("translation batch missing");
		const summary = {
			runId: "translation-accounting-run",
			startedAt: "2026-08-15T10:00:00.000Z",
			finishedAt: "2026-08-15T10:00:01.000Z",
			promptMode: "build" as const,
			appReady: false,
			moduleCount: 0,
			stepCount: 0,
			model: "gpt-5.6-sol",
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			costEstimate: 0,
			toolCallCount: 0,
		};
		const contribution = {
			translationBatchId: firstBatch.id,
			stepCount: 0,
			inputTokens: 100,
			outputTokens: 40,
			cacheReadTokens: 20,
			cacheWriteTokens: 0,
			costEstimate: 0.001,
		};
		const firstAccounting = await writeRunSummaryWithDurableContributions(
			{ kind: "design-session", designSessionId: lineage.designSessionId },
			summary.runId,
			summary,
			[contribution],
			{ userId: ACTOR, period: "2026-08" },
		);
		const repeatedAccounting = await writeRunSummaryWithDurableContributions(
			{ kind: "design-session", designSessionId: lineage.designSessionId },
			summary.runId,
			summary,
			[contribution],
			{ userId: ACTOR, period: "2026-08" },
		);
		expect(firstAccounting.admittedContributions).toEqual([contribution]);
		expect(repeatedAccounting.admittedContributions).toEqual([]);
		expect(
			await h
				.db()
				.selectFrom("design_localization_batch_usage_accounts")
				.select("batch_id")
				.where("batch_id", "=", firstBatch.id)
				.execute(),
		).toHaveLength(1);

		const app = await loadApp(APP);
		if (app === null) throw new Error("localized app missing");
		await h
			.db()
			.updateTable("design_localization_batches")
			.set({ model_id: "gpt-5.5-persisted-test" })
			.where("id", "=", firstBatch.id)
			.execute();
		await finalizeInitialBuildLocalization(
			{ ...args, sourceBlueprint: app.blueprint },
			{
				runBatch,
				automaticTranslationAvailable: () => true,
			},
		);
		expect(runBatch).toHaveBeenCalledTimes(callCount);
		expect(trackDurable).toHaveBeenCalledTimes(batches.length * 2);
		const replayCalls = trackDurable.mock.calls.slice(batches.length);
		expect(replayCalls[0]?.[0].translationBatchId).toBe(firstBatch.id);
		expect(replayCalls[0]?.[2]?.model).toBe("gpt-5.5-persisted-test");
	});

	it("refuses a random retry of a failed protocol but admits a deployed protocol replacement", async () => {
		const contract = cloneContract(makeContract());
		contract.charter.localization = {
			sourceLanguage: { code: "en", name: "English", direction: "ltr" },
			defaultLanguage: "en",
			targets: [
				{
					language: { code: "es", name: "Español", direction: "ltr" },
					seedFrom: "en",
					strategy: "translate-with-nova",
				},
			],
		};
		const runBatch = vi.fn(async () => ({
			object: { translations: [] },
			usage: {
				inputTokens: 25,
				inputTokenDetails: {
					noCacheTokens: 25,
					cacheReadTokens: 0,
					cacheWriteTokens: 0,
				},
				outputTokens: 5,
				outputTokenDetails: { textTokens: 5, reasoningTokens: 0 },
				totalTokens: 30,
			},
			warnings: undefined,
			finishReason: "stop" as const,
		}));
		const lineageArgs = {
			designSessionId: lineage.designSessionId,
			designRevisionId: lineage.designRevisionId,
			designRevisionDigest: lineage.designRevisionDigest,
			buildPlanId: lineage.buildPlanId,
			buildPlanDigest: lineage.buildPlanDigest,
			appId: APP,
		};
		const authority = {
			actorUserId: ACTOR,
			projectId: PROJECT,
			runId: RUN,
			holderNonce: NONCE,
		};
		const sourceBlueprint = toPersistableDoc(source);
		const args = {
			lineage: lineageArgs,
			authority,
			contract,
			sourceBlueprint,
			sourceSeq: 1,
			meter: undefined,
			signal: new AbortController().signal,
		};
		const deps = {
			runBatch,
			automaticTranslationAvailable: () => true,
		};
		await expect(
			finalizeInitialBuildLocalization(args, deps),
		).rejects.toMatchObject({
			code: "translation-output-invalid",
		});
		expect(runBatch).toHaveBeenCalledTimes(1);
		await expect(
			finalizeInitialBuildLocalization(args, deps),
		).rejects.toMatchObject({
			code: "translation-output-invalid",
		});
		expect(runBatch).toHaveBeenCalledTimes(1);

		const attempt = await beginOrRecoverLocalizationAttempt({
			lineage: lineageArgs,
			authority,
			sourceSeq: 1,
			sourceSnapshotDigest: canonicalJsonDigest(sourceBlueprint),
			intent: contract.charter.localization,
		});
		expect(attempt.status).toBe("running");
		const failed = await h
			.db()
			.selectFrom("design_localization_batches")
			.selectAll()
			.where("attempt_id", "=", attempt.id)
			.where("status", "=", "failed")
			.executeTakeFirstOrThrow();
		const replacement = await claimTranslationBatch({
			attempt,
			authority,
			spec: {
				batchIndex: failed.batch_index,
				sourceLanguage: failed.source_language,
				targetLanguage: failed.target_language,
				unitIds: failed.unit_ids,
				inputDigest: failed.input_digest,
				modelId: failed.model_id,
				promptVersion: `${failed.prompt_version}-fixed`,
				schemaVersion: failed.schema_version,
			},
		});
		expect(replacement.kind).toBe("run");
		expect(
			await h
				.db()
				.selectFrom("design_localization_batches")
				.select("id")
				.where("attempt_id", "=", attempt.id)
				.where("batch_index", "=", failed.batch_index)
				.execute(),
		).toHaveLength(2);
	});
});
