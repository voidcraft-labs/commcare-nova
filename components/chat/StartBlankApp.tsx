/**
 * StartBlankApp — the "skip the SA, build it yourself" affordance that sits
 * under the centered chat card on `/build/new`.
 *
 * It shares the centered column with the hero logo and the chat card, so its
 * presence pushes the chat above true center. Sending a message is the user
 * choosing the SA instead: the card collapses (`height → 0`) and the column,
 * being `justify-center`, reflows the logo + chat back to center every frame
 * — no layout animation to coordinate, and nothing to race.
 *
 * While it animates out the button stays visually enabled ON PURPOSE. The
 * click is already inert (the parent latches the moment the message is sent),
 * and flashing a disabled state mid-fade — under a chat card that is itself
 * sliding — is one visual event too many for a single user action.
 */
"use client";

import { Icon } from "@iconify/react/offline";
import tablerFilePlus from "@iconify-icons/tabler/file-plus";
import { AnimatePresence, motion } from "motion/react";
import { Button } from "@/components/shadcn/button";
import { Spinner } from "@/components/shadcn/spinner";

interface StartBlankAppProps {
	/** The user has sent a message — the SA is taking over, so this collapses away. */
	agentEngaged: boolean;
	/** The blank app is being created; navigation follows. */
	creating: boolean;
	/** No-ops once the parent has latched `agentEngaged` or a create is in flight. */
	onCreate: () => void;
}

export function StartBlankApp({
	agentEngaged,
	creating,
	onCreate,
}: StartBlankAppProps) {
	return (
		<AnimatePresence>
			{!agentEngaged && (
				<motion.div
					/* `-mt-6` cancels the column's `gap-6` and the inner `pt-3` supplies
					 * the real spacing, so a fully collapsed box contributes exactly zero
					 * and `height` can be the only animated dimension. It is measured at
					 * exit-start and driven to 0; `overflow-hidden` keeps the contents
					 * from spilling as the box closes. */
					className="-mt-6 pointer-events-auto w-full max-w-2xl shrink-0 overflow-hidden"
					initial={{ opacity: 0, y: 6 }}
					animate={{ opacity: 1, y: 0 }}
					/* Exit carries its own transition: `AnimatePresence` re-renders the
					 * leaving child with its LAST props, so the entrance delay below
					 * would otherwise stall the collapse. Opacity leads the height so
					 * the text is gone before the box finishes closing. */
					exit={{
						opacity: 0,
						height: 0,
						transition: {
							opacity: { duration: 0.18, ease: "easeOut" },
							height: { duration: 0.34, ease: [0.4, 0, 0.2, 1] },
						},
					}}
					transition={{
						duration: 0.4,
						ease: [0.4, 0, 0.2, 1],
						/* Let the hero logo and chat card land before this arrives —
						 * it's the secondary path, and it should read that way. */
						delay: 0.4,
					}}
				>
					{/* `pt-3` matches the column's `gap-3` so the "or" divider sits
					 *  equidistant from the chat card above and the button below. */}
					<div className="flex flex-col items-center gap-3 pt-3">
						<div className="flex w-full items-center gap-3">
							<span className="h-px flex-1 bg-nova-border" />
							<span className="text-xs leading-none text-nova-text-muted">
								or
							</span>
							<span className="h-px flex-1 bg-nova-border" />
						</div>

						{/* Deliberately never `disabled`. `onCreate` is already inert once the
						 *  parent has latched (it latches synchronously, in the same handler
						 *  that sends), and this is mid-fade under a chat card that is
						 *  itself sliding — a disabled flash is one visual event too many.
						 *  Don't try to drive attributes off `agentEngaged` here either:
						 *  `AnimatePresence` re-renders the LEAVING child with its last
						 *  props, so anything keyed on it can't change during the exit. */}
						<Button
							variant="outline"
							size="xl"
							onClick={onCreate}
							aria-busy={creating || undefined}
						>
							{creating ? <Spinner /> : <Icon icon={tablerFilePlus} />}
							{creating ? "Creating blank app…" : "Start with a blank app"}
						</Button>

						<p className="text-xs text-nova-text-muted">
							Skip chat and build the app yourself
						</p>
					</div>
				</motion.div>
			)}
		</AnimatePresence>
	);
}
