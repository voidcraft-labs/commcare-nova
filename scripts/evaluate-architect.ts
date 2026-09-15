/** Bounded local quality trial through the production architect and peer. */
import "dotenv/config";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Command } from "commander";
import { z } from "zod";
import { readDesignSession } from "@/lib/agent/anatomy/recorded";
import { captureModelRequests } from "@/lib/agent/anatomy/requestCapture";
import { runBuildOrchestration } from "@/lib/agent/build/orchestrator";
import { completeBuildOrchestration } from "@/lib/agent/build/orchestratorState";
import {
	AgentModelStepError,
	type AgentModelStepFn,
	productionModelStep,
} from "@/lib/agent/modelStep";
import {
	createModelCallTransport,
	createNovaOpenAI,
} from "@/lib/agent/openaiProvider";
import { getAuthDb } from "@/lib/auth/db";
import { closeCaseStoreDatabase } from "@/lib/case-store/postgres/connection";
import { claimAndReserveRun, failApp, loadApp } from "@/lib/db/apps";
import { settleAndRelease } from "@/lib/db/credits";
import {
	createAndClaimDesignSessionRun,
	failAndRefundDesignSessionRun,
} from "@/lib/db/designSessions";
import { materializeCaseStoreSchemas } from "@/lib/db/materializeCaseStoreSchemas";
import { getAppDb } from "@/lib/db/pg";
import { UsageAccumulator } from "@/lib/db/usage";
import { MODEL_ROLES } from "@/lib/models";
import { createProject } from "@/lib/projects/manage";
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
		confirmPaid?: boolean;
		dryRun?: boolean;
	}>();
const MAX_REQUESTS = 80;
const MAX_OUTPUT_TOKENS = 16_000;
const TRIAL_CEILING_USD = 25;
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
	if (options.feedback && !options.resume)
		throw new Error("Feedback requires a prior trial.");
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
		const runId = randomUUID();
		let userMessages = [
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
					appId: z.string().uuid(),
					designSessionId: z.string().uuid(),
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
			if (
				!resumedApp ||
				resumedApp.owner !== actor.id ||
				resumedApp.project_id !== prior.projectId ||
				resumedApp.status !== "error"
			)
				throw new Error(
					"Resume requires this actor's stopped trial app in its original Project.",
				);
			const recorded = await readDesignSession(prior.designSessionId);
			const sources = new Map<
				string,
				{ id: string; role: "user"; parts: { type: "text"; text: string }[] }
			>();
			for (const context of recorded?.contexts ?? []) {
				if (context.kind !== "architect") continue;
				for (const item of context.items) {
					const match = item.appendKey.match(/^request:([0-9a-f-]+):0$/);
					if (
						!match ||
						item.message.role !== "user" ||
						typeof item.message.content !== "string"
					)
						continue;
					const id = z.uuid().parse(match[1]);
					sources.set(id, {
						id,
						role: "user",
						parts: [{ type: "text", text: item.message.content }],
					});
				}
			}
			userMessages = [...sources.values()];
			if (!userMessages.some((m) => m.parts[0]?.text === task))
				throw new Error("The original request identity is unavailable.");
		}
		if (feedback && !userMessages.some((m) => m.parts[0]?.text === feedback))
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
					...(await claimAndReserveRun(
						prior.appId,
						"build",
						runId,
						actor.id,
						1,
						prior.projectId,
						undefined,
						{ requireModeMatchesStatus: true },
					)),
				}
			: await createAndClaimDesignSessionRun({
					projectId: project.id,
					actorUserId: actor.id,
					runId,
					cost: 1,
				});

		const meter = new UsageAccumulator({
			target: prior
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
				userMessages,
				...(options.resume && { resumedFrom: resolve(options.resume) }),
			});
			const provider = createNovaOpenAI(
				process.env.OPENAI_API_KEY ?? "",
				captureModelRequests(transport.fetch, async (request) => {
					if (requests >= MAX_REQUESTS)
						throw new Error("Trial request limit reached.");
					// Every UTF-8 byte is a conservative token allowance for this text-only
					// request, including deferred schemas. Price at the long-context Sol
					// cache-write rate, plus the enforced output ceiling, before dispatch.
					const reservedUsd =
						(Buffer.byteLength(request.body) * 12.5 + MAX_OUTPUT_TOKENS * 45) /
						1_000_000;
					if (
						ledger.estimatedSpentUsd + reservedUsd >
						Math.min(
							ledger.ceilingUsd,
							ledger.targetUsd,
							startingSpend + TRIAL_CEILING_USD,
						)
					)
						throw new Error("Trial spend limit reached.");
					requests += 1;
					currentCall = {
						runId,
						request: requests,
						reservedUsd,
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
							maxOutputTokens: Math.min(
								request.maxOutputTokens ?? MAX_OUTPUT_TOKENS,
								MAX_OUTPUT_TOKENS,
							),
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
			await save("outcome.json", outcome);
			if (!completed) process.exitCode = 1;
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
				if (!completed) meter.markRunFailed();
				await meter.flush();
				if (!completed) {
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
