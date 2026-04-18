/**
 * ReplayController — floating transport bar for scrubbing through a
 * generation replay. Fully self-sufficient: reads the event log +
 * derived chapters from the session store, applies mutations via the
 * doc store, and records the new scrub cursor on `setReplayCursor` so
 * message derivation (`useReplayMessages`) re-projects the chat view.
 *
 * Navigation model — chapters are cumulative scrub targets over the
 * raw `Event[]`, not independent segments. Clicking chapter N resets
 * the doc and replays `events[0..chapters[N].endIndex]` inclusive. The
 * arrows step between adjacent chapters; the current chapter is the
 * one whose inclusive `[startIndex, endIndex]` range contains the
 * session store's current cursor.
 *
 * No props needed from BuilderLayout. Mount/unmount is controlled by
 * BuilderLayout based on `inReplayMode`, but the component owns all
 * its own data and actions.
 */
"use client";
import { Icon } from "@iconify/react/offline";
import tablerChevronLeft from "@iconify-icons/tabler/chevron-left";
import tablerChevronRight from "@iconify-icons/tabler/chevron-right";
import tablerX from "@iconify-icons/tabler/x";
import { AnimatePresence, motion } from "motion/react";
import { useRouter } from "next/navigation";
import { useCallback, useContext, useState } from "react";
import { BlueprintDocContext } from "@/lib/doc/provider";
import { replayEvents } from "@/lib/log/replay";
import type { Event } from "@/lib/log/types";
import { useBuilderFormEngine } from "@/lib/preview/engine/provider";
import { resetBuilder } from "@/lib/services/resetBuilder";
import {
	BuilderSessionContext,
	useBuilderSession,
} from "@/lib/session/provider";
import type { ReplayChapter } from "@/lib/session/types";

/* Reference-stable empty-array sentinels keep the selectors below from
 * returning a fresh `[]` on every render when replay is not loaded — a
 * fresh reference would make `useBuilderSession`'s equality check fail
 * on every tick and thrash React reconciliation in the transport bar. */
const EMPTY_EVENTS: readonly Event[] = [];
const EMPTY_CHAPTERS: readonly ReplayChapter[] = [];

export function ReplayController() {
	const router = useRouter();
	const docStore = useContext(BlueprintDocContext);
	const sessionStore = useContext(BuilderSessionContext);
	const engineController = useBuilderFormEngine();

	/* Self-subscribe to replay state — no props from parent. The cursor
	 * lives in the session store so `useReplayMessages` and this
	 * controller stay in lock-step across scrubs. */
	const replay = useBuilderSession((s) => s.replay);
	const events = replay?.events ?? EMPTY_EVENTS;
	const chapters = replay?.chapters ?? EMPTY_CHAPTERS;
	const cursor = replay?.cursor ?? 0;
	const [error, setError] = useState<string>();

	/* Which chapter does the current cursor fall inside? Chapters cover
	 * inclusive `[startIndex, endIndex]` ranges and the cursor is always
	 * clamped into the `events` range, so `findIndex` locates a unique
	 * chapter for every valid cursor (-1 only when `chapters` is empty,
	 * which the fallback path below handles). */
	const currentChapterIndex = chapters.findIndex(
		(c) => cursor >= c.startIndex && cursor <= c.endIndex,
	);
	const currentChapter = chapters[currentChapterIndex];

	const doReset = useCallback(() => {
		/* The provider stack guarantees all stores/controllers are
		 * installed by the time this component mounts — assert loudly if
		 * the invariant is violated instead of silently dropping the reset. */
		if (!docStore || !sessionStore) {
			throw new Error(
				"ReplayController.reset: missing docStore or sessionStore context",
			);
		}
		resetBuilder({
			sessionStore,
			docStore,
			engineController,
		});
	}, [docStore, sessionStore, engineController]);

	const goToChapter = useCallback(
		(chapterIndex: number) => {
			const chapter = chapters[chapterIndex];
			if (!chapter || !docStore || !sessionStore) return;
			try {
				doReset();
				/* Cumulative replay — from event 0 through this chapter's
				 * end. Chapters are scrub targets, not independent segments,
				 * so every scrub reconstructs state from the beginning. The
				 * doc store was just wiped by `doReset`, so no stale entities
				 * bleed into the new frame.
				 *
				 * `delayPerEvent = 0` because we want the new frame to land
				 * in one commit — user-visible pacing belongs to live
				 * generation, not scrubbing. */
				const slice = events.slice(0, chapter.endIndex + 1);
				void replayEvents(
					slice,
					(m) => docStore.getState().applyMany([m]),
					() => {
						/* Conversation events are projected on read by
						 * `useReplayMessages`; no side channel needed. */
					},
					0,
				);
				/* Record the new scrub position — `useReplayMessages`
				 * subscribes to this and re-derives the chat view. */
				sessionStore.getState().setReplayCursor(chapter.endIndex);
				setError(undefined);
			} catch (err) {
				setError(
					`Cannot load chapter: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		},
		[chapters, events, doReset, docStore, sessionStore],
	);

	/** Exit replay mode — reset the builder and navigate to the exit path. */
	const handleExit = useCallback(() => {
		const exitPath = sessionStore?.getState().replay?.exitPath ?? "/";
		doReset();
		router.push(exitPath);
	}, [sessionStore, doReset, router]);

	const canGoBack = currentChapterIndex > 0;
	const canGoForward =
		currentChapterIndex >= 0 && currentChapterIndex < chapters.length - 1;

	return (
		<div className="fixed bottom-3 left-1/2 -translate-x-1/2 z-popover flex flex-col items-center gap-2">
			<motion.div
				initial={{ opacity: 0, y: 20 }}
				animate={{ opacity: 1, y: 0 }}
				transition={{ type: "spring", stiffness: 300, damping: 25 }}
				className="flex items-center gap-3 px-4 py-2 bg-nova-deep/95 backdrop-blur-xl border border-nova-violet-bright/40 rounded-2xl shadow-[0_0_20px_rgba(139,92,246,0.25),0_4px_16px_rgba(0,0,0,0.5)]"
			>
				{/* Left arrow */}
				<button
					type="button"
					onClick={() => canGoBack && goToChapter(currentChapterIndex - 1)}
					disabled={!canGoBack}
					className={`p-0.5 rounded-md transition-colors ${
						canGoBack
							? "text-nova-text hover:text-nova-violet-bright cursor-pointer"
							: "text-nova-text-muted cursor-not-allowed"
					}`}
				>
					<Icon icon={tablerChevronLeft} width={20} height={20} />
				</button>

				{/* Chapter info — fixed width to prevent layout shift */}
				<div className="w-44 select-none flex flex-col justify-center h-9">
					<div className="flex items-center gap-1.5">
						<motion.span
							layout
							className="text-sm font-medium text-nova-text truncate"
							transition={{ duration: 0.2 }}
						>
							{currentChapter?.header ?? "Loading…"}
						</motion.span>
						<span className="text-xs text-nova-text-muted shrink-0">
							{/* 1-indexed chapter counter; `0/0` while chapters are
							 *  empty (should only happen for a split-second during
							 *  hydration — after which the session store always
							 *  holds a non-empty chapter array). */}
							{Math.max(currentChapterIndex + 1, 0)}/{chapters.length}
						</span>
					</div>
					<AnimatePresence>
						{currentChapter?.subtitle && (
							<motion.p
								initial={{ height: 0, opacity: 0 }}
								animate={{ height: "auto", opacity: 1 }}
								exit={{ height: 0, opacity: 0 }}
								transition={{ duration: 0.2 }}
								className="text-xs text-nova-text-muted truncate overflow-hidden"
							>
								{currentChapter.subtitle}
							</motion.p>
						)}
					</AnimatePresence>
				</div>

				{/* Right arrow */}
				<button
					type="button"
					onClick={() => canGoForward && goToChapter(currentChapterIndex + 1)}
					disabled={!canGoForward}
					className={`p-0.5 rounded-md transition-colors ${
						canGoForward
							? "text-nova-text hover:text-nova-violet-bright cursor-pointer"
							: "text-nova-text-muted cursor-not-allowed"
					}`}
				>
					<Icon icon={tablerChevronRight} width={20} height={20} />
				</button>

				{/* Divider */}
				<div className="w-px h-5 bg-nova-border" />

				{/* Close */}
				<button
					type="button"
					onClick={handleExit}
					className="p-0.5 rounded-md text-nova-text-muted hover:text-nova-text transition-colors cursor-pointer"
				>
					<Icon icon={tablerX} width={18} height={18} />
				</button>
			</motion.div>

			{/* Error toast */}
			<AnimatePresence>
				{error && (
					<motion.div
						initial={{ opacity: 0, y: 8 }}
						animate={{ opacity: 1, y: 0 }}
						exit={{ opacity: 0, y: 8 }}
						onAnimationComplete={() => {
							setTimeout(() => setError(undefined), 3000);
						}}
						className="px-3 py-1.5 bg-nova-rose/15 border border-nova-rose/30 rounded-full text-xs text-nova-rose"
					>
						{error}
					</motion.div>
				)}
			</AnimatePresence>
		</div>
	);
}
