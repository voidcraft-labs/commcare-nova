"use client";
import { Icon } from "@iconify/react/offline";
import tablerChevronRight from "@iconify-icons/tabler/chevron-right";
import { AnimatePresence, motion } from "motion/react";
import { Fragment, memo, useState } from "react";
import { Tooltip } from "@/components/ui/Tooltip";
import { useDismissRef } from "@/hooks/useDismissRef";

/** A breadcrumb segment with a label, stable identity key, and navigation callback. */
export interface BreadcrumbPart {
	/** Stable identity derived from the underlying PreviewScreen (e.g. "home", "module-0").
	 *  Labels aren't unique — "App > Intake > Intake" is valid — so we need a
	 *  semantic key from the navigation hierarchy. */
	key: string;
	label: string;
	onClick: () => void;
}

/** Chevron separator rendered between breadcrumb segments. */
/** Chevron at full `text-nova-text-muted` (~2.9:1 on dark backgrounds) instead of
 *  the previous /50 variant (1.5:1). The chevron is a supplementary visual separator —
 *  hierarchy is conveyed by the text labels themselves — so near-3:1 is acceptable. */
const Chevron = (
	<Icon
		icon={tablerChevronRight}
		width="14"
		height="14"
		className="text-nova-text-muted shrink-0"
	/>
);

/** Shared base styles for all segments. Both ancestor and current use font-medium
 *  so the rendered text width stays constant when a segment transitions between
 *  states — preventing content shift from font-weight changes.
 *  `min-h-[44px]` ensures WCAG 2.5.8 minimum target size compliance. */
const SEGMENT_BASE =
	"font-medium shrink-0 whitespace-nowrap min-h-[44px] flex items-center";

/** Ancestor segment — muted text, clickable to navigate up. */
const ANCESTOR_CLASS = `${SEGMENT_BASE} text-nova-text-muted hover:text-nova-text transition-colors cursor-pointer`;

/** Current segment — bright text, non-interactive. */
const CURRENT_CLASS = `${SEGMENT_BASE} text-nova-text cursor-default`;

/**
 * Deep equality check for BreadcrumbPart arrays. Compares labels by value
 * and onClick by reference, so the component only re-renders when the visible
 * breadcrumb text changes (e.g. inline title edit) or the navigation structure
 * changes (different handler references from a new breadcrumbPath).
 */
function breadcrumbPartsEqual(
	prev: { parts: BreadcrumbPart[] },
	next: { parts: BreadcrumbPart[] },
): boolean {
	const a = prev.parts,
		b = next.parts;
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		if (
			a[i].key !== b[i].key ||
			a[i].label !== b[i].label ||
			a[i].onClick !== b[i].onClick
		)
			return false;
	}
	return true;
}

/**
 * Navigable breadcrumb trail for the builder subheader.
 *
 * Uses a single, stable DOM structure via `.map()` over all parts — every segment
 * is a `<button>` element, just styled differently for ancestor vs. current. This
 * prevents the layout-shifting teardown/rebuild that occurs when depth changes
 * cause branching render paths (e.g. 1-part vs 2-part layouts). Adding a new
 * depth level only appends elements; existing elements update in place.
 *
 * Collapses middle segments behind an ellipsis dropdown when depth > 3.
 * Wrapped in `memo` with deep part comparison to skip re-renders from unrelated
 * BuilderLayout state changes (chat messages, selection, etc.).
 */
export const CollapsibleBreadcrumb = memo(function CollapsibleBreadcrumb({
	parts,
}: {
	parts: BreadcrumbPart[];
}) {
	const [menuOpen, setMenuOpen] = useState(false);
	const dismissRef = useDismissRef(() => setMenuOpen(false));

	if (parts.length === 0) return null;

	/* Middle segments that get collapsed behind an ellipsis when depth > 3 */
	const needsCollapse = parts.length > 3;
	const collapsedMiddle = needsCollapse ? parts.slice(1, -1) : [];

	return (
		<nav
			className="flex items-center gap-1 text-lg min-w-0"
			aria-label="Breadcrumb"
		>
			{parts.map((part, i) => {
				const isLast = i === parts.length - 1;

				/* ── Collapsed middle: render ellipsis menu at index 1, skip rest ── */
				if (needsCollapse && i > 0 && i < parts.length - 1) {
					/* Only the first collapsed slot renders the ellipsis; the rest are hidden */
					if (i !== 1) return null;
					return (
						<Fragment key="collapse">
							{Chevron}
							<div ref={dismissRef} className="relative shrink-0">
								<button
									type="button"
									onClick={() => setMenuOpen(!menuOpen)}
									className="text-nova-text-muted hover:text-nova-text hover:bg-nova-surface min-w-[44px] min-h-[44px] flex items-center justify-center rounded-md transition-colors cursor-pointer"
								>
									&hellip;
								</button>
								<AnimatePresence>
									{menuOpen && (
										<motion.div
											initial={{ opacity: 0, y: -4, scale: 0.97 }}
											animate={{ opacity: 1, y: 0, scale: 1 }}
											exit={{
												opacity: 0,
												y: -4,
												scale: 0.97,
												/* Exit ~60% of enter duration for responsiveness (MD motion) */
												transition: { duration: 0.1, ease: [0.4, 0, 0.2, 1] },
											}}
											transition={{ duration: 0.15, ease: [0.4, 0, 0.2, 1] }}
											className="absolute left-0 top-[calc(100%+4px)] z-popover min-w-[180px] max-w-[280px] rounded-xl border border-nova-border-bright bg-nova-surface/95 backdrop-blur-xl shadow-[0_4px_16px_rgba(0,0,0,0.5)] overflow-hidden py-1"
										>
											{collapsedMiddle.map((mp) => (
												<button
													key={mp.key}
													type="button"
													onClick={() => {
														mp.onClick();
														setMenuOpen(false);
													}}
													className="w-full px-3 py-2 text-left text-sm text-nova-text-muted hover:text-nova-text hover:bg-nova-elevated/80 transition-colors cursor-pointer truncate"
												>
													{mp.label}
												</button>
											))}
										</motion.div>
									)}
								</AnimatePresence>
							</div>
						</Fragment>
					);
				}

				/* ── Standard segment: chevron (if not first) + button ── */
				return (
					<Fragment key={part.key}>
						{i > 0 && Chevron}
						<Tooltip content={part.label}>
							<button
								type="button"
								onClick={isLast ? undefined : part.onClick}
								className={isLast ? CURRENT_CLASS : ANCESTOR_CLASS}
								{...(isLast ? { "aria-current": "location" as const } : {})}
							>
								{part.label}
							</button>
						</Tooltip>
					</Fragment>
				);
			})}
		</nav>
	);
}, breadcrumbPartsEqual);
