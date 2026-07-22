/**
 * ThreadList — the conversations view of the chat rail.
 *
 * First-class thread rows: every conversation about this app, most recently
 * active first, clickable back into. Replaces the conversation region while
 * open (ChatSidebar owns the open/close state and the header's back
 * affordance). A row shows what a person needs to pick a conversation —
 * its opening request, how old it is, how much was said — and two live
 * signals: the violet dot marks the open conversation, and the pulsing active
 * badge marks one with a run streaming right now (its row resumes the
 * stream on open).
 */
"use client";

import { Icon } from "@iconify/react/offline";
import tablerMessage from "@iconify-icons/tabler/message";
import tablerSparkles from "@iconify-icons/tabler/sparkles";
import { Button } from "@/components/shadcn/button";
import { Spinner } from "@/components/shadcn/spinner";
import type { ThreadMeta } from "@/lib/db/types";
import { formatRelativeDate } from "@/lib/utils/format";

interface ThreadListProps {
	threads: ThreadMeta[];
	/** The conversation currently open in the rail (the Chat instance's id). */
	activeThreadId: string;
	/** True while the open conversation's stream is live in this tab. This lights
	 *  its active badge even before the server-side marker round-trips. */
	activeThreadStreaming: boolean;
	openingThreadId: string | null;
	disabled?: boolean;
	onSelect: (threadId: string) => void | Promise<void>;
}

export function ThreadList({
	threads,
	activeThreadId,
	activeThreadStreaming,
	openingThreadId,
	disabled = false,
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
		<ul className="flex-1 min-h-0 overflow-y-auto list-none m-0 p-0">
			{threads.map((thread) => {
				const active = thread.thread_id === activeThreadId;
				const opening = thread.thread_id === openingThreadId;
				const live =
					thread.active_stream_id !== null || (active && activeThreadStreaming);
				return (
					<li key={thread.thread_id}>
						<Button
							type="button"
							variant="ghost"
							onClick={() => void onSelect(thread.thread_id)}
							disabled={disabled || openingThreadId !== null}
							aria-current={active ? "true" : undefined}
							aria-busy={opening || undefined}
							className={`relative h-auto min-h-11 w-full flex-col items-stretch gap-0 whitespace-normal rounded-none border-b border-nova-border px-4 py-3 text-left focus-visible:z-10 focus-visible:ring-inset ${
								active
									? "bg-nova-violet/[0.08] before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-nova-violet"
									: "not-disabled:hover:bg-nova-surface/40"
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
								{opening ? (
									<Spinner className="mt-0.5 size-3.5 shrink-0 text-nova-violet-bright" />
								) : live ? (
									<span className="shrink-0 flex items-center gap-1.5 mt-0.5">
										<span className="relative flex size-2">
											<span className="absolute inline-flex size-full rounded-full bg-nova-emerald/60 animate-ping motion-reduce:hidden" />
											<span className="relative inline-flex size-2 rounded-full bg-nova-emerald" />
										</span>
										<span className="text-xs font-medium text-nova-text-muted">
											Active
										</span>
									</span>
								) : null}
							</div>
							<div className="mt-1 flex items-center gap-1.5 pl-6 text-xs text-nova-text-muted">
								<span>
									{thread.thread_type === "build" ? "Initial build" : "Edit"}
								</span>
								<span aria-hidden>·</span>
								<span>{formatRelativeDate(new Date(thread.updated_at))}</span>
								<span className="ml-auto tabular-nums">
									{thread.message_count}{" "}
									{thread.message_count === 1 ? "message" : "messages"}
								</span>
							</div>
						</Button>
					</li>
				);
			})}
		</ul>
	);
}
