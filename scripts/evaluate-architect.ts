/** Bounded local quality trial through the production architect and peer. */
import "dotenv/config";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { Command } from "commander";
import { z } from "zod";
import { readDesignSession } from "@/lib/agent/anatomy/recorded";
import { captureModelRequests } from "@/lib/agent/anatomy/requestCapture";
import { runBuildOrchestration } from "@/lib/agent/build/orchestrator";
import { completeBuildOrchestration } from "@/lib/agent/build/orchestratorState";
import type { AttachmentCondenser } from "@/lib/agent/documentExtraction";
import { ensureStoredExtract } from "@/lib/agent/documentExtractionStore";
import {
	AgentModelStepError,
	type AgentModelStepFn,
	productionModelStep,
} from "@/lib/agent/modelStep";
import {
	createModelCallTransport,
	createNovaOpenAI,
} from "@/lib/agent/openaiProvider";
import { productionSourceMaterialDeps } from "@/lib/agent/sources.server";
import { streamObjectWith } from "@/lib/agent/subGeneration";
import { askQuestionsInputSchema } from "@/lib/agent/tools/askQuestions";
import { getAuthDb } from "@/lib/auth/db";
import { closeCaseStoreDatabase } from "@/lib/case-store/postgres/connection";
import type { NovaUIMessage as UIMessage } from "@/lib/chat/attachmentRefs";
import { claimAndReserveRun, failApp, loadApp } from "@/lib/db/apps";
import { settleAndRelease } from "@/lib/db/credits";
import {
	claimAndReserveDesignSessionRun,
	createAndClaimDesignSessionRun,
	failAndRefundDesignSessionRun,
	loadDesignSession,
} from "@/lib/db/designSessions";
import { materializeCaseStoreSchemas } from "@/lib/db/materializeCaseStoreSchemas";
import { insertReadyAsset } from "@/lib/db/mediaAssets";
import { getAppDb } from "@/lib/db/pg";
import { UsageAccumulator } from "@/lib/db/usage";
import { asMediaAssetId, gcsObjectKeyFor } from "@/lib/domain/multimedia";
import { MODEL_ROLES } from "@/lib/models";
import { createProject } from "@/lib/projects/manage";
import { uploadAssetBytes } from "@/lib/storage/media";
import {
	countAuthoringInput,
	countedInputReservation,
} from "./lib/authoringInputCount";
import {
	completedPilotCharge,
	withPilotLedger,
} from "./lib/authoringPilotLedger";

const options = new Command()
	.description(
		"Run a local architect trial. Keeps its synthetic app and dedicated Project for inspection; captures full messages and credential-free requests in a private directory.",
	)
	.requiredOption("--task <file>", "synthetic user request")
	.requiredOption("--out <directory>", "new private artifact directory")
	.requiredOption("--ledger <file>", "shared spend ledger, at most $200")
	.option(
		"--resume <directory>",
		"resume this prior trial’s saved app and conversation",
	)
	.option("--document <file>", "attach and extract one UTF-8 text source")
	.option(
		"--answers <file>",
		"ordinary answers to the prior pending question card",
	)
	.option("--feedback <file>", "independent observations to add when resuming")
	.option("--confirm-paid", "authorize this bounded trial")
	.option(
		"--dry-run",
		"verify setup and capture source without calling a model",
	)
	.parse()
	.opts<{
		task: string;
		out: string;
		ledger: string;
		resume?: string;
		feedback?: string;
		answers?: string;
		document?: string;
		confirmPaid?: boolean;
		dryRun?: boolean;
	}>();
const MAX_REQUESTS = 400;
// Preserve the models' output capacity, including reasoning. Explicit production
// limits (for example translation's 32k) pass through unchanged.
const MAX_OUTPUT_TOKENS = 128_000;
const TRIAL_CEILING_USD = 30;
const ledgerSchema = z.object({
	ceilingUsd: z.number().positive().max(200),
	targetUsd: z.number().positive(),
	estimatedSpentUsd: z.number().nonnegative(),
	calls: z.array(z.record(z.string(), z.unknown())),
});

async function main() {
	const url = new URL(process.env.NOVA_DB_LOCAL_URL ?? "");
	if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
		throw new Error("A loopback local database is required.");
	if (!options.dryRun && (!options.confirmPaid || !process.env.OPENAI_API_KEY))
		throw new Error("Paid trials require --confirm-paid and OPENAI_API_KEY.");
	const output = resolve(options.out);
	await mkdir(output, { mode: 0o700 });
	const save = (name: string, value: unknown) =>
		writeFile(resolve(output, name), JSON.stringify(value, null, 2), {
			mode: 0o600,
		});
	const task = await readFile(resolve(options.task), "utf8");
	if ((options.feedback || options.answers) && !options.resume)
		throw new Error("Feedback or answers require a prior trial.");
	const feedback = options.feedback
		? await readFile(resolve(options.feedback), "utf8")
		: undefined;
	if (feedback) await save("feedback.json", { text: feedback });
	await save("task.json", {
		text: task,
		sha256: createHash("sha256").update(task).digest("hex"),
	});
	const paths = [
		"scripts/evaluate-architect.ts",
		"lib/agent/prompts.ts",
		"lib/agent/build/orchestrator.ts",
		"lib/agent/build/architectLoop.ts",
		"lib/agent/build/authoringTools.ts",
		"lib/agent/build/authoringSession.ts",
		"lib/agent/translation/translateLanguage.ts",
		"lib/models.ts",
	];
	await save(
		"source.json",
		await Promise.all(
			paths.map(async (path) => {
				const content = await readFile(resolve(path), "utf8");
				return {
					path,
					content,
					sha256: createHash("sha256").update(content).digest("hex"),
				};
			}),
		),
	);
	const auth = await getAuthDb();
	const actor = await auth
		.selectFrom("auth_user")
		.select("id")
		.where("email", "=", "agent@dimagi.com")
		.executeTakeFirstOrThrow();
	if (options.dryRun) {
		await save("dry-run.json", {
			models: MODEL_ROLES,
			maxRequests: MAX_REQUESTS,
			maxOutputTokens: MAX_OUTPUT_TOKENS,
			trialCeilingUsd: TRIAL_CEILING_USD,
		});
		return;
	}
	await withPilotLedger(resolve(options.ledger), async (ledgerFile) => {
		const ledger = ledgerSchema.parse(
			JSON.parse(await readFile(ledgerFile.path, "utf8")),
		);
		const startingSpend = ledger.estimatedSpentUsd;
		let trialStartingSpend = startingSpend;
		const runId = randomUUID();
		let userMessages: UIMessage[] = [
			{
				id: randomUUID() as string,
				role: "user" as const,
				parts: [{ type: "text" as const, text: task }],
			},
		];
		let resumedApp: Awaited<ReturnType<typeof loadApp>> = null;
		let prior:
			| { appId: string; designSessionId: string; projectId: string }
			| undefined;
		if (options.resume) {
			const previous = resolve(options.resume);
			prior = z
				.object({
					appId: z.uuid(),
					designSessionId: z.uuid(),
					projectId: z.string(),
				})
				.parse(
					JSON.parse(await readFile(resolve(previous, "run.json"), "utf8")),
				);
			const priorTask = z
				.object({ text: z.string() })
				.parse(
					JSON.parse(await readFile(resolve(previous, "task.json"), "utf8")),
				);
			if (priorTask.text !== task)
				throw new Error("Resume requires the original trial request.");
			resumedApp = await loadApp(prior.appId);
			const session = await loadDesignSession(prior.designSessionId);
			if (
				!session ||
				session.owner_user_id !== actor.id ||
				session.project_id !== prior.projectId ||
				(resumedApp &&
					(resumedApp.owner !== actor.id ||
						resumedApp.project_id !== prior.projectId ||
						resumedApp.status === "complete"))
			)
				throw new Error(
					"Resume requires this actor's unfinished trial in its original Project.",
				);
			const saved = JSON.parse(
				await readFile(resolve(previous, "run.json"), "utf8"),
			) as { userMessages: UIMessage[]; trialStartingSpend?: number };
			trialStartingSpend = saved.trialStartingSpend ?? startingSpend;
			userMessages = saved.userMessages;
			if (
				!userMessages.some(
					(m) =>
						m.role === "user" &&
						m.parts.some((p) => p.type === "text" && p.text === task),
				)
			)
				throw new Error("The original request identity is unavailable.");
			if (options.answers) {
				const events: unknown[] = JSON.parse(
					await readFile(resolve(previous, "events.json"), "utf8"),
				);
				const questionSchema = z.object({
					type: z.literal("tool-input-available"),
					toolName: z.literal("askQuestions"),
					toolCallId: z.string(),
					input: askQuestionsInputSchema,
				});
				const questions = events.flatMap((event) => {
					const parsed = questionSchema.safeParse(event);
					return parsed.success ? [parsed.data] : [];
				});
				const question = questions.at(-1);
				if (!question)
					throw new Error("The prior trial has no pending question card.");
				const answers = z
					.record(z.string(), z.string())
					.parse(JSON.parse(await readFile(resolve(options.answers), "utf8")));
				if (
					question.input.questions.some(
						(_, index) => !answers[String(index)]?.trim(),
					)
				)
					throw new Error("Every question needs an ordinary user answer.");
				userMessages.push({
					id: randomUUID(),
					role: "assistant",
					parts: [
						{
							type: "tool-askQuestions",
							toolCallId: question.toolCallId,
							state: "output-available",
							input: question.input,
							output: answers,
						},
					],
				});
				await save("answers.json", { question, answers });
			}
		}
		if (
			feedback &&
			!userMessages.some((m) =>
				m.parts.some((part) => part.type === "text" && part.text === feedback),
			)
		)
			userMessages.push({
				id: randomUUID(),
				role: "user",
				parts: [{ type: "text", text: feedback }],
			});
		const project = prior
			? { id: prior.projectId }
			: await createProject(
					actor.id,
					`Architect trial ${randomUUID().slice(0, 8)}`,
				);
		const claim = prior
			? {
					designSessionId: prior.designSessionId,
					proposedAppId: prior.appId,
					...(resumedApp
						? await claimAndReserveRun(
								prior.appId,
								"build",
								runId,
								actor.id,
								1,
								prior.projectId,
								undefined,
								{ requireModeMatchesStatus: true },
							)
						: await claimAndReserveDesignSessionRun(
								prior.designSessionId,
								runId,
								actor.id,
								1,
								prior.projectId,
							)),
				}
			: await createAndClaimDesignSessionRun({
					projectId: project.id,
					actorUserId: actor.id,
					runId,
					cost: 1,
				});

		const meter = new UsageAccumulator({
			target:
				resumedApp && prior
					? { kind: "app", appId: prior.appId }
					: { kind: "design-session", designSessionId: claim.designSessionId },
			userId: actor.id,
			runId,
			holderNonce: claim.holderNonce,
			model: MODEL_ROLES.architect.modelId,
			promptMode: "build",
			appReady: false,
			moduleCount: resumedApp?.module_count ?? 0,
			didReserve: true,
			reservedAmount: 1,
			chargePeriod: claim.reservation.period,
		});
		const abort = new AbortController();
		const stop = () => abort.abort(new Error("Trial cancelled."));
		let deadline: ReturnType<typeof setTimeout> | undefined;
		let closeTransport: (() => Promise<void>) | undefined;
		let requests = 0;
		let currentCall: Record<string, unknown> | undefined;
		const events: unknown[] = [];
		let completed = false;
		let paused = false;
		try {
			const transport = createModelCallTransport();
			closeTransport = () => transport.destroy();
			deadline = setTimeout(
				() => abort.abort(new Error("Trial time limit reached.")),
				30 * 60_000,
			);
			process.once("SIGINT", stop);
			process.once("SIGTERM", stop);
			await save("run.json", {
				runId,
				appId: claim.proposedAppId,
				designSessionId: claim.designSessionId,
				projectId: project.id,
				actorUserId: actor.id,
				models: MODEL_ROLES,
				startedAt: new Date().toISOString(),
				trialStartingSpend,
				userMessages,
				...(options.resume && { resumedFrom: resolve(options.resume) }),
			});
			const provider = createNovaOpenAI(
				process.env.OPENAI_API_KEY ?? "",
				captureModelRequests(transport.fetch, async (request) => {
					if (requests >= MAX_REQUESTS)
						throw new Error("Trial request limit reached.");
					const outputCeiling = z
						.object({ max_output_tokens: z.number().positive().max(128_000) })
						.parse(JSON.parse(request.body)).max_output_tokens;
					// Every UTF-8 byte is a conservative token allowance for this text-only
					// request, including deferred schemas. Price at the long-context Sol
					// cache-write rate, plus the enforced output ceiling, before dispatch.
					let reservedUsd =
						(Buffer.byteLength(request.body) * 12.5 + outputCeiling * 45) /
						1_000_000;
					const limit = Math.min(
						ledger.ceilingUsd,
						ledger.targetUsd,
						trialStartingSpend + TRIAL_CEILING_USD,
					);
					let inputTokenCount: number | undefined;
					if (ledger.estimatedSpentUsd + reservedUsd > limit) {
						inputTokenCount = await countAuthoringInput({
							body: request.body,
							apiKey: process.env.OPENAI_API_KEY ?? "",
							signal: abort.signal,
						});
						reservedUsd = countedInputReservation(
							inputTokenCount,
							outputCeiling,
						);
					}
					if (ledger.estimatedSpentUsd + reservedUsd > limit)
						throw new Error("Trial spend limit reached.");

					requests += 1;
					currentCall = {
						runId,
						request: requests,
						reservedUsd,
						...(inputTokenCount === undefined ? {} : { inputTokenCount }),
						status: "pending",
						sha256: request.sha256,
					};
					ledger.calls.push(currentCall);
					ledger.estimatedSpentUsd += reservedUsd;
					await ledgerFile.save(ledger);
					await writeFile(
						resolve(output, `request-${requests}.json`),
						request.body,
						{ mode: 0o600 },
					);
					console.log(
						JSON.stringify({
							request: requests,
							estimatedSpentUsd: ledger.estimatedSpentUsd,
						}),
					);
				}),
			);
			const stepFor = (
				role: "architect" | "peer" | "translator",
			): AgentModelStepFn => {
				const config = MODEL_ROLES[role];
				const production = productionModelStep(
					provider(config.modelId),
					config.reasoningEffort,
					`nova:${role}:${claim.designSessionId}`,
				);
				return async (request) => {
					currentCall = undefined;
					const settle = async (
						usage: { inputTokens?: number; outputTokens?: number } | undefined,
					) => {
						if (!currentCall || !usage) return;
						const reserved = Number(currentCall.reservedUsd);
						const charge = completedPilotCharge(
							config.modelId,
							usage,
							reserved,
						);
						Object.assign(currentCall, charge, {
							model: config.modelId,
							role,
							usage,
						});
						ledger.estimatedSpentUsd += charge.estimatedUsd - reserved;
						await ledgerFile.save(ledger);
					};
					try {
						const result = await production({
							...request,
							maxOutputTokens: request.maxOutputTokens ?? MAX_OUTPUT_TOKENS,
						});
						await settle(result.usage);
						await save(`response-${requests}.json`, { role, ...result });
						console.log(
							JSON.stringify({
								completedRequest: requests,
								role,
								tools: result.toolCalls.map((call) => call.toolName),
								estimatedSpentUsd: ledger.estimatedSpentUsd,
							}),
						);
						return result;
					} catch (error) {
						if (error instanceof AgentModelStepError) await settle(error.usage);
						throw error;
					}
				};
			};
			const condenser: AttachmentCondenser = {
				async extractDocumentStructured(opts) {
					currentCall = undefined;
					const result = await streamObjectWith({
						...opts,
						model: provider(opts.model),
						abortSignal: abort.signal,
					});
					if (currentCall) {
						const call = currentCall as Record<string, unknown>;
						const reserved = Number(call.reservedUsd);
						const charge = completedPilotCharge(
							opts.model,
							result.usage ?? {},
							reserved,
						);
						Object.assign(call, charge, {
							model: opts.model,
							role: "documentExtractor",
							usage: result.usage,
						});
						ledger.estimatedSpentUsd += charge.estimatedUsd - reserved;
						await ledgerFile.save(ledger);
					}
					await save(`response-${requests}.json`, {
						role: "documentExtractor",
						...result,
					});
					return {
						object: result.object,
						truncated: result.finishReason === "length",
					};
				},
			};
			if (options.document && !prior) {
				const bytes = await readFile(resolve(options.document));
				if (bytes.length > 100_000)
					throw new Error("Trial text documents must be at most 100 KB.");
				const contentHash = createHash("sha256").update(bytes).digest("hex");
				const gcsObjectKey = gcsObjectKeyFor(project.id, contentHash, ".txt");
				await uploadAssetBytes({
					gcsObjectKey,
					bytes,
					contentType: "text/plain",
					ifAbsent: true,
				});
				const asset = await insertReadyAsset({
					assetId: asMediaAssetId(randomUUID()),
					owner: actor.id,
					project_id: project.id,
					contentHash,
					mimeType: "text/plain",
					kind: "text",
					extension: ".txt",
					sizeBytes: bytes.length,
					gcsObjectKey,
					originalFilename: basename(options.document),
				});
				const extract = await ensureStoredExtract({
					asset,
					documentKind: "text",
					condenser,
					onInflight: "wait",
				});
				await save("extraction.json", {
					source: bytes.toString("utf8"),
					contentHash,
					extract,
					assetId: asset.id,
				});
				if (extract.status !== "ready")
					throw new Error("Document extraction did not complete.");
				userMessages[0].metadata = {
					attachments: [
						{
							assetId: asset.id,
							filename: asset.originalFilename,
							mimeType: asset.mimeType,
							kind: "text",
						},
					],
				};
				const run = JSON.parse(
					await readFile(resolve(output, "run.json"), "utf8"),
				);
				await save("run.json", { ...run, userMessages });
			}
			const outcome = await runBuildOrchestration({
				designSessionId: claim.designSessionId,
				proposedAppId: claim.proposedAppId,
				projectId: project.id,
				projectRole: "owner",
				actorUserId: actor.id,
				runId,
				holderNonce: claim.holderNonce,
				threadId: randomUUID(),
				messages: userMessages,
				responseMessageId: randomUUID(),
				writer: { write: (chunk) => events.push(chunk) },
				apiKey: process.env.OPENAI_API_KEY ?? "",
				meter,
				signal: abort.signal,
				materializedAppId: resumedApp ? claim.proposedAppId : null,
				deps: {
					sourceDeps: productionSourceMaterialDeps(condenser),
					modelStep: stepFor("architect"),
					peerStep: stepFor("peer"),
					translationStep: stepFor("translator"),
					onToolResult: (role, call, result) => {
						meter.noteToolCall();
						events.push({ role, call, result });
					},
				},
				finalizeCompletion: async (completion) => {
					const app = await loadApp(completion.appId);
					if (!app || app.mutation_seq !== completion.expectedSeq)
						throw new Error("The final app changed before completion.");
					await materializeCaseStoreSchemas({
						appId: completion.appId,
						blueprint: app.blueprint,
						syncedSeq: completion.expectedSeq,
					});
					const head = await completeBuildOrchestration({
						...completion,
						designSessionId: claim.designSessionId,
						actorUserId: actor.id,
						runId,
						holderNonce: claim.holderNonce,
						expectedProjectId: project.id,
					});
					return { blueprint: app.blueprint, head };
				},
			});
			completed = outcome.kind === "completed";
			paused = outcome.kind === "awaiting-input" && outcome.pauseOwned;
			await save("outcome.json", outcome);
			if (!completed && !paused) process.exitCode = 1;
		} catch (error) {
			await save("error.json", {
				name: error instanceof Error ? error.name : "Error",
				message: error instanceof Error ? error.message : String(error),
			});
			process.exitCode = 1;
		} finally {
			clearTimeout(deadline);
			process.off("SIGINT", stop);
			process.off("SIGTERM", stop);
			try {
				if (!completed && !paused) meter.markRunFailed();
				await meter.flush();
				if (!completed && !paused) {
					const app = await loadApp(claim.proposedAppId);
					if (app) {
						const settled = await settleAndRelease(
							claim.proposedAppId,
							runId,
							claim.holderNonce,
							{ mode: "build" },
						);
						if (settled.outcome === "owned" && settled.settled)
							await failApp(
								claim.proposedAppId,
								runId,
								claim.holderNonce,
								"internal",
							);
					} else
						await failAndRefundDesignSessionRun(
							claim.designSessionId,
							runId,
							claim.holderNonce,
							"trial-stopped",
						);
				}
				const db = await getAppDb();
				await save("events.json", events);
				await save(
					"recorded.json",
					await readDesignSession(claim.designSessionId),
				);
				await save(
					"plan.json",
					await db
						.selectFrom("authoring_plan_revisions")
						.selectAll()
						.where("session_id", "=", claim.designSessionId)
						.orderBy("revision")
						.execute(),
				);
				await save("result.json", {
					app: await loadApp(claim.proposedAppId),
					usage: meter.snapshot(),
					requests,
					conservativeTrialUsd: ledger.estimatedSpentUsd - startingSpend,
				});
			} finally {
				await closeTransport?.();
			}
		}
	});
}
main()
	.catch((error) => {
		console.error(error);
		process.exitCode = 1;
	})
	.finally(closeCaseStoreDatabase);
