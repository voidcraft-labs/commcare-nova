"use client";
import type { ToolUIPart } from "ai";
import type { ReactNode } from "react";
import { useRef } from "react";
import { Message, MessageContent } from "@/components/ai-elements/message";
import {
	Reasoning,
	ReasoningContent,
	ReasoningTrigger,
} from "@/components/ai-elements/reasoning";
import { AskQuestionsCard } from "@/components/chat/AskQuestionsCard";
import { MessageAttachments } from "@/components/chat/MessageAttachments";
import { ToolRunSummary } from "@/components/chat/ToolRunSummary";
import type { NovaUIMessage } from "@/lib/chat/attachmentRefs";
import { isEditToolPart } from "@/lib/chat/toolSummary";
import { ChatMarkdown } from "@/lib/markdown";

interface ChatMessageProps {
	message: NovaUIMessage;
	addToolOutput: (params: {
		tool: string;
		toolCallId: string;
		output: unknown;
	}) => void;
	pendingAnswerRef?: React.MutableRefObject<((text: string) => void) | null>;
	/** Set by ChatSidebar for the last message while the SSE stream is open.
	 *  Drives the reasoning panel's "Thinking…" shimmer — narrowed below to "the
	 *  trailing part is still reasoning" so the shimmer stops the instant the model
	 *  emits its first answer token. */
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
	 * Stable ID map for text parts. UIMessage text parts have no intrinsic
	 * identifier (tool parts have `toolCallId`, text parts are anonymous). This ref
	 * assigns a unique ID to each text part on first observation; since parts are
	 * append-only within a message, each ID stays paired with its part for the
	 * component's lifetime. The ordinal counts only text parts, so grouping the
	 * tool parts below doesn't disturb it.
	 */
	const textPartIds = useRef<string[]>([]);
	let textPartOrdinal = 0;

	/* Reasoning is relevant to the work that FOLLOWS it (think → act → think
	 * again), so each burst renders at its own position rather than being hoisted
	 * into one block at the top. The trailing burst of an in-flight message is the
	 * only one still streaming — its trigger shimmers "Thinking…"; once the model
	 * emits its next part the burst is complete. */
	const lastPart = message.parts.at(-1);
	const trailingReasoningIsStreaming =
		Boolean(isStreaming) && lastPart?.type === "reasoning";

	/*
	 * Walk the parts once, grouping each CONSECUTIVE run of one kind:
	 *   - edit-tool calls collapse into one ToolRunSummary ("N changes") so a
	 *     large build's dozens of addFields don't flood the transcript;
	 *   - reasoning bursts collapse into one Reasoning panel at their position
	 *     (consecutive parts = one burst the SDK split across deltas).
	 * Switching kind — or hitting text / attachments / askQuestions — flushes the
	 * open run first, preserving the model's narrative order
	 * (think → "3 changes" → text → think → "4 changes"). Generation tools and
	 * bookkeeping parts (data-*, step-start) are elided: the signal grid +
	 * GenerationProgress own build-mode feedback.
	 */
	const items: ReactNode[] = [];
	/* Attachment chips lead the message — the files the user attached, each
	 * opening the Document / What-Nova-reads preview. Read off the message
	 * metadata (the one `AttachmentRef` shape live, replay, and thread history
	 * all populate), so there's a single render path regardless of source. */
	const attachments = message.metadata?.attachments;
	if (attachments && attachments.length > 0) {
		items.push(
			<MessageAttachments
				key={`${message.id}-attachments`}
				attachments={attachments}
			/>,
		);
	}
	let toolRun: ToolUIPart[] = [];
	let reasoningRun: string[] = [];
	let reasoningRunKey: string | null = null;

	const flushTools = () => {
		if (toolRun.length > 0) {
			const parts = toolRun;
			items.push(
				<ToolRunSummary key={`run-${parts[0].toolCallId}`} parts={parts} />,
			);
			toolRun = [];
		}
	};

	/* `streaming` is true only for the trailing burst of an in-flight message — a
	 * mid-message burst the loop flushes because tool/text follows it has already
	 * finished. Panels are collapsed by default; `defaultOpen={false}` also
	 * suppresses the component's auto-open-while-streaming, so an active burst
	 * stays tucked away (its trigger shimmers) until the user expands it. */
	const flushReasoning = (streaming = false) => {
		if (reasoningRun.length === 0 || !reasoningRunKey) return;
		const text = reasoningRun.join("\n\n");
		const key = reasoningRunKey;
		reasoningRun = [];
		reasoningRunKey = null;
		if (!text.trim()) return;
		items.push(
			<Reasoning defaultOpen={false} isStreaming={streaming} key={key}>
				<ReasoningTrigger />
				<ReasoningContent>{text}</ReasoningContent>
			</Reasoning>,
		);
	};

	for (const [partIndex, part] of message.parts.entries()) {
		if (isEditToolPart(part)) {
			flushReasoning();
			toolRun.push(part as ToolUIPart);
			continue;
		}
		if (part.type === "reasoning") {
			flushTools();
			reasoningRunKey ??= `${message.id}-reasoning-${partIndex}`;
			reasoningRun.push(part.text);
			continue;
		}
		flushTools();
		flushReasoning();

		if (part.type === "text") {
			/* Assign/reuse this text part's stable id (ordinal = Nth text part). */
			const idx = textPartOrdinal++;
			if (idx >= textPartIds.current.length) {
				textPartIds.current.push(crypto.randomUUID());
			}
			const text = part.text.trim();
			if (!text) continue;
			/* MessageContent supplies the user bubble chrome and renders assistant
			 * text as unwrapped prose, so we emit content only. */
			items.push(
				isUser ? (
					<div
						className="whitespace-pre-wrap break-words"
						key={textPartIds.current[idx]}
					>
						{text}
					</div>
				) : (
					<div className="chat-markdown" key={textPartIds.current[idx]}>
						<ChatMarkdown>{text}</ChatMarkdown>
					</div>
				),
			);
			continue;
		}

		if (part.type === "tool-askQuestions") {
			items.push(
				<AskQuestionsCard
					addToolOutput={addToolOutput}
					input={
						part.input as {
							header: string;
							questions: {
								question: string;
								options: { label: string; description?: string }[];
							}[];
						}
					}
					key={part.toolCallId}
					output={
						part.state === "output-available"
							? (part.output as Record<string, string>)
							: undefined
					}
					pendingAnswerRef={pendingAnswerRef}
					state={part.state}
					toolCallId={part.toolCallId}
				/>,
			);
		}

		/* tool-generateSchema / tool-generateScaffold, data-* events, step-start,
		 * etc. render nothing here. */
	}
	flushTools();
	flushReasoning(trailingReasoningIsStreaming);

	return (
		<Message from={message.role}>
			<MessageContent>{items}</MessageContent>
		</Message>
	);
}
