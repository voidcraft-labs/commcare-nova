// components/builder/shared/SlotCardHeader.tsx
//
// Shared section-header chrome for optional-slot cards. Multiple
// section authoring surfaces present a slot (Predicate, ValueExpression)
// behind the same header shape — violet rail, icon, uppercase title,
// hint span, and a `ml-auto` Clear button that surfaces when the slot
// is defined. This component owns that chrome so consumers can't drift
// each one's layout (icon size, rail width, Clear glyph) independently.
//
// Two consumers at landing time:
//
//   - `PredicateSlotCard` — the optional-Predicate slot primitive
//     (filter, search-button display condition). No collapse — the
//     editor mounts when the slot is defined.
//   - `AdvancedSection` — the case-search advanced cluster's
//     `blacklistedOwnerIds` ValueExpression slot. Niche affordance, so
//     the body collapses by default and the header carries a chevron
//     toggle between the rail and the icon.
//
// The chevron is opt-in via the `collapse` prop. Consumers without a
// collapse affordance (PredicateSlotCard) simply omit the prop and the
// chevron is never rendered. The chevron's aria-label flips on open/
// close (`expandLabel` ↔ `collapseLabel`) so screen readers see the
// action the click would take, not the current state.
//
// The Clear button is opt-in via `onClear` — the consumer drives whether
// the slot is "present enough" to clear (typically `value !== undefined`)
// and passes the handler. Without `onClear`, no Clear button renders.
// Aria-label uses the consumer-supplied `clearLabel` so the visible
// text and the accessible name read identically.

"use client";
import { Icon, type IconifyIcon } from "@iconify/react/offline";
import tablerChevronDown from "@iconify-icons/tabler/chevron-down";
import tablerChevronRight from "@iconify-icons/tabler/chevron-right";
import tablerX from "@iconify-icons/tabler/x";

// ── Public types ──────────────────────────────────────────────────

/**
 * Optional collapse-toggle wiring. Consumers with a collapsible body
 * pass this; consumers without one omit it and the chevron is never
 * rendered. Aria-label on the toggle flips on `isOpen` so the click
 * action stays self-describing for screen readers.
 */
export interface SlotCardHeaderCollapse {
	readonly isOpen: boolean;
	readonly onToggle: () => void;
	/** Aria-label when the body is currently closed (the click expands). */
	readonly expandLabel: string;
	/** Aria-label when the body is currently open (the click collapses). */
	readonly collapseLabel: string;
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
	/** Clear handler. When present, a `ml-auto` Clear button renders
	 *  on the right end of the header. The consumer decides when the
	 *  Clear affordance is reachable (typically when the slot is
	 *  defined). */
	readonly onClear?: () => void;
	/** Aria-label and visible button text for the Clear affordance.
	 *  Required when `onClear` is supplied. */
	readonly clearLabel?: string;
}

// ── Component ─────────────────────────────────────────────────────

/**
 * Shared header chrome for optional-slot cards. Renders the violet
 * rail, optional collapse chevron, icon, title, hint span, and the
 * `ml-auto` Clear affordance — every consumer's header reads as a
 * sibling of every other consumer's because the layout lives here.
 */
export function SlotCardHeader({
	icon,
	title,
	description,
	collapse,
	onClear,
	clearLabel,
}: SlotCardHeaderProps) {
	return (
		<header className="flex items-baseline gap-2">
			<div className="w-0.5 h-3 rounded-full bg-nova-violet/40 self-center" />
			{collapse ? (
				<button
					type="button"
					onClick={collapse.onToggle}
					aria-expanded={collapse.isOpen}
					aria-label={
						collapse.isOpen ? collapse.collapseLabel : collapse.expandLabel
					}
					className="self-center cursor-pointer text-nova-text-muted/70 hover:text-nova-violet-bright transition-colors"
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
				className="text-nova-violet-bright/80 self-center"
			/>
			<h3 className="text-[11px] font-semibold uppercase tracking-widest text-nova-text/90">
				{title}
			</h3>
			<span className="ml-1 text-[10px] text-nova-text-muted/70">
				{description}
			</span>
			<div className="ml-auto">
				{onClear && clearLabel ? (
					<button
						type="button"
						onClick={onClear}
						className="inline-flex items-center gap-1 px-2 py-1 text-[10px] rounded-md text-nova-text-muted/70 hover:text-nova-error hover:bg-nova-error/10 transition-colors cursor-pointer"
						aria-label={clearLabel}
					>
						<Icon icon={tablerX} width="11" height="11" />
						<span>{clearLabel}</span>
					</button>
				) : null}
			</div>
		</header>
	);
}
