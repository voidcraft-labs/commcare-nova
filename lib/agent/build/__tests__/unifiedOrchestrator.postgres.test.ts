import type { Kysely } from "kysely";
import { expect, it, vi } from "vitest";
import {
	type ProviderOutput,
	type ProviderRequest,
	respondWithParts,
} from "@/lib/agent/__tests__/responsesParts";
import { withResponsesPeer } from "@/lib/agent/__tests__/responsesPeer";
import { productionModelStep } from "@/lib/agent/modelStep";
import { PostgresCaseStore } from "@/lib/case-store/postgres/store";
import { HeuristicCaseGenerator } from "@/lib/case-store/sample/heuristic";
import type { Database } from "@/lib/case-store/sql/database";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { claimAndReserveRun, loadApp } from "@/lib/db/apps";
import {
	claimAndReserveDesignSessionRun,
	createAndClaimDesignSessionRun,
} from "@/lib/db/designSessions";
import { withAppTx } from "@/lib/db/pg";
import { hasUnfinishedMaterializedDesignInTransaction } from "@/lib/db/unfinishedMaterializedDesign";
import {
	type RunBuildOrchestrationArgs,
	runBuildOrchestration,
} from "../orchestrator";
import { completeBuildOrchestration } from "../orchestratorState";

const { schemaContext, projectContext } = vi.hoisted(() => ({
	schemaContext: vi.fn(),
	projectContext: vi.fn(),
}));
vi.mock("@/lib/case-store", async () => ({
	...(await vi.importActual("@/lib/case-store")),
	withSchemaContext: schemaContext,
	withProjectContext: projectContext,
}));
const h = setupAppStateTestDb("unified_build_", { authSchema: "migrated" });

it.each([
	["uninterrupted", false],
	["staged-work", false],
	["saved-work", false],
	["active-peer", false],
	["completed-peer", false],
	["staged-work", true],
	["active-peer", true],
] as const)(
	"plans, builds, evaluates and reviews the actual app, recovering at %s (replacement run: %s)",
	async (interruption, replaceRun) => {
		schemaContext.mockImplementation(
			async () =>
				new PostgresCaseStore({
					projectId: null,
					actorUserId: null,
					ownerId: null,
					db: h.db() as unknown as Kysely<Database>,
					sampleGenerator: new HeuristicCaseGenerator(),
				}),
		);
		projectContext.mockImplementation(
			async (projectId: string, actorUserId: string, ownerId: string) =>
				new PostgresCaseStore({
					projectId,
					actorUserId,
					ownerId,
					db: h.db() as unknown as Kysely<Database>,
					sampleGenerator: new HeuristicCaseGenerator(),
				}),
		);
		const actorUserId = "architect";
		const projectId = "unified-project";
		let runId = "unified-run";
		await h.seedProjectMember(actorUserId, projectId, "owner");
		const claim = await createAndClaimDesignSessionRun({
			projectId,
			actorUserId,
			runId,
			cost: 1,
		});
		let holderNonce = claim.holderNonce;
		const script: readonly (readonly ProviderOutput[])[] = [
			...(interruption === "uninterrupted"
				? [
						[
							{
								type: "tool" as const,
								name: "readSource",
								callId: "missing-source",
								input: { document: "unattached.pdf" },
							},
						],
					]
				: []),
			[
				{
					type: "tool",
					name: "writePlan",
					callId: "plan",
					input: {
						markdown: "Register a loan with the borrower's name and tool.",
					},
				},
			],
			[{ type: "tool", name: "startBuilding", callId: "start", input: {} }],
			[
				{
					type: "tool",
					name: "editPlan",
					callId: "peer-plan",
					input: {
						oldText: "borrower's name and tool",
						newText: "borrower's name and tool, both required",
					},
				},
			],
			[
				{
					type: "text",
					text: "Both answers should be required so a loan is identifiable.",
				},
			],
			[
				{
					type: "tool",
					name: "createModule",
					callId: "loans",
					input: {
						name: "Loans",
						case_type: "loan",
						forms: [
							{
								name: "Lend",
								type: "registration",
								recordName: "concat(#form/borrower, ' - ', #form/tool)",
								fields: [
									{
										kind: "text",
										id: "borrower",
										label: "Borrower",
										required: true,
									},
									{ kind: "text", id: "tool", label: "Tool", required: true },
								],
							},
						],
					},
				},
			],
			[{ type: "tool", name: "saveWork", callId: "save", input: {} }],
			[{ type: "text", text: "The loan registration workflow is built." }],
			[{ type: "tool", name: "getApp", callId: "peer-app", input: {} }],
			[
				{
					type: "tool",
					name: "evaluateForm",
					callId: "empty-answers",
					input: { moduleUuid: "Loans", formUuid: "Lend", answers: [] },
				},
			],
			[
				{
					type: "tool",
					name: "evaluateForm",
					callId: "filled-answers",
					input: {
						moduleUuid: "Loans",
						formUuid: "Lend",
						answers: [
							{ path: "borrower", value: "Ada" },
							{ path: "tool", value: "Drill" },
						],
					},
				},
			],
			[
				{
					type: "text",
					text: "I inspected the saved loan workflow. Its record name includes both answers.",
				},
			],
			[{ type: "text", text: "The loan workflow is ready." }],
		];
		const requests: ProviderRequest[] = [];
		const failures: unknown[] = [];
		const chunks: unknown[] = [];
		let interrupted = false;
		let previousState: string | undefined;
		const disconnect = () => {
			interrupted = true;
			throw new Error("Simulated connection loss");
		};
		await withResponsesPeer(
			(request, response) => {
				const buffers: Buffer[] = [];
				request.on("data", (chunk: Buffer) => buffers.push(chunk));
				request.on("end", () => {
					try {
						const index = requests.length;
						requests.push(JSON.parse(Buffer.concat(buffers).toString()));
						const next = script[index];
						if (!next) throw new Error(`Unexpected provider call ${index}`);
						respondWithParts(response, next, index);
					} catch (error) {
						failures.push(error);
						response.writeHead(400).end();
					}
				});
			},
			async (provider) => {
				const step = productionModelStep(
					provider("gpt-5.6-sol"),
					"medium",
					"unified-test",
				);
				const args: RunBuildOrchestrationArgs = {
					designSessionId: claim.designSessionId,
					proposedAppId: claim.proposedAppId,
					projectId,
					projectRole: "owner",
					actorUserId,
					runId,
					holderNonce: claim.holderNonce,
					threadId: "thread",
					messages: [
						{
							id: "request",
							role: "user",
							parts: [
								{
									type: "text",
									text: "Register loans with a borrower name and the tool borrowed.",
								},
							],
						},
					],
					responseMessageId: "response",
					writer: {
						write: (chunk) => {
							chunks.push(chunk);
							if (
								!interrupted &&
								interruption === "staged-work" &&
								chunk.type === "tool-output-available" &&
								"toolCallId" in chunk &&
								chunk.toolCallId === "loans"
							)
								disconnect();
							if (
								!interrupted &&
								interruption === "saved-work" &&
								chunk.type === "data-app-materialized"
							)
								disconnect();
							if (chunk.type === "data-authoring-progress" && "data" in chunk) {
								const next = (chunk.data as { stage: string }).stage;
								if (
									!interrupted &&
									interruption === "completed-peer" &&
									previousState === "reviewing-app" &&
									next === "building"
								)
									disconnect();
								previousState = next;
							}
						},
					},
					apiKey: "synthetic-local-only",
					meter: undefined,
					signal: new AbortController().signal,
					materializedAppId: null,
					deps: {
						onAgentStep: (step, role) => {
							if (
								!interrupted &&
								interruption === "active-peer" &&
								role === "peer" &&
								step.toolCalls?.some((call) => call.toolCallId === "peer-app")
							)
								disconnect();
						},
						modelStep: step,
						peerStep: step,
						sourceDeps: {
							loadAssets: async () => [],
							readExtract: async () => {
								throw new Error("No document expected");
							},
							loadImage: async () => {
								throw new Error("No image expected");
							},
						},
					},
					finalizeCompletion: async (completion) => {
						const app = await loadApp(completion.appId);
						if (!app) throw new Error("No app was materialized");
						const head = await completeBuildOrchestration({
							...completion,
							designSessionId: claim.designSessionId,
							actorUserId,
							runId,
							holderNonce,
							expectedProjectId: projectId,
						});
						return { blueprint: app.blueprint, head };
					},
				};
				if (interruption !== "uninterrupted") {
					await expect(runBuildOrchestration(args)).rejects.toThrow(
						"Simulated connection loss",
					);
					expect(interrupted).toBe(true);
				}
				if (replaceRun) {
					runId = "replacement-run";
					const existing = await loadApp(claim.proposedAppId);
					if (existing) {
						await h
							.db()
							.updateTable("apps")
							.set({ updated_at: new Date(0) })
							.where("id", "=", claim.proposedAppId)
							.execute();
						holderNonce = (
							await claimAndReserveRun(
								claim.proposedAppId,
								"build",
								runId,
								actorUserId,
								1,
								projectId,
							)
						).holderNonce;
					} else {
						await h
							.db()
							.updateTable("design_sessions")
							.set({ run_lease_expires_at: new Date(0) })
							.where("id", "=", claim.designSessionId)
							.execute();
						holderNonce = (
							await claimAndReserveDesignSessionRun(
								claim.designSessionId,
								runId,
								actorUserId,
								1,
								projectId,
							)
						).holderNonce;
					}
				}
				const resumedArgs = { ...args, runId, holderNonce };
				const result = await runBuildOrchestration(resumedArgs);
				expect(result.kind).toBe("completed");
				if (result.kind !== "completed")
					throw new Error("Build did not complete");
				const app = await loadApp(result.appId);
				expect(app?.mutation_seq).toBe(1);
				const toolResults = requests
					.flatMap((request) => request.input ?? [])
					.filter((part) => part.type === "function_call_output");
				const evaluation = (callId: string) =>
					JSON.parse(
						String(toolResults.find((part) => part.call_id === callId)?.output),
					);
				if (interruption === "uninterrupted")
					expect(evaluation("missing-source")).toMatchObject({
						error: expect.stringContaining("document"),
					});
				expect(evaluation("loans")).toMatchObject({
					ok: true,
					moduleUuid: app?.blueprint.moduleOrder[0],
				});
				expect(evaluation("empty-answers")).toMatchObject({
					mode: "evaluation",
					valid: false,
				});
				expect(evaluation("filled-answers")).toMatchObject({
					mode: "evaluation",
					valid: true,
					proposedValues: { primary: { caseName: "Ada - Drill" } },
				});
				expect(
					await withAppTx((tx) =>
						hasUnfinishedMaterializedDesignInTransaction(tx, result.appId),
					),
				).toBe(false);
				expect(
					await h
						.db()
						.selectFrom("authoring_checkpoints")
						.select("request_id")
						.execute(),
				).toEqual([{ request_id: "save" }]);
				const contexts = await h
					.db()
					.selectFrom("design_model_contexts")
					.select(["context_kind", "id"])
					.execute();
				expect(
					contexts.filter((row) => row.context_kind === "architect"),
				).toHaveLength(1);
				expect(
					contexts.filter((row) => row.context_kind === "peer"),
				).toHaveLength(2);
				const reviews = await h
					.db()
					.selectFrom("authoring_reviews")
					.select(["app_seq", "completed_revision", "summary"])
					.orderBy("app_seq")
					.execute();
				expect(reviews).toHaveLength(2);
				expect(
					reviews.some(
						(review) => review.app_seq === "1" && review.summary !== null,
					),
				).toBe(true);
				expect(requests[0]?.tools?.map((tool) => tool.name)).not.toContain(
					"createModule",
				);
				const buildingRequest = requests.find((request) =>
					request.input?.some(
						(item) =>
							item.type === "function_call_output" && item.call_id === "start",
					),
				);
				expect(buildingRequest?.tools?.map((tool) => tool.name)).toContain(
					"createModule",
				);
				expect(chunks).toContainEqual(
					expect.objectContaining({ type: "data-app-materialized" }),
				);
				// Completion has already released the lease. Its exact saved receipt
				// remains recoverable without paying for or applying another step.
				expect(await runBuildOrchestration(resumedArgs)).toEqual(result);
				const finalLeadRequest = requests.at(-1);
				if (replaceRun) {
					const states = (finalLeadRequest?.input ?? []).flatMap((item) => {
						if (item.role !== "user" || !Array.isArray(item.content)) return [];
						return item.content.flatMap((part) => {
							if (typeof part.text !== "string") return [];
							try {
								const state = JSON.parse(part.text);
								return state.workspace ? [state] : [];
							} catch {
								return [];
							}
						});
					});
					expect(states).toHaveLength(1);
					expect(states[0]).toMatchObject({
						appSaved: interruption !== "staged-work",
						planRevision: 2,
						plan: expect.stringContaining("both required"),
						workspace: {
							app: {
								modules: expect.arrayContaining([
									expect.objectContaining({ name: "Loans" }),
								]),
							},
						},
					});
				}
				expect(JSON.stringify(finalLeadRequest?.input)).toContain(
					"I inspected the saved loan workflow",
				);
			},
		);
		expect(failures).toEqual([]);
		expect(requests).toHaveLength(script.length);
	},
);
