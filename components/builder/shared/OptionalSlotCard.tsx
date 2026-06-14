// components/builder/shared/OptionalSlotCard.tsx
//
// Generic optional-slot card primitive. Owns the shape every authoring
// surface shares around a single optional value: section header
// (etched console label + hint, with a Clear button when the slot is
// defined), body switch (consumer-supplied editor when set, dashed
// "Add ..." CTA when unset), validity short-circuit, and an optional
// collapse affordance.
//
// Consumers specialize with a typed `T` plus a `renderEditor` render
// prop and an `addSeed` value. `onChange(T | undefined)` emits into
// the consumer's source-of-truth; routing the `undefined` clear into
// a "drop key" emit on the doc store is the consumer's call.
//
// The collapse is a visibility toggle, not a mount toggle — when the
// slot is defined, the editor stays mounted across collapse state so
// its validity verdict keeps reaching the inner shadow.

"use client";
import { Icon } from "@iconify/react/offline";
import tablerPlus from "@iconify-icons/tabler/plus";
import { type ReactNode, useId, useState } from "react";
import { SlotCardHeader } from "./SlotCardHeader";
import { useValidityPropagator } from "./useInnerValidityShadow";

// ── Public types ──────────────────────────────────────────────────

/**
 * Optional collapse-toggle wiring. The disclosed region's DOM id
 * comes from an internal `useId` — the consumer doesn't thread one
 * through.
 */
export interface OptionalSlotCardCollapse {
	/** Initial open state on first mount. `false` collapses the body
	 *  by default; `true` opens it on first render. */
	readonly defaultOpen: boolean;
	/** Aria-label when the body is closed (the click expands). */
	readonly expandLabel: string;
	/** Aria-label when the body is open (the click collapses). */
	readonly collapseLabel: string;
}

export interface OptionalSlotCardProps<T> {
	/** Header title — short label rendered as the section's etched
	 *  console eyebrow (e.g., "Excluded owners"). */
	readonly title: string;
	/** Header hint — single-line description below the title that
	 *  tells the author what the slot does. */
	readonly description: string;
	/** Empty-state CTA label. Used as the dashed "Add ..." button's
	 *  visible text AND `aria-label` so screen readers and visual
	 *  readers see the same words. */
	readonly addLabel: string;
	/** Header Clear button — short visible text (the section title
	 *  beside it already names the slot). Surfaces only when
	 *  `value !== undefined`. */
	readonly clearLabel: string;
	/** Screen-reader name for the Clear button — the specific action
	 *  ("Clear the excluded owners"), since SRs don't get the
	 *  visual adjacency to the section title. */
	readonly clearAriaLabel: string;
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
 * Optional-slot card primitive. The validity short-circuit is load-
 * bearing: when `value === undefined` the card reports `valid: true`
 * regardless of any stale inner shadow. Without it, a stale `false`
 * left behind by a cleared editor leaks past the clear and the
 * parent keeps seeing the cleared slot as invalid until the next
 * editor mount overwrites the shadow.
 */
export function OptionalSlotCard<T>({
	title,
	description,
	addLabel,
	clearLabel,
	clearAriaLabel,
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
	const isValid = !slotPresent || innerValid;
	useValidityPropagator({ isValid, onValidityChange });

	const handleAdd = () => {
		onChange(addSeed);
	};
	const handleClear = () => {
		onChange(undefined);
	};

	// `slotPresent` reused so the body branch and the validity branch
	// read off one source.
	// No wrapper well around the editor — predicate / expression rows
	// carry their own surfaces, and a second frame around them reads
	// as a box inside a box.
	const body = slotPresent ? (
		renderEditor(value, onChange, setInnerValid)
	) : (
		<button
			type="button"
			onClick={handleAdd}
			className="w-full inline-flex items-center justify-center gap-2 px-3 min-h-11 text-[13px] rounded-lg border border-dashed border-white/[0.10] text-nova-text-muted hover:text-nova-violet-bright hover:border-nova-violet/30 transition-colors cursor-pointer"
			aria-label={addLabel}
		>
			<Icon icon={tablerPlus} width="14" height="14" />
			<span>{addLabel}</span>
		</button>
	);

	return (
		<div className="space-y-3">
			<SlotCardHeader
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
					slotPresent
						? {
								onClick: handleClear,
								label: clearLabel,
								ariaLabel: clearAriaLabel,
							}
						: undefined
				}
			/>
			{collapse ? (
				// `hidden={!isOpen}` toggles on the wrapper, not on the
				// inner conditional, so the region stays present in the
				// DOM and resolvable via `aria-controls` across all four
				// (collapsed/open × undefined/defined) states.
				<div id={regionId} hidden={!isOpen}>
					{body}
				</div>
			) : (
				body
			)}
		</div>
	);
}
