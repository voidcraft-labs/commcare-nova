/**
 * ReplayController — floating transport bar for scrubbing through a
 * generation replay. Pure presentation: subscribes to
 * `useReplayController` for behavior (cursor derivation, goToChapter,
 * handleExit, error toast) and renders the glass-styled bar with
 * motion-driven entry + chapter-subtitle reveal.
 *
 * No props from BuilderLayout. Mount/unmount is controlled by
 * BuilderLayout based on `inReplayMode`; the controller hook owns all
 * data + actions, including the auto-dismiss timer for the error toast.
 *
 * The behavior contract is exercised by `useReplayController.test.tsx`
 * via renderHook — the chrome here is visual chrome only. Visual QA /
 * Playwright covers the spring entry, glass surface, and label layout.
 */
"use client";
import { Icon } from "@iconify/react/offline";
import tablerChevronLeft from "@iconify-icons/tabler/chevron-left";
import tablerChevronRight from "@iconify-icons/tabler/chevron-right";
import tablerX from "@iconify-icons/tabler/x";
import { AnimatePresence, motion } from "motion/react";
import { useReplayController } from "./useReplayController";

export function ReplayController() {
	const {
		currentChapter,
		currentChapterIndex,
		totalChapters,
		canGoBack,
		canGoForward,
		error,
		goToChapter,
		handleExit,
	} = useReplayController();

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
							{Math.max(currentChapterIndex + 1, 0)}/{totalChapters}
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

			{/* Error toast — the controller hook owns the auto-dismiss timer.
			 *  Don't wire dismiss into motion's `onAnimationComplete`: it
			 *  fires for both enter AND exit, doubling the timer per error. */}
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
