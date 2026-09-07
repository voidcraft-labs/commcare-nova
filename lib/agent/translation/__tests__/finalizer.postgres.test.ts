/** Native localization ledger and canonical transaction tests. The accepted
 * design rows are FK-valid fixtures; real genesis and run claims establish
 * source history and authority. Responses-peer cases retain the real SDK. */

import { sql } from "kysely";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import {
	respondWithObject,
	withResponsesPeer,
} from "@/lib/agent/__tests__/responsesPeer";
import {
	cloneContract,
	makeContract,
} from "@/lib/agent/design/__tests__/fixtures";
import { DesignGenerationContext } from "@/lib/agent/design/designGenerationContext";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { createExplicitBlankApp } from "@/lib/db/appGenesis";
import { claimAndReserveRun, loadApp } from "@/lib/db/apps";
import { writeRunSummaryWithDurableContributions } from "@/lib/db/runSummary";
import {
	hydratePersistedBlueprint,
	toPersistableDoc,
} from "@/lib/doc/fieldParent";
import { effectiveAppLocalization } from "@/lib/domain";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import { finalizeInitialBuildLocalization } from "../finalizer";
import {
	beginOrRecoverLocalizationAttempt,
	claimTranslationBatch,
} from "../store";
import type { TranslationBatchInput } from "../translator";
import { createProductionTranslationBatchRunner } from "../translator";

let APP: string;
const PROJECT = "project-test";
const ACTOR = "owner-test";
const RUN = "translation-run";
const NONCE = "99999999-9999-4999-8999-999999999999";
const h = setupAppStateTestDb("translation_finalizer_");

let lineage: Awaited<ReturnType<typeof h.seedDesignLineage>>;
let source = buildDoc();

beforeEach(async () => {
	await h.seedProjectMember(ACTOR, PROJECT, "owner");
	const born = await createExplicitBlankApp(ACTOR, PROJECT, "source-genesis", {
		name: "Clinic",
		status: "complete",
	});
	APP = born.appId;
	source = hydratePersistedBlueprint(born.blueprint);
	await claimAndReserveRun(APP, "build", RUN, ACTOR, 100, PROJECT, NONCE);
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
	it.each([true, false])(
		"retains provider completion status through native persistence (incomplete=%s)",
		async (incomplete) => {
			const contract = cloneContract(makeContract());
			contract.charter.localization = {
				sourceLanguage: { language: "eng" },
				defaultLanguage: { language: "eng" },
				targets: [
					{
						language: { language: "spa" },
						seedFrom: { language: "eng" },
						strategy: "translate-with-nova",
					},
				],
			};
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
			};
			let requests = 0;
			const peerErrors: unknown[] = [];
			await withResponsesPeer(
				(request, response) => {
					let body = "";
					request.setEncoding("utf8");
					request.on("data", (chunk) => {
						body += chunk;
					});
					request.on("end", () => {
						try {
							const requestBody = z
								.object({
									input: z.array(
										z.object({ role: z.string(), content: z.unknown() }),
									),
								})
								.parse(JSON.parse(body));
							const content = z
								.array(
									z.object({ type: z.string(), text: z.string().optional() }),
								)
								.parse(
									requestBody.input.find((item) => item.role === "user")
										?.content,
								);
							const text = content.find(
								(item) => item.type === "input_text",
							)?.text;
							const payload = z
								.object({
									units: z.array(
										z.object({ unitId: z.string(), sourceText: z.string() }),
									),
								})
								.parse(JSON.parse(text ?? ""));
							requests++;
							respondWithObject(
								response,
								JSON.stringify({
									translations: payload.units.map((unit) => ({
										unitId: unit.unitId,
										translatedText: `ES: ${unit.sourceText}`,
									})),
								}),
								{ incomplete },
							);
						} catch (error) {
							peerErrors.push(error);
							response.writeHead(400);
							response.end(
								JSON.stringify({
									error: { message: "Invalid translation fixture request" },
								}),
							);
						}
					});
				},
				async (_provider, transport) => {
					const context = new DesignGenerationContext({
						apiKey: "synthetic-local",
						transport,
						userId: ACTOR,
						projectId: PROJECT,
						runId: RUN,
						designSessionId: lineage.designSessionId,
					});
					const deps = {
						runBatch: createProductionTranslationBatchRunner(context),
						automaticTranslationAvailable: () => true,
					};
					if (incomplete) {
						await expect(
							finalizeInitialBuildLocalization(args, deps),
						).rejects.toMatchObject({ code: "translation-output-truncated" });
						expect((await loadApp(APP))?.blueprint).toEqual(
							toPersistableDoc(source),
						);
						expect((await loadApp(APP))?.mutation_seq).toBe(1);
						expect(
							await h
								.db()
								.selectFrom("design_localization_receipts")
								.selectAll()
								.execute(),
						).toEqual([]);
						const failed = await h
							.db()
							.selectFrom("design_localization_batches")
							.select(["status", "failure_code", "usage"])
							.execute();
						expect(failed).toEqual([
							{
								status: "failed",
								failure_code: "translation-output-truncated",
								usage: {
									inputTokens: 11,
									outputTokens: 7,
									cacheReadTokens: 3,
									cacheWriteTokens: 0,
								},
							},
						]);
						await expect(
							finalizeInitialBuildLocalization(args, deps),
						).rejects.toMatchObject({ code: "translation-output-truncated" });
						expect(requests).toBe(1);
					} else {
						const receipt = await finalizeInitialBuildLocalization(args, deps);
						expect(receipt?.seq).toBe(2);
						const app = await loadApp(APP);
						if (!app) throw new Error("missing app");
						expect(
							effectiveAppLocalization(app.blueprint.localization).translations
								.spa,
						).toBeDefined();
						const called = requests;
						expect(
							await finalizeInitialBuildLocalization(
								{ ...args, sourceBlueprint: app.blueprint },
								deps,
							),
						).toEqual(receipt);
						expect(requests).toBe(called);
						expect(requests).toBeGreaterThan(0);
					}
				},
			);
			expect(peerErrors).toEqual([]);
		},
	);

	it("rolls back localization and its attempt when the last receipt insert fails, then retries", async () => {
		const contract = cloneContract(makeContract());
		contract.charter.localization = {
			sourceLanguage: { language: "eng" },
			defaultLanguage: { language: "spa" },
			targets: [
				{
					language: { language: "spa" },
					seedFrom: { language: "eng" },
					strategy: "copy-only",
				},
			],
		};
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
		};
		const deps = {
			runBatch: vi.fn(async () => {
				throw new Error("copy-only finalization must not call a model");
			}),
			automaticTranslationAvailable: () => false,
		};
		await h.pool().query(`
   CREATE FUNCTION audit_refuse_localization_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN
    IF NOT EXISTS (SELECT 1 FROM apps WHERE id = NEW.app_id AND mutation_seq = 2)
       OR NOT EXISTS (SELECT 1 FROM app_changes WHERE app_id = NEW.app_id AND seq = 2)
       OR NOT EXISTS (SELECT 1 FROM design_localization_attempts WHERE id = NEW.attempt_id AND status = 'committed')
    THEN RAISE EXCEPTION 'audit fault did not reach the complete write tail'; END IF;
    RAISE EXCEPTION 'audit final localization receipt failure';
   END $$;
   CREATE TRIGGER audit_refuse_localization_receipt BEFORE INSERT ON design_localization_receipts
    FOR EACH ROW EXECUTE FUNCTION audit_refuse_localization_receipt();
  `);
		try {
			await expect(
				finalizeInitialBuildLocalization(args, deps),
			).rejects.toThrow("audit final localization receipt failure");
			const app = await loadApp(APP);
			expect(app?.mutation_seq).toBe(1);
			expect(app?.blueprint).toEqual(toPersistableDoc(source));
			expect(
				await h
					.db()
					.selectFrom("app_changes")
					.select("seq")
					.where("app_id", "=", APP)
					.where("seq", ">", 1)
					.execute(),
			).toEqual([]);
			expect(
				await h
					.db()
					.selectFrom("design_localization_receipts")
					.selectAll()
					.execute(),
			).toEqual([]);
			expect(
				await h
					.db()
					.selectFrom("design_localization_attempts")
					.select(["status", "committed_seq", "committed_batch_id"])
					.execute(),
			).toEqual([
				{ status: "running", committed_seq: null, committed_batch_id: null },
			]);
		} finally {
			await h
				.pool()
				.query(
					"DROP TRIGGER IF EXISTS audit_refuse_localization_receipt ON design_localization_receipts; DROP FUNCTION IF EXISTS audit_refuse_localization_receipt();",
				);
		}
		expect((await finalizeInitialBuildLocalization(args, deps))?.seq).toBe(2);
		expect(deps.runBatch).not.toHaveBeenCalled();
	});

	it("commits copy-only localization and its receipt as one canonical revision", async () => {
		const contract = cloneContract(makeContract());
		contract.charter.localization = {
			sourceLanguage: { language: "eng" },
			defaultLanguage: { language: "spa" },
			targets: [
				{
					language: { language: "spa" },
					seedFrom: { language: "eng" },
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
			languageTag: "spa",
			languageName: "Spanish",
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
		expect(localization.defaultLanguage).toBe("spa");
		expect(localization.languageOrder).toEqual(["spa", "eng"]);
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
			sourceLanguage: { language: "eng" },
			defaultLanguage: { language: "eng" },
			targets: [
				{
					language: { language: "spa" },
					seedFrom: { language: "eng" },
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

	it("fails closed when a persisted localization intent is corrupt", async () => {
		const contract = cloneContract(makeContract());
		contract.charter.localization = {
			sourceLanguage: { language: "eng" },
			defaultLanguage: { language: "eng" },
			targets: [],
		};
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
			sourceSeq: 1,
			sourceSnapshotDigest: canonicalJsonDigest(toPersistableDoc(source)),
			intent: contract.charter.localization,
		};
		const attempt = await beginOrRecoverLocalizationAttempt(args);
		await sql`
			UPDATE design_localization_attempts
			SET intent = ${JSON.stringify({
				sourceLanguage: { language: "eng" },
				defaultLanguage: { language: "fra" },
				targets: [],
			})}::jsonb
			WHERE id = ${attempt.id}
		`.execute(h.db());

		await expect(beginOrRecoverLocalizationAttempt(args)).rejects.toThrow(
			"runtime default language",
		);
	});

	it("refuses a random retry of a failed protocol but admits a deployed protocol replacement", async () => {
		const contract = cloneContract(makeContract());
		contract.charter.localization = {
			sourceLanguage: { language: "eng" },
			defaultLanguage: { language: "eng" },
			targets: [
				{
					language: { language: "spa" },
					seedFrom: { language: "eng" },
					strategy: "translate-with-nova",
				},
			],
		};
		const runBatch = vi.fn(async (input: TranslationBatchInput) => ({
			object: {
				translations: input.units.map((unit) => ({
					unitId: unit.unitId,
					translatedText:
						unit.role === "app-name" ? ` ${unit.sourceText}` : unit.sourceText,
				})),
			},
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
			isReusableAcceptedOutput: () => true,
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

	it("reuses valid accepted semantic batches when a failed generation receives a protocol upgrade", async () => {
		const contract = cloneContract(makeContract());
		contract.charter.localization = {
			sourceLanguage: { language: "eng" },
			defaultLanguage: { language: "eng" },
			targets: [
				{
					language: { language: "spa" },
					seedFrom: { language: "eng" },
					strategy: "translate-with-nova",
				},
			],
		};
		const runBatch = vi.fn(async (input: TranslationBatchInput) => {
			const callIndex = runBatch.mock.calls.length;
			return {
				object:
					callIndex === 2
						? null
						: {
								translations: input.units.map((unit) => ({
									unitId: unit.unitId,
									translatedText: `ES: ${unit.sourceText}`,
								})),
							},
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
			};
		});
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
		};
		const deps = {
			runBatch,
			automaticTranslationAvailable: () => true,
		};
		await expect(
			finalizeInitialBuildLocalization(args, deps),
		).rejects.toMatchObject({ code: "translation-output-unparseable" });
		const firstGeneration = await h
			.db()
			.selectFrom("design_localization_batches")
			.selectAll()
			.orderBy("batch_index", "asc")
			.execute();
		expect(firstGeneration.map((batch) => batch.status)).toEqual([
			"accepted",
			"failed",
		]);
		const accepted = firstGeneration[0];
		const failed = firstGeneration[1];
		if (accepted === undefined || failed === undefined) {
			throw new Error("translation recovery generations missing");
		}
		await h
			.db()
			.updateTable("design_localization_batches")
			.set({ prompt_version: "translation-v0" })
			.execute();

		const receipt = await finalizeInitialBuildLocalization(args, deps);
		expect(receipt?.seq).toBe(2);
		const generations = await h
			.db()
			.selectFrom("design_localization_batches")
			.selectAll()
			.orderBy("batch_index", "asc")
			.orderBy("created_at", "asc")
			.execute();
		const acceptedBatchCount = generations.filter(
			(batch) => batch.status === "accepted",
		).length;
		expect(runBatch).toHaveBeenCalledTimes(acceptedBatchCount + 1);
		expect(
			generations.filter((batch) => batch.batch_index === accepted.batch_index),
		).toHaveLength(1);
		expect(
			generations.filter((batch) => batch.batch_index === failed.batch_index),
		).toHaveLength(2);
		expect(
			generations.some(
				(batch) => batch.id === accepted.id && batch.status === "accepted",
			),
		).toBe(true);
	});
});
