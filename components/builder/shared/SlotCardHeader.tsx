// components/builder/shared/SlotCardHeader.tsx
//
// Shared header chrome for optional-slot cards: readable section
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
import { Button } from "@/components/shadcn/button";

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
	/** Header title — short sentence-case section label. */
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

const SECTION_LABEL_CLS =
	"text-[13px] font-semibold leading-5 text-nova-text-secondary";

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
					<h3 className="min-w-0 flex-1">
						<Button
							type="button"
							variant="ghost"
							size="xl"
							onClick={collapse.onToggle}
							aria-expanded={collapse.isOpen}
							aria-controls={collapse.controlsId}
							aria-label={
								collapse.isOpen ? collapse.collapseLabel : collapse.expandLabel
							}
							className="w-full min-w-0 justify-start gap-2 rounded-lg px-1 text-left not-disabled:hover:bg-transparent dark:not-disabled:hover:bg-transparent"
						>
							<Icon
								icon={collapse.isOpen ? tablerChevronDown : tablerChevronRight}
								width="12"
								height="12"
								className="shrink-0 text-nova-text-muted transition-colors group-hover/button:text-nova-violet-bright"
							/>
							<span
								className={`${SECTION_LABEL_CLS} transition-colors group-hover/button:text-nova-text`}
							>
								{title}
							</span>
						</Button>
					</h3>
				) : (
					<h3 className={`min-w-0 flex-1 ${SECTION_LABEL_CLS}`}>{title}</h3>
				)}
				{clear ? (
					// Button renders only with `clear` — a cleared-slot
					// header has no stray spacer node. `whitespace-nowrap`
					// because an action label must never wrap mid-phrase.
					<Button
						type="button"
						variant="ghost"
						size="xl"
						onClick={clear.onClick}
						className="shrink-0 gap-1 rounded-lg px-2.5 text-sm text-nova-text-muted not-disabled:hover:bg-nova-rose/[0.08] not-disabled:hover:text-nova-rose dark:not-disabled:hover:bg-nova-rose/[0.08]"
						aria-label={clear.ariaLabel}
					>
						<Icon icon={tablerX} width="13" height="13" />
						<span>{clear.label}</span>
					</Button>
				) : null}
			</div>
			{/* Description gets its own line — sharing the title row made
			 *  it fight the Clear action for space in narrow rails. */}
			<p className="text-[13px] leading-relaxed text-nova-text-muted">
				{description}
			</p>
		</header>
	);
}
