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
import { useCallback, useContext, useEffect, useState } from "react";
import { BlueprintDocContext } from "@/lib/doc/provider";
import { replayEventsSync } from "@/lib/log/replay";
import type { Event } from "@/lib/log/types";
import { useBuilderFormEngine } from "@/lib/preview/engine/provider";
import { resetBuilder } from "@/lib/services/resetBuilder";
import { useReplayState } from "@/lib/session/hooks";
import { BuilderSessionContext } from "@/lib/session/provider";
import type { ReplayChapter } from "@/lib/session/types";

/* Reference-stable empty-array sentinels used when replay is not loaded.
 * `useReplayState` returns `undefined` in that case; these sentinels keep
 * the destructured `events` / `chapters` references stable across renders
 * so the transport bar's downstream memos + `findIndex` don't thrash. */
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
	const replay = useReplayState();
	const events = replay?.events ?? EMPTY_EVENTS;
	const chapters = replay?.chapters ?? EMPTY_CHAPTERS;
	const cursor = replay?.cursor ?? 0;
	const [error, setError] = useState<string>();

	/* Which chapter does the current cursor fall inside? Chapters cover
	 * inclusive `[startIndex, endIndex]` ranges and the cursor is always
	 * clamped into the `events` range by `setReplayCursor`. `findIndex`
	 * therefore returns a valid index for every real cursor; the only
	 * legitimate -1 case is `chapters.length === 0` during the sub-frame
	 * between mount and hydration (pre-`loadReplay`). */
	const currentChapterIndex = chapters.findIndex(
		(c) => cursor >= c.startIndex && cursor <= c.endIndex,
	);
	/* Assert cursor/chapter consistency once chapters are populated. A
	 * mismatch here means either `setReplayCursor`'s clamp is broken or
	 * `deriveReplayChapters` skipped a range — either way the user can't
	 * navigate, so failing loudly beats rendering a stuck "Loading…"
	 * header. The empty-chapters case is the transient pre-hydration
	 * state and is covered by the `currentChapter?.header ?? "Loading…"`
	 * fallback in the JSX below. */
	if (chapters.length > 0 && currentChapterIndex === -1) {
		throw new Error(
			`ReplayController: cursor ${cursor} outside chapter ranges (${chapters.length} chapters)`,
		);
	}
	const currentChapter = chapters[currentChapterIndex];

	/* Auto-dismiss the error toast 3s after it appears. Keyed on `error`
	 * so a new error resets the timer; returns a cleanup that fires on
	 * unmount or when `error` changes, so the dismiss never stacks and
	 * can't clobber a newer toast.
	 *
	 * Previously the dismiss was armed inside `onAnimationComplete`,
	 * which motion/react fires for BOTH enter and exit animations —
	 * doubling the timer per error and leaking on unmount. */
	useEffect(() => {
		if (!error) return;
		const timer = setTimeout(() => setError(undefined), 3000);
		return () => clearTimeout(timer);
	}, [error]);

	const goToChapter = useCallback(
		(chapterIndex: number) => {
			const chapter = chapters[chapterIndex];
			if (!chapter || !docStore || !sessionStore) return;
			try {
				/* Reset the doc + engine + signal grid only. Session state
				 * (including `replay.events` / `replay.chapters` / the
				 * transport bar) is preserved by composition — we simply
				 * don't call `sessionStore.reset()` here. The previous
				 * foot-gun (a composite reset that bundled session.reset)
				 * cleared `replay: undefined` and caused the transport bar
				 * to render `0/0` chapters until unmount. */
				resetBuilder({ docStore, engineController });
				/* Cumulative replay — from event 0 through this chapter's
				 * end. Chapters are scrub targets, not independent segments,
				 * so every scrub reconstructs state from the beginning. The
				 * doc store was just wiped by the reset, so no stale entities
				 * bleed into the new frame.
				 *
				 * `replayEventsSync` guarantees every mutation lands before
				 * the `setReplayCursor` call below — otherwise the chat
				 * view (derived from the cursor) could race ahead of the
				 * doc view and render a mismatched frame. */
				const slice = events.slice(0, chapter.endIndex + 1);
				replayEventsSync(
					slice,
					(m) => docStore.getState().applyMany([m]),
					() => {
						/* Conversation events are projected on read by
						 * `useReplayMessages`; no side channel needed. */
					},
				);
				/* Swap the session events buffer to the new slice so
				 * lifecycle derivations see the chapter's terminal frame —
				 * the frame live rendered at the same cursor position.
				 * Exception: the final chapter represents a *completed*
				 * run, and live's post-endRun state has an empty buffer →
				 * derivePhase returns Ready. Mirroring that here means
				 * clearing the buffer on the terminal scrub so the final
				 * frame doesn't flash Generating. All earlier chapters use
				 * the normal slice so Generating phase + stage progression
				 * render correctly mid-scrub.
				 *
				 * `replaceEvents` (not `pushEvents`) because scrub is a
				 * full reconstruction, not a delta. */
				const atTerminal = chapterIndex === chapters.length - 1;
				sessionStore.getState().replaceEvents(atTerminal ? [] : slice);
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
		[chapters, events, docStore, sessionStore, engineController],
	);

	/** Exit replay mode — reset the builder and navigate to the exit path.
	 *  `replay.exitPath` is required on `ReplayInit` (see `lib/session/types`)
	 *  and this component only mounts inside an active replay session, so
	 *  a missing value is an invariant violation — throw loudly rather
	 *  than silently navigating somewhere unexpected.
	 *
	 *  Composes `resetBuilder` (doc + engine + signal grid) with an
	 *  explicit `sessionStore.reset()` — exit is the one place where
	 *  session state should also clear, so `replay.*`, cursor mode,
	 *  sidebar visibility, etc. all zero out before navigation. The
	 *  session reset runs BEFORE `router.push` so the next route's
	 *  mount doesn't observe stale session state during its initial
	 *  render. */
	const handleExit = useCallback(() => {
		if (!docStore || !sessionStore) {
			throw new Error(
				"ReplayController.handleExit: missing docStore or sessionStore",
			);
		}
		const exitPath = sessionStore.getState().replay?.exitPath;
		if (!exitPath) {
			throw new Error(
				"ReplayController.handleExit: no exitPath in replay state",
			);
		}
		resetBuilder({ docStore, engineController });
		sessionStore.getState().reset();
		router.push(exitPath);
	}, [docStore, sessionStore, engineController, router]);

	const canGoBack = currentChapterIndex > 0;
	/* When chapters is empty `currentChapterIndex` is -1 — the
	 * `!currentChapter` branch in `goToChapter` would reject any click
	 * anyway, but short-circuit here so the arrow also renders disabled. */
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

			{/* Error toast — auto-dismiss owned by the `[error]`-keyed effect
			 *  above; no onAnimationComplete side-effects here. */}
			<AnimatePresence>
				{error && (
					<motion.div
						initial={{ opacity: 0, y: 8 }}
						animate={{ opacity: 1, y: 0 }}
						exit={{ opacity: 0, y: 8 }}
						className="px-3 py-1.5 bg-nova-rose/15 border border-nova-rose/30 rounded-full text-xs text-nova-rose"
					>
						{error}
					</motion.div>
				)}
			</AnimatePresence>
		</div>
	);
}
