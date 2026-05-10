// components/builder/shared/OptionalSlotCard.tsx
//
// Generic optional-slot card primitive. Composes the shape every
// authoring surface shares when presenting a single optional value
// behind a dashed Add CTA / inline editor / Clear affordance:
//
//   1. A section header — violet rail + per-consumer icon + title +
//      hint line, plus a `ml-auto` Clear button when the slot is
//      defined. Threaded through the shared `SlotCardHeader`
//      primitive so every consumer's header reads as a sibling.
//
//   2. The body switch — consumer-supplied editor when the slot is
//      defined (via the `renderEditor` render prop); a dashed
//      "Add ..." CTA when the slot is undefined. The editor mounts
//      and unmounts in lockstep with the slot's presence — when the
//      slot is `undefined` the editor is not in the tree.
//
//   3. The validity contract — an inner shadow caches the editor's
//      `onValidityChange` verdict; the aggregate the card propagates
//      is `!slotPresent || innerValid`. The slot-presence short-
//      circuit defends against a stale `false` left behind by a
//      cleared editor leaking past the clear.
//
//   4. (Optional) A collapse affordance — when the consumer opts
//      into the `collapse` prop, the header gains a chevron toggle
//      between the rail and the icon, and the body wraps in a
//      `hidden`-toggled disclosed region. The collapse is a VISIBILITY
//      toggle, not a mount toggle: when the slot is defined, the
//      editor stays mounted across collapse state so its validity
//      verdict keeps reaching the inner shadow on every render pass.
//      Add (when the slot is undefined) flips the collapse open as a
//      side-effect so the freshly-mounted editor is immediately
//      visible.
//
// Consumers specialize the primitive with a typed `T` (Predicate
// for `PredicateSlotCard` / ValueExpression for `AdvancedSection`)
// plus a `renderEditor` render prop that mounts the matching
// tree-editor and an `addSeed` value that constructs the initial
// `T` when the author clicks Add. The primitive's `onChange` emits
// `T | undefined`; consumers route that into their source-of-truth
// (a parent slot on a doc-store entity, typically). When the
// consumer's source-of-truth shape requires a "drop key on clear"
// emit (rather than `key: undefined`), the translation lives in
// the consumer's wrapper — the primitive's `onChange(undefined)`
// is the clean trigger and the consumer shapes the emit shape from
// there.

"use client";
import { Icon, type IconifyIcon } from "@iconify/react/offline";
import tablerPlus from "@iconify-icons/tabler/plus";
import { type ReactNode, useId, useState } from "react";
import { SlotCardHeader } from "./SlotCardHeader";
import { useValidityPropagator } from "./useInnerValidityShadow";

// ── Public types ──────────────────────────────────────────────────

/**
 * Optional collapse-toggle wiring. Consumers with a collapsible body
 * pass this; consumers without one omit it and the chevron is never
 * rendered. The disclosed region's DOM id is generated internally
 * via `useId` — the consumer doesn't need to thread one through.
 */
export interface OptionalSlotCardCollapse {
	/** Initial open state on first mount. `false` collapses the body
	 *  by default (the right shape for niche affordances like the
	 *  case-search advanced cluster); `true` opens it on first render. */
	readonly defaultOpen: boolean;
	/** Aria-label when the body is closed (the click expands). */
	readonly expandLabel: string;
	/** Aria-label when the body is open (the click collapses). */
	readonly collapseLabel: string;
}

export interface OptionalSlotCardProps<T> {
	/** Header icon — the consumer's per-surface glyph (filter, eye,
	 *  forbid, etc). Threaded through to `SlotCardHeader`. */
	readonly icon: IconifyIcon;
	/** Header title — short uppercase label (e.g., "Filter",
	 *  "Display condition"). */
	readonly title: string;
	/** Header hint — single-line description below the title that
	 *  tells the author what the slot does. */
	readonly description: string;
	/** Empty-state CTA label. Used as the dashed "Add ..." button's
	 *  visible text AND `aria-label` so screen readers and visual
	 *  readers see the same words. */
	readonly addLabel: string;
	/** Header "Clear ..." label — visible button text + `aria-label`.
	 *  Surfaces only when `value !== undefined`. */
	readonly clearLabel: string;
	/** Current slot value. `undefined` ≡ slot empty (the card surfaces
	 *  the dashed Add affordance and reports trivially-valid). */
	readonly value: T | undefined;
	/** Fired when the slot transitions. Receives `undefined` on Clear;
	 *  receives a freshly-seeded `T` on Add (built from `addSeed`); and
	 *  receives the editor's emitted `T` on every inner edit. The
	 *  consumer routes this back into its source-of-truth. */
	readonly onChange: (next: T | undefined) => void;
	/** Add-seed value. Cloned by reference into `onChange` when the
	 *  author clicks the dashed Add CTA, so consumers can pass a
	 *  pre-built typed AST node (e.g., `matchAll()` for Predicate,
	 *  `term(literal(""))` for ValueExpression). The primitive treats
	 *  this as opaque and never inspects its shape. */
	readonly addSeed: T;
	/** Editor render prop — mounted whenever `value !== undefined`.
	 *  Receives the present value, the inner `onChange` (consumers
	 *  pipe this back into the primitive's `onChange`), and the
	 *  validity callback (consumers pipe this into the editor's
	 *  `onValidityChange` so the inner shadow stays current). */
	readonly renderEditor: (
		value: T,
		onChange: (next: T) => void,
		onValidityChange: (valid: boolean) => void,
	) => ReactNode;
	/** Optional collapse-toggle wiring. When present, the header
	 *  gains a chevron toggle and the body wraps in a `hidden`-toggled
	 *  region. When omitted, the body is always visible. */
	readonly collapse?: OptionalSlotCardCollapse;
	/** Aggregated validity verdict. `true` when the slot is undefined
	 *  OR the editor's verdict is `true`; `false` when a defined value
	 *  fails its inner verdict. */
	readonly onValidityChange?: (valid: boolean) => void;
}

// ── Component ─────────────────────────────────────────────────────

/**
 * Optional-slot card primitive. Owns the shared chrome (header +
 * dashed Add CTA + editor wrapper + slot-presence validity short-
 * circuit + optional collapse) every authoring surface composes
 * around an optional `T`-typed slot.
 *
 * Validity contract: when `value === undefined` the card reports
 * `valid: true` regardless of any stale inner shadow. Without the
 * slot-presence short-circuit, a stale `false` left behind by a
 * cleared editor would leak past the clear — the section's parent
 * would still see the cleared slot reporting invalid until the next
 * editor mount overwrote the shadow.
 */
export function OptionalSlotCard<T>({
	icon,
	title,
	description,
	addLabel,
	clearLabel,
	value,
	onChange,
	addSeed,
	renderEditor,
	collapse,
	onValidityChange,
}: OptionalSlotCardProps<T>) {
	// Inner editor verdict shadow. Default `true` — when the slot is
	// undefined, the editor is unmounted and the verdict stays
	// trivially valid. When the slot is defined, the editor's
	// `onValidityChange` overrides this on its first effect tick.
	const [innerValid, setInnerValid] = useState(true);

	// Collapse open state. `useId` and `useState` MUST run unconditionally
	// (hook rules), so both fire whether or not the consumer passes
	// `collapse`. The `defaultOpen` initializer falls back to `true` when
	// collapse is absent — the open state is unread in that case anyway,
	// since the body is never wrapped in a `hidden`-toggled region.
	const [isOpen, setIsOpen] = useState(collapse?.defaultOpen ?? true);
	const regionId = useId();

	const slotPresent = value !== undefined;
	// Slot-presence short-circuit. When the slot is undefined the card
	// is trivially valid regardless of `innerValid`'s stash.
	const isValid = !slotPresent || innerValid;
	useValidityPropagator({ isValid, onValidityChange });

	// ── Mutators ──
	const handleAdd = () => {
		onChange(addSeed);
		// When the consumer opted into collapse, opening the body on
		// Add makes the freshly-mounted editor immediately visible —
		// otherwise the author would click Add and see no result.
		if (collapse) setIsOpen(true);
	};
	const handleClear = () => {
		onChange(undefined);
	};

	// Body content — the editor when the slot is defined, the dashed
	// Add CTA when the slot is undefined. Hoisted into a const so the
	// optional-collapse wrapper can wrap it once below without
	// duplicating the ternary. Reuses the `slotPresent` constant from
	// the validity short-circuit so the body branch and the validity
	// branch read off one source.
	const body = slotPresent ? (
		// Defined slot: render the consumer's editor inside the
		// shared violet-tinted wrapper. The editor receives the
		// inner-validity callback so the shadow stays current; the
		// inner `onChange` pipes back into the primitive's
		// `onChange` unchanged (consumers route at the boundary).
		<div className="rounded-md border border-white/[0.04] bg-nova-surface/30 p-3">
			{renderEditor(value, onChange, setInnerValid)}
		</div>
	) : (
		// Undefined slot: dashed Add CTA. Same className pattern
		// every authoring surface uses for an empty-state add row.
		<button
			type="button"
			onClick={handleAdd}
			className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2.5 text-[11px] rounded-md border border-dashed border-white/[0.10] text-nova-text-muted/80 hover:text-nova-violet-bright hover:border-nova-violet/30 transition-colors cursor-pointer"
			aria-label={addLabel}
		>
			<Icon icon={tablerPlus} width="12" height="12" />
			<span>{addLabel}</span>
		</button>
	);

	return (
		<div className="space-y-3">
			<SlotCardHeader
				icon={icon}
				title={title}
				description={description}
				collapse={
					collapse
						? {
								isOpen,
								onToggle: () => setIsOpen((prev) => !prev),
								expandLabel: collapse.expandLabel,
								collapseLabel: collapse.collapseLabel,
								controlsId: regionId,
							}
						: undefined
				}
				clear={
					slotPresent ? { onClick: handleClear, label: clearLabel } : undefined
				}
			/>
			{collapse ? (
				// Collapsed-aware body wrapper. The wrapper carries the
				// id the chevron's `aria-controls` points at, so the W3C
				// disclosure relationship resolves uniformly across all
				// four (collapsed/open × undefined/defined) states.
				// `hidden={!isOpen}` puts the visibility toggle on the
				// wrapper, not on the inner conditional, so a closed-
				// undefined render keeps the region present in the DOM
				// (empty body, but resolvable via `aria-controls`).
				<div id={regionId} hidden={!isOpen}>
					{body}
				</div>
			) : (
				body
			)}
		</div>
	);
}
