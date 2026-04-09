/**
 * HistoricalMessage — read-only muted rendering of a stored chat message.
 *
 * Used inside HistoricalThread to display dead conversation messages.
 * All interactive elements are stripped: askQuestions renders as static
 * Q&A pairs, not interactive QuestionCards. Visual treatment is muted —
 * no violet accent on user bubbles, everything in text-nova-text-muted.
 */

import type { StoredMessagePart, StoredThreadMessage } from "@/lib/db/types";
import { ChatMarkdown } from "@/lib/markdown";

interface HistoricalMessageProps {
	message: StoredThreadMessage;
}

/** Render a single Q&A pair from a completed askQuestions block. */
function AnsweredQuestion({
	question,
	answer,
}: {
	question: string;
	answer: string;
}) {
	return (
		<div className="flex flex-col gap-0.5">
			<span className="text-nova-text-muted text-xs">{question}</span>
			<span className="text-nova-text-secondary text-xs font-medium">
				{answer}
			</span>
		</div>
	);
}

/** Render a stored message part in its muted historical form. */
function HistoricalPart({ part }: { part: StoredMessagePart }) {
	if (part.type === "text") {
		return (
			<div className="chat-markdown text-nova-text-muted">
				<ChatMarkdown>{part.text}</ChatMarkdown>
			</div>
		);
	}

	/* askQuestions — compact Q&A summary, no interactive card. */
	return (
		<div className="flex flex-col gap-1.5 rounded-lg border border-nova-border/50 bg-nova-surface/30 px-3 py-2">
			<span className="text-nova-text-muted text-xs font-medium">
				{part.header}
			</span>
			{part.questions.map((qa, idx) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: static stored array, never reordered
				<AnsweredQuestion key={idx} question={qa.question} answer={qa.answer} />
			))}
		</div>
	);
}

export function HistoricalMessage({ message }: HistoricalMessageProps) {
	const isUser = message.role === "user";

	return (
		<>
			{message.parts.map((part, idx) => (
				<div
					// biome-ignore lint/suspicious/noArrayIndexKey: parts lack unique IDs, append-only array
					key={idx}
					className={`rounded-xl px-3.5 py-2 text-sm leading-relaxed opacity-60 ${
						isUser
							? "bg-nova-surface/40 text-nova-text-muted border border-nova-border/40"
							: "bg-transparent"
					}`}
				>
					<HistoricalPart part={part} />
				</div>
			))}
		</>
	);
}
