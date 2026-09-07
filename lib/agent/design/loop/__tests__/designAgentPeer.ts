import type { ServerResponse } from "node:http";
import type { LanguageModel, ModelMessage } from "ai";
import { withResponsesPeer } from "@/lib/agent/__tests__/responsesPeer";
import { DesignRepairTracker } from "@/lib/agent/design/loop/gates";
import {
	computeSourcePackageDigest,
	type DesignSourcePackage,
} from "@/lib/agent/design/sourcePackage";
import { parseLookupRevision } from "@/lib/lookup/schema";
import { MODEL_ROLES } from "@/lib/models";
import { createDesignAgent, type DesignAgentArgs } from "../designAgent";
import {
	createDesignLoopTools,
	createDesignToolExecutionQueue,
	type DesignLoopToolDeps,
} from "../tools";

export type ProviderOutput =
	| { type: "text"; text: string }
	| { type: "tool"; name: string; input: unknown; callId: string }
	| { type: "compaction"; id: string; encryptedContent: string };
export interface ProviderRequest {
	model?: string;
	input?: Array<Record<string, unknown>>;
	tools?: Array<{
		name: string;
		strict?: boolean;
		parameters?: {
			additionalProperties?: boolean;
			required?: string[];
			properties?: Record<string, unknown>;
		};
	}>;
	tool_choice?: unknown;
	store?: boolean;
	include?: string[];
	reasoning?: { effort?: string; summary?: string };
	prompt_cache_key?: string;
	prompt_cache_options?: unknown;
	parallel_tool_calls?: boolean;
}

/** Only the provider's HTTP output is scripted. The installed OpenAI decoder
 * produces tool calls, opaque checkpoint parts, usage and step boundaries. */
function respond(
	response: ServerResponse,
	output: readonly ProviderOutput[],
	ordinal: number,
): void {
	response.writeHead(200, { "content-type": "text/event-stream" });
	const event = (value: unknown) =>
		response.write(`data: ${JSON.stringify(value)}\n\n`);
	event({
		type: "response.created",
		response: { id: `resp_${ordinal}`, created_at: 1, model: "offline-design" },
	});
	for (const [index, part] of output.entries()) {
		if (part.type === "compaction") {
			event({
				type: "response.output_item.done",
				output_index: index,
				item: {
					type: "compaction",
					id: part.id,
					encrypted_content: part.encryptedContent,
				},
			});
		} else if (part.type === "tool") {
			const id = `fc_${ordinal}_${index}`;
			const args = JSON.stringify(part.input);
			event({
				type: "response.output_item.added",
				output_index: index,
				item: {
					type: "function_call",
					id,
					call_id: part.callId,
					name: part.name,
					arguments: "",
				},
			});
			// Multiple chunks force actual provider argument assembly before validation.
			const split = Math.ceil(args.length / 2);
			for (const delta of [args.slice(0, split), args.slice(split)])
				event({
					type: "response.function_call_arguments.delta",
					item_id: id,
					output_index: index,
					delta,
				});
			event({
				type: "response.output_item.done",
				output_index: index,
				item: {
					type: "function_call",
					id,
					call_id: part.callId,
					name: part.name,
					arguments: args,
					status: "completed",
				},
			});
		} else {
			const id = `msg_${ordinal}_${index}`;
			event({
				type: "response.output_item.added",
				output_index: index,
				item: { type: "message", id },
			});
			event({
				type: "response.output_text.delta",
				item_id: id,
				delta: part.text,
			});
			event({
				type: "response.output_item.done",
				output_index: index,
				item: {
					type: "message",
					id,
					content: [{ type: "output_text", text: part.text, annotations: [] }],
				},
			});
		}
	}
	event({
		type: "response.completed",
		response: {
			usage: {
				input_tokens: 10,
				output_tokens: 5,
				input_tokens_details: { cached_tokens: 0 },
				output_tokens_details: { reasoning_tokens: 0 },
			},
			incomplete_details: null,
		},
	});
	response.end();
}

export async function withDesignResponses<T>(
	script: readonly (readonly ProviderOutput[])[],
	run: (
		model: LanguageModel,
		requests: ProviderRequest[],
		transport: typeof globalThis.fetch,
	) => Promise<T>,
): Promise<T> {
	const requests: ProviderRequest[] = [];
	const failures: unknown[] = [];
	return withResponsesPeer(
		(request, response) => {
			const chunks: Buffer[] = [];
			request.on("data", (chunk: Buffer) => chunks.push(chunk));
			request.on("end", () => {
				try {
					if (request.method !== "POST" || request.url !== "/v1/responses")
						throw new Error("Unexpected provider destination");
					const ordinal = requests.length;
					requests.push(JSON.parse(Buffer.concat(chunks).toString()));
					const output = script[ordinal];
					if (!output)
						throw new Error(`Unexpected provider call ${ordinal + 1}`);
					respond(response, output, ordinal);
				} catch (error) {
					failures.push(error);
					response.writeHead(400, { "content-type": "application/json" });
					response.end(
						JSON.stringify({
							error: { message: "Unexpected design peer request" },
						}),
					);
				}
			});
		},
		async (provider, transport) => {
			const result = await run(
				provider(MODEL_ROLES.designAuthor.modelId),
				requests,
				transport,
			);
			if (failures.length > 0)
				throw new AggregateError(failures, "Design provider peer failed");
			if (requests.length !== script.length)
				throw new Error(
					`Expected ${script.length} provider calls, received ${requests.length}`,
				);
			return result;
		},
	);
}

export const catalogInput = {
	tableId: null,
	query: null,
	columnIds: null,
	choiceProjection: null,
	cursor: null,
};

/** Registration is real. The Project-data callback is a controlled read
 * boundary used only to observe execution order, not an authority proof. */
export function wireAgent(
	model: LanguageModel,
	overrides: Partial<DesignAgentArgs> = {},
	inspect?: DesignLoopToolDeps["inspectProjectData"],
) {
	const base: Omit<DesignSourcePackage, "packageDigest"> = {
		schemaVersion: 1,
		designSessionId: "00000000-0000-4000-8000-000000000002",
		projectId: "design-wire-project",
		request: {
			blocks: [
				{
					ref: {
						kind: "message",
						threadId: "00000000-0000-4000-8000-000000000001",
						messageId: "m1",
						partIndex: 0,
					},
					text: "Build it.",
					truncated: false,
				},
			],
		},
		claims: [],
		attachments: [],
		images: [],
		platformConstraints: [],
		sources: [
			{
				ref: {
					kind: "message",
					threadId: "00000000-0000-4000-8000-000000000001",
					messageId: "m1",
					partIndex: 0,
				},
			},
		],
	};
	const pkg: DesignSourcePackage = {
		...base,
		packageDigest: computeSourcePackageDigest(base),
	};
	const queue = createDesignToolExecutionQueue();
	const tools = createDesignLoopTools(
		{
			designSessionId: pkg.designSessionId,
			runId: "wire-run",
			authority: {
				actorUserId: "wire-actor",
				runId: "wire-run",
				holderNonce: "00000000-0000-4000-8000-000000000003",
				expectedProjectId: pkg.projectId,
			},
			currentPkg: pkg,
			catalogText: "CATALOG",
			ctx: {
				userId: "wire-actor",
				projectId: pkg.projectId,
				runId: "wire-run",
				target: {
					kind: "design-session",
					designSessionId: pkg.designSessionId,
				},
				model: () => model,
				trackSubGeneration: () => {},
				runStructured: async () => {
					throw new Error("This agent-factory test does not run a reviewer");
				},
			},
			signal: new AbortController().signal,
			repair: new DesignRepairTracker(),
			loadAncestry: async () => {
				throw new Error("This agent-factory test does not mutate a workspace");
			},
			ancestryChanged: () => {},
			rebuildPackageForDigest: async () => null,
			inspectProjectData:
				inspect ??
				(async () => ({
					kind: "catalog",
					projectRevision: parseLookupRevision("0"),
					tables: [],
					complete: true,
				})),
			validateProjectLookupEvidence: async () => [],
		},
		queue,
	);
	return createDesignAgent({
		model,
		tools,
		toolExecutionQueue: queue,
		phase: "author",
		catalogText: "CATALOG",
		constraintsText: "CONSTRAINTS",
		instructions: "You are Nova's designer.",
		promptCacheKey: "nova:design:session-probe",
		fatalError: () => undefined,
		requiredUserQuestions: () => [],
		freshStateMessage: async () => ({
			role: "user",
			content: "# Design session state (server-derived)\nworkspace revision 4",
		}),
		stepsBeforeStream: 0,
		contextGeneration: 0,
		...overrides,
	});
}

export async function consumeDesignAgent(
	agent: ReturnType<typeof createDesignAgent>,
	prompt: ModelMessage[] = [{ role: "user", content: "Build it." }],
	observe?: (part: {
		type: string;
		toolCallId?: string;
		toolName?: string;
	}) => void,
) {
	const result = await agent.stream({ prompt });
	const failures: unknown[] = [];
	await result.fullStream.pipeTo(
		new WritableStream({
			write(part) {
				observe?.(part);
				if (part.type === "error") failures.push(part.error);
			},
		}),
	);
	if (failures.length > 0)
		throw new AggregateError(failures, "The design agent stream failed");
	return {
		steps: await result.steps,
		finishReason: await result.finishReason,
		text: await result.text,
	};
}
