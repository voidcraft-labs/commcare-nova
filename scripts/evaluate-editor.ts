/** Bounded local edit comparison through the production Solutions Architect. */
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { UIMessageStreamWriter } from "ai";
import { Command } from "commander";
import { z } from "zod";
import { captureModelRequests } from "@/lib/agent/anatomy/requestCapture";
import { projectArchitectHistory } from "@/lib/agent/architectHistory";
import { runSharedToolCall } from "@/lib/agent/authoring/sharedToolCall";
import { authoringToolSchema } from "@/lib/agent/authoring/toolSchema";
import { GenerationContext } from "@/lib/agent/generationContext";
import { createModelCallTransport } from "@/lib/agent/openaiProvider";
import { buildAppStateMessage } from "@/lib/agent/prompts";
import { SHARED_TOOL_REGISTRY } from "@/lib/agent/sharedToolRegistry";
import {
	createSolutionsArchitect,
	SOLUTIONS_ARCHITECT_MAX_STEPS,
} from "@/lib/agent/solutionsArchitect";
import { CanonicalMutationWorkspace } from "@/lib/agent/workspace/canonicalWorkspace";
import type { Session } from "@/lib/auth";
import { getAuthDb } from "@/lib/auth/db";
import { withSchemaContext } from "@/lib/case-store";
import { closeCaseStoreDatabase } from "@/lib/case-store/postgres/connection";
import { createExplicitBlankApp } from "@/lib/db/appGenesis";
import { claimAndReserveRun, loadApp } from "@/lib/db/apps";
import { settleAndRelease } from "@/lib/db/credits";
import { UsageAccumulator } from "@/lib/db/usage";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import { LogWriter } from "@/lib/log/writer";
import { initMcpCall } from "@/lib/mcp/context";
import { MODEL_ROLES } from "@/lib/models";
import { createProject } from "@/lib/projects/manage";
import {
	completedPilotCharge,
	withPilotLedger,
} from "./lib/authoringPilotLedger";

const options = new Command()
	.requiredOption("--task <file>", "Ordinary edit request")
	.requiredOption(
		"--setup <file>",
		"Fixture setup as shared tool calls, before the model runs",
	)
	.requiredOption("--out <directory>", "New private artifact directory")
	.requiredOption("--ledger <file>", "Shared spend ledger")
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
		dryRun?: boolean;
		confirmPaid?: boolean;
	}>();

async function main() {
	if (!options.dryRun && !options.confirmPaid)
		throw new Error("Paid trials require --confirm-paid.");
	const url = new URL(process.env.NOVA_DB_LOCAL_URL ?? "");
	if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
		throw new Error("A loopback local database is required.");
	const model = MODEL_ROLES.followUpEditor;
	if (!["gpt-5.6-luna", "gpt-6-luna"].includes(model.modelId))
		throw new Error("Recheck the reservation before using a different model.");
	const apiKey = process.env.OPENAI_API_KEY;
	if (!options.dryRun && !apiKey)
		throw new Error("OPENAI_API_KEY is required.");
	const task = await readFile(resolve(options.task), "utf8");
	const setup = z
		.array(z.object({ toolName: z.string(), input: z.unknown() }))
		.parse(JSON.parse(await readFile(resolve(options.setup), "utf8")));
	const out = resolve(options.out);
	await mkdir(out, { mode: 0o700 });
	const save = (name: string, data: unknown) =>
		writeFile(resolve(out, name), JSON.stringify(data, null, 2), {
			mode: 0o600,
		});
	const actor = await (await getAuthDb())
		.selectFrom("auth_user")
		.selectAll()
		.where("email", "=", "agent@dimagi.com")
		.executeTakeFirstOrThrow();
	const project = await createProject(
		actor.id,
		`Editor trial ${randomUUID().slice(0, 8)}`,
	);
	const runId = randomUUID();
	const genesis = await createExplicitBlankApp(
		actor.id,
		project.id,
		randomUUID(),
		{ name: "Editor comparison", status: "complete" },
	);
	const seedHost = initMcpCall(
		{
			userId: actor.id,
			scopes: ["nova.read", "nova.write"],
			authKind: "api-key",
		},
		genesis.appId,
		project.id,
		"owner",
		randomUUID(),
		undefined,
	);
	const workspace = new CanonicalMutationWorkspace({
		host: seedHost.mcpCtx,
		initialDoc: hydratePersistedBlueprint(genesis.blueprint),
		baseSeq: genesis.baseSeq,
	});
	try {
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
			)
				throw new Error("Setup can only edit the isolated app.");
			const input = authoringToolSchema(
				entry.saName,
				entry.tool.inputSchema,
			).authored.parse(item.input);
			const result = await workspace.invoke({
				toolName: entry.saName,
				execute: async (ctx) => {
					const outcome = await runSharedToolCall(entry, input, ctx);
					return outcome.kind === "read" ? outcome.data : outcome.result;
				},
			});
			if (
				result &&
				typeof result === "object" &&
				("error" in result || ("ok" in result && result.ok === false))
			)
				throw new Error(JSON.stringify(result));
		}
	} finally {
		await seedHost.logWriter.flush();
	}
	const app = await loadApp(genesis.appId);
	if (!app) throw new Error("The fixture is missing.");
	await save("before.json", app.blueprint);
	await save("run.json", {
		runId,
		appId: genesis.appId,
		projectId: project.id,
		model,
		task,
		setup,
		startedAt: new Date().toISOString(),
		maxSteps: SOLUTIONS_ARCHITECT_MAX_STEPS,
	});
	if (options.dryRun) return;
	await withPilotLedger(resolve(options.ledger), async (ledgerFile) => {
		const ledger = z
			.object({
				ceilingUsd: z.number().positive().max(100),
				targetUsd: z.number().positive(),
				estimatedSpentUsd: z.number().nonnegative(),
				calls: z.array(z.record(z.string(), z.unknown())),
			})
			.parse(JSON.parse(await readFile(ledgerFile.path, "utf8")));
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
		const capture = captureModelRequests(transport.fetch, async (request) => {
			// One UTF-8 byte per input token plus 128k output, at the larger Luna
			// long-context/cache-write rate, with 25% margin, costs less than $1.
			if (Buffer.byteLength(request.body, "utf8") > 1_000_000)
				throw new Error("The bounded edit trial input is too large.");
			if (
				requests >= SOLUTIONS_ARCHITECT_MAX_STEPS ||
				ledger.estimatedSpentUsd + 1 >
					Math.min(ledger.ceilingUsd, ledger.targetUsd, startSpend + 5)
			)
				throw new Error("Edit trial budget reached.");
			requests++;
			currentCall = {
				runId,
				request: requests,
				model: model.modelId,
				reservedUsd: 1,
				status: "pending",
			};
			ledger.calls.push(currentCall);
			ledger.estimatedSpentUsd += 1;
			await ledgerFile.save(ledger);
			await writeFile(resolve(out, `request-${requests}.json`), request.body, {
				mode: 0o600,
			});
		});
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
		try {
			ctx.startRunLeaseHeartbeat();
			const agent = createSolutionsArchitect(
				ctx,
				hydratePersistedBlueprint(app.blueprint),
				app.mutation_seq,
			);
			const state = buildAppStateMessage(
				hydratePersistedBlueprint(app.blueprint),
			);
			const history = await projectArchitectHistory({
				messages: [
					{
						id: randomUUID(),
						role: "user",
						parts: [{ type: "text", text: task }],
					},
				],
				tools: agent.tools,
				model: model.modelId,
			});
			const result = await agent.stream({
				messages: [...history.modelMessages, ...(state ? [state] : [])],
				abortSignal: AbortSignal.timeout(15 * 60_000),
				onStepEnd: async (step) => {
					if (currentCall?.status !== "pending")
						throw new Error("The completed edit step has no reservation.");
					const charge = completedPilotCharge(model.modelId, step.usage, 1);
					ledger.estimatedSpentUsd += charge.estimatedUsd - 1;
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
			await result.consumeStream({
				onError: (error) => {
					throw error;
				},
			});
			const finishReason = await result.finishReason;
			complete = finishReason === "stop" && !ctx.pausedOnInput();
			await save("result.json", {
				complete,
				finishReason,
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
			try {
				await ctx.stopRunLeaseHeartbeat();
				if (!complete) usage.markRunFailed();
				await usage.flush();
				await settleAndRelease(genesis.appId, runId, claim.holderNonce, {
					mode: "edit",
				});
				await save("events.json", events);
				await save("after.json", await loadApp(genesis.appId));
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
