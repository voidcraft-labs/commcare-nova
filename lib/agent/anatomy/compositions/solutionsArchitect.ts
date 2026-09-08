/**
 * The Solutions Architect: one tool-loop agent over the full thread history,
 * a static prompt, the shared tool set, and a fresh app-state snapshot at the
 * end of every turn.
 *
 * The history runs through the chat route's own pipeline, with one
 * substitution: attachment references become placeholder parts instead of
 * stored extracts, because resolving them can claim an extraction job and
 * run a model, which a page must never do.
 */

import {
	convertToModelMessages,
	type ModelMessage,
	tool,
	validateUIMessages,
} from "ai";
import { wrapAttachment } from "@/lib/agent/documentExtraction";
import {
	buildAppStateMessage,
	buildSolutionsArchitectPrompt,
	markStablePrefixBoundary,
	SOLUTIONS_ARCHITECT_SEGMENTS,
} from "@/lib/agent/prompts";
import { solutionsArchitectToolDefinitions } from "@/lib/agent/solutionsArchitect";
import { buildTurnRetryContinuation } from "@/lib/agent/turnRetry";
import type { NovaUIMessage } from "@/lib/chat/attachmentRefs";
import { projectCompatibleCompactedHistory } from "@/lib/chat/compaction";
import { sanitizeHistoricalReasoningParts } from "@/lib/chat/sanitizeReasoningParts";
import { sanitizeHistoricalToolParts } from "@/lib/chat/sanitizeToolParts";
import { MODEL_ROLES } from "@/lib/models";
import type {
	AppInput,
	ContextItem,
	MomentSpec,
	RoleComposition,
} from "../types";
import {
	compactionItem,
	messageHasCacheBoundary,
	messageHasCompaction,
	messageItem,
	messageLead,
	missingItem,
	moment,
	segmentViews,
	specById,
	systemItem,
	toolsItem,
	toolViews,
} from "./shared";

const ROUTE = { file: "app/api/chat/route.ts", symbol: "POST" };
const PROMPTS = "lib/agent/prompts.ts";

const MOMENTS: readonly MomentSpec[] = [
	{
		id: "next-turn",
		label: "Next turn",
		why: "What the architect receives if the user sends a message now: the sanitized thread, a cache boundary on the deepest stable user item, then a fresh app-state snapshot.",
		needs: ["app"],
		source: ROUTE,
	},
	{
		id: "provider-retry",
		label: "Retry after a provider fault",
		why: "A mid-stream provider error re-drives the whole turn inside the same request. The app-state snapshot is replaced by one continuation that carries the committed state.",
		needs: ["app"],
		source: {
			file: "lib/agent/turnRetry.ts",
			symbol: "buildTurnRetryContinuation",
		},
	},
	{
		id: "redrive",
		label: "Redrive after the instance died",
		why: "A fresh run over the same turn after a deploy or OOM. Same shape as a retry; the continuation names the interruption differently.",
		needs: ["app"],
		source: {
			file: "lib/agent/turnRetry.ts",
			symbol: "buildTurnRetryContinuation",
		},
	},
	{
		id: "after-compaction",
		label: "After a compaction, same turn",
		why: "When the provider compacts mid-turn, the next step starts at the checkpoint. Nova appends nothing: the app-state snapshot is behind the boundary until the next request re-appends it.",
		needs: [],
		source: {
			file: "lib/chat/compaction.ts",
			symbol: "projectModelHistoryFromNewestCompaction",
		},
	},
];

function placeholderAttachments(
	messages: readonly NovaUIMessage[],
): NovaUIMessage[] {
	return messages.map((message) => {
		const refs = message.metadata?.attachments ?? [];
		if (refs.length === 0) return message;
		return {
			...message,
			parts: [
				...message.parts,
				...refs.map((ref) => ({
					type: "text" as const,
					text: wrapAttachment(
						ref.filename,
						`(${ref.kind} ${ref.assetId}: at send time this part carries the stored extract or the image bytes. The anatomy page does not load them.)`,
					),
				})),
			],
		};
	});
}

/** The route's pipeline over a thread, with definition-only tools and
 * placeholder attachments. Returns the converted history with the cache
 * boundary marked, but without the app-state tail. */
export async function projectArchitectHistory(
	messages: readonly NovaUIMessage[],
): Promise<ModelMessage[]> {
	/* Definition-only tools: the same description, schema, and strictness
	 * the architect mounts, with no execute. Validation and conversion read
	 * only the schema, so the widening the sanitizer performs is behavior-safe. */
	const tools = Object.fromEntries(
		Object.entries(solutionsArchitectToolDefinitions()).map(
			([name, definition]) => [
				name,
				tool({
					description: definition.description,
					inputSchema: definition.inputSchema,
					strict: definition.strict,
				}),
			],
		),
	) as Parameters<typeof validateUIMessages>[0]["tools"] &
		Parameters<typeof sanitizeHistoricalToolParts>[1];
	const model = MODEL_ROLES.followUpEditor.modelId;
	const prepared = placeholderAttachments(messages);
	const sanitized = await sanitizeHistoricalToolParts(prepared, tools);
	const reasoningSafe = sanitizeHistoricalReasoningParts(sanitized, model);
	const effective = projectCompatibleCompactedHistory(reasoningSafe, model);
	const validated = await validateUIMessages({ messages: effective, tools });
	return markStablePrefixBoundary(
		await convertToModelMessages(validated, { tools }),
	);
}

function historyItems(history: readonly ModelMessage[]): ContextItem[] {
	return history.map((message, index) => {
		const id = `history:${index}`;
		if (messageHasCompaction(message)) {
			return compactionItem({
				id,
				source: {
					file: "lib/chat/compaction.ts",
					symbol: "projectCompatibleCompactedHistory",
				},
				origin: "derived",
				note: "The thread carried a compatible checkpoint from an earlier turn, so the history starts here.",
			});
		}
		const boundary = messageHasCacheBoundary(message);
		return messageItem({
			id,
			label: messageLead(message, `${message.role} message`),
			message,
			source: ROUTE,
			origin: "derived",
			cacheBoundary: boundary,
			...(boundary && {
				note: "The explicit prompt-cache boundary: the provider writes a reusable entry here, before the volatile tail.",
			}),
		});
	});
}

async function threadItems(app: AppInput | undefined): Promise<ContextItem[]> {
	if (app?.thread === undefined) {
		return [
			missingItem({
				id: "history",
				label: "Thread history",
				needs: "app",
				explanation:
					app === undefined
						? "Pick a local app to see its newest thread run through the route's pipeline: tool-part repair, reasoning-part policy, compaction projection, validation, conversion, and the cache boundary."
						: "This app has no chat thread yet. The first edit turn would carry only the user's message here.",
				source: ROUTE,
			}),
		];
	}
	return historyItems(await projectArchitectHistory(app.thread.messages));
}

function appStateItem(app: AppInput | undefined): ContextItem {
	const message = app === undefined ? null : buildAppStateMessage(app.doc);
	if (message === null) {
		return missingItem({
			id: "app-state",
			label: "App state snapshot",
			needs: "app",
			explanation:
				"Pick a local app to render the per-turn summary the route appends after the history: the same summarizer the retry continuation and the MCP edit prompt use.",
			source: { file: PROMPTS, symbol: "buildAppStateMessage" },
		});
	}
	return messageItem({
		id: "app-state",
		label: "App state snapshot",
		message,
		source: { file: PROMPTS, symbol: "buildAppStateMessage" },
		origin: "derived",
		note: "Rendered fresh from the doc on every request and never stored in the thread, so each turn carries exactly one snapshot.",
	});
}

function continuationItem(
	app: AppInput | undefined,
	cause: "provider-retry" | "redrive",
): ContextItem {
	const message =
		app === undefined ? null : buildTurnRetryContinuation(app.doc, cause);
	const source = {
		file: "lib/agent/turnRetry.ts",
		symbol: "buildTurnRetryContinuation",
	};
	if (message === null) {
		return missingItem({
			id: "retry-continuation",
			label: "Retry continuation",
			needs: "app",
			explanation:
				app === undefined
					? "Pick a local app to render the continuation: the committed-state summary plus the instruction to continue rather than restart."
					: "This app has nothing committed, so a retry re-runs the base prompt with no continuation.",
			source,
		});
	}
	return messageItem({
		id: "retry-continuation",
		label: "Retry continuation",
		message,
		source,
		origin: "derived",
		note: "Replaces the app-state snapshot: the model must see exactly one authoritative state.",
	});
}

export const solutionsArchitectComposition: RoleComposition = {
	role: "solutions-architect",
	moments: MOMENTS,
	async compose(momentId, inputs) {
		const spec = specById(MOMENTS, momentId, "solutions architect");
		const system = systemItem({
			text: buildSolutionsArchitectPrompt(),
			segments: segmentViews(
				SOLUTIONS_ARCHITECT_SEGMENTS,
				PROMPTS,
				"SOLUTIONS_ARCHITECT_SEGMENTS",
			),
			source: { file: PROMPTS, symbol: "buildSolutionsArchitectPrompt" },
			note: "Static on every turn and every app. The provider's exact-prefix cache keys on it.",
		});
		const tools = toolsItem({
			tools: await toolViews(solutionsArchitectToolDefinitions()),
			source: {
				file: "lib/agent/solutionsArchitect.ts",
				symbol: "solutionsArchitectToolDefinitions",
			},
			note: "askQuestions first, then every shared registry tool through the chat wire projection. strict: false on all of them.",
		});
		switch (spec.id) {
			case "next-turn":
				return moment(spec, [
					system,
					tools,
					...(await threadItems(inputs.app)),
					appStateItem(inputs.app),
				]);
			case "provider-retry":
			case "redrive":
				return moment(spec, [
					system,
					tools,
					...(await threadItems(inputs.app)),
					continuationItem(inputs.app, spec.id),
				]);
			case "after-compaction":
				return moment(spec, [
					system,
					tools,
					compactionItem({
						id: "history:compaction",
						source: spec.source,
						origin: "composed",
						note: "The provider's checkpoint replaces the history and the app-state snapshot alike. Only the provider knows where it fell.",
					}),
					missingItem({
						id: "history:suffix",
						label: "Steps since the checkpoint",
						needs: "live-call",
						explanation:
							"The tool calls and results this turn produced after the boundary, kept in provider order. The architect's wire is not persisted, so only a live turn shows them; Nova appends no state packet here.",
						source: spec.source,
					}),
				]);
			default:
				throw new Error(`Unhandled solutions architect moment ${spec.id}.`);
		}
	},
};
