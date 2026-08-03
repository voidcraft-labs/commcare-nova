/**
 * Dev-only bench for the shared header band and the brand handoff.
 *
 * The real `AppHeader`, filled with stand-ins for the slots each surface
 * fills, so the collapse can be watched and re-watched without minting an app
 * per attempt. Three things it exists to answer:
 *
 *  - does the mark sit at the same x and y in every composition (the whole
 *    reason the two headers were merged);
 *  - does the wordmark travel into the sphere rather than snapping away, and
 *    does the sphere's answer land after the word rather than under it;
 *  - does the band survive its stacked and short-window variants.
 *
 * The stand-ins are deliberately not the real controls: this bench is about
 * the band and the brand, and importing the builder's document tools would
 * drag the doc and session stores in behind them.
 */

"use client";

import { Icon } from "@iconify/react/offline";
import tablerApps from "@iconify-icons/tabler/apps";
import tablerHelp from "@iconify-icons/tabler/help";
import tablerUserCircle from "@iconify-icons/tabler/user-circle";
import { useState } from "react";
import { Button } from "@/components/shadcn/button";
import { AppHeader } from "@/components/ui/AppHeader";
import { selectableSegmentCls } from "@/lib/styles";

/** The three compositions the band actually ships in. */
const SURFACES = {
	site: {
		label: "Site",
		hint: "App list, admin, settings: nav, Project switcher, Help, account.",
	},
	newBuild: {
		label: "Build: new",
		hint: "`/build/new`. No app exists, so the lockup is Nova's own presence.",
	},
	building: {
		label: "Build: app open",
		hint: "The app carries its own name, so the sphere alone stands here.",
	},
} as const;

type Surface = keyof typeof SURFACES;

function ToolStandIn({ label }: { label: string }) {
	return (
		<Button type="button" variant="ghost" size="icon" aria-label={label}>
			<Icon icon={tablerHelp} width="18" height="18" />
		</Button>
	);
}

export function HeaderLab() {
	const [surface, setSurface] = useState<Surface>("newBuild");
	const [stacked, setStacked] = useState(false);
	const [banner, setBanner] = useState(false);

	/* Replaying the handoff means going back to the lockup and collapsing it
	 * again, because that IS the handoff: the header plays it off the change,
	 * never off a caller asking for an animation. Two frames apart so the
	 * browser has a computed lockup to transition FROM. */
	const replay = () => {
		setSurface("newBuild");
		requestAnimationFrame(() => {
			requestAnimationFrame(() => setSurface("building"));
		});
	};

	const markOnly = surface === "building";

	return (
		<div className="flex h-dvh flex-col bg-nova-void">
			<AppHeader
				homeLabel={markOnly ? "Back to your apps" : "commcare nova"}
				markOnly={markOnly}
				start={
					banner ? (
						<span className="rounded-full border border-nova-amber/30 bg-nova-amber/[0.06] px-3 py-1 text-xs text-nova-text-secondary">
							Viewing as Ada Lovelace
						</span>
					) : surface === "site" ? (
						<nav aria-label="Main navigation" className="flex items-center">
							<span className={selectableSegmentCls(true)}>
								<Icon icon={tablerApps} width="16" height="16" />
								<span className="hidden sm:inline">Apps</span>
							</span>
						</nav>
					) : null
				}
				center={
					surface === "building" ? (
						<Button type="button" variant="secondary">
							Preview
						</Button>
					) : null
				}
				actions={
					surface === "building" ? (
						<>
							<ToolStandIn label="Undo" />
							<ToolStandIn label="Redo" />
							<Button type="button">Publish</Button>
						</>
					) : surface === "site" ? (
						<>
							<Button type="button" variant="ghost">
								Personal
							</Button>
							<ToolStandIn label="Help" />
						</>
					) : null
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
				stacked={stacked}
			/>

			<div className="flex-1 overflow-auto p-6">
				<div className="mx-auto flex max-w-2xl flex-col gap-6">
					<div className="flex flex-col gap-2">
						<h1 className="font-display text-2xl font-medium text-nova-text">
							Header lab
						</h1>
						<p className="text-sm text-nova-text-secondary">
							{SURFACES[surface].hint}
						</p>
					</div>

					<div className="flex flex-col gap-3">
						<span className="text-xs uppercase tracking-wide text-nova-text-muted">
							Brand handoff
						</span>
						<div className="flex flex-wrap gap-2">
							<Button type="button" onClick={replay}>
								Replay the collapse
							</Button>
							<Button
								type="button"
								variant="secondary"
								onClick={() => setSurface("newBuild")}
							>
								Unfold back out
							</Button>
						</div>
						<p className="text-sm text-nova-text-secondary">
							Collapse is what a build starting looks like: the word is drawn
							in, then the sphere answers with the swell it gives the pointer.
							Unfolding is leaving the builder, and decelerates instead. Below
							800px the row can't hold the lockup, so the word is already gone
							and only the swell plays.
						</p>
					</div>

					<div className="flex flex-col gap-3">
						<span className="text-xs uppercase tracking-wide text-nova-text-muted">
							Composition
						</span>
						<div className="flex flex-wrap gap-2">
							{(Object.keys(SURFACES) as Surface[]).map((key) => (
								<Button
									key={key}
									type="button"
									variant={surface === key ? "default" : "outline"}
									onClick={() => setSurface(key)}
								>
									{SURFACES[key].label}
								</Button>
							))}
						</div>
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
							row rather than any control shrinking. Narrow the window under
							360px tall to see the band give up its outer air.
						</p>
					</div>
				</div>
			</div>
		</div>
	);
}
