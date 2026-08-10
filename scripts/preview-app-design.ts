/**
 * Preview the design agent loop's EXACT artifacts for a described app: the
 * agent's questions, its Design Contract, the independent review, the
 * dispositions, and the build plan: without a chat run, an app, or a
 * database row.
 *
 * Drives the REAL agent (same system prompt, same strict wire schemas, same
 * provider options `lib/agent/design/loop` mounts) over a synthetic
 * in-memory source package, with the submit tools re-executed in memory:
 * every submission still parses through the exact schema factories, the
 * requestReview tool still runs the real independent reviewer call, and
 * askQuestions rounds pause for YOUR answers on stdin: so question
 * behavior is checkable exactly as a user would meet it. Nothing persists
 * to Postgres; the store discipline is the integration tests' job
 * (`lib/agent/design/__tests__/designLoop.integration.test.ts`).
 *
 * Usage:
 *   npx tsx --conditions=react-server scripts/preview-app-design.ts \
 *     --out /tmp/design "Track CHW home visits..."
 *
 * The `--conditions=react-server` flag is required, exactly as it is for
 * `npm run test:schema`: the capability catalog imports the shared tool
 * registry, whose graph reaches `server-only`: under plain Node its bare
 * default export throws before this script prints anything, while the
 * condition resolves it to the package's own no-op.
 *
 * Reads OPENAI_API_KEY from .env.
 * ⚠️ Cost: one xhigh agent loop plus one xhigh reviewer call: the design
 * half of a build. Ask before running it on a shared key.
 */

import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import type { ModelMessage } from "ai";
import {
	buildPlanDraftSchema,
	buildPlanSchemaFor,
} from "../lib/agent/design/buildPlan";
import {
	buildCapabilityCatalog,
	renderCapabilityCatalog,
} from "../lib/agent/design/capabilityCatalog";
import type { AppDesignContract } from "../lib/agent/design/contract";
import { appDesignContractSchema } from "../lib/agent/design/contract";
import { DesignGenerationContext } from "../lib/agent/design/designGenerationContext";
import { createDesignAgent } from "../lib/agent/design/loop/designAgent";
import { createDesignLoopTools } from "../lib/agent/design/loop/tools";
import { PLATFORM_CONSTRAINTS } from "../lib/agent/design/platformConstraints";
import {
	DESIGN_AGENT_SYSTEM,
	renderPlatformConstraintsSection,
} from "../lib/agent/design/prompts";
import type { DesignReview } from "../lib/agent/design/review";
import {
	designRevisionResultSchemaFor,
	validateSensitivityNotSilentlyLowered,
} from "../lib/agent/design/review";
import { runDesignReviewer } from "../lib/agent/design/reviewer";
import {
	computeSourcePackageDigest,
	type DesignSourcePackage,
} from "../lib/agent/design/sourcePackage";
import { stripNullProperties } from "../lib/agent/strictStructuredOutput";
import { DESIGN_MODEL } from "../lib/models";

function usage(): never {
	console.log(
		"Usage: npx tsx --conditions=react-server scripts/preview-app-design.ts " +
			'[--out <dir>] "<request text>"\n' +
			"(--conditions=react-server is required: the tool-registry import " +
			"graph reaches server-only)\n" +
			"⚠️ Runs a live xhigh design agent loop plus the xhigh reviewer.",
	);
	process.exit(1);
}

/** In-memory design state: the preview's stand-in for the artifact store.
 *  The REAL gates live in `loop/gates.ts` over persisted rows; this mirror
 *  is only strong enough to keep the preview honest about sequence. */
interface PreviewState {
	contract: AppDesignContract | null;
	lifecycle: "draft" | "accepted" | null;
	reviews: DesignReview[];
	plan: unknown | null;
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
			track(u) {
				usageTotals.inputTokens += u.inputTokens;
				usageTotals.outputTokens += u.outputTokens;
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
		plan: null,
	};

	/* The real tool factory supplies descriptions + strict wire schemas; the
	 * executes are replaced with in-memory equivalents that keep the exact
	 * schema parses and the real reviewer call. */
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
			noteAccepted() {},
			fatalError: () => undefined,
		} as never,
		loadAncestry: async () => {
			throw new Error("The preview never touches the artifact store.");
		},
		rebuildPackageForDigest: async () => pkg,
	});

	const issuesText = (error: {
		issues: Array<{ path: PropertyKey[]; message: string }>;
	}) =>
		error.issues
			.slice(0, 25)
			.map((issue) => `- ${issue.path.join(".") || "<root>"}: ${issue.message}`)
			.join("\n");

	const tools = {
		submitContract: {
			...realTools.submitContract,
			execute: async (input: unknown) => {
				if (state.contract !== null && state.lifecycle === "draft") {
					return {
						error:
							state.reviews.length > 0
								? "The draft has review findings awaiting dispositions; use submitRevision."
								: "A draft already exists; request its review with requestReview.",
					};
				}
				const parsed = appDesignContractSchema.safeParse(
					stripNullProperties(input),
				);
				if (!parsed.success) return { error: issuesText(parsed.error) };
				state.contract = parsed.data;
				state.lifecycle = "draft";
				state.reviews = [];
				write("contract-draft.json", parsed.data);
				console.log(
					`\n[submitContract] ${parsed.data.actors.length} actors, ${parsed.data.tasks.length} tasks, ${parsed.data.records.length} records, ${parsed.data.openQuestions.length} open questions`,
				);
				return {
					ok: true,
					revisionId: crypto.randomUUID(),
					message:
						"The draft persisted. Request its independent review with requestReview.",
				};
			},
		},
		requestReview: {
			...realTools.requestReview,
			execute: async () => {
				if (state.contract === null || state.lifecycle !== "draft") {
					return { error: "No unreviewed draft exists." };
				}
				console.log("\n[requestReview] running the independent reviewer…");
				const reviewed = await runDesignReviewer(
					ctx,
					{ pkg, contract: state.contract, catalogText },
					signal,
				);
				if (reviewed.kind !== "produced") {
					return {
						error: `The review did not come back (${reviewed.reason}).`,
					};
				}
				state.reviews = [reviewed.artifact];
				write("review.json", reviewed.artifact);
				const gated = reviewed.artifact.findings.filter(
					(finding) => finding.severity !== "advisory",
				);
				console.log(
					`[requestReview] ${reviewed.artifact.findings.length} findings (${gated.length} gated)`,
				);
				if (gated.length === 0) {
					state.lifecycle = "accepted";
					return {
						ok: true,
						findings: reviewed.artifact.findings,
						summary: reviewed.artifact.summary,
						accepted: true,
						message:
							"No gated findings; the design is accepted. Submit the plan with submitPlan.",
					};
				}
				return {
					ok: true,
					findings: reviewed.artifact.findings,
					summary: reviewed.artifact.summary,
					accepted: false,
					message: `Disposition every critical and important finding with submitRevision.`,
				};
			},
		},
		submitRevision: {
			...realTools.submitRevision,
			execute: async (input: unknown) => {
				if (state.contract === null || state.reviews.length === 0) {
					return { error: "No reviewed draft exists to revise." };
				}
				const parsed = designRevisionResultSchemaFor(state.reviews).safeParse(
					stripNullProperties(input),
				);
				if (!parsed.success) return { error: issuesText(parsed.error) };
				const violations = validateSensitivityNotSilentlyLowered(
					state.contract,
					parsed.data,
				);
				if (violations.length > 0) {
					return { error: violations.join("\n") };
				}
				state.contract = parsed.data.contract;
				state.lifecycle = "accepted";
				state.reviews = [];
				write("contract-revised.json", parsed.data.contract);
				write("dispositions.json", parsed.data.dispositions);
				console.log("\n[submitRevision] accepted");
				return {
					ok: true,
					revisionId: crypto.randomUUID(),
					accepted: true,
					message:
						"The revision persisted as the accepted design. Submit the build plan with submitPlan.",
				};
			},
		},
		submitPlan: {
			...realTools.submitPlan,
			execute: async (input: unknown) => {
				if (state.contract === null || state.lifecycle !== "accepted") {
					return { error: "No accepted design exists to plan." };
				}
				const blocking = state.contract.openQuestions.filter(
					(question) => question.blocking,
				);
				if (blocking.length > 0) {
					return {
						error:
							"The accepted design carries blocking open questions; ask the user with askQuestions.",
					};
				}
				const draft = buildPlanDraftSchema.safeParse(
					stripNullProperties(input),
				);
				if (!draft.success) return { error: issuesText(draft.error) };
				const composed = {
					schemaVersion: 1 as const,
					designRevisionId: crypto.randomUUID(),
					designRevisionDigest: "0".repeat(64),
					id: crypto.randomUUID(),
					slices: draft.data.slices,
					externalActions: draft.data.externalActions,
					intentOwnership: draft.data.intentOwnership,
				};
				const plan = buildPlanSchemaFor(state.contract).safeParse(composed);
				if (!plan.success) return { error: issuesText(plan.error) };
				state.plan = plan.data;
				write("build-plan.json", plan.data);
				console.log(`\n[submitPlan] ${plan.data.slices.length} slices`);
				return {
					ok: true,
					planId: composed.id,
					message: "The design phase is complete.",
				};
			},
		},
	};

	const agent = createDesignAgent({
		model: ctx.model(DESIGN_MODEL),
		tools: tools as never,
		catalogText,
		constraintsText: renderPlatformConstraintsSection(),
		instructions: DESIGN_AGENT_SYSTEM,
		promptCacheKey: `nova:design-preview:${sessionId}`,
		fatalError: () => undefined,
		freshStateMessage: async () => ({
			role: "user",
			content:
				"# Design session state (server-derived)\n\nContinue from the durable preview state.",
		}),
		onStepEnd: (step) => {
			if (step.text) console.log(`\nNova: ${step.text}`);
		},
	});

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

	for (let turn = 0; turn < 8 && state.plan === null; turn += 1) {
		const result = await agent.stream({ prompt: messages });
		await result.consumeStream();
		const response = await result.response;
		messages = [...messages, ...response.messages];
		const toolCalls = await result.toolCalls;
		const pendingQuestions = toolCalls.filter(
			(call) => call.toolName === "askQuestions",
		);
		if (pendingQuestions.length === 0) break;
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
