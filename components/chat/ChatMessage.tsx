"use client";
import type { ToolUIPart, UIMessage } from "ai";
import { useRef } from "react";
import {
	Attachment,
	AttachmentInfo,
	AttachmentPreview,
	Attachments,
} from "@/components/ai-elements/attachments";
import { Message, MessageContent } from "@/components/ai-elements/message";
import {
	Reasoning,
	ReasoningContent,
	ReasoningTrigger,
} from "@/components/ai-elements/reasoning";
import {
	Tool,
	ToolContent,
	ToolHeader,
	ToolInput,
	ToolOutput,
} from "@/components/ai-elements/tool";
import { AskQuestionsCard } from "@/components/chat/AskQuestionsCard";
import { ChatMarkdown } from "@/lib/markdown";

interface ChatMessageProps {
	message: UIMessage;
	addToolOutput: (params: {
		tool: string;
		toolCallId: string;
		output: unknown;
	}) => void;
	pendingAnswerRef?: React.MutableRefObject<((text: string) => void) | null>;
	/** Set by ChatSidebar for the last message while the SSE stream is open.
	 *  Drives the reasoning panel's "Thinking…" shimmer — see the reasoning
	 *  branch below, which narrows it to "the trailing part is still reasoning"
	 *  so the shimmer stops the instant the model emits its first answer token. */
	isStreaming?: boolean;
}

export function ChatMessage({
	message,
	addToolOutput,
	pendingAnswerRef,
	isStreaming,
}: ChatMessageProps) {
	const isUser = message.role === "user";

	/**
	 * Stable ID map for text parts. The AI SDK's UIMessage text parts have no
	 * intrinsic identifier — tool parts have `toolCallId`, but text parts are
	 * anonymous. This ref assigns a unique ID to each text part on first
	 * observation. Since parts are append-only within a message (never reordered
	 * or removed), each ID stays paired with the same part for the component's
	 * lifetime. IDs use `message.id` as a namespace for global uniqueness.
	 */
	const textPartIds = useRef<string[]>([]);

	/* Counter tracks how many text parts we've seen so far in this render pass,
	 * to pair each text part with its stable ID from the ref. */
	let textPartOrdinal = 0;

	/* The model can interleave several `reasoning` parts within one assistant
	 * turn (one per thinking burst). AI Elements' convention is a single
	 * Reasoning panel per turn, so we join every reasoning part's text and
	 * render the consolidated block at the position of the FIRST reasoning part,
	 * returning null for the rest. Doing it inline (rather than a pre-pass) keeps
	 * the panel in its natural transcript position relative to text/tool parts. */
	const consolidatedReasoning = message.parts
		.filter((part) => part.type === "reasoning")
		.map((part) => part.text)
		.join("\n\n");
	let reasoningRendered = false;

	/* Index of the trailing part — used to detect whether the turn is still
	 * mid-thought (last part is reasoning) so the shimmer only runs then. */
	const lastPart = message.parts.at(-1);
	const reasoningIsStreaming =
		Boolean(isStreaming) && lastPart?.type === "reasoning";

	return (
		<Message from={message.role}>
			<MessageContent>
				{message.parts.map((part, partIndex) => {
					if (part.type === "text") {
						const text = part.text.trim();
						/* Assign a stable ID to this text part if it doesn't have one yet.
						 * Ordinal maps to the Nth text part in the message — stable because
						 * parts are append-only and we only count text parts. */
						const idx = textPartOrdinal++;
						if (idx >= textPartIds.current.length) {
							textPartIds.current.push(crypto.randomUUID());
						}
						if (!text) return null;
						/* MessageContent already supplies the user bubble chrome (rounded
						 * border + surface fill) and renders assistant text as unwrapped
						 * prose, so we emit content only — wrapping here would double-bubble
						 * the user turn and fight the re-skin on the assistant turn. */
						return isUser ? (
							<div
								key={textPartIds.current[idx]}
								className="whitespace-pre-wrap break-words"
							>
								{text}
							</div>
						) : (
							<div key={textPartIds.current[idx]} className="chat-markdown">
								<ChatMarkdown>{text}</ChatMarkdown>
							</div>
						);
					}

					if (part.type === "file") {
						/* User attachments echoed back into the transcript. The server
						 * condenses the file's CONTENT before it reaches the model, but the
						 * chip shows the original filename the user attached. AttachmentData
						 * requires an `id`; the file part carries none, so we synthesize a
						 * stable one from the message id + part index (inert here — list
						 * variant has no remove affordance, the id just keys the chip). */
						const data = {
							...part,
							id: `${message.id}-file-${partIndex}`,
						};
						return (
							<Attachments key={data.id} variant="list">
								<Attachment data={data}>
									<AttachmentPreview />
									<AttachmentInfo />
								</Attachment>
							</Attachments>
						);
					}

					if (part.type === "reasoning") {
						/* Render the consolidated panel once, at the first reasoning part. */
						if (reasoningRendered || !consolidatedReasoning.trim()) return null;
						reasoningRendered = true;
						return (
							<Reasoning
								key={`${message.id}-reasoning`}
								isStreaming={reasoningIsStreaming}
							>
								<ReasoningTrigger />
								<ReasoningContent>{consolidatedReasoning}</ReasoningContent>
							</Reasoning>
						);
					}

					if (part.type === "tool-askQuestions") {
						return (
							<AskQuestionsCard
								key={part.toolCallId}
								toolCallId={part.toolCallId}
								input={
									part.input as {
										header: string;
										questions: {
											question: string;
											options: { label: string; description?: string }[];
										}[];
									}
								}
								state={part.state}
								output={
									part.state === "output-available"
										? (part.output as Record<string, string>)
										: undefined
								}
								addToolOutput={addToolOutput}
								pendingAnswerRef={pendingAnswerRef}
							/>
						);
					}

					/* Generation tools own their feedback elsewhere — the signal grid
					 * (live energy) and GenerationProgress (staged status). Rendering a
					 * tool card for them would duplicate that surface, so they're elided. */
					if (
						part.type === "tool-generateSchema" ||
						part.type === "tool-generateScaffold"
					) {
						return null;
					}

					/* Every remaining tool-* part is an edit/mutation tool (edit mode):
					 * surface it as a collapsible Tool card. `startsWith` doesn't narrow
					 * the discriminated union, so we cast to ToolUIPart to read the
					 * toolCallId / input / state / output / errorText fields. */
					if (part.type.startsWith("tool-")) {
						const toolPart = part as ToolUIPart;
						return (
							<Tool key={toolPart.toolCallId}>
								<ToolHeader type={toolPart.type} state={toolPart.state} />
								<ToolContent>
									<ToolInput input={toolPart.input} />
									<ToolOutput
										output={
											typeof toolPart.output === "string" ? (
												<ChatMarkdown>{toolPart.output}</ChatMarkdown>
											) : undefined
										}
										errorText={
											toolPart.state === "output-error"
												? toolPart.errorText
												: undefined
										}
									/>
								</ToolContent>
							</Tool>
						);
					}

					/* Non-rendered parts: data-* events, step-start, etc. */
					return null;
				})}
			</MessageContent>
		</Message>
	);
}
