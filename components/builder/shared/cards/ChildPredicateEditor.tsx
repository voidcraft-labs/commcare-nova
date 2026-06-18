// components/builder/shared/cards/ChildPredicateEditor.tsx
//
// Dispatch shell for a single predicate node — looks up the
// schema entry for `value.kind`, delegates rendering to the
// matched card, and frames the card with a kind-replacing menu so
// authors can swap a clause's operator without re-creating the
// surrounding structure.
//
// This is the recursive entry point used by every card that holds
// a nested clause (`not.clause`, `when-input-present.clause`,
// `exists.where`, `and.clauses[i]`, `or.clauses[i]`). The
// PredicateCardEditor at the top of the tree mounts the same
// shell at the root.

"use client";
import { Menu } from "@base-ui/react/menu";
import { Icon } from "@iconify/react/offline";
import { useRef } from "react";
import {
	ANY_CONSTRAINT,
	and,
	COMPARISON_KINDS,
	type ComparisonKind,
	exists,
	isBlank,
	isNull,
	missing,
	or,
	type Predicate,
	type SlotConstraint,
} from "@/lib/domain/predicate";
import {
	MENU_ITEM_CLS,
	MENU_POPUP_CLS,
	MENU_POSITIONER_CLS,
} from "@/lib/styles";
import { useEditorErrorsAt, usePredicateEditContext } from "../editorContext";
import {
	type PredicateCardSchema,
	type PredicateEditContext,
	predicateCardSchemaList,
	predicateCardSchemas,
} from "../editorSchemas";
import type { EditorPath } from "../path";
import { CardShell, PredicateRowShell } from "../primitives/CardShell";
import { KIND_BUILDERS as COMPARISON_BUILDERS } from "./ComparisonCard";

interface ChildPredicateEditorProps {
	readonly value: Predicate;
	readonly onChange: (next: Predicate) => void;
	readonly path: EditorPath;
	/**
	 * Optional remove handler — when provided, the card surfaces a
	 * "Delete" item in its kebab menu. Cards inside an `and`/`or`
	 * clause list, under a `not` wrapper, etc. carry the affordance;
	 * the top-level editor passes `undefined` (the root card cannot
	 * be deleted, only replaced).
	 */
	readonly onRemove?: () => void;
	/**
	 * Display variant — the top-level card uses `"normal"`; nested
	 * children inside a logical group use `"nested"` so the parent
	 * group's accent doesn't fight the child's surface.
	 */
	readonly variant?: "normal" | "nested";
	/**
	 * Optional ref-callback the parent installs on the card shell's
	 * grip handle for native drag binding. When undefined, the grip
	 * does not render — only cards inside an `and` / `or` clause
	 * list carry a drag affordance.
	 */
	readonly dragHandleRef?: (el: HTMLElement | null) => void;
	/**
	 * The slot's type constraint — threaded for signature uniformity
	 * with the ValueExpression-side `ExpressionPicker`. A Predicate has
	 * no result type, so every clause recurses with `ANY_CONSTRAINT`
	 * and predicate cards compute their own child constraints from
	 * `useResolvedType` rather than reading the incoming one.
	 */
	readonly constraint?: SlotConstraint;
}

/** Sentence-shaped kinds — these render headerless rows whose verb
 *  chip (the in-card `PredicateVerbMenu`) carries the operation AND
 *  the kind switching. Container kinds keep the titled card shell. */
const SENTENCE_KINDS: ReadonlySet<Predicate["kind"]> = new Set([
	...COMPARISON_KINDS,
	"in",
	"between",
	"match",
	"multi-select-contains",
	"within-distance",
	"is-null",
	"is-blank",
	"match-all",
	"match-none",
]);

/**
 * Render one predicate node. Sentence-shaped kinds (comparisons,
 * matches, membership, blank/missing, the sentinels) render as
 * headerless rows — the condition reads as subject–verb–object, and
 * the verb chip inside the row owns both the operation and the
 * kind switching. Container kinds (groups, related-case lookups,
 * the when-field gate) keep the titled `CardShell` with the
 * kind-replace menu in the header.
 */
export function ChildPredicateEditor({
	value,
	onChange,
	path,
	onRemove,
	variant = "normal",
	dragHandleRef,
	constraint = ANY_CONSTRAINT,
}: ChildPredicateEditorProps) {
	const operatorErrors = useEditorErrorsAt(path);
	const schema = predicateCardSchemas[value.kind];
	const Component = schema.component as React.ComponentType<{
		value: Predicate;
		onChange: (next: Predicate) => void;
		path: EditorPath;
		constraint?: SlotConstraint;
	}>;

	if (SENTENCE_KINDS.has(value.kind)) {
		return (
			<PredicateRowShell
				variant={variant}
				onRemove={onRemove}
				dragHandleRef={dragHandleRef}
				errors={operatorErrors}
			>
				<Component
					value={value}
					onChange={onChange}
					path={path}
					constraint={constraint}
				/>
			</PredicateRowShell>
		);
	}

	return (
		<CardShell
			icon={schema.icon}
			label={schema.label}
			variant={variant}
			onRemove={onRemove}
			dragHandleRef={dragHandleRef}
			errors={operatorErrors}
			kindAccent={<KindReplaceMenu currentValue={value} onChange={onChange} />}
		>
			<Component
				value={value}
				onChange={onChange}
				path={path}
				constraint={constraint}
			/>
		</CardShell>
	);
}

interface KindReplaceMenuProps {
	readonly currentValue: Predicate;
	readonly onChange: (next: Predicate) => void;
}

/** Comparison-kind membership Set, sourced from the canonical
 *  `COMPARISON_KINDS` constant in `lib/domain/predicate/types.ts`.
 *  Single source of truth — adding a comparison kind to the
 *  predicate package widens this Set without a parallel edit
 *  here. */
const COMPARISON_KIND_SET: ReadonlySet<Predicate["kind"]> = new Set(
	COMPARISON_KINDS,
);

/**
 * Map a kind to the structural-twin set it shares — pairs of
 * kinds with identical operand shapes that the editor preserves
 * verbatim across replacement. Four twin groups, one per operand
 * shape:
 *
 *   - `{ clauses: [Predicate, ...Predicate[]] }` — `and` ↔ `or`.
 *     Switching the discriminator preserves the author's clause
 *     list verbatim. Routes through the matching `and` / `or`
 *     builder so the construction-time reductions apply.
 *   - `{ left: ValueExpression }` — `is-null` ↔ `is-blank`.
 *     Same `left` shape; the two operators differ only in the
 *     strict-vs-portable absence semantic. Routes through the
 *     matching `isNull` / `isBlank` builder.
 *   - `{ left, right: ValueExpression }` — the six comparison
 *     kinds (`eq` / `neq` / `gt` / `gte` / `lt` / `lte`). Routes
 *     through `COMPARISON_BUILDERS` (the table exported by
 *     `ComparisonCard`).
 *   - `{ via: RelationPath, where?: Predicate }` — `exists` ↔
 *     `missing`. Same shape; the in-card `KindMenu` toggles
 *     between them and the outer "Change" menu now produces the
 *     same result. Routes through the `exists` / `missing`
 *     builder, preserving the absent-not-undefined contract on
 *     `where`.
 *
 * Returns `null` when no twin shape applies; the caller falls
 * through to `defaultValue(ctx)`.
 *
 * Exported as part of the module's tested surface — the
 * transformation is the contract (the emitted AST shape), so the
 * unit tests call it directly rather than driving the menu chrome.
 */
export function preservedOperandSwap(
	currentValue: Predicate,
	targetKind: Predicate["kind"],
): Predicate | null {
	// and ↔ or — same `{ clauses }`.
	if (
		(currentValue.kind === "and" || currentValue.kind === "or") &&
		(targetKind === "and" || targetKind === "or")
	) {
		const builder = targetKind === "or" ? or : and;
		// Spread through the builder's variadic signature — at least
		// two clauses guaranteed by the schema (and / or both reject
		// empty + single-clause envelopes via reduction). The cast
		// widens to the implementation signature; the runtime
		// non-empty guarantee comes from the source AST's schema.
		return (builder as (...args: Predicate[]) => Predicate)(
			...currentValue.clauses,
		);
	}
	// is-null ↔ is-blank — same `{ left }`.
	if (
		(currentValue.kind === "is-null" || currentValue.kind === "is-blank") &&
		(targetKind === "is-null" || targetKind === "is-blank")
	) {
		const builder = targetKind === "is-null" ? isNull : isBlank;
		return builder(currentValue.left);
	}
	// Comparison ↔ comparison — same `{ left, right }`.
	if (
		COMPARISON_KIND_SET.has(currentValue.kind) &&
		COMPARISON_KIND_SET.has(targetKind)
	) {
		const comparison = currentValue as Extract<
			Predicate,
			{ kind: ComparisonKind }
		>;
		const builder = COMPARISON_BUILDERS[targetKind as ComparisonKind];
		return builder(comparison.left, comparison.right);
	}
	// exists ↔ missing — same `{ via, where? }`. The builders'
	// absent-not-undefined contract handles the optional `where`
	// slot — calling `exists(via)` produces a result with no
	// `where` key (rather than `where: undefined`), matching the
	// schema's `.optional()` strip behavior on parse.
	if (
		(currentValue.kind === "exists" || currentValue.kind === "missing") &&
		(targetKind === "exists" || targetKind === "missing")
	) {
		const builder = targetKind === "missing" ? missing : exists;
		return currentValue.where === undefined
			? builder(currentValue.via)
			: builder(currentValue.via, currentValue.where);
	}
	return null;
}

/**
 * Menu that replaces the current card's predicate with a
 * different kind. Two replacement strategies:
 *
 *   1. **Operand-preserving swap** — when the source and target
 *      kinds share an identical operand shape (the four
 *      structural-twin pairs documented on
 *      `preservedOperandSwap`), the existing operands carry over
 *      to the new kind verbatim. Same result the in-card
 *      `KindMenu` produces for `exists` ↔ `missing`, so the two
 *      affordances are interchangeable.
 *   2. **Default-value reset** — for every other kind transition
 *      (e.g. `eq` → `between`), the target schema's
 *      `defaultValue(...)` factory rebuilds from the case-type
 *      schema. Operand SHAPES differ enough that no structural
 *      carry-over is sound (e.g. `eq`'s `{ left, right }` doesn't
 *      map cleanly onto `between`'s `{ left, lower?, upper?,
 *      lowerInclusive, upperInclusive }`).
 *
 * The menu lists every kind, marking the current one with a
 * violet dot.
 */
function KindReplaceMenu({ currentValue, onChange }: KindReplaceMenuProps) {
	const triggerRef = useRef<HTMLButtonElement>(null);
	const ctx = usePredicateEditContext();
	const editCtx: PredicateEditContext = {
		caseTypes: ctx.caseTypes,
		currentCaseType: ctx.currentCaseType,
		knownInputs: ctx.knownInputs,
	};
	const currentKind = currentValue.kind;

	const replaceWith = <K extends Predicate["kind"]>(
		schema: PredicateCardSchema<K>,
	) => {
		const preserved = preservedOperandSwap(currentValue, schema.kind);
		onChange(preserved ?? schema.defaultValue(editCtx));
	};

	return (
		<Menu.Root>
			<Menu.Trigger
				ref={triggerRef}
				aria-label="Change card type"
				className="group flex items-center gap-1 px-2 min-h-11 text-[10px] uppercase tracking-wider rounded-md text-nova-text-muted hover:text-nova-violet-bright hover:bg-white/[0.04] transition-colors cursor-pointer"
			>
				<span>Change</span>
				<svg
					aria-hidden="true"
					width="8"
					height="8"
					viewBox="0 0 10 10"
					className="shrink-0 transition-transform group-data-[popup-open]:rotate-180"
				>
					<path
						d="M2 3.5L5 6.5L8 3.5"
						stroke="currentColor"
						strokeWidth="1.4"
						fill="none"
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
				</svg>
			</Menu.Trigger>
			<Menu.Portal>
				<Menu.Positioner
					side="bottom"
					align="end"
					sideOffset={4}
					anchor={triggerRef}
					className={MENU_POSITIONER_CLS}
					style={{ maxHeight: 320 }}
				>
					<Menu.Popup
						className={`${MENU_POPUP_CLS} max-h-80 overflow-y-auto min-w-[18rem]`}
					>
						{predicateCardSchemaList.map((s, i) => {
							const isCurrent = s.kind === currentKind;
							const isApplicable = s.applicable(editCtx);
							const last = predicateCardSchemaList.length - 1;
							const corners =
								i === 0 && i === last
									? "rounded-xl"
									: i === 0
										? "rounded-t-xl"
										: i === last
											? "rounded-b-xl"
											: "";
							const cls = [
								corners,
								MENU_ITEM_CLS,
								isCurrent ? "text-nova-violet-bright bg-nova-violet/10" : "",
								isApplicable ? "" : "opacity-40",
							].join(" ");
							return (
								<Menu.Item
									key={s.kind}
									onClick={() => replaceWith(s)}
									// Current kind is not a valid replacement target —
									// clicking it would re-render an identical predicate.
									// Inapplicable kinds (per the schema's `applicable`
									// predicate — e.g. `multi-select-contains` on a case
									// type without a multi_select property) are disabled
									// WITH a reason so the editor never offers a swap that
									// would author a kind whose semantics don't fit the
									// scope. The current kind stays rendered regardless of
									// its own applicability (legacy-open backstop).
									// Symmetric with the kind-replace menu in
									// `primitives/ExpressionPicker.tsx`.
									disabled={isCurrent || !isApplicable}
									className={cls}
								>
									<Icon
										icon={s.icon}
										width="14"
										height="14"
										className={
											isCurrent
												? "text-nova-violet-bright"
												: "text-nova-text-muted"
										}
									/>
									<span className="flex-1 text-left min-w-0">
										<div className="truncate">{s.label}</div>
										<div
											className={`text-[10px] truncate ${
												isCurrent
													? "text-nova-violet-bright"
													: "text-nova-text-muted"
											}`}
										>
											{isApplicable
												? s.description
												: "Not available for this case type."}
										</div>
									</span>
								</Menu.Item>
							);
						})}
					</Menu.Popup>
				</Menu.Positioner>
			</Menu.Portal>
		</Menu.Root>
	);
}
