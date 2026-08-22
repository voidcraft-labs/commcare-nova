/**
 * Preview the design agent loop's exact model-facing protocol without an app
 * or database row. The script keeps the bounded author/review/revision
 * workspaces in memory, runs the real independent reviewer, and lets Nova
 * derive the build plan deterministically from the accepted Design Contract.
 *
 * Usage:
 *   npx tsx --conditions=react-server scripts/preview-app-design.ts \
 *     --out /tmp/design "Track CHW home visits..."
 *
 * Reads OPENAI_API_KEY from .env.
 * WARNING: this spends money on the live design author and reviewer models.
 */

import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import type { ModelMessage } from "ai";
import {
	CONTRACT_COLLECTIONS,
	type DesignArtifactWorkspaceOperation,
	designArtifactWorkspaceOperationSchema,
	designWorkspaceBoundError,
	finishDesignInputSchema,
	inspectDesignInputSchema,
	inspectDesignWorkspaceCandidate,
	replayDesignWorkspace,
} from "../lib/agent/design/artifactWorkspaceOperations";
import type { DesignIdentityHandleBinding } from "../lib/agent/design/artifactWorkspaceStore";
import { type BuildPlan, deriveBuildPlan } from "../lib/agent/design/buildPlan";
import {
	buildCapabilityCatalog,
	renderCapabilityCatalog,
} from "../lib/agent/design/capabilityCatalog";
import type { AppDesignContract } from "../lib/agent/design/contract";
import { appDesignContractSchema } from "../lib/agent/design/contract";
import { DesignGenerationContext } from "../lib/agent/design/designGenerationContext";
import {
	changesArchitecture,
	criticalFindingCount,
	leavesCriticalFinding,
} from "../lib/agent/design/loop/artifacts";
import { createDesignAgent } from "../lib/agent/design/loop/designAgent";
import {
	collectDesignIdentityHandleBindings,
	createDesignLoopTools,
	createDesignToolExecutionQueue,
	projectDesignIdentityHandles,
	renderDesignValidationIssues,
	resolveDesignFindingHandles,
	resolveDesignWorkspaceHandles,
} from "../lib/agent/design/loop/tools";
import { PLATFORM_CONSTRAINTS } from "../lib/agent/design/platformConstraints";
import {
	DESIGN_AGENT_SYSTEM,
	renderPlatformConstraintsSection,
} from "../lib/agent/design/prompts";
import type {
	DesignReview,
	DesignRevisionResult,
} from "../lib/agent/design/review";
import {
	designRevisionResultSchemaFor,
	findingBlocksAcceptance,
	validateSensitivityNotSilentlyLowered,
} from "../lib/agent/design/review";
import { runDesignReviewer } from "../lib/agent/design/reviewer";
import { deriveFindingHandleBindings } from "../lib/agent/design/reviewVocabulary";
import {
	computeSourcePackageDigest,
	type DesignSourcePackage,
} from "../lib/agent/design/sourcePackage";
import { stripNullProperties } from "../lib/agent/strictStructuredOutput";
import { MODEL_ROLES } from "../lib/models";
import { designPreviewInputTerminal } from "./lib/designPreviewInputTerminal";

function usage(): never {
	console.log(
		"Usage: npx tsx --conditions=react-server scripts/preview-app-design.ts " +
			'[--out <dir>] "<request text>"\n' +
			"WARNING: runs the live design author and independent reviewer.",
	);
	process.exit(1);
}

interface PreviewState {
	contract: AppDesignContract | null;
	lifecycle: "draft" | "accepted" | null;
	reviews: DesignReview[];
	openReviewCount: number;
	plan: BuildPlan | null;
	contractOperations: DesignArtifactWorkspaceOperation[];
	revisionOperations: DesignArtifactWorkspaceOperation[];
	/** The in-memory stand-in for the durable identity-handle ledger:
	 *  every accepted stage's declarations, deduped by handle, exactly what
	 *  production reads back for the reviewer's symbol vocabulary. */
	handleBindings: Map<string, DesignIdentityHandleBinding>;
}

function issuesText(error: {
	issues: Array<{ path: PropertyKey[]; message: string }>;
}): string {
	return error.issues
		.slice(0, 25)
		.map((issue) => `- ${issue.path.join(".") || "<root>"}: ${issue.message}`)
		.join("\n");
}

function parseInput<T>(
	schema: {
		safeParse(value: unknown):
			| { success: true; data: T }
			| {
					success: false;
					error: { issues: Array<{ path: PropertyKey[]; message: string }> };
			  };
	},
	input: unknown,
): { ok: true; data: T } | { ok: false; error: string } {
	const parsed = schema.safeParse(stripNullProperties(input));
	return parsed.success
		? { ok: true, data: parsed.data }
		: { ok: false, error: issuesText(parsed.error) };
}

function phaseFor(state: PreviewState) {
	if (state.contract === null) return "author" as const;
	if (state.lifecycle === "draft" && state.reviews.length === 0) {
		return "review" as const;
	}
	if (state.lifecycle === "draft") return "revision" as const;
	return "awaiting-input" as const;
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	if (argv.includes("--help") || argv.length === 0) usage();
	let outDir = "design-preview";
	const rest: string[] = [];
	for (let i = 0; i < argv.length; i += 1) {
		if (argv[i] === "--out") {
			outDir = argv[i + 1] ?? usage();
			i += 1;
		} else {
			rest.push(argv[i] as string);
		}
	}
	const request = rest.join(" ").trim();
	if (!request) usage();
	if (!process.env.OPENAI_API_KEY) {
		console.error("OPENAI_API_KEY is not set: nothing was sent.");
		process.exit(1);
	}

	mkdirSync(outDir, { recursive: true });
	const write = (name: string, value: unknown) => {
		const path = join(outDir, name);
		writeFileSync(path, JSON.stringify(value, null, 2));
		console.log(`  wrote ${path}`);
	};

	const sessionId = crypto.randomUUID();
	const threadId = crypto.randomUUID();
	const usageTotals = { inputTokens: 0, outputTokens: 0 };
	const ctx = new DesignGenerationContext({
		apiKey: process.env.OPENAI_API_KEY,
		userId: "preview",
		projectId: "preview",
		runId: `preview-${sessionId.slice(0, 8)}`,
		designSessionId: sessionId,
		meter: {
			track(usage) {
				usageTotals.inputTokens += usage.inputTokens;
				usageTotals.outputTokens += usage.outputTokens;
			},
		},
	});
	const unsealed: Omit<DesignSourcePackage, "packageDigest"> = {
		schemaVersion: 1,
		designSessionId: sessionId,
		projectId: "preview",
		request: {
			blocks: [
				{
					ref: {
						kind: "message",
						threadId,
						messageId: "preview-request",
						partIndex: 0,
					},
					text: request,
					truncated: false,
				},
			],
		},
		claims: [],
		attachments: [],
		images: [],
		platformConstraints: Object.values(PLATFORM_CONSTRAINTS),
		sources: [
			{
				ref: {
					kind: "message",
					threadId,
					messageId: "preview-request",
					partIndex: 0,
				},
			},
		],
	};
	const pkg: DesignSourcePackage = {
		...unsealed,
		packageDigest: computeSourcePackageDigest(unsealed),
	};
	const signal = new AbortController().signal;
	const catalogText = renderCapabilityCatalog(buildCapabilityCatalog());
	const state: PreviewState = {
		contract: null,
		lifecycle: null,
		reviews: [],
		openReviewCount: 0,
		plan: null,
		contractOperations: [],
		revisionOperations: [],
		handleBindings: new Map(),
	};

	/* Reuse production descriptions and strict wire schemas while replacing
	 * persistence with the same pure workspace replay used by the store. */
	const realTools = createDesignLoopTools({
		designSessionId: sessionId,
		runId: "preview",
		authority: {
			actorUserId: "preview",
			runId: "preview",
			holderNonce: "00000000-0000-4000-8000-000000000004",
			expectedProjectId: pkg.projectId,
		},
		currentPkg: pkg,
		catalogText,
		ctx,
		signal,
		repair: {
			noteSchemaRejection() {},
			noteSequenceError() {},
			noteLegalCall() {},
			noteAccepted() {},
			fatalError: () => undefined,
		} as never,
		loadAncestry: async () => {
			throw new Error("The preview never touches the artifact store.");
		},
		/* In-memory protocol: nothing memoizes, so a changed ancestry needs no
		 * notification. */
		ancestryChanged: () => {},
		rebuildPackageForDigest: async () => pkg,
	});

	const candidateFor = (kind: "contract" | "revision") =>
		replayDesignWorkspace({
			kind,
			...(kind === "revision" && state.contract !== null
				? { baseContract: state.contract }
				: {}),
			operations:
				kind === "contract"
					? state.contractOperations
					: state.revisionOperations,
		});

	const activeKind = (): "contract" | "revision" =>
		state.contract !== null && state.reviews.length > 0
			? "revision"
			: "contract";
	const stage = async (
		kind: "contract" | "revision",
		rawBody: Record<string, unknown>,
	) => {
		const rawOperation = { kind, ...rawBody };
		/* Same order as production revision updates: finding handles resolve
		 * before the generic resolver can mint a wrong deterministic UUID. */
		const preResolved =
			kind === "revision"
				? resolveDesignFindingHandles(
						stripNullProperties(rawOperation),
						deriveFindingHandleBindings(state.reviews),
					)
				: ({ ok: true, value: rawOperation } as const);
		if (!preResolved.ok) return { error: preResolved.error };
		const parsed = parseInput(
			designArtifactWorkspaceOperationSchema,
			resolveDesignWorkspaceHandles(preResolved.value, sessionId),
		);
		if (!parsed.ok) return { error: parsed.error };
		const operations =
			kind === "contract" ? state.contractOperations : state.revisionOperations;
		const operation = parsed.data as DesignArtifactWorkspaceOperation;
		const bound = designWorkspaceBoundError({ input: rawOperation, operation });
		if (bound !== null) return { error: bound };
		operations.push(operation);
		for (const binding of collectDesignIdentityHandleBindings(
			stripNullProperties(rawOperation),
			sessionId,
		)) {
			state.handleBindings.set(binding.handle, binding);
		}
		return {
			ok: true,
			message: "The semantic design update is saved.",
		};
	};

	const finalizePlan = () => {
		if (state.contract === null) return;
		state.plan = deriveBuildPlan({
			contract: state.contract,
			revision: { id: crypto.randomUUID(), digest: "0".repeat(64) },
		});
		write("build-plan.json", state.plan);
		console.log(`\n[deriveBuildPlan] ${state.plan.slices.length} slices`);
	};

	const finishContract = async (input: unknown) => {
		const finalized = parseInput(finishDesignInputSchema, input);
		if (!finalized.ok) return { error: finalized.error };
		const parsed = appDesignContractSchema.safeParse(candidateFor("contract"));
		if (!parsed.success) {
			return { error: renderDesignValidationIssues(parsed.error) };
		}
		state.contract = parsed.data;
		state.lifecycle = "draft";
		state.reviews = [];
		state.revisionOperations = [];
		write("contract-draft.json", parsed.data);
		console.log(
			`\n[finishDesign] ${parsed.data.actors.length} actors, ${parsed.data.workflows.length} workflows, ${parsed.data.records.length} records`,
		);
		return {
			ok: true,
			revisionId: crypto.randomUUID(),
			message: "The draft persisted. Request its independent review.",
		};
	};

	const requestReview = async () => {
		if (state.contract === null || state.lifecycle !== "draft") {
			return { error: "No unreviewed draft exists." };
		}
		console.log("\n[requestReview] running the independent reviewer…");
		const reviewed = await runDesignReviewer(
			ctx,
			{
				pkg,
				contract: state.contract,
				catalogText,
				bindings: [...state.handleBindings.values()],
			},
			signal,
		);
		if (reviewed.kind !== "produced") {
			return {
				error: `The review did not come back (${reviewed.reason}).`,
			};
		}
		state.reviews = [reviewed.artifact];
		state.openReviewCount += 1;
		write(`review-${state.openReviewCount}.json`, reviewed.artifact);
		const blocking = reviewed.artifact.findings.filter(findingBlocksAcceptance);
		console.log(
			`[requestReview] ${reviewed.artifact.findings.length} findings (${blocking.length} blocking)`,
		);
		if (blocking.length === 0) {
			state.lifecycle = "accepted";
			finalizePlan();
		}
		return {
			ok: true,
			findings: projectDesignIdentityHandles(reviewed.artifact.findings, [
				...state.handleBindings.values(),
				...deriveFindingHandleBindings([reviewed.artifact]),
			]),
			summary: reviewed.artifact.summary,
			accepted: blocking.length === 0,
			message:
				blocking.length === 0
					? "The design is accepted and its build plan was derived."
					: "Update the blocking corrections and their dispositions.",
		};
	};

	const finishRevision = async (input: unknown) => {
		if (state.contract === null || state.reviews.length === 0) {
			return { error: "No reviewed draft exists to revise." };
		}
		const finalized = parseInput(finishDesignInputSchema, input);
		if (!finalized.ok) return { error: finalized.error };
		const { dispositions, ...contract } = candidateFor("revision");
		const parsed = designRevisionResultSchemaFor(state.reviews).safeParse({
			contract,
			dispositions,
		});
		if (!parsed.success) {
			return { error: renderDesignValidationIssues(parsed.error) };
		}
		const violations = validateSensitivityNotSilentlyLowered(
			state.contract,
			parsed.data,
			state.reviews,
		);
		if (violations.length > 0) return { error: violations.join("\n") };
		const prior = state.contract;
		const revision: DesignRevisionResult = parsed.data;
		const secondReview =
			state.openReviewCount === 1 &&
			(leavesCriticalFinding(revision, state.reviews) ||
				criticalFindingCount(state.reviews) >= 2 ||
				(criticalFindingCount(state.reviews) > 0 &&
					changesArchitecture(prior, revision.contract)));
		state.contract = revision.contract;
		state.lifecycle = secondReview ? "draft" : "accepted";
		state.reviews = [];
		state.revisionOperations = [];
		write(`contract-revision-${state.openReviewCount}.json`, revision.contract);
		write(`dispositions-${state.openReviewCount}.json`, revision.dispositions);
		if (!secondReview) finalizePlan();
		return {
			ok: true,
			accepted: !secondReview,
			message: secondReview
				? "The revision warrants one more independent review."
				: "The revision is accepted and its build plan was derived.",
		};
	};

	const toolExecutionQueue = createDesignToolExecutionQueue();
	const ordered = toolExecutionQueue.run;
	const collectionToolName = {
		actors: "updateActors",
		records: "updateRecords",
		workflows: "updateWorkflows",
		lists: "updateLists",
		access: "updateAccess",
		navigation: "updateNavigation",
		moduleCompositions: "updateModuleCompositions",
		formCompositions: "updateFormCompositions",
		externalRequirements: "updateExternalRequirements",
		decisions: "updateDecisions",
		assumptions: "updateAssumptions",
		openQuestions: "updateOpenQuestions",
	} as const;
	const semanticCollectionTools = Object.fromEntries(
		CONTRACT_COLLECTIONS.map((collection) => {
			const toolName = collectionToolName[collection];
			return [
				toolName,
				{
					...realTools[toolName],
					execute: (input: unknown) =>
						ordered(input, () =>
							stage(activeKind(), {
								collections: [
									{
										collection,
										...(stripNullProperties(input) as Record<string, unknown>),
									},
								],
							}),
						),
				},
			];
		}),
	);
	const tools = {
		...realTools,
		...semanticCollectionTools,
		setDesignRoot: {
			...realTools.setDesignRoot,
			execute: (input: unknown) =>
				ordered(input, () =>
					stage(activeKind(), {
						root: stripNullProperties(input),
						collections: [],
					}),
				),
		},
		updateFindingDispositions: {
			...realTools.updateFindingDispositions,
			execute: (input: unknown) =>
				ordered(input, () =>
					stage("revision", {
						collections: [],
						dispositions: {
							collection: "dispositions",
							...(stripNullProperties(input) as Record<string, unknown>),
						},
					}),
				),
		},
		inspectDesign: {
			...realTools.inspectDesign,
			execute: (input: unknown) =>
				ordered(input, async () => {
					const parsed = parseInput(inspectDesignInputSchema, input);
					if (!parsed.ok) return { error: parsed.error };
					const kind = activeKind();
					return {
						ok: true,
						view: projectDesignIdentityHandles(
							inspectDesignWorkspaceCandidate({
								kind,
								candidate: candidateFor(kind),
								...(state.contract !== null && {
									sourceContract: state.contract,
								}),
								selection: parsed.data.selection,
							}),
							[...state.handleBindings.values()],
						),
					};
				}),
		},
		finishDesign: {
			...realTools.finishDesign,
			execute: (input: unknown) =>
				ordered<unknown>(input, () =>
					activeKind() === "revision"
						? finishRevision(input)
						: finishContract(input),
				),
		},
		requestReview: {
			...realTools.requestReview,
			execute: (input: unknown) => ordered(input, requestReview),
		},
	};

	const readline = createInterface({
		input: process.stdin,
		output: process.stdout,
	});
	let messages: ModelMessage[] = [
		{
			role: "user",
			content: `<nova:source ref="message:preview">${request}</nova:source>`,
		},
	];

	for (let turn = 0; turn < 20 && state.plan === null; turn += 1) {
		const phase = phaseFor(state);
		const agent = createDesignAgent({
			model: ctx.model(MODEL_ROLES.designAuthor.modelId),
			tools: tools as never,
			toolExecutionQueue,
			phase,
			catalogText,
			constraintsText: renderPlatformConstraintsSection(),
			instructions: DESIGN_AGENT_SYSTEM,
			promptCacheKey: `nova:design-preview:${sessionId}:${phase}`,
			fatalError: () => undefined,
			requiredUserQuestions: () => [],
			freshStateMessage: async () => ({
				role: "user",
				content: `# Design session state (server-derived)\n\nCurrent phase: ${phase}.`,
			}),
			stepsBeforeStream: 0,
			contextGeneration: 0,
			onStepEnd: (step) => {
				if (step.text) console.log(`\nNova: ${step.text}`);
			},
		});
		const result = await agent.stream({ prompt: messages });
		await result.consumeStream();
		const response = await result.response;
		messages = [...messages, ...response.messages];
		const [toolCalls, toolResults] = await Promise.all([
			result.toolCalls,
			result.toolResults,
		]);
		const inputTerminal = designPreviewInputTerminal(
			toolCalls.filter(
				(call): call is NonNullable<typeof call> => call != null,
			),
			toolResults.filter(
				(result): result is NonNullable<typeof result> => result != null,
			),
		);
		if (inputTerminal.kind === "wait") break;
		const pendingQuestions =
			inputTerminal.kind === "questions" ? inputTerminal.questions : [];
		for (const call of pendingQuestions) {
			const input = call.input as {
				header?: string;
				questions?: Array<{
					question: string;
					options?: Array<{ label: string }>;
				}>;
			};
			console.log(`\n── ${input.header ?? "Questions"} ──`);
			const answers: Record<string, string> = {};
			for (const [index, question] of (input.questions ?? []).entries()) {
				console.log(`\n${question.question}`);
				for (const option of question.options ?? []) {
					console.log(`  - ${option.label}`);
				}
				answers[String(index)] = await readline.question("> ");
			}
			messages = [
				...messages,
				{
					role: "tool",
					content: [
						{
							type: "tool-result",
							toolCallId: call.toolCallId,
							toolName: "askQuestions",
							output: { type: "json", value: { answers } },
						},
					],
				},
			];
		}
		if (inputTerminal.kind === "none" && phaseFor(state) === phase) break;
	}
	readline.close();

	console.log(
		`\nDone. Tokens: ${usageTotals.inputTokens.toLocaleString()} in / ${usageTotals.outputTokens.toLocaleString()} out.`,
	);
	if (state.plan === null) {
		console.log("The loop ended without a plan: inspect the artifacts above.");
	}
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
