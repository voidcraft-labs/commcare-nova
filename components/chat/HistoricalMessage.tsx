/**
 * HistoricalMessage — read-only muted rendering of a stored chat message.
 *
 * Used inside HistoricalThread to display dead conversation messages.
 * All interactive elements are stripped: askQuestions renders as a static
 * completed QuestionCard (same violet border card, check icons, Q&A pairs).
 * Visual treatment is muted — the parent wrapper applies opacity-60 so
 * everything reads as ghosted historical content.
 */

import { Icon } from "@iconify/react/offline";
import tablerCheck from "@iconify-icons/tabler/check";
import type { StoredMessagePart, StoredThreadMessage } from "@/lib/db/types";
import { ChatMarkdown } from "@/lib/markdown";

interface HistoricalMessageProps {
	message: StoredThreadMessage;
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

	/* askQuestions — completed QuestionCard visual: same violet border card
	 * with check icons and Q&A pairs, ghosted by the parent's opacity-60. */
	return (
		<div className="rounded-xl border border-nova-violet/20 bg-nova-violet/5 overflow-hidden">
			<div className="px-3.5 py-2.5 border-b border-nova-violet/10">
				<p className="text-sm font-medium text-nova-text-secondary mt-0.5">
					{part.header}
				</p>
			</div>
			<div className="px-3.5 py-3 space-y-3">
				{part.questions.map((qa, idx) => (
					<div
						// biome-ignore lint/suspicious/noArrayIndexKey: static stored array, never reordered
						key={idx}
						className="flex items-start gap-2 text-xs"
					>
						<Icon
							icon={tablerCheck}
							width="14"
							height="14"
							className="mt-0.5 shrink-0"
							style={{ color: "var(--nova-emerald)" }}
						/>
						<div>
							<span className="text-nova-text-muted">{qa.question}</span>
							<span className="ml-1.5 text-nova-text">{qa.answer}</span>
						</div>
					</div>
				))}
			</div>
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
