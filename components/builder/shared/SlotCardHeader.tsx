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
// Affordances compose through grouped optional props so the type
// system encodes "either this surface is on, or it's absent" without
// half-on states:
//
//   - `collapse` carries the chevron toggle wiring AND the disclosed
//     region's `id` (so the chevron's `aria-controls` points at the
//     consumer's body wrapper per the W3C disclosure pattern). The
//     chevron's aria-label flips on open/close (`expandLabel` ↔
//     `collapseLabel`) so screen readers see the action the click would
//     take, not the current state.
//   - `clear` carries the click handler AND the visible / accessible
//     label as one slot — handler-without-label and label-without-
//     handler are unrepresentable, so a future consumer can't ship a
//     silent no-op or an unlabelled button.

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
 * action stays self-describing for screen readers; `controlsId` is
 * the disclosed region's DOM id so the chevron's `aria-controls`
 * points at it (W3C disclosure pattern).
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
 * Optional Clear-affordance wiring. Pairing the handler with its label
 * in one slot makes "handler without label" and "label without handler"
 * unrepresentable — a regression that drops one half fails the build.
 * The label is used both as visible button text AND as `aria-label`
 * so visual readers and screen readers see the same words.
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
	clear,
}: SlotCardHeaderProps) {
	return (
		<header className="flex items-baseline gap-2">
			<div className="w-0.5 h-3 rounded-full bg-nova-violet/40 self-center" />
			{collapse ? (
				<button
					type="button"
					onClick={collapse.onToggle}
					aria-expanded={collapse.isOpen}
					aria-controls={collapse.controlsId}
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
				{clear ? (
					<button
						type="button"
						onClick={clear.onClick}
						className="inline-flex items-center gap-1 px-2 py-1 text-[10px] rounded-md text-nova-text-muted/70 hover:text-nova-error hover:bg-nova-error/10 transition-colors cursor-pointer"
						aria-label={clear.label}
					>
						<Icon icon={tablerX} width="11" height="11" />
						<span>{clear.label}</span>
					</button>
				) : null}
			</div>
		</header>
	);
}
