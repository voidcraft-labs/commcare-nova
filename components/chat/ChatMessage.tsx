"use client";
import type { UIMessage } from "ai";
import { useRef } from "react";
import { QuestionCard } from "@/components/chat/QuestionCard";
import { ChatMarkdown } from "@/lib/markdown";

interface ChatMessageProps {
	message: UIMessage;
	addToolOutput: (params: {
		tool: string;
		toolCallId: string;
		output: unknown;
	}) => void;
	pendingAnswerRef?: React.MutableRefObject<((text: string) => void) | null>;
}

export function ChatMessage({
	message,
	addToolOutput,
	pendingAnswerRef,
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

	return (
		<>
			{message.parts.map((part) => {
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
					return (
						<div
							key={textPartIds.current[idx]}
							className={`rounded-xl px-3.5 py-2.5 text-sm leading-relaxed ${
								isUser
									? "bg-nova-violet/15 text-nova-text border border-nova-violet/10"
									: "bg-nova-surface text-nova-text-secondary border border-nova-border"
							}`}
						>
							{isUser ? (
								<div className="whitespace-pre-wrap break-words">{text}</div>
							) : (
								<div className="chat-markdown">
									<ChatMarkdown>{text}</ChatMarkdown>
								</div>
							)}
						</div>
					);
				}

				if (part.type === "tool-askQuestions") {
					return (
						<QuestionCard
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

				// Non-chat parts (tool-generateApp, tool-editApp, data-*, etc.) are handled by BuilderLayout
				return null;
			})}
		</>
	);
}
