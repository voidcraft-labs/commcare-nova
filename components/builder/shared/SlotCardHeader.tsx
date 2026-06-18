// components/builder/shared/SlotCardHeader.tsx
//
// Shared header chrome for optional-slot cards: etched mono section
// label, hint line, optional disclosure toggle, and an `ml-auto`
// Clear button when the slot is defined. The look matches the rest
// of the inspector's console chrome (`InspectorSection`,
// `OptionalTextRow`) so a slot section reads as a sibling of the
// plain rows around it, never as a second heading system.
//
// Affordances compose through grouped optional props so the type
// encodes "on or absent" without half-on states. `collapse` makes
// the WHOLE label row the disclosure toggle (a full-height target,
// not a 12px chevron) and carries the disclosed region's `id` so the
// W3C disclosure pattern resolves; the toggle's aria-label flips on
// open/close so screen readers hear the action a click would take,
// not the current state. `clear` carries handler AND label as one
// slot — handler-without-label and label-without-handler don't
// typecheck.

"use client";
import { Icon } from "@iconify/react/offline";
import tablerChevronDown from "@iconify-icons/tabler/chevron-down";
import tablerChevronRight from "@iconify-icons/tabler/chevron-right";
import tablerX from "@iconify-icons/tabler/x";

// ── Public types ──────────────────────────────────────────────────

/**
 * Optional disclosure wiring. Aria-label flips on `isOpen` so the
 * click action stays self-describing for screen readers;
 * `controlsId` points the toggle's `aria-controls` at the disclosed
 * region (W3C disclosure pattern).
 */
export interface SlotCardHeaderCollapse {
	readonly isOpen: boolean;
	readonly onToggle: () => void;
	/** Aria-label when the body is currently closed (the click expands). */
	readonly expandLabel: string;
	/** Aria-label when the body is currently open (the click collapses). */
	readonly collapseLabel: string;
	/** DOM id of the disclosed region this toggle controls. The toggle
	 *  emits `aria-controls={controlsId}` so screen readers can navigate
	 *  the toggle ↔ region relationship. */
	readonly controlsId: string;
}

/**
 * Optional Clear-affordance wiring. The visible label can stay short
 * ("Clear" — the adjacent section title already names the slot);
 * `ariaLabel` carries the specific action for screen readers, who
 * don't get the visual adjacency.
 */
export interface SlotCardHeaderClear {
	readonly onClick: () => void;
	readonly label: string;
	readonly ariaLabel: string;
}

export interface SlotCardHeaderProps {
	/** Header title — short label rendered as the section's etched
	 *  console eyebrow (e.g., "Show when", "Excluded owners"). */
	readonly title: string;
	/** Header hint — single-line description below the title that
	 *  tells the author what the slot does. */
	readonly description: string;
	/** Optional disclosure wiring. When present, the whole label row
	 *  becomes the toggle, led by a state chevron. */
	readonly collapse?: SlotCardHeaderCollapse;
	/** Optional Clear-affordance wiring. When present, an `ml-auto`
	 *  Clear button renders on the right end of the header; the
	 *  consumer drives presence (typically when the slot is defined). */
	readonly clear?: SlotCardHeaderClear;
}

// ── Component ─────────────────────────────────────────────────────

const ETCHED_LABEL_CLS =
	"font-mono text-[10px] uppercase tracking-[0.14em] text-nova-text-muted";

/**
 * Shared header chrome for optional-slot cards. Every consumer's
 * header reads as a sibling because the layout lives here.
 */
export function SlotCardHeader({
	title,
	description,
	collapse,
	clear,
}: SlotCardHeaderProps) {
	return (
		<header className="space-y-1.5">
			<div className="flex items-center gap-2">
				{collapse ? (
					<button
						type="button"
						onClick={collapse.onToggle}
						aria-expanded={collapse.isOpen}
						aria-controls={collapse.controlsId}
						aria-label={
							collapse.isOpen ? collapse.collapseLabel : collapse.expandLabel
						}
						className="group flex-1 min-w-0 min-h-11 flex items-center gap-2 text-left cursor-pointer"
					>
						<Icon
							icon={collapse.isOpen ? tablerChevronDown : tablerChevronRight}
							width="12"
							height="12"
							className="shrink-0 text-nova-text-muted group-hover:text-nova-violet-bright transition-colors"
						/>
						<h3
							className={`${ETCHED_LABEL_CLS} group-hover:text-nova-text-secondary transition-colors`}
						>
							{title}
						</h3>
					</button>
				) : (
					<h3 className={`flex-1 min-w-0 ${ETCHED_LABEL_CLS}`}>{title}</h3>
				)}
				{clear ? (
					// Button renders only with `clear` — a cleared-slot
					// header has no stray spacer node. `whitespace-nowrap`
					// because an action label must never wrap mid-phrase.
					<button
						type="button"
						onClick={clear.onClick}
						className="shrink-0 inline-flex items-center gap-1 px-2.5 min-h-11 text-[10px] uppercase tracking-wider whitespace-nowrap rounded-md text-nova-text-muted hover:text-nova-rose hover:bg-nova-rose/10 transition-colors cursor-pointer"
						aria-label={clear.ariaLabel}
					>
						<Icon icon={tablerX} width="11" height="11" />
						<span>{clear.label}</span>
					</button>
				) : null}
			</div>
			{/* Description gets its own line — sharing the title row made
			 *  it fight the Clear action for space in narrow rails. */}
			<p className="text-[11px] leading-relaxed text-nova-text-muted">
				{description}
			</p>
		</header>
	);
}
