// components/builder/shared/primitives/ExpressionPicker.tsx
//
// Recursive dispatch shell for a single ValueExpression node — the
// ValueExpression-side analogue of `cards/ChildPredicateEditor.tsx`.
// Looks up the schema entry for `value.kind`, delegates rendering to
// the matched card, and frames the card with a kind-replacing menu
// so authors can swap an expression's discriminator without
// re-creating the surrounding structure.
//
// The shell is the recursive entry point used by every Expression
// card that holds a nested value slot (`arith.left` / `right`,
// `date-add.date` / `quantity`, `concat.parts[i]`, `coalesce.values[i]`,
// `if.then` / `else`, `switch.on` / `cases[i].then` / `fallback`,
// `count.where` is a Predicate slot — that uses ChildPredicateEditor).
// The Predicate-side cards (ComparisonCard.right, BetweenCard's bound
// editors, MatchCard's value, WithinDistanceCard's center) ALSO mount
// this shell at their value slots; both editors share one type-check
// context via the `usePredicateEditContext` provider, so the shell
// works identically in either tree.
//
// Valid by construction: the shell takes a `SlotConstraint` naming the
// types the slot may hold (computed by the parent card from its
// subject's resolved type) and offers ONLY the kinds whose result can
// satisfy it — every inadmissible kind is disabled WITH A REASON, never
// dimmed-but-clickable. A `termOnly` slot offers no computed kinds at
// all. The constraint flows down to `TermCard`, which gates its value
// sources the same way, so no sequence of picker choices can author a
// type the checker would reject.
//
// Round-trip preservation is structural: every ValueExpression kind
// has a card that round-trips its AST shape verbatim via the per-arm
// cards in `cards/expression/`, and the kind-replace menu preserves
// the operand-shape twin pairs (`date-coerce` ↔ `datetime-coerce`)
// so a kind swap doesn't drop authored content.
//
// Term values (a typed value, a property, a search field — the
// overwhelmingly common case) render UNBOXED: no card shell, no slot
// title, because inside a condition sentence the value is just the
// object of the verb. The computed kinds (math, if–then, today, …)
// fold into the term's own source dropdown as a "Computed" group —
// one menu answers "what is this value?". Computed kinds, once
// picked, render as titled container cards (their structure isn't
// expressible inline).

"use client";
import { Menu } from "@base-ui/react/menu";
import { Icon } from "@iconify/react/offline";
import { useRef } from "react";
import {
	ANY_CONSTRAINT,
	admitsValueExpressionKind,
	dateCoerce,
	datetimeCoerce,
	type SlotConstraint,
	type ValueExpression,
} from "@/lib/domain/predicate";
import {
	MENU_ITEM_CLS,
	MENU_POPUP_CLS,
	MENU_POSITIONER_CLS,
} from "@/lib/styles";
import { TermCard } from "../cards/expression/TermCard";
import { useEditorErrorsAt, usePredicateEditContext } from "../editorContext";
import {
	type ExpressionCardSchema,
	type ExpressionEditContext,
	expressionCardSchemaList,
	expressionCardSchemas,
} from "../expressionEditorSchemas";
import type { EditorPath } from "../path";
import { CardShell, InlineError, PredicateRowShell } from "./CardShell";

interface ExpressionPickerProps {
	readonly value: ValueExpression;
	readonly onChange: (next: ValueExpression) => void;
	readonly path: EditorPath;
	/**
	 * The type constraint on this slot — the kinds whose result can
	 * satisfy it are offered; every other kind is disabled with a
	 * reason. Defaults to `ANY_CONSTRAINT` (no narrowing). The parent
	 * card computes it from its subject's resolved type
	 * (`comparisonObjectConstraint(useResolvedType(left))`, etc.); a
	 * `termOnly` constraint suppresses the computed kinds entirely.
	 */
	readonly constraint?: SlotConstraint;
	/**
	 * Optional remove handler — when provided, the card surfaces a
	 * "Delete" item in its kebab menu. List-shaped containers
	 * (`concat.parts` / `coalesce.values` / `switch.cases`) thread
	 * one through; single-slot operands and the top-level editor
	 * pass undefined.
	 */
	readonly onRemove?: () => void;
	/**
	 * Display variant — `"normal"` (default) renders the standard
	 * glass surface; `"nested"` shifts the violet accent up for
	 * cards inside a parent group's list.
	 */
	readonly variant?: "normal" | "nested";
	/**
	 * Optional ref-callback the parent installs on the card shell's
	 * grip handle for native drag binding. When undefined, the grip
	 * does not render.
	 */
	readonly dragHandleRef?: (el: HTMLElement | null) => void;
}

/**
 * Render one ValueExpression as a card. Looks up the registry entry
 * by `value.kind` and dispatches to the matching card component;
 * routes operator-level errors (path === self) to the shell's error
 * footer; passes a kind-replacing menu in the kebab.
 */
export function ExpressionPicker({
	value,
	onChange,
	path,
	constraint = ANY_CONSTRAINT,
	onRemove,
	variant = "normal",
	dragHandleRef,
}: ExpressionPickerProps) {
	const operatorErrors = useEditorErrorsAt(path);
	const ctx = usePredicateEditContext();
	const schema = expressionCardSchemas[value.kind];
	const Component = schema.component as React.ComponentType<{
		value: ValueExpression;
		onChange: (next: ValueExpression) => void;
		path: EditorPath;
		constraint?: SlotConstraint;
	}>;

	// Term values render unboxed — see the file header. The computed
	// kinds ride the term's source menu as injected items, each gated
	// by whether its result type can satisfy the slot's constraint; a
	// `termOnly` slot offers no computed kinds at all. Inside a
	// reorderable list (concat parts, coalesce values) the row shell
	// still wraps the term so the grab rail and Delete stay; a plain
	// value slot renders the bare controls.
	if (value.kind === "term") {
		const editCtx: ExpressionEditContext = {
			caseTypes: ctx.caseTypes,
			currentCaseType: ctx.currentCaseType,
			knownInputs: ctx.knownInputs,
		};
		const computedItems = constraint.termOnly
			? undefined
			: expressionCardSchemaList
					.filter((s) => s.kind !== "term")
					.map((s) => {
						const { admitted, reason } = admitsValueExpressionKind(
							s.kind,
							constraint,
						);
						return (
							<Menu.Item
								key={s.kind}
								disabled={!admitted}
								onClick={() => onChange(s.defaultValue(editCtx))}
								className={`${MENU_ITEM_CLS} min-h-11 ${admitted ? "" : "opacity-45"}`}
							>
								<Icon
									icon={s.icon}
									width="14"
									height="14"
									className="text-nova-text-muted"
								/>
								<span className="flex-1 text-left min-w-0">
									<div className="truncate">{s.label}</div>
									<div className="text-[11px] truncate text-nova-text-muted">
										{admitted ? s.description : reason}
									</div>
								</span>
							</Menu.Item>
						);
					});
		const termBody = (
			<div className="space-y-1">
				<TermCard
					value={value}
					onChange={onChange}
					path={path}
					constraint={constraint}
					computedItems={computedItems}
				/>
				<InlineError errors={[...operatorErrors]} />
			</div>
		);
		if (dragHandleRef !== undefined || onRemove !== undefined) {
			return (
				<PredicateRowShell
					variant={variant}
					dragHandleRef={dragHandleRef}
					onRemove={onRemove}
				>
					{termBody}
				</PredicateRowShell>
			);
		}
		return termBody;
	}

	return (
		<CardShell
			icon={schema.icon}
			label={schema.label}
			variant={variant}
			onRemove={onRemove}
			dragHandleRef={dragHandleRef}
			errors={operatorErrors}
			kindAccent={
				<KindReplaceMenu
					currentValue={value}
					onChange={onChange}
					constraint={constraint}
				/>
			}
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
	readonly currentValue: ValueExpression;
	readonly onChange: (next: ValueExpression) => void;
	readonly constraint: SlotConstraint;
}

/**
 * Map a kind to the structural-twin set it shares — pairs of kinds
 * with identical operand shapes that the editor preserves verbatim
 * across replacement. One twin pair on the ValueExpression side:
 *
 *   - `{ value: ValueExpression }` — `date-coerce` ↔
 *     `datetime-coerce`. Same `value` slot; the two operators differ
 *     only in the result type. Routes through the matching builder
 *     so the construction stays canonical.
 *
 * Other kinds with identical operand-shape carriers (`coalesce` /
 * `concat` differ on slot name `values` vs `parts`, so the AST shape
 * is NOT identical and the swap doesn't apply). `today` ↔ `now` are
 * also discriminator-only but produce different result types
 * (`date` vs `datetime`); the in-card "Change" menu can swap them
 * without losing operand content because there's no operand to
 * lose.
 *
 * Returns `null` when no twin shape applies; the caller falls
 * through to `defaultValue(ctx)`.
 */
function preservedExpressionSwap(
	currentValue: ValueExpression,
	targetKind: ValueExpression["kind"],
): ValueExpression | null {
	// date-coerce ↔ datetime-coerce — same `{ value }` operand shape.
	if (
		(currentValue.kind === "date-coerce" ||
			currentValue.kind === "datetime-coerce") &&
		(targetKind === "date-coerce" || targetKind === "datetime-coerce")
	) {
		const builder = targetKind === "date-coerce" ? dateCoerce : datetimeCoerce;
		return builder(currentValue.value);
	}
	// today ↔ now — discriminator-only, no operand content to preserve.
	// The kind picker's defaultValue factory produces the right shape;
	// no preservation step needed (the source's content is empty by
	// definition).
	return null;
}

/**
 * Menu that replaces the current card's expression with a different
 * kind. Two replacement strategies (mirrors the Predicate-side
 * `ChildPredicateEditor.KindReplaceMenu`):
 *
 *   1. **Operand-preserving swap** — when the source and target
 *      kinds share an identical operand shape (the `date-coerce` ↔
 *      `datetime-coerce` twin pair on the value side), the existing
 *      operands carry over to the new kind verbatim.
 *   2. **Default-value reset** — for every other kind transition
 *      (e.g. `term` → `arith`), the target schema's `defaultValue(...)`
 *      factory rebuilds from the case-type schema. Operand SHAPES
 *      differ enough that no structural carry-over is sound.
 *
 * The menu lists every kind, marking the current one with a violet
 * dot. A kind whose result type can't satisfy the slot's constraint
 * is disabled WITH A REASON (`admitsValueExpressionKind`) — the
 * editor never offers a swap that would author a type the checker
 * rejects. The current kind's own row stays non-selectable (clicking
 * it would re-render an identical expression) regardless of its
 * admission, so a legacy-open invalid expression keeps rendering its
 * own kind.
 */
function KindReplaceMenu({
	currentValue,
	onChange,
	constraint,
}: KindReplaceMenuProps) {
	const triggerRef = useRef<HTMLButtonElement>(null);
	const ctx = usePredicateEditContext();
	const editCtx: ExpressionEditContext = {
		caseTypes: ctx.caseTypes,
		currentCaseType: ctx.currentCaseType,
		knownInputs: ctx.knownInputs,
	};
	const currentKind = currentValue.kind;

	const replaceWith = <K extends ValueExpression["kind"]>(
		schema: ExpressionCardSchema<K>,
	) => {
		const preserved = preservedExpressionSwap(currentValue, schema.kind);
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
					style={{ maxHeight: 360 }}
				>
					<Menu.Popup
						className={`${MENU_POPUP_CLS} max-h-80 overflow-y-auto min-w-[18rem]`}
					>
						{expressionCardSchemaList.map((s, i) => {
							const isCurrent = s.kind === currentKind;
							// The current kind is exempt from the admission gate —
							// a legacy-open invalid expression must keep rendering
							// its own kind even when the slot's constraint no longer
							// admits it.
							const { admitted, reason } = isCurrent
								? { admitted: true, reason: undefined }
								: admitsValueExpressionKind(s.kind, constraint);
							const last = expressionCardSchemaList.length - 1;
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
								admitted ? "" : "opacity-45",
							].join(" ");
							return (
								<Menu.Item
									key={s.kind}
									onClick={() => replaceWith(s)}
									// Current kind is not a valid replacement target —
									// clicking it would re-render an identical
									// expression. Inadmissible kinds are disabled WITH a
									// reason so the editor never offers a swap that would
									// author a type the checker rejects.
									disabled={isCurrent || !admitted}
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
											{admitted ? s.description : reason}
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
