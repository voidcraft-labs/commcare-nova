// components/builder/shared/SlotCardHeader.tsx
//
// Shared header chrome for optional-slot cards: violet rail, icon,
// uppercase title, hint span, and an `ml-auto` Clear button when the
// slot is defined. Owning the layout here keeps consumers from
// drifting icon sizes, rail widths, and Clear glyphs independently.
//
// Affordances compose through grouped optional props so the type
// encodes "on or absent" without half-on states. `collapse` carries
// the chevron wiring AND the disclosed region's `id` so the W3C
// disclosure pattern resolves; the chevron's aria-label flips on
// open/close so screen readers hear the action a click would take,
// not the current state. `clear` carries handler AND label as one
// slot — handler-without-label and label-without-handler don't
// typecheck.

"use client";
import { Icon, type IconifyIcon } from "@iconify/react/offline";
import tablerChevronDown from "@iconify-icons/tabler/chevron-down";
import tablerChevronRight from "@iconify-icons/tabler/chevron-right";
import tablerX from "@iconify-icons/tabler/x";

// ── Public types ──────────────────────────────────────────────────

/**
 * Optional collapse-toggle wiring. Aria-label flips on `isOpen` so
 * the click action stays self-describing for screen readers;
 * `controlsId` points the chevron's `aria-controls` at the disclosed
 * region (W3C disclosure pattern).
 */
export interface SlotCardHeaderCollapse {
	readonly isOpen: boolean;
	readonly onToggle: () => void;
	/** Aria-label when the body is currently closed (the click expands). */
	readonly expandLabel: string;
	/** Aria-label when the body is currently open (the click collapses). */
	readonly collapseLabel: string;
	/** DOM id of the disclosed region this toggle controls. The chevron
	 *  emits `aria-controls={controlsId}` so screen readers can navigate
	 *  the toggle ↔ region relationship. */
	readonly controlsId: string;
}

/**
 * Optional Clear-affordance wiring. Label is the visible button text
 * AND the `aria-label` so screen readers and visual readers see the
 * same words.
 */
export interface SlotCardHeaderClear {
	readonly onClick: () => void;
	readonly label: string;
}

export interface SlotCardHeaderProps {
	/** Header icon — the consumer's per-surface glyph (filter, eye,
	 *  forbid, etc). */
	readonly icon: IconifyIcon;
	/** Header title — short uppercase label (e.g., "Filter",
	 *  "Display condition"). */
	readonly title: string;
	/** Header hint — single-line description below the title that
	 *  tells the author what the slot does. */
	readonly description: string;
	/** Optional collapse-toggle wiring. When present, a chevron button
	 *  renders between the rail and the icon. */
	readonly collapse?: SlotCardHeaderCollapse;
	/** Optional Clear-affordance wiring. When present, an `ml-auto`
	 *  Clear button renders on the right end of the header; the
	 *  consumer drives presence (typically when the slot is defined). */
	readonly clear?: SlotCardHeaderClear;
}

// ── Component ─────────────────────────────────────────────────────

/**
 * Shared header chrome for optional-slot cards. Every consumer's
 * header reads as a sibling because the layout lives here.
 */
export function SlotCardHeader({
	icon,
	title,
	description,
	collapse,
	clear,
}: SlotCardHeaderProps) {
	return (
		<header className="space-y-1">
			<div className="flex items-center gap-2">
				<div className="w-0.5 h-3 rounded-full bg-nova-violet/40" />
				{collapse ? (
					<button
						type="button"
						onClick={collapse.onToggle}
						aria-expanded={collapse.isOpen}
						aria-controls={collapse.controlsId}
						aria-label={
							collapse.isOpen ? collapse.collapseLabel : collapse.expandLabel
						}
						className="cursor-pointer text-nova-text-muted/70 hover:text-nova-violet-bright transition-colors"
					>
						<Icon
							icon={collapse.isOpen ? tablerChevronDown : tablerChevronRight}
							width="12"
							height="12"
						/>
					</button>
				) : null}
				<Icon
					icon={icon}
					width="14"
					height="14"
					className="text-nova-violet-bright/80"
				/>
				<h3 className="text-[11px] font-semibold uppercase tracking-widest text-nova-text/90">
					{title}
				</h3>
				{clear ? (
					// Button renders only with `clear` — a cleared-slot
					// header has no stray spacer node. `whitespace-nowrap`
					// because an action label must never wrap mid-phrase.
					<button
						type="button"
						onClick={clear.onClick}
						className="ml-auto inline-flex items-center gap-1 px-2.5 min-h-11 text-[10px] uppercase tracking-wider whitespace-nowrap rounded-md text-nova-text-muted/70 hover:text-nova-error hover:bg-nova-error/10 transition-colors cursor-pointer"
						aria-label={clear.label}
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
