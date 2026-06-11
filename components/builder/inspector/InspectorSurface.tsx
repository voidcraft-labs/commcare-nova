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
import { type ReactNode, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Tooltip } from "@/components/ui/Tooltip";
import { useInspectorContext } from "@/lib/ui/inspector";

interface InspectorSurfaceProps {
	/** Mono eyebrow above the title — entity context like
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
		<div className="flex-1 min-h-0 flex flex-col">
			<div className="flex items-center gap-3 px-4 pt-3 pb-2.5 border-b border-nova-border shrink-0">
				<div className="min-w-0 flex-1">
					<div className="text-[9px] font-mono uppercase tracking-[0.15em] text-nova-text-muted mb-0.5 truncate">
						{kicker}
					</div>
					<div className="text-[15px] font-display font-semibold text-nova-text truncate">
						{title}
					</div>
				</div>
				<Tooltip content="Close (Esc)" placement="left">
					<button
						type="button"
						onClick={onClose}
						aria-label="Close inspector"
						className="shrink-0 size-11 grid place-items-center rounded-lg border border-nova-border text-nova-text-muted hover:text-nova-text hover:border-nova-border-bright transition-colors cursor-pointer"
					>
						<Icon icon={tablerX} width="16" height="16" />
					</button>
				</Tooltip>
			</div>
			{/* `@container` so editor bodies can adapt to the rail's width —
			 *  the predicate/expression cards stack their operand grids in
			 *  narrow containers and go multi-column only with real room. */}
			<div className="flex-1 min-h-0 overflow-y-auto px-4 py-4 space-y-4 @container">
				{children}
			</div>
		</div>,
		portalEl,
	);
}
