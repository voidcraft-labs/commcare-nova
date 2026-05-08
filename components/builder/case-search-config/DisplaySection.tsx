// components/builder/case-search-config/DisplaySection.tsx
//
// Composes the case-search authoring surface's Display section. Owns
// six independent slots on `caseSearchConfig`'s display cluster — the
// labels and one optional predicate that together author the chrome
// the running app shows on the case-search screen:
//
//   1. `searchScreenTitle: string?` — title above the search inputs
//      (e.g., "Find a patient").
//   2. `searchScreenSubtitle: string?` — subtitle rendered below the
//      title with markdown formatting (bold, links, lists). The
//      author writes free-form markdown; the running app's runtime
//      renders it through the same markdown formatter the rest of
//      the product uses for user-authored copy.
//   3. `emptyListText: string?` — the message shown when the search
//      returns zero results.
//   4. `searchButtonLabel: string?` — label on the "Search" button.
//   5. `searchAgainButtonLabel: string?` — label on the "Search
//      Again" button shown after results render.
//   6. `searchButtonDisplayCondition: Predicate?` — when present,
//      gates the search button's visibility (the runtime hides the
//      button until the predicate evaluates true). Mounted via the
//      shared `<PredicateSlotCard>` primitive — the same primitive
//      the Filters and Claim sections consume for their optional
//      predicate slots.
//
// The five text slots have no validity beyond empty-vs-set; an
// empty string clears the slot (the per-key setter writes
// `undefined` so strict-parse drops the key on the next mount).
// The single validity-bearing slot is the predicate, and
// `PredicateSlotCard` already applies the slot-presence short-
// circuit internally — the section just forwards the verdict it
// receives from the card to its own parent.
//
// `caseSearchConfig` itself is OPTIONAL on the Module schema (the
// shared `nextConfig` helper seeds `{ dontClaimAlreadyOwned: false }`
// on first edit) so a module that has not authored a case-search
// configuration receives a fully-formed config the moment any one
// of these six slots takes its first value.

"use client";
import tablerEye from "@iconify-icons/tabler/eye";
import { useId, useState } from "react";
import { PredicateSlotCard } from "@/components/builder/shared/PredicateSlotCard";
import { useValidityPropagator } from "@/components/builder/shared/useInnerValidityShadow";
import type { CaseSearchConfig, CaseType } from "@/lib/domain";
import type { Predicate, SearchInputDecl } from "@/lib/domain/predicate";
import { PreviewMarkdown } from "@/lib/markdown";
import { useCommitField } from "@/lib/ui/hooks/useCommitField";
import { nextConfig } from "./nextConfig";

// ── Public types ──────────────────────────────────────────────────

export interface DisplaySectionProps {
	/** Current case-search configuration. `undefined` means the
	 *  module has no caseSearchConfig authored yet — first edit
	 *  through this section seeds the slot with
	 *  `{ dontClaimAlreadyOwned: false }` plus the changed sub-slot. */
	readonly value: CaseSearchConfig | undefined;
	/** Fired with the next configuration. The parent applies the
	 *  next config to its source-of-truth (the doc store's module
	 *  `caseSearchConfig` slot). Each onChange carries a fully-formed
	 *  `CaseSearchConfig` — the seed pattern lives inside the shared
	 *  `nextConfig` helper. */
	readonly onChange: (next: CaseSearchConfig) => void;
	/** Blueprint case-type definitions — drives the property pickers
	 *  inside the predicate editor mounted on the
	 *  `searchButtonDisplayCondition` slot. */
	readonly caseTypes: readonly CaseType[];
	/** The case-type the search runs against. Property references in
	 *  the search-button display condition resolve against this scope;
	 *  relation walks inside `exists`/`missing` flip the destination
	 *  scope as authored. */
	readonly currentCaseType: string;
	/** Search-input declarations from the parent screen. Threaded
	 *  into the predicate editor so an `input(...)` term resolves
	 *  the binding name. The case-search-config panel draws these
	 *  from `mod.caseListConfig?.searchInputs ?? []`. */
	readonly knownInputs?: readonly SearchInputDecl[];
	/** Aggregated validity verdict. `true` when the search-button
	 *  display-condition slot is undefined OR its predicate type-
	 *  checks (the only validity-bearing slot in this section). The
	 *  parent gates its save affordance on this. */
	readonly onValidityChange?: (valid: boolean) => void;
}

// ── Optional-text-slot row ────────────────────────────────────────
//
// One row primitive that drives every label slot in this section.
// Two layout variants vary on the textarea-vs-input flag and the
// presence of a markdown live preview; every other piece (label
// chrome, hint line, blur-commit handshake, empty-clears
// normalization) is identical across all six visible rows.
//
// Empty-string-clears comes from `useCommitField`'s `onEmpty`
// callback — when the user empties the input and blurs, the hook
// fires `onEmpty()` rather than `onSave("")`. The row converts
// that to `onCommit(undefined)` so the parent's strict-parse drops
// the key on the next mount. `useCommitField` also `trim()`s before
// commit, which means a value of `"   "` round-trips to "empty" —
// the right behavior for label slots where surrounding whitespace
// is a typo, not intent.

interface OptionalTextRowProps {
	readonly label: string;
	readonly hint: string;
	readonly value: string | undefined;
	readonly onCommit: (next: string | undefined) => void;
	readonly placeholder?: string;
	/** When `true`, the row renders a `<textarea>` + a "Markdown"
	 *  badge + a live `<PreviewMarkdown />` panel beneath. When
	 *  `false` (default), the row renders a single-line
	 *  `<input type="text">` with no preview. */
	readonly markdown?: boolean;
}

function OptionalTextRow({
	label,
	hint,
	value,
	onCommit,
	placeholder,
	markdown = false,
}: OptionalTextRowProps) {
	const inputId = useId();
	// Convert `string | undefined` ↔ `string` at the hook boundary.
	// `useCommitField` requires a defined `value: string` and pairs
	// `onSave: string -> void` with `onEmpty: () -> void` for the
	// "empty commit" path — exactly the empty-string-clears semantic
	// the schema's `optional()` slots want.
	const { draft, setDraft, ref, handleFocus, handleBlur, handleKeyDown } =
		useCommitField({
			value: value ?? "",
			onSave: (next) => onCommit(next),
			onEmpty: () => onCommit(undefined),
			multiline: markdown,
		});

	return (
		<div className="flex flex-col gap-1.5">
			<div className="flex items-center gap-2">
				<label
					htmlFor={inputId}
					className="text-[11px] font-semibold uppercase tracking-widest text-nova-text/90"
				>
					{label}
				</label>
				{markdown ? (
					// Markdown affordance badge — without it the textarea
					// looks identical to the plain-text rows and the
					// author has no way to tell this slot accepts
					// formatting.
					<span className="inline-flex items-center px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider rounded bg-nova-violet/15 text-nova-violet-bright/90 border border-nova-violet/20">
						Markdown
					</span>
				) : null}
			</div>
			{markdown ? (
				<textarea
					id={inputId}
					ref={ref as React.RefCallback<HTMLTextAreaElement>}
					value={draft}
					onChange={(e) => setDraft(e.target.value)}
					onFocus={handleFocus}
					onBlur={handleBlur}
					onKeyDown={handleKeyDown}
					autoComplete="off"
					data-1p-ignore
					placeholder={placeholder}
					rows={3}
					className="w-full px-2 py-1.5 text-xs rounded-md border border-white/[0.06] bg-nova-deep/50 text-nova-text placeholder:text-nova-text-muted/60 focus:outline-none focus:ring-1 focus:border-nova-violet/40 focus:ring-nova-violet/30 transition-colors resize-none"
				/>
			) : (
				<input
					id={inputId}
					ref={ref as React.RefCallback<HTMLInputElement>}
					type="text"
					value={draft}
					onChange={(e) => setDraft(e.target.value)}
					onFocus={handleFocus}
					onBlur={handleBlur}
					onKeyDown={handleKeyDown}
					autoComplete="off"
					data-1p-ignore
					placeholder={placeholder}
					className="w-full px-2 py-1.5 text-xs rounded-md border border-white/[0.06] bg-nova-deep/50 text-nova-text placeholder:text-nova-text-muted/60 focus:outline-none focus:ring-1 focus:border-nova-violet/40 focus:ring-nova-violet/30 transition-colors"
				/>
			)}
			<span className="text-[10px] text-nova-text-muted/70">{hint}</span>
			{markdown && draft.trim().length > 0 ? (
				// Live preview of the markdown the author is typing.
				// Visual-only — the textarea above carries the
				// accessible name from its `<label>`, so the preview
				// node itself doesn't need its own aria attributes.
				<div className="rounded-md border border-white/[0.04] bg-nova-surface/30 p-2 preview-markdown text-xs text-nova-text-muted">
					<PreviewMarkdown>{draft}</PreviewMarkdown>
				</div>
			) : null}
		</div>
	);
}

// ── Top-level component ───────────────────────────────────────────

/**
 * Composes the display cluster of the case-search authoring surface.
 * Renders five plain text inputs, one markdown textarea with a live
 * preview, and the optional `searchButtonDisplayCondition` slot via
 * `PredicateSlotCard`. The section's overall validity is the
 * predicate slot's verdict — every other slot is structurally always
 * valid (free-form strings).
 */
export function DisplaySection({
	value,
	onChange,
	caseTypes,
	currentCaseType,
	knownInputs = [],
	onValidityChange,
}: DisplaySectionProps) {
	// `PredicateSlotCard` already applies its own slot-presence
	// short-circuit — when the slot is undefined the card reports
	// `valid: true` regardless of any stale inner shadow. The section
	// just caches the card's verdict and forwards it to its parent
	// via the standardized propagator (handles fresh-each-render
	// callback identity).
	const [predicateValid, setPredicateValid] = useState(true);
	useValidityPropagator({ isValid: predicateValid, onValidityChange });

	// Per-slot mutators. Each routes through the shared `nextConfig`
	// seed helper so the emitted shape always carries
	// `dontClaimAlreadyOwned: false` even when the parent value is
	// undefined. Setting a slot to `undefined` clears it — strict
	// parse on the next mount drops the key.
	const setSearchScreenTitle = (next: string | undefined) => {
		onChange(nextConfig(value, { searchScreenTitle: next }));
	};
	const setSearchScreenSubtitle = (next: string | undefined) => {
		onChange(nextConfig(value, { searchScreenSubtitle: next }));
	};
	const setEmptyListText = (next: string | undefined) => {
		onChange(nextConfig(value, { emptyListText: next }));
	};
	const setSearchButtonLabel = (next: string | undefined) => {
		onChange(nextConfig(value, { searchButtonLabel: next }));
	};
	const setSearchAgainButtonLabel = (next: string | undefined) => {
		onChange(nextConfig(value, { searchAgainButtonLabel: next }));
	};
	const setSearchButtonDisplayCondition = (next: Predicate | undefined) => {
		onChange(nextConfig(value, { searchButtonDisplayCondition: next }));
	};

	return (
		<div className="space-y-6">
			{/* ── Title + subtitle pair ──
			    Sit at the top because they govern the screen's overall
			    chrome — the user reads them first when arriving at the
			    case-search screen. */}
			<OptionalTextRow
				label="Title"
				hint="Shown above the search inputs."
				value={value?.searchScreenTitle}
				onCommit={setSearchScreenTitle}
				placeholder="Find a patient"
			/>

			<OptionalTextRow
				label="Subtitle"
				hint="Shown below the title. Supports markdown — bold, links, and lists."
				value={value?.searchScreenSubtitle}
				onCommit={setSearchScreenSubtitle}
				placeholder="Search by name, date of birth, or village."
				markdown
			/>

			{/* ── Empty-list text ──
			    Surfaces only when the search returns zero results;
			    grouped here with the other labels because it's a
			    response-side label rather than a button-side label. */}
			<OptionalTextRow
				label="Empty results message"
				hint="Shown when the search returns no matching cases."
				value={value?.emptyListText}
				onCommit={setEmptyListText}
				placeholder="No patients matched. Try widening your search."
			/>

			{/* ── Button labels pair ──
			    Two related slots. Defaults vary at the runtime layer;
			    these are the author's overrides. */}
			<OptionalTextRow
				label="Search button label"
				hint="Label on the search button before results have rendered."
				value={value?.searchButtonLabel}
				onCommit={setSearchButtonLabel}
				placeholder="Search"
			/>

			<OptionalTextRow
				label="Search-again button label"
				hint="Label on the search-again button shown after results render."
				value={value?.searchAgainButtonLabel}
				onCommit={setSearchAgainButtonLabel}
				placeholder="Search again"
			/>

			{/* ── Search-button display condition ──
			    Optional predicate. When present, the runtime hides the
			    search button until this evaluates true. Delegated
			    wholesale to `PredicateSlotCard` — the primitive owns
			    the header chrome, the add/clear affordances, the
			    `matchAll()` seed on Add, and the slot-presence
			    validity short-circuit. */}
			<PredicateSlotCard
				icon={tablerEye}
				title="Display condition"
				description="Hide the search button until this condition is met."
				addLabel="Add display condition"
				clearLabel="Clear display condition"
				value={value?.searchButtonDisplayCondition}
				onChange={setSearchButtonDisplayCondition}
				caseTypes={caseTypes}
				currentCaseType={currentCaseType}
				knownInputs={knownInputs}
				onValidityChange={setPredicateValid}
			/>
		</div>
	);
}
