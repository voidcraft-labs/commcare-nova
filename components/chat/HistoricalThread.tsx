/**
 * HistoricalThread — collapsible rendering of a dead conversation thread.
 *
 * Displays in the chat sidebar above the active thread area. Collapsed by
 * default — shows a single row with thread type, date, and message count.
 * Expanding reveals all messages in muted historical styling.
 *
 * 320px sidebar constraint drives the design: collapsed is compact, expanded
 * scrolls naturally within the existing scroll container.
 */
"use client";

import { Icon } from "@iconify/react/offline";
import tablerChevronDown from "@iconify-icons/tabler/chevron-down";
import tablerChevronRight from "@iconify-icons/tabler/chevron-right";
import tablerMessage from "@iconify-icons/tabler/message";
import { useState } from "react";
import { HistoricalMessage } from "@/components/chat/HistoricalMessage";
import type { ThreadDoc } from "@/lib/db/types";

interface HistoricalThreadProps {
	thread: ThreadDoc;
}

/** Format an ISO date string into a short human-readable label. */
function formatThreadDate(isoDate: string): string {
	const date = new Date(isoDate);
	const now = new Date();
	const diffMs = now.getTime() - date.getTime();
	const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

	if (diffDays === 0) return "Today";
	if (diffDays === 1) return "Yesterday";
	if (diffDays < 7) return `${diffDays}d ago`;

	return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** Human-readable thread type label. */
function threadTypeLabel(type: ThreadDoc["thread_type"]): string {
	return type === "build" ? "Initial Build" : "Edit";
}

export function HistoricalThread({ thread }: HistoricalThreadProps) {
	const [expanded, setExpanded] = useState(false);
	const messageCount = thread.messages.length;

	return (
		<div className="group">
			{/* Collapsed header — always visible */}
			<button
				type="button"
				onClick={() => setExpanded((prev) => !prev)}
				className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left transition-colors hover:bg-nova-surface/40 cursor-pointer"
			>
				<Icon
					icon={expanded ? tablerChevronDown : tablerChevronRight}
					width="12"
					height="12"
					className="shrink-0 text-nova-text-muted"
				/>
				<Icon
					icon={tablerMessage}
					width="13"
					height="13"
					className="shrink-0 text-nova-text-muted"
				/>
				<span className="flex-1 truncate text-xs text-nova-text-muted">
					{threadTypeLabel(thread.thread_type)} —{" "}
					{formatThreadDate(thread.created_at)}
				</span>
				<span className="shrink-0 text-[10px] text-nova-text-muted tabular-nums">
					{messageCount}
				</span>
			</button>

			{/* Expanded messages — muted historical rendering */}
			{expanded && (
				<div className="mt-1 mb-2 space-y-2 pl-2">
					{thread.messages.map((msg) => (
						<HistoricalMessage key={msg.id} message={msg} />
					))}
				</div>
			)}
		</div>
	);
}
