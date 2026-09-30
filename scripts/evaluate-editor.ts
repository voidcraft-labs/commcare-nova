/** Bounded local edit comparison through the production Solutions Architect. */
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
	type ModelMessage,
	readUIMessageStream,
	toUIMessageStream,
	type UIMessage,
	type UIMessageStreamWriter,
} from "ai";
import { Command } from "commander";
import { z } from "zod";
import { captureModelRequests } from "@/lib/agent/anatomy/requestCapture";
import { projectArchitectHistory } from "@/lib/agent/architectHistory";
import { openChatWork } from "@/lib/agent/authoring/chatWork";
import {
	beginWork,
	executeWorkTool,
	getWork,
	saveWork,
} from "@/lib/agent/authoring/session";
import { buildWorkStateMessage } from "@/lib/agent/authoring/workMessages";
import { GenerationContext } from "@/lib/agent/generationContext";
import { createModelCallTransport } from "@/lib/agent/openaiProvider";
import { SHARED_TOOL_REGISTRY } from "@/lib/agent/sharedToolRegistry";
import {
	createSolutionsArchitect,
	SOLUTIONS_ARCHITECT_MAX_STEPS,
} from "@/lib/agent/solutionsArchitect";
import type { Session } from "@/lib/auth";
import { getAuthDb } from "@/lib/auth/db";
import { withSchemaContext } from "@/lib/case-store";
import { closeCaseStoreDatabase } from "@/lib/case-store/postgres/connection";
import { createExplicitBlankApp } from "@/lib/db/appGenesis";
import { claimAndReserveRun, loadApp } from "@/lib/db/apps";
import { settleAndRelease } from "@/lib/db/credits";
import { persistResponseSnapshot, upsertThreadTurn } from "@/lib/db/threads";
import { UsageAccumulator } from "@/lib/db/usage";
import { LogWriter } from "@/lib/log/writer";
import { MODEL_CONTEXT_VERSION, MODEL_ROLES } from "@/lib/models";
import { createProject } from "@/lib/projects/manage";
import {
	completedPilotCharge,
	pilotReservation,
	readPilotLedger,
	standardPilotTransport,
	withPilotLedger,
} from "./lib/authoringPilotLedger";
import {
	loadTrialConfig,
	trialCodeIdentity,
	verifyTrialResume,
	verifyTrialWire,
} from "./lib/authoringTrialConfig";
import { remainingTrialBudget } from "./lib/authoringTrialHistory";
import {
	answerTrialQuestion,
	trialConversationWithResponse,
} from "./lib/authoringTrialTranscript";

const options = new Command()
	.requiredOption("--task <file>", "Ordinary edit request")
	.requiredOption(
		"--setup <file>",
		"Fixture setup as shared tool calls, before the model runs",
	)
	.requiredOption("--out <directory>", "New private artifact directory")
	.requiredOption("--ledger <file>", "Shared spend ledger")
	.option(
		"--resume <directory>",
		"Continue the same saved edit after a question",
	)
	.option("--answers <file>", "Ordinary answers to the pending question")
	.option("--trial-config <file>", "Expected roles and bounded runtime")
	.option("--dry-run", "Set up the isolated fixture without a model request")
	.option(
		"--confirm-paid",
		"Run within the authorized shared and $5 trial ceilings",
	)
	.parse()
	.opts<{
		task: string;
		setup: string;
		out: string;
		ledger: string;
		resume?: string;
		answers?: string;
		trialConfig?: string;
		dryRun?: boolean;
		confirmPaid?: boolean;
	}>();

async function main() {
	const config = await loadTrialConfig(options.trialConfig, "editor");
	if (config.reviewPolicy.kind !== "production")
		throw new Error(
			"The editor has no peer review policy; use production in its trial config.",
		);
	const trialIdentity = {
		config,
		code: await trialCodeIdentity(!options.dryRun),
		ledger: resolve(options.ledger),
	};
	if (options.resume) await verifyTrialResume(options.resume, trialIdentity);
	if (!options.dryRun && !options.confirmPaid)
		throw new Error("Paid trials require --confirm-paid.");
	const url = new URL(process.env.NOVA_DB_LOCAL_URL ?? "");
	if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
		throw new Error("A loopback local database is required.");
	const model = MODEL_ROLES.followUpEditor;
	const apiKey = process.env.OPENAI_API_KEY;
	if (!options.dryRun && !apiKey)
		throw new Error("OPENAI_API_KEY is required.");
	const task = await readFile(resolve(options.task), "utf8");
	const setup = z
		.array(z.object({ toolName: z.string(), input: z.unknown() }))
		.parse(JSON.parse(await readFile(resolve(options.setup), "utf8")));
	if (Boolean(options.resume) !== Boolean(options.answers))
		throw new Error(
			"An edit continuation requires both --resume and --answers.",
		);
	const prior = options.resume
		? {
				run: JSON.parse(
					await readFile(resolve(options.resume, "run.json"), "utf8"),
				),
				result: JSON.parse(
					await readFile(resolve(options.resume, "result.json"), "utf8"),
				),
			}
		: undefined;
	let userMessages: UIMessage[] = [
		{ id: randomUUID(), role: "user", parts: [{ type: "text", text: task }] },
	];
	if (prior) {
		if (!options.answers || !options.resume)
			throw new Error("Continuation inputs are missing.");
		if (
			prior.run.task !== task ||
			JSON.stringify(prior.run.setup) !== JSON.stringify(setup)
		)
			throw new Error(
				"A continuation must preserve the original task and fixture.",
			);
		if (JSON.stringify(prior.run.model) !== JSON.stringify(model))
			throw new Error("A continuation must use the original model and effort.");
		if (
			prior.result.complete ||
			prior.result.finishReason !== "tool-calls" ||
			prior.result.privateWork.pendingChanges !== 0
		)
			throw new Error(
				"Only a saved edit paused on an ordinary question may continue.",
			);
		const question = prior.result.messages
			.at(-1)
			?.content?.find(
				(item: { type: string; toolName?: string }) =>
					item.type === "tool-call" && item.toolName === "askQuestions",
			);
		if (!question || !Array.isArray(question.input?.questions))
			throw new Error("The previous result has no pending question card.");
		const answers = z
			.record(z.string(), z.string())
			.parse(JSON.parse(await readFile(resolve(options.answers), "utf8")));
		if (
			question.input.questions.some(
				(_: unknown, index: number) => !answers[String(index)]?.trim(),
			)
		)
			throw new Error("Every pending question needs an ordinary answer.");
		const previousMessages = JSON.parse(
			await readFile(resolve(options.resume, "conversation.json"), "utf8"),
		) as UIMessage[];
		userMessages = answerTrialQuestion(
			previousMessages,
			question.toolCallId,
			answers,
		);
	}
	const out = resolve(options.out);
	await mkdir(out, { mode: 0o700 });
	const save = (name: string, data: unknown) =>
		writeFile(resolve(out, name), JSON.stringify(data, null, 2), {
			mode: 0o600,
		});
	await save("trial-config.json", trialIdentity);
	const actor = await (await getAuthDb())
		.selectFrom("auth_user")
		.selectAll()
		.where("email", "=", "agent@dimagi.com")
		.executeTakeFirstOrThrow();
	const project = prior
		? { id: prior.run.projectId as string }
		: await createProject(actor.id, `Editor trial ${randomUUID().slice(0, 8)}`);
	const runId = randomUUID();
	const threadId = prior ? z.uuid().parse(prior.run.threadId) : randomUUID();
	const streamId = randomUUID();
	const genesis = prior
		? { appId: prior.run.appId as string }
		: await createExplicitBlankApp(actor.id, project.id, randomUUID(), {
				name: "Editor comparison",
				status: "complete",
			});
	if (!prior) {
		const seedAuthority = {
			actorUserId: actor.id,
			host: { kind: "mcp" as const },
		};
		const opened = await beginWork({
			...seedAuthority,
			projectId: project.id,
			target: { appId: genesis.appId },
			requestId: randomUUID(),
		});
		const seedWork = { ...seedAuthority, workId: opened.workId };
		for (const item of setup) {
			const entry = SHARED_TOOL_REGISTRY.find(
				(entry) => entry.saName === item.toolName,
			);
			if (
				!entry ||
				entry.policy.capabilities.some(
					(c) =>
						!["canonical-blueprint-write", "case-store-migration"].includes(c),
				)
			) {
				throw new Error("Setup can only edit the isolated app.");
			}
			const outcome = await executeWorkTool({
				...seedWork,
				toolName: item.toolName,
				input: item.input,
				requestId: randomUUID(),
			});
			const result = outcome.kind === "read" ? outcome.data : outcome.result;
			if (
				result &&
				typeof result === "object" &&
				("error" in result || ("ok" in result && result.ok === false))
			)
				throw new Error(JSON.stringify(result));
		}
		const seedStatus = await getWork(seedWork);
		if (seedStatus.revision) {
			const saved = await saveWork({
				...seedWork,
				expectedRevision: seedStatus.revision,
				requestId: randomUUID(),
			});
			if (saved.saved !== true) throw new Error(JSON.stringify(saved));
		}
	}
	const app = await loadApp(genesis.appId);
	if (!app || app.owner !== actor.id || app.project_id !== project.id)
		throw new Error("The fixture is unavailable in this actor’s Project.");
	if (prior && app.mutation_seq !== prior.result.app.mutation_seq)
		throw new Error("The saved app changed after the paused first output.");
	const priorRunIds: string[] = prior
		? (prior.run.trialRunIds ?? [prior.run.runId])
		: [];
	await save("before.json", app.blueprint);
	await save("run.json", {
		runId,
		trialRunIds: [...priorRunIds, runId],
		resumedFrom: options.resume,
		appId: genesis.appId,
		projectId: project.id,
		model,
		threadId,
		task,
		setup,
		startedAt: new Date().toISOString(),
		maxSteps: Math.min(config.maxRequests, SOLUTIONS_ARCHITECT_MAX_STEPS),
		timeoutMinutes: config.timeoutMinutes,
	});
	if (options.dryRun) return;
	await withPilotLedger(resolve(options.ledger), async (ledgerFile) => {
		const ledger = readPilotLedger(
			JSON.parse(await readFile(ledgerFile.path, "utf8")),
		);
		const startSpend = ledger.estimatedSpentUsd;
		const claim = await claimAndReserveRun(
			genesis.appId,
			"edit",
			runId,
			actor.id,
			1,
			project.id,
		);
		const usage = new UsageAccumulator({
			target: { kind: "app", appId: genesis.appId },
			userId: actor.id,
			runId,
			holderNonce: claim.holderNonce,
			model: model.modelId,
			promptMode: "edit",
			appReady: true,
			moduleCount: app.module_count,
			didReserve: true,
			reservedAmount: 1,
			chargePeriod: claim.reservation.period,
		});
		const transport = createModelCallTransport();
		const logWriter = new LogWriter(genesis.appId, "chat");
		let requests = 0,
			steps = 0;
		let currentCall: Record<string, unknown> | undefined;
		const events: unknown[] = [];
		const writer: UIMessageStreamWriter = {
			write: (event) => {
				events.push(event);
			},
			merge: () => {
				throw new Error("The trial captures model output directly.");
			},
			onError: undefined,
		};
		const capture = standardPilotTransport(
			captureModelRequests(transport.fetch, async (request) => {
				const parsedRequest = verifyTrialWire(
					request.body,
					config,
					"followUpEditor",
				);
				const reservedUsd = pilotReservation(
					parsedRequest.model,
					Buffer.byteLength(request.body),
					parsedRequest.max_output_tokens,
				);
				if (Buffer.byteLength(request.body, "utf8") > 1_000_000)
					throw new Error("The bounded edit trial input is too large.");
				if (
					requests >=
						Math.min(config.maxRequests, SOLUTIONS_ARCHITECT_MAX_STEPS) ||
					reservedUsd >
						remainingTrialBudget(
							ledger,
							[...priorRunIds, runId],
							5,
							genesis.appId,
						)
				)
					throw new Error("Edit trial budget reached.");
				requests++;
				currentCall = {
					runId,
					trialId: genesis.appId,
					request: requests,
					model: model.modelId,
					role: "followUpEditor",
					reasoningEffort: parsedRequest.reasoning.effort,
					reservedUsd,
					serviceTier: "default",
					status: "pending",
				};
				ledger.calls.push(currentCall);
				ledger.estimatedSpentUsd += reservedUsd;
				await ledgerFile.save(ledger);
				await writeFile(
					resolve(out, `request-${requests}.json`),
					request.body,
					{
						mode: 0o600,
					},
				);
			}),
		);
		const ctx = new GenerationContext({
			apiKey: apiKey ?? "dry-run",
			transport: async (input, init) => {
				const body =
					typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
				if (body && typeof body === "object" && "model" in body) {
					if (body.model !== model.modelId)
						throw new Error(
							"Only the configured editor model is metered in this trial.",
						);
					body.max_output_tokens ??= 128_000;
					if (body.max_output_tokens > 128_000)
						throw new Error("Output exceeds the edit trial reservation.");
					return capture(input, { ...init, body: JSON.stringify(body) });
				}
				return capture(input, init);
			},
			writer,
			logWriter,
			usage,
			session: { user: actor } as unknown as Session,
			appId: genesis.appId,
			projectId: project.id,
			projectRole: "owner",
			holderNonce: claim.holderNonce,
			editLease: true,
			conversionImpact: async (args) =>
				(await withSchemaContext()).conversionImpact({
					appId: genesis.appId,
					...args,
				}),
		});
		let complete = false;
		let responseMessage: UIMessage | null = null;
		const trailingMessage = userMessages.at(-1);
		const responseSeed =
			trailingMessage?.role === "assistant" ? trailingMessage : undefined;
		let threadStarted = false;
		const abort = new AbortController();
		const stop = () => abort.abort(new Error("Trial cancelled."));
		const deadline = setTimeout(
			() => abort.abort(new Error("Trial time limit reached.")),
			config.timeoutMinutes * 60_000,
		);
		process.once("SIGINT", stop);
		process.once("SIGTERM", stop);
		try {
			ctx.startRunLeaseHeartbeat();
			threadStarted = await upsertThreadTurn({
				target: ctx.target,
				threadId,
				runId: ctx.runId,
				streamId,
				holderNonce: claim.holderNonce,
				threadType: "edit",
				messages: userMessages,
				expectedProjectId: project.id,
			});
			if (!threadStarted)
				throw new Error("The trial thread could not be opened.");
			const work = await openChatWork(ctx, threadId);
			const agent = createSolutionsArchitect(ctx, work);
			const state = buildWorkStateMessage(await work.status());
			const history = await projectArchitectHistory({
				messages: userMessages,
				tools: agent.tools,
				model: model.modelId,
			});
			const messages: ModelMessage[] = [
				...history.modelMessages,
				...(state ? [state] : []),
			];
			await save("input-messages.json", messages);
			if (options.answers)
				await save(
					"answers.json",
					JSON.parse(await readFile(resolve(options.answers), "utf8")),
				);
			const result = await agent.stream({
				messages,
				abortSignal: abort.signal,
				onStepEnd: async (step) => {
					if (currentCall?.status !== "pending")
						throw new Error("The completed edit step has no reservation.");
					const reserved = Number(currentCall.reservedUsd);
					const charge = completedPilotCharge(
						model.modelId,
						step.usage,
						reserved,
					);
					ledger.estimatedSpentUsd += charge.estimatedUsd - reserved;
					Object.assign(currentCall, charge, { usage: step.usage });
					await ledgerFile.save(ledger);
					steps++;
					await save(`response-${steps}.json`, {
						role: "followUpEditor",
						text: step.text,
						reasoningText: step.reasoningText,
						toolCalls: step.toolCalls,
						toolResults: step.toolResults,
						content: step.content,
						usage: step.usage,
						finishReason: step.finishReason,
					});
				},
			});
			for await (const snapshot of readUIMessageStream({
				message: responseSeed,
				stream: toUIMessageStream({
					stream: result.stream,
					tools: agent.tools,
					generateMessageId: randomUUID,
					originalMessages: userMessages,
					messageMetadata: ({ part }) =>
						part.type === "start"
							? { model: model.modelId, contextVersion: MODEL_CONTEXT_VERSION }
							: undefined,
				}),
				terminateOnError: true,
			}))
				responseMessage = snapshot;
			const finishReason = await result.finishReason;
			const privateWork = await work.status();
			complete =
				finishReason === "stop" &&
				!ctx.pausedOnInput() &&
				privateWork.pendingChanges === 0;
			await save("result.json", {
				complete,
				finishReason,
				privateWork,
				text: await result.text,
				messages: await result.responseMessages,
				usage: usage.snapshot(),
				app: await loadApp(genesis.appId),
				requests,
				steps,
				conservativeTrialUsd: ledger.estimatedSpentUsd - startSpend,
			});
			if (!complete) process.exitCode = 1;
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
				try {
					if (threadStarted) {
						await persistResponseSnapshot({
							target: ctx.target,
							threadId,
							streamId,
							expectedProjectId: project.id,
							responseMessage,
							clearMarker: true,
						});
						await save(
							"conversation.json",
							trialConversationWithResponse(userMessages, responseMessage),
						);
					}
				} finally {
					await ctx.stopRunLeaseHeartbeat();
					if (!complete) usage.markRunFailed();
					await usage.flush();
					await settleAndRelease(genesis.appId, runId, claim.holderNonce, {
						mode: "edit",
					});
					await save("events.json", events);
					await save("after.json", await loadApp(genesis.appId));
				}
			} finally {
				try {
					await logWriter.flush();
				} finally {
					await transport.destroy();
				}
			}
		}
	});
}
main()
	.finally(closeCaseStoreDatabase)
	.catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
