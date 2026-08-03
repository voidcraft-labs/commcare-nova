/**
 * Dev-only bench for the shared header band and the handoff into the builder.
 *
 * The real `AppHeader` and the real motion primitives, filled with stand-ins,
 * so the swap can be watched and re-watched without minting an app per
 * attempt. Three things it exists to answer:
 *
 *  - does the mark sit at the same x and y in both states (the whole reason
 *    the two headers were merged);
 *  - does the band change hands as ONE gesture — menus out, word drawn into
 *    the sphere, tools in — rather than as three things that happen to fire at
 *    once;
 *  - does the band survive its stacked and short-window variants.
 *
 * The two states here are the two the band really has. `/build/new` is not a
 * third: no app exists there, so it wears the site band exactly, and the
 * handoff is what a build STARTING looks like.
 *
 * The stand-ins are deliberately not the real controls: this bench is about
 * the band, and importing the builder's document tools would drag the doc and
 * session stores in behind them.
 */

"use client";

import { Icon } from "@iconify/react/offline";
import tablerApps from "@iconify-icons/tabler/apps";
import tablerHelp from "@iconify-icons/tabler/help";
import tablerUserCircle from "@iconify-icons/tabler/user-circle";
import { AnimatePresence } from "motion/react";
import { useState } from "react";
import { Button } from "@/components/shadcn/button";
import { AppHeader } from "@/components/ui/AppHeader";
import {
	HEADER_HANDOFF_DELAY,
	HeaderCluster,
} from "@/components/ui/headerMotion";
import { selectableSegmentCls } from "@/lib/styles";

function ToolStandIn({ label }: { label: string }) {
	return (
		<Button type="button" variant="ghost" size="icon" aria-label={label}>
			<Icon icon={tablerHelp} width="18" height="18" />
		</Button>
	);
}

export function HeaderLab() {
	const [building, setBuilding] = useState(false);
	const [stacked, setStacked] = useState(false);
	const [banner, setBanner] = useState(false);

	/* Replaying means going back to the unclaimed band and handing it over
	 * again, because that IS the handoff: the band plays it off the change,
	 * never off a caller asking for an animation. Two frames apart so the
	 * browser has a computed lockup to transition FROM. */
	const replay = () => {
		setBuilding(false);
		requestAnimationFrame(() => {
			requestAnimationFrame(() => setBuilding(true));
		});
	};

	return (
		<div className="flex h-dvh flex-col bg-nova-void">
			<AppHeader
				homeLabel={building ? "Back to your apps" : "commcare nova"}
				markOnly={building}
				banner={
					banner ? (
						<span className="rounded-full border border-nova-amber/30 bg-nova-amber/[0.06] px-3 py-1 text-xs text-nova-text-secondary">
							Viewing as Ada Lovelace
						</span>
					) : null
				}
				start={
					<AnimatePresence>
						{building ? null : (
							<HeaderCluster
								key="nav"
								delay={HEADER_HANDOFF_DELAY}
								className="flex min-w-0 items-center"
							>
								<nav aria-label="Main navigation" className="flex items-center">
									<span className={selectableSegmentCls(true)}>
										<Icon icon={tablerApps} width="16" height="16" />
										<span className="hidden sm:inline">Apps</span>
									</span>
								</nav>
							</HeaderCluster>
						)}
					</AnimatePresence>
				}
				center={
					/* No `AnimatePresence`: the builder's own controls arrive animated
					 * and leave instantly, because they go when app access stops being
					 * resolved and a control mid-fade still takes a click. */
					building ? (
						<HeaderCluster delay={HEADER_HANDOFF_DELAY}>
							<Button type="button" variant="secondary">
								Preview
							</Button>
						</HeaderCluster>
					) : null
				}
				actions={
					<>
						{building ? (
							<HeaderCluster delay={HEADER_HANDOFF_DELAY}>
								<ToolStandIn label="Undo" />
								<ToolStandIn label="Redo" />
								<Button type="button">Publish</Button>
							</HeaderCluster>
						) : null}
						<AnimatePresence>
							{building ? null : (
								<HeaderCluster key="site-actions" delay={HEADER_HANDOFF_DELAY}>
									<Button type="button" variant="ghost">
										Personal
									</Button>
									<ToolStandIn label="Help" />
								</HeaderCluster>
							)}
						</AnimatePresence>
					</>
				}
				account={
					<Button
						type="button"
						variant="ghost"
						size="icon"
						aria-label="Account"
					>
						<Icon icon={tablerUserCircle} width="22" height="22" />
					</Button>
				}
				stacked={stacked && building}
			/>

			<div className="flex-1 overflow-auto p-6">
				<div className="mx-auto flex max-w-2xl flex-col gap-6">
					<div className="flex flex-col gap-2">
						<h1 className="font-display text-2xl font-medium text-nova-text">
							Header lab
						</h1>
						<p className="text-sm text-nova-text-secondary">
							{building
								? "A build is open. The app carries its own name, so the sphere alone stands here and the band holds the document tools."
								: "The app list, settings, and /build/new all look like this. No app exists yet on /build/new, so nothing has changed hands."}
						</p>
					</div>

					<div className="flex flex-col gap-3">
						<span className="text-xs uppercase tracking-wide text-nova-text-muted">
							The handoff
						</span>
						<div className="flex flex-wrap gap-2">
							<Button type="button" onClick={replay}>
								Replay a build starting
							</Button>
							<Button
								type="button"
								variant="secondary"
								onClick={() => setBuilding(false)}
							>
								Hand it back
							</Button>
						</div>
						<p className="text-sm text-nova-text-secondary">
							One gesture with two beats: the site's menus leave, the word is
							drawn into the sphere, and the tools arrive behind them while the
							sphere answers with the swell it gives the pointer. Handing it
							back decelerates instead. Below 800px the row can't hold the
							lockup, so the word is already gone and only the swell plays.
						</p>
					</div>

					<div className="flex flex-col gap-3">
						<span className="text-xs uppercase tracking-wide text-nova-text-muted">
							Variants
						</span>
						<div className="flex flex-wrap gap-2">
							<Button
								type="button"
								variant={stacked ? "default" : "outline"}
								onClick={() => setStacked((on) => !on)}
							>
								Stacked rows
							</Button>
							<Button
								type="button"
								variant={banner ? "default" : "outline"}
								onClick={() => setBanner((on) => !on)}
							>
								Impersonation banner
							</Button>
						</div>
						<p className="text-sm text-nova-text-secondary">
							Stacked is the builder under 560px, where the tools take their own
							row rather than any control shrinking, so it only applies to an
							open build. Narrow the window under 360px tall to see the band
							give up its outer air.
						</p>
					</div>
				</div>
			</div>
		</div>
	);
}
