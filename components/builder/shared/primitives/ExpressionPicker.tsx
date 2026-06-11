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
	dateCoerce,
	datetimeCoerce,
	type ResolvedType,
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
	 * Optional caller-side type expectation for the slot. Threads
	 * into the kind-replace menu's applicability gate so unrelated
	 * kinds (e.g. `today` for an `int` slot) de-emphasize. The
	 * editor does NOT enforce the expectation — the type checker's
	 * verdict at the editor's root is the structural gate. Strict
	 * filtering would hide kinds whose result type depends on
	 * inputs (`if`, `switch`, `count`, `term`, `coalesce`).
	 */
	readonly expectedType?: ResolvedType;
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
	expectedType,
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
	}>;

	// Term values render unboxed — see the file header. The computed
	// kinds ride the term's source menu as injected items. Inside a
	// reorderable list (concat parts, coalesce values) the row shell
	// still wraps the term so the grab rail and Delete stay; a plain
	// value slot renders the bare controls.
	if (value.kind === "term") {
		const editCtx: ExpressionEditContext = {
			caseTypes: ctx.caseTypes,
			currentCaseType: ctx.currentCaseType,
			knownInputs: ctx.knownInputs,
		};
		const termBody = (
			<div className="space-y-1">
				<TermCard
					value={value}
					onChange={onChange}
					path={path}
					computedItems={expressionCardSchemaList
						.filter((s) => s.kind !== "term")
						.map((s) => {
							const isApplicable = s.applicable(editCtx, expectedType);
							return (
								<Menu.Item
									key={s.kind}
									onClick={() => onChange(s.defaultValue(editCtx))}
									className={`${MENU_ITEM_CLS} min-h-11 ${isApplicable ? "" : "opacity-45"}`}
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
											{s.description}
										</div>
									</span>
								</Menu.Item>
							);
						})}
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
					expectedType={expectedType}
				/>
			}
		>
			<Component value={value} onChange={onChange} path={path} />
		</CardShell>
	);
}

interface KindReplaceMenuProps {
	readonly currentValue: ValueExpression;
	readonly onChange: (next: ValueExpression) => void;
	readonly expectedType?: ResolvedType;
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
 * dot. Inapplicable kinds (per the schema entry's `applicable(ctx,
 * expectedType?)`) render at reduced opacity so the user sees them
 * but understands they're not the recommended choice for this slot.
 */
function KindReplaceMenu({
	currentValue,
	onChange,
	expectedType,
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
				className="group flex items-center gap-1 px-2 min-h-11 text-[10px] uppercase tracking-wider rounded-md text-nova-text-muted/60 hover:text-nova-violet-bright hover:bg-white/[0.04] transition-colors cursor-pointer"
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
							const isApplicable = s.applicable(editCtx, expectedType);
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
								isApplicable ? "" : "opacity-40",
							].join(" ");
							return (
								<Menu.Item
									key={s.kind}
									onClick={() => replaceWith(s)}
									// Current kind is not a valid replacement
									// target — clicking it would re-render and
									// recompute the validity index for a
									// structurally identical expression.
									// Inapplicable kinds (per the schema's
									// `applicable` predicate) render with
									// reduced opacity (the `opacity-40`
									// className above) but stay clickable —
									// the type checker's inline error is the
									// structural gate, and de-emphasis surfaces
									// the suggestion without locking the
									// author out of authoring a type-mismatched
									// expression. The editor lets invalid
									// edits flow through so the user can keep
									// authoring; the parent's save affordance
									// gates on the validity verdict.
									disabled={isCurrent}
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
													? "text-nova-violet-bright/60"
													: "text-nova-text-muted"
											}`}
										>
											{s.description}
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
