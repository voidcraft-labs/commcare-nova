/**
 * ReplayController — floating transport bar for stepping through generation
 * replay stages. Fully self-sufficient — reads replay data from the session
 * store, dispatches emissions via `applyStreamEvent` (the same dispatcher
 * used by real-time streaming), and writes replay messages back for
 * ChatContainer.
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
import { applyStreamEvent } from "@/lib/generation/streamDispatcher";
import { useBuilderFormEngine } from "@/lib/preview/engine/provider";
import { resetBuilder } from "@/lib/services/resetBuilder";
import {
	BuilderSessionContext,
	useBuilderSession,
} from "@/lib/session/provider";

export function ReplayController() {
	const router = useRouter();
	const docStore = useContext(BlueprintDocContext);
	const sessionStore = useContext(BuilderSessionContext);
	const engineController = useBuilderFormEngine();

	/* Self-subscribe to replay state — no props from parent. */
	const replay = useBuilderSession((s) => s.replay);
	const stages = replay?.stages ?? [];
	const doneIndex = replay?.doneIndex ?? 0;
	const [currentIndex, setCurrentIndex] = useState(doneIndex);
	const [error, setError] = useState<string>();

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

	const goToStage = useCallback(
		(targetIndex: number) => {
			try {
				doReset();
				/* Replay all emissions from stage 0 through the target stage
				 * via the stream dispatcher — the same code path as real-time
				 * streaming, ensuring replay and live builds produce identical
				 * doc state. */
				for (let i = 0; i <= targetIndex; i++) {
					for (const em of stages[i].emissions) {
						applyStreamEvent(em.type, em.data, docStore!, sessionStore!);
					}
				}
				/* Write replay messages to the session store — ChatContainer reads them. */
				sessionStore!
					.getState()
					.setReplayMessages(stages[targetIndex].messages);
				setCurrentIndex(targetIndex);
				setError(undefined);
			} catch (err) {
				setError(
					`Cannot load stage: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		},
		[doReset, docStore, sessionStore, stages],
	);

	/** Exit replay mode — reset the builder and navigate to the exit path. */
	const handleExit = useCallback(() => {
		const exitPath = sessionStore?.getState().replay?.exitPath ?? "/";
		doReset();
		router.push(exitPath);
	}, [sessionStore, doReset, router]);

	const canGoBack = currentIndex > 0;
	const canGoForward = currentIndex < stages.length - 1;
	const stage = stages[currentIndex];

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
					onClick={() => canGoBack && goToStage(currentIndex - 1)}
					disabled={!canGoBack}
					className={`p-0.5 rounded-md transition-colors ${
						canGoBack
							? "text-nova-text hover:text-nova-violet-bright cursor-pointer"
							: "text-nova-text-muted cursor-not-allowed"
					}`}
				>
					<Icon icon={tablerChevronLeft} width={20} height={20} />
				</button>

				{/* Stage info — fixed width to prevent layout shift */}
				<div className="w-44 select-none flex flex-col justify-center h-9">
					<div className="flex items-center gap-1.5">
						<motion.span
							layout
							className="text-sm font-medium text-nova-text truncate"
							transition={{ duration: 0.2 }}
						>
							{stage.header}
						</motion.span>
						<span className="text-xs text-nova-text-muted shrink-0">
							{currentIndex + 1}/{stages.length}
						</span>
					</div>
					<AnimatePresence>
						{stage.subtitle && (
							<motion.p
								initial={{ height: 0, opacity: 0 }}
								animate={{ height: "auto", opacity: 1 }}
								exit={{ height: 0, opacity: 0 }}
								transition={{ duration: 0.2 }}
								className="text-xs text-nova-text-muted truncate overflow-hidden"
							>
								{stage.subtitle}
							</motion.p>
						)}
					</AnimatePresence>
				</div>

				{/* Right arrow */}
				<button
					type="button"
					onClick={() => canGoForward && goToStage(currentIndex + 1)}
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
