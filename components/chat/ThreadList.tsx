/**
 * ThreadList — the conversations view of the chat rail.
 *
 * First-class thread rows: every conversation about this app, most recently
 * active first, clickable back into. Replaces the conversation region while
 * open (ChatSidebar owns the open/close state and the header's back
 * affordance). A row shows what a person needs to pick a conversation —
 * its opening request, how old it is, how much was said — and two live
 * signals: the violet dot marks the OPEN conversation, the pulsing LIVE
 * badge marks one with a run streaming right now (its row resumes the
 * stream on open).
 */
"use client";

import { Icon } from "@iconify/react/offline";
import tablerMessage from "@iconify-icons/tabler/message";
import tablerSparkles from "@iconify-icons/tabler/sparkles";
import type { ThreadMeta } from "@/lib/db/types";
import { formatRelativeDate } from "@/lib/utils/format";

interface ThreadListProps {
	threads: ThreadMeta[];
	/** The conversation currently open in the rail (the Chat instance's id). */
	activeThreadId: string;
	/** True while the OPEN conversation's stream is live in this tab — lights
	 *  its LIVE badge even before the server-side marker round-trips. */
	activeThreadStreaming: boolean;
	onSelect: (threadId: string) => void;
}

export function ThreadList({
	threads,
	activeThreadId,
	activeThreadStreaming,
	onSelect,
}: ThreadListProps) {
	if (threads.length === 0) {
		return (
			<div className="flex-1 min-h-0 flex items-center justify-center px-6">
				<p className="text-sm text-nova-text-muted text-center leading-relaxed">
					No conversations yet. Send a message to start one.
				</p>
			</div>
		);
	}

	return (
		<div className="flex-1 min-h-0 overflow-y-auto p-2 space-y-1">
			{threads.map((thread) => {
				const active = thread.thread_id === activeThreadId;
				const live =
					thread.active_stream_id !== null || (active && activeThreadStreaming);
				return (
					<button
						key={thread.thread_id}
						type="button"
						onClick={() => onSelect(thread.thread_id)}
						className={`w-full min-h-11 rounded-lg border px-3 py-2.5 text-left transition-colors cursor-pointer ${
							active
								? "border-nova-violet/30 bg-nova-violet/[0.08]"
								: "border-transparent hover:bg-nova-surface/40"
						}`}
					>
						<div className="flex items-start gap-2">
							<Icon
								icon={
									thread.thread_type === "build"
										? tablerSparkles
										: tablerMessage
								}
								width="14"
								height="14"
								className={`mt-0.5 shrink-0 ${
									active ? "text-nova-violet-bright" : "text-nova-text-muted"
								}`}
							/>
							<span className="flex-1 min-w-0 text-[13px] leading-snug text-nova-text line-clamp-2">
								{thread.summary}
							</span>
							{live && (
								<span className="shrink-0 flex items-center gap-1.5 mt-0.5">
									<span className="relative flex size-2">
										<span className="absolute inline-flex size-full rounded-full bg-nova-emerald/60 animate-ping motion-reduce:hidden" />
										<span className="relative inline-flex size-2 rounded-full bg-nova-emerald" />
									</span>
									<span className="text-[9px] font-mono tracking-[0.18em] text-nova-text-muted">
										LIVE
									</span>
								</span>
							)}
						</div>
						<div className="mt-1 pl-6 flex items-center gap-1.5 text-[11px] text-nova-text-muted">
							<span>
								{thread.thread_type === "build" ? "Initial build" : "Edit"}
							</span>
							<span aria-hidden>·</span>
							<span>{formatRelativeDate(new Date(thread.updated_at))}</span>
							<span aria-hidden>·</span>
							<span className="tabular-nums">
								{thread.message_count}{" "}
								{thread.message_count === 1 ? "message" : "messages"}
							</span>
						</div>
					</button>
				);
			})}
		</div>
	);
}
