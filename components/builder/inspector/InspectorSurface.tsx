/**
 * InspectorSurface — the declarative way a builder surface puts a
 * properties panel in the right rail.
 *
 * Render it with the selected entity's chrome + editor body and the
 * rail docks (chat condenses beneath the panel); unmount it and the
 * rail returns to full chat. The body stays part of the OWNING
 * surface's React tree via a portal into the rail's slot, so editors
 * read fresh props/context and mutations flow through the surface's
 * own handlers — the rail never holds content state.
 *
 * The claim is established in an effect on purpose: React's
 * `<Activity>` destroys effects when it hides a screen, so a surface
 * that navigates away releases its claim (and drops its portal)
 * without knowing it was hidden. See `lib/ui/inspector.tsx` for the
 * claim model.
 *
 * Escape-to-close is the OWNING SURFACE's job (register it through
 * `useKeyboardShortcuts` alongside the selection state) — the global
 * keyboard manager preventDefaults every matched key, so a raw window
 * listener here would never see the event.
 */
"use client";

import { Icon } from "@iconify/react/offline";
import tablerX from "@iconify-icons/tabler/x";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/shadcn/button";
import { SimpleTooltip } from "@/components/shadcn/tooltip";
import { useInspectorContext } from "@/lib/ui/inspector";

interface InspectorSurfaceProps {
	/** Friendly context above the title — for example,
	 *  "Column 2 of 5" or "Search input". */
	readonly kicker: string;
	/** Entity title — the column header, input label, etc. */
	readonly title: string;
	/** Clear the owning surface's selection. The rail's close button,
	 *  the dock's expand-chat affordance, and Escape all land here. */
	readonly onClose: () => void;
	readonly children: ReactNode;
}

export function InspectorSurface({
	kicker,
	title,
	onClose,
	children,
}: InspectorSurfaceProps) {
	const { portalEl, activeClaimId, claim, release } = useInspectorContext();
	const titleId = useId();

	/* `onClose` identity changes with the owner's renders; the claim's
	 * close callback reads through a ref so the claim itself is
	 * established exactly once per mount. */
	const onCloseRef = useRef(onClose);
	onCloseRef.current = onClose;

	const [claimId, setClaimId] = useState<number | null>(null);
	useEffect(() => {
		const id = claim(() => onCloseRef.current());
		setClaimId(id);
		return () => {
			release(id);
			setClaimId(null);
		};
	}, [claim, release]);

	if (claimId === null || claimId !== activeClaimId || portalEl === null) {
		return null;
	}

	return createPortal(
		<aside aria-labelledby={titleId} className="flex-1 min-h-0 flex flex-col">
			<div
				className="flex h-16 shrink-0 items-center gap-3 border-b border-nova-border px-4"
				data-builder-secondary-header="inspector"
			>
				<SimpleTooltip
					content={
						<span className="grid gap-0.5">
							<span>{kicker}</span>
							<span className="font-semibold">{title}</span>
						</span>
					}
					side="bottom"
				>
					{/* The fixed-height rail header clamps imported names visually. The
					 * complete text remains in the accessibility tree, while the tooltip
					 * helps pointer users without inventing a dead button or tab stop. */}
					<div
						data-inspector-identity
						className="flex min-h-11 min-w-0 flex-1 flex-col justify-center text-left"
					>
						<div className="mb-1 truncate text-xs font-medium leading-4 text-nova-text-secondary">
							{kicker}
						</div>
						<h2
							id={titleId}
							className="truncate font-display text-[16px] font-semibold leading-5 text-nova-text"
						>
							{title}
						</h2>
					</div>
				</SimpleTooltip>
				<SimpleTooltip content="Close properties" side="left">
					<Button
						type="button"
						variant="outline"
						size="icon-lg"
						onClick={onClose}
						aria-label="Close properties"
						aria-keyshortcuts="Escape"
						className="size-11 shrink-0 border-nova-border bg-transparent text-nova-text-muted hover:border-nova-border-bright hover:text-nova-text dark:bg-transparent"
					>
						<Icon icon={tablerX} width="16" height="16" />
					</Button>
				</SimpleTooltip>
			</div>
			{/* `@container` so editor bodies can adapt to the rail's width —
			 *  the predicate/expression cards stack their operand grids in
			 *  narrow containers and go multi-column only with real room. */}
			<div className="flex-1 min-h-0 overflow-y-auto px-4 py-4 space-y-4 @container">
				{children}
			</div>
		</aside>,
		portalEl,
	);
}
