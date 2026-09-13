/** Local, bounded authoring pilot. No production registration or data access.
 * node --conditions=react-server --import=tsx scripts/evaluate-agent-authoring.ts
 *   --confirm-paid --out <new-directory> --ledger <spend-ledger.json>
 */
import "dotenv/config";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { asSchema, isStepCount, ToolLoopAgent } from "ai";
import { z } from "zod";
import { captureModelRequests } from "@/lib/agent/anatomy/requestCapture";
import { estimateTokens } from "@/lib/agent/anatomy/tokens";
import {
	currentPilotTools,
	deduplicatePilotCalls,
	programmaticPilotTools,
} from "@/lib/agent/authoring/experimental/comparison";
import {
	executePilotOperation,
	nativePilotTools,
	PILOT_GUIDANCE,
} from "@/lib/agent/authoring/experimental/native";
import {
	createModelCallTransport,
	createNovaOpenAI,
} from "@/lib/agent/openaiProvider";
import {
	buildAppStateMessage,
	buildSolutionsArchitectPrompt,
} from "@/lib/agent/prompts";
import { CanonicalMutationWorkspace } from "@/lib/agent/workspace/canonicalWorkspace";
import { getAuthDb } from "@/lib/auth/db";
import { ensurePersonalProject } from "@/lib/auth/provisionProject";
import { closeCaseStoreDatabase } from "@/lib/case-store/postgres/connection";
import { createExplicitBlankApp } from "@/lib/db/appGenesis";
import {
	loadApp,
	loadAppForInspection,
	restoreApp,
	softDeleteApp,
} from "@/lib/db/apps";
import { estimateCost } from "@/lib/db/usage";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import { initMcpCall } from "@/lib/mcp/context";
import { canonicalJsonText } from "@/lib/utils/canonicalJsonText";

const MODEL = "gpt-5.6-luna";
const MAX_REQUESTS = 12;
const ledgerSchema = z.object({
	ceilingUsd: z.number().positive().max(200),
	targetUsd: z.number().positive(),
	estimatedSpentUsd: z.number().nonnegative(),
	calls: z.array(z.record(z.string(), z.unknown())),
});

const TASK = `Add a client registration workflow to this app. A worker registers a client's name and age in completed years. Both are required. Reject ages below 0 or above 120 with a helpful message. Show an optional phone question only for clients aged 18 or older. End with a short note that includes the client's name. Workers should be able to find clients by name and open a follow-up form to update their phone number without changing the name or age. Preserve the app's existing content. These requirements are complete; build the workflow now.`;

function argument(name: string): string {
	const value = process.argv[process.argv.indexOf(name) + 1];
	if (!process.argv.includes(name) || !value || value.startsWith("--"))
		throw new Error(`${name} is required.`);
	return resolve(value);
}

async function main() {
	if (process.argv.includes("--help")) {
		console.log(`Compare authoring interfaces on a disposable local app.
--variant native|programmatic|current  Interface (default: native)
--out <new-directory>                 Private request and result artifacts
--ledger <json-file>                  Shared dollar ledger, at most $200
--dry-run                            Persist a fixture without a model call
--confirm-paid                       Authorize this bounded model trial
--task <text-file>                    Task instead of the registration example
--from-run <directory>                Fresh edit turn on that trial's exact app

Requires a loopback NOVA_DB_LOCAL_URL and the local agent account. Paid trials
also require OPENAI_API_KEY. Each trial has at most 12 requests and 5 minutes.
The app is soft-deleted on exit. Private artifacts contain full model context.`);
		return;
	}
	const dryRun = process.argv.includes("--dry-run");
	const variant = z
		.enum(["native", "programmatic", "current"])
		.parse(
			process.argv.includes("--variant")
				? process.argv[process.argv.indexOf("--variant") + 1]
				: "native",
		);
	if (!dryRun && !process.argv.includes("--confirm-paid"))
		throw new Error(
			"This pilot makes paid calls. Supply --confirm-paid after authorization.",
		);
	const url = new URL(process.env.NOVA_DB_LOCAL_URL ?? "");
	if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
		throw new Error("A loopback local database is required.");
	const apiKey = process.env.OPENAI_API_KEY;
	if (!dryRun && !apiKey) throw new Error("OPENAI_API_KEY is required.");
	const output = argument("--out");
	const task = process.argv.includes("--task")
		? await readFile(argument("--task"), "utf8")
		: TASK;
	const ledgerPath = argument("--ledger");
	const ledger = ledgerSchema.parse(
		JSON.parse(await readFile(ledgerPath, "utf8")),
	);
	await mkdir(output, { mode: 0o700 });
	const save = (name: string, value: unknown) =>
		writeFile(resolve(output, name), JSON.stringify(value, null, 2), {
			mode: 0o600,
		});
	const sourcePaths = [
		"scripts/evaluate-agent-authoring.ts",
		"lib/agent/anatomy/requestCapture.ts",
		"lib/agent/authoring/experimental/comparison.ts",
		"lib/agent/authoring/experimental/native.ts",
		"lib/agent/authoring/experimental/normalize.ts",
		"lib/agent/authoring/experimental/schemas.ts",
		"lib/agent/authoring/experimental/values.ts",
		"lib/doc/expressionText.ts",
		"lib/commcare/xpath/expressionAst.ts",
	];
	await save(
		"source.json",
		await Promise.all(
			sourcePaths.map(async (path) => {
				const content = await readFile(resolve(path), "utf8");
				return {
					path,
					content,
					sha256: createHash("sha256").update(content).digest("hex"),
				};
			}),
		),
	);
	const db = await getAuthDb();
	const actor = await db
		.selectFrom("auth_user")
		.select("id")
		.where("email", "=", "agent@dimagi.com")
		.executeTakeFirstOrThrow();
	const projectId = await ensurePersonalProject(actor.id);
	const runId = randomUUID();
	const prepareApp = async () => {
		if (!process.argv.includes("--from-run"))
			return createExplicitBlankApp(actor.id, projectId, runId, {
				name: "Authoring comparison",
				status: "complete",
			});
		if (dryRun) throw new Error("Dry runs create their own app.");
		const prior = argument("--from-run");
		const { appId } = z
			.object({ appId: z.uuid() })
			.parse(JSON.parse(await readFile(resolve(prior, "run.json"), "utf8")));
		const expected = JSON.parse(
			await readFile(resolve(prior, "result.json"), "utf8"),
		);
		const app = await loadAppForInspection(appId);
		if (
			!app ||
			app.owner !== actor.id ||
			app.project_id !== projectId ||
			app.blueprint.appName !== "Authoring comparison" ||
			canonicalJsonText(app.blueprint) !== canonicalJsonText(expected.blueprint)
		)
			throw new Error(
				"The prior trial app no longer matches its saved result.",
			);
		await restoreApp(appId, actor.id);
		return { appId, blueprint: app.blueprint, baseSeq: app.mutation_seq };
	};
	const genesis = await prepareApp();
	try {
		await save("before.json", genesis.blueprint);
		const { mcpCtx, logWriter } = initMcpCall(
			{
				userId: actor.id,
				scopes: ["nova.read", "nova.write"],
				authKind: "api-key",
			},
			genesis.appId,
			projectId,
			"owner",
			runId,
			undefined,
		);
		const workspace = new CanonicalMutationWorkspace({
			host: mcpCtx,
			initialDoc: hydratePersistedBlueprint(genesis.blueprint),
			baseSeq: genesis.baseSeq,
		});
		const transport = createModelCallTransport();
		let requests = 0;
		let steps = 0;
		let currentCall: Record<string, unknown> | undefined;
		const saveLedger = () =>
			writeFile(ledgerPath, JSON.stringify(ledger, null, 2), { mode: 0o600 });
		try {
			const provider = createNovaOpenAI(
				apiKey ?? "dry-run",
				captureModelRequests(transport.fetch, async (request) => {
					if (requests >= MAX_REQUESTS)
						throw new Error("Pilot request limit reached.");
					// One dollar exceeds the cost of a full accepted Luna context plus this
					// output allowance, even with long-context/cache-write rates (2026-09-12).
					// Unknown outcomes retain the reservation; a completed step replaces it.
					if (
						ledger.estimatedSpentUsd + 1 >
						Math.min(ledger.ceilingUsd, ledger.targetUsd)
					)
						throw new Error("Pilot spend limit reached.");
					requests += 1;
					currentCall = {
						runId,
						request: requests,
						model: MODEL,
						reservedUsd: 1,
						status: "pending",
						sha256: request.sha256,
					};
					ledger.calls.push(currentCall);
					ledger.estimatedSpentUsd += 1;
					await saveLedger();
					await writeFile(
						resolve(output, `request-${requests}.json`),
						request.body,
						{ mode: 0o600 },
					);
				}),
			);
			await save("run.json", {
				runId,
				appId: genesis.appId,
				model: MODEL,
				effort: "xhigh",
				variant,
				interfaceVersion: "authoring-pilot-v5",
				startedAt: new Date().toISOString(),
				task,
				turnMode: process.argv.includes("--from-run")
					? "fresh follow-up edit"
					: "creation",
				fromRun: process.argv.includes("--from-run")
					? argument("--from-run")
					: null,
			});
			const instructions =
				variant === "current"
					? buildSolutionsArchitectPrompt()
					: PILOT_GUIDANCE;
			const tools = deduplicatePilotCalls(
				variant === "current"
					? currentPilotTools(workspace)
					: variant === "programmatic"
						? programmaticPilotTools(workspace, provider)
						: nativePilotTools(workspace),
			);
			await save("instructions.json", { instructions });
			const definitions = await Promise.all(
				Object.entries(tools).map(async ([name, definition]) => ({
					name,
					description: definition.description,
					parameters: await asSchema(definition.inputSchema).jsonSchema,
					strict: definition.strict,
					providerOptions: definition.providerOptions,
					type: definition.type,
				})),
			);
			await save("definitions.json", definitions);
			const tokens = {
				prompt: await estimateTokens(instructions),
				tools: await estimateTokens(JSON.stringify(definitions)),
				kind: "local-estimate",
			};
			await save("tokens.json", tokens);
			if (dryRun) {
				const declared = await executePilotOperation(
					workspace,
					"declareRecords",
					{
						caseTypes: [
							{
								name: "client",
								properties: [{ name: "case_name", label: "Client name" }],
							},
						],
					},
				);
				const created = await executePilotOperation(workspace, "createModule", {
					name: "Clients",
					case_type: "client",
					case_list_columns: [
						{ kind: "plain", field: "case_name", header: "Name" },
					],
					forms: [
						{
							name: "Register",
							type: "registration",
							fields: [
								{
									id: "client_name",
									kind: "text",
									caseWrite: { caseType: "client", property: "case_name" },
									required: true,
								},
								{
									id: "confirmation",
									kind: "label",
									label: "Registered {{client_name}}.",
								},
							],
						},
					],
				});
				const persisted = await loadApp(genesis.appId);
				await save("dry-run.json", {
					declared,
					created,
					blueprint: persisted?.blueprint,
				});
				if (
					!persisted ||
					!Object.values(persisted.blueprint.fields).some(
						(field) => field.id === "confirmation",
					)
				)
					throw new Error("The dry run did not persist its workflow.");
				console.log(JSON.stringify({ output, dryRun: true, tokens }));
				return;
			}
			const agent = new ToolLoopAgent({
				model: provider(MODEL),
				instructions,
				tools,
				stopWhen: isStepCount(MAX_REQUESTS),
				maxRetries: 0,
				maxOutputTokens: 12_000,
				providerOptions: { openai: { store: false, reasoningEffort: "xhigh" } },
				onStepEnd: async (step) => {
					steps += 1;
					// Conservatively count all input as uncached; usage remains alongside
					// this estimate so later analysis can distinguish cache effects.
					const cost =
						estimateCost(
							MODEL,
							step.usage.inputTokens ?? 0,
							step.usage.outputTokens ?? 0,
						) * 1.25;
					if (currentCall?.status !== "pending")
						throw new Error("A metered step has no pending request.");
					ledger.estimatedSpentUsd += cost - 1;
					Object.assign(currentCall, {
						status: "completed",
						estimatedUsd: cost,
						usage: step.usage,
					});
					await saveLedger();
					await save(`step-${steps}.json`, {
						text: step.text,
						toolCalls: step.toolCalls,
						toolResults: step.toolResults,
						finishReason: step.finishReason,
						usage: step.usage,
					});
					console.log(
						JSON.stringify({
							step: steps,
							tools: step.toolCalls.map((call) => call.toolName),
							inputTokens: step.usage.inputTokens,
							estimatedUsd: cost,
						}),
					);
				},
			});
			const initialState =
				variant === "current"
					? buildAppStateMessage(workspace.currentSnapshot().doc)
					: null;
			const result = await agent.generate({
				messages: [
					{ role: "user", content: task },
					...(initialState ? [initialState] : []),
				],
				abortSignal: AbortSignal.timeout(300_000),
			});
			const persisted = await loadApp(genesis.appId);
			await save("result.json", {
				text: result.text,
				messages: result.response.messages,
				finishReason: result.finishReason,
				steps,
				requests,
				usage: result.totalUsage,
				blueprint: persisted?.blueprint,
				estimatedTotalSpentUsd: ledger.estimatedSpentUsd,
			});
			console.log(
				JSON.stringify({
					output,
					appId: genesis.appId,
					steps,
					estimatedTotalSpentUsd: ledger.estimatedSpentUsd,
				}),
			);
		} catch (error) {
			await save("failure.json", {
				message: error instanceof Error ? error.message : String(error),
				steps,
				requests,
				blueprint: workspace.currentSnapshot().doc,
			});
			throw error;
		} finally {
			try {
				await logWriter.flush();
			} finally {
				await transport.destroy();
			}
		}
	} finally {
		await softDeleteApp(genesis.appId, actor.id);
	}
}

main()
	.finally(closeCaseStoreDatabase)
	.catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
