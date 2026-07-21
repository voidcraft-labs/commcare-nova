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
// compatible operand carriers (the unary coercions and the two
// ordered value lists) so a kind swap doesn't drop authored content.
//
// Term values (a typed value, a property, a search field — the
// overwhelmingly common case) render UNBOXED: no card shell, no slot
// title, because inside a condition sentence the value is just the
// object of the verb. The computed kinds (math, if–then, today, …)
// fold into the term's own source dropdown as a "Calculated" group —
// one menu answers "what is this value?". Calculated kinds, once
// picked, render as titled container cards (their structure isn't
// expressible inline).

"use client";
import { Icon } from "@iconify/react/offline";
import tablerChevronDown from "@iconify-icons/tabler/chevron-down";
import { useCallback, useMemo, useRef, useState } from "react";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/shadcn/alert-dialog";
import { Button } from "@/components/shadcn/button";
import {
	DropdownMenu,
	DropdownMenuItem,
	DropdownMenuPopup,
	DropdownMenuPortal,
	DropdownMenuPositioner,
	DropdownMenuTrigger,
} from "@/components/shadcn/dropdown-menu";
import { canonicalCasePropertyName, effectiveDataType } from "@/lib/domain";
import {
	ANY_CONSTRAINT,
	acceptsType,
	admitsValueExpressionKind,
	dateAdd,
	dateAddOperandConstraint,
	ifExpr,
	input,
	literal,
	now,
	prop,
	type SlotConstraint,
	sessionContext,
	switchCase,
	switchExpr,
	term,
	type ValueExpression,
} from "@/lib/domain/predicate";
import { hasCountableRelation } from "../cards/expression/CountCard";
import {
	TermCard,
	termHasMeaningfulContent,
} from "../cards/expression/TermCard";
import { reseedValueForConstraint } from "../cards/reseed";
import {
	useEditorErrorsAt,
	useEditorErrorsBelow,
	useExpressionFocusTarget,
	usePredicateEditContext,
} from "../editorContext";
import {
	type ExpressionCardSchema,
	type ExpressionEditContext,
	expressionCardSchemaList,
	expressionCardSchemas,
	isAuthorableExpressionKind,
} from "../expressionEditorSchemas";
import { planPreservedExpressionReplacement } from "../expressionReplacement";
import type { EditorPath } from "../path";
import {
	expressionFocusDescription,
	expressionFocusTitle,
	pathsEqual,
	RuleFocusSummary,
	useRuleFocusContext,
} from "../RuleFocusContext";
import type { ReorderKeyboardKey } from "../useReorderableList";
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
	 * (`comparisonObjectConstraint(kind, useResolvedType(left))`, etc.); a
	 * `termOnly` constraint suppresses the computed kinds entirely.
	 */
	readonly constraint?: SlotConstraint;
	/** The semantic role this expression plays. Subject slots keep the
	 *  common property source primary and phrase its source menu as
	 *  "A property"; ordinary value slots use "Another property". */
	readonly presentation?: "value" | "subject";
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
	/** Keyboard alternative to drag supplied by list-shaped owners. */
	readonly onMove?: (key: ReorderKeyboardKey) => void;
	readonly reorderLabel?: string;
}

function termSourceLabel(value: Extract<ValueExpression, { kind: "term" }>) {
	switch (value.term.kind) {
		case "prop":
			return "property";
		case "input":
			return "search answer";
		case "session-context":
			return "app information";
		case "session-user":
			return "user information";
		case "literal":
			return "value";
	}
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
	presentation = "value",
	onRemove,
	variant = "normal",
	dragHandleRef,
	onMove,
	reorderLabel,
}: ExpressionPickerProps) {
	const operatorErrors = useEditorErrorsAt(path);
	const descendantErrors = useEditorErrorsBelow(path);
	const focus = useRuleFocusContext();
	const ctx = usePredicateEditContext();
	const termRootRef = useRef<HTMLDivElement>(null);
	const replacementFocusFallbackRef = useRef<HTMLElement | null>(null);
	const { resolve: resolveExpressionFocusTarget, focusAfterReplacement } =
		useExpressionFocusTarget(path);
	const [pendingTermReplacement, setPendingTermReplacement] = useState<{
		readonly source: Extract<ValueExpression, { kind: "term" }>;
		readonly target: ExpressionCardSchema<ValueExpression["kind"]>;
	} | null>(null);
	const schema = expressionCardSchemas[value.kind];
	// `forbidDirectLiteral` is deliberately local to this node. Once the
	// current expression is calculated (`if`, `coalesce`, math, and so on),
	// literal descendants are valid inputs to that calculation and must not
	// inherit the root absence-check restriction.
	const childConstraint = useMemo<SlotConstraint>(() => {
		if (constraint.forbidDirectLiteral !== true) return constraint;
		const { forbidDirectLiteral: _forbidDirectLiteral, ...rest } = constraint;
		return rest;
	}, [constraint]);
	const Component = schema.component as React.ComponentType<{
		value: ValueExpression;
		onChange: (next: ValueExpression) => void;
		path: EditorPath;
		constraint?: SlotConstraint;
	}>;

	// A calculated child becomes a compact semantic row while its parent is in
	// focus. Opening that row promotes the exact subtree into this same
	// full-width editor. Term values stay inline because they are the readable
	// nouns in a condition sentence, not nested structures.
	if (
		focus !== null &&
		value.kind !== "term" &&
		!pathsEqual(path, focus.activePath)
	) {
		return (
			<PredicateRowShell
				variant={variant}
				onRemove={onRemove}
				dragHandleRef={dragHandleRef}
				onMove={onMove}
				reorderLabel={reorderLabel}
				errors={operatorErrors}
			>
				<RuleFocusSummary
					path={path}
					icon={schema.icon}
					title={expressionFocusTitle(value)}
					description={expressionFocusDescription(value)}
					hasErrors={operatorErrors.length > 0 || descendantErrors.length > 0}
				/>
			</PredicateRowShell>
		);
	}

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
		const typeCtx = {
			caseTypes: [...ctx.caseTypes],
			currentCaseType: ctx.currentCaseType,
			knownInputs: [...ctx.knownInputs],
		};
		const pendingTermSourceLabel = termSourceLabel(
			pendingTermReplacement?.source ?? value,
		);
		const computedItems = constraint.termOnly
			? undefined
			: expressionCardSchemaList
					.filter(
						(schema) =>
							schema.kind !== "term" && isAuthorableExpressionKind(schema.kind),
					)
					.map((s) => {
						const typeAdmission = admitsValueExpressionKind(s.kind, constraint);
						const countHasConnection =
							s.kind !== "count" || hasCountableRelation(editCtx);
						const preserved = planPreservedExpressionReplacement(
							value,
							s.kind,
							typeCtx,
						);
						const candidate =
							preserved ??
							defaultExpressionForSlot(s, editCtx, constraint, presentation);
						const ruleAdmission = ctx.admitExpressionChange?.(path, candidate);
						const admitted =
							typeAdmission.admitted &&
							countHasConnection &&
							(ruleAdmission?.admitted ?? true);
						const reason = !countHasConnection
							? "Add a parent or child case type before counting related cases"
							: ruleAdmission?.admitted === false
								? ruleAdmission.reason
								: typeAdmission.reason;
						return (
							<DropdownMenuItem
								key={s.kind}
								disabled={!admitted}
								onClick={() => {
									if (preserved !== null) {
										onChange(preserved);
										return;
									}
									if (!termHasMeaningfulContent(value.term)) {
										onChange(
											defaultExpressionForSlot(
												s,
												editCtx,
												constraint,
												presentation,
											),
										);
										return;
									}
									replacementFocusFallbackRef.current =
										termRootRef.current
											?.closest<HTMLElement>("[data-workbench-focus-id]")
											?.querySelector<HTMLElement>(
												"[data-workbench-active-heading]",
											) ?? null;
									setPendingTermReplacement({ source: value, target: s });
								}}
							>
								<Icon
									icon={s.icon}
									width="14"
									height="14"
									className="text-nova-text-muted"
								/>
								<span className="flex-1 text-left min-w-0">
									<div className="break-words">{s.label}</div>
									<div className="break-words text-xs text-nova-text-muted">
										{admitted ? s.description : reason}
									</div>
								</span>
							</DropdownMenuItem>
						);
					});
		const termBody = (
			<div ref={termRootRef} className="space-y-1">
				<TermCard
					value={value}
					onChange={onChange}
					path={path}
					constraint={constraint}
					sourceContext={presentation}
					computedItems={computedItems}
				/>
				<InlineError errors={[...operatorErrors]} />
				<AlertDialog
					open={pendingTermReplacement !== null}
					onOpenChange={(open) => {
						if (open) return;
						setPendingTermReplacement(null);
					}}
				>
					<AlertDialogContent
						finalFocus={() =>
							resolveExpressionFocusTarget() ??
							replacementFocusFallbackRef.current
						}
						className="text-left"
					>
						<AlertDialogHeader>
							<AlertDialogTitle className="font-display">
								Use “
								{pendingTermReplacement?.target.label ?? "a calculated value"}”
								instead?
							</AlertDialogTitle>
							<AlertDialogDescription className="text-left">
								This replaces the saved {pendingTermSourceLabel} and removes its
								current settings. Saved case data won’t change. You can undo
								this change.
							</AlertDialogDescription>
						</AlertDialogHeader>
						<AlertDialogFooter>
							<AlertDialogCancel>Cancel</AlertDialogCancel>
							<AlertDialogAction
								variant="destructive"
								onClick={() => {
									const pending = pendingTermReplacement;
									setPendingTermReplacement(null);
									if (pending === null || pending.source !== value) return;
									onChange(
										defaultExpressionForSlot(
											pending.target,
											editCtx,
											constraint,
											presentation,
										),
									);
									focusAfterReplacement(replacementFocusFallbackRef.current);
								}}
							>
								Replace
							</AlertDialogAction>
						</AlertDialogFooter>
					</AlertDialogContent>
				</AlertDialog>
			</div>
		);
		if (dragHandleRef !== undefined || onRemove !== undefined) {
			return (
				<PredicateRowShell
					variant={variant}
					dragHandleRef={dragHandleRef}
					onMove={onMove}
					reorderLabel={reorderLabel}
					onRemove={onRemove}
					removeLabel="Remove value"
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
			removeLabel="Remove value"
			dragHandleRef={dragHandleRef}
			onMove={onMove}
			reorderLabel={reorderLabel}
			errors={operatorErrors}
			kindAccent={
				<KindReplaceMenu
					currentValue={value}
					onChange={onChange}
					path={path}
					constraint={constraint}
					presentation={presentation}
				/>
			}
		>
			<Component
				value={value}
				onChange={onChange}
				path={path}
				constraint={childConstraint}
			/>
		</CardShell>
	);
}

interface KindReplaceMenuProps {
	readonly currentValue: ValueExpression;
	readonly onChange: (next: ValueExpression) => void;
	readonly path: EditorPath;
	readonly constraint: SlotConstraint;
	readonly presentation: "value" | "subject";
}

/** Pick a working Term seed for this slot. Predicate subjects prefer a
 * property so the common condition remains compact and meaningful; typed
 * slots fall back through a matching search input, session information,
 * then a checker-compatible literal. */
function termSeedForSlot(
	ctx: ExpressionEditContext,
	constraint: SlotConstraint,
	presentation: "value" | "subject",
): ValueExpression {
	if (presentation === "subject" || constraint.forbidDirectLiteral === true) {
		const caseType = ctx.caseTypes.find(
			(candidate) => candidate.name === ctx.currentCaseType,
		);
		const property = caseType?.properties.find(
			(candidate) =>
				constraint.accepts === "any" ||
				acceptsType(constraint, effectiveDataType(candidate)),
		);
		if (property !== undefined) {
			return term(
				prop(ctx.currentCaseType, canonicalCasePropertyName(property.name)),
			);
		}

		const searchInput = ctx.knownInputs.find(
			(candidate) =>
				constraint.accepts === "any" ||
				acceptsType(constraint, candidate.data_type ?? "text"),
		);
		if (searchInput !== undefined) return term(input(searchInput.name));

		if (constraint.accepts === "any" || acceptsType(constraint, "text")) {
			return term(sessionContext("userid"));
		}
	}

	return constraint.accepts === "any"
		? term(literal(""))
		: reseedValueForConstraint(term(literal("")), constraint.accepts);
}

/** Registry defaults are intentionally context-only. Depend-on-input kinds
 * (`term`, `if`, `switch`) need their result-bearing leaves reseeded for a
 * typed slot at selection time; otherwise choosing a calculated numeric
 * subject could transiently author a text expression. */
function defaultExpressionForSlot<K extends ValueExpression["kind"]>(
	schema: ExpressionCardSchema<K>,
	ctx: ExpressionEditContext,
	constraint: SlotConstraint,
	presentation: "value" | "subject",
): ValueExpression {
	if (schema.kind === "term") {
		return termSeedForSlot(ctx, constraint, presentation);
	}

	const { forbidDirectLiteral: _forbidDirectLiteral, ...childConstraint } =
		constraint;
	// Widen the generic registry return to the discriminated union so the
	// kind checks below narrow the corresponding AST arm normally.
	const seed: ValueExpression = schema.defaultValue(ctx);
	const branchSeed = () => termSeedForSlot(ctx, childConstraint, "value");

	if (seed.kind === "if") {
		return ifExpr(seed.cond, branchSeed(), branchSeed());
	}
	if (seed.kind === "switch") {
		const [first, ...rest] = seed.cases;
		return switchExpr(
			seed.on,
			[
				switchCase(first.when, branchSeed()),
				...rest.map((item) => switchCase(item.when, branchSeed())),
			],
			branchSeed(),
		);
	}
	if (seed.kind === "date-add") {
		const dateConstraint = dateAddOperandConstraint(childConstraint);
		// The standard seed is `today() + 7 days`. In a datetime-only parent
		// slot, adapt the result-following operand before the AST reaches the
		// commit gate; `date-add` returns exactly its starting value's type.
		if (
			dateConstraint.accepts !== "any" &&
			!dateConstraint.accepts.has("date") &&
			dateConstraint.accepts.has("datetime")
		) {
			return dateAdd(now(), seed.interval, seed.quantity);
		}
	}
	return seed;
}

/**
 * Replace the current calculated value without hiding data loss. Compatible
 * carriers retain every authored child immediately; incompatible shapes open
 * a consequence-first confirmation and only create a new target default after
 * the author chooses Replace. Cancel leaves the exact source object untouched.
 */
function KindReplaceMenu({
	currentValue,
	onChange,
	path,
	constraint,
	presentation,
}: KindReplaceMenuProps) {
	const triggerRef = useRef<HTMLButtonElement>(null);
	const replacementFocusFallbackRef = useRef<HTMLElement | null>(null);
	const {
		register: registerExpressionFocusTarget,
		resolve,
		focusAfterReplacement,
	} = useExpressionFocusTarget(path);
	const setTriggerRef = useCallback(
		(target: HTMLButtonElement | null) => {
			triggerRef.current = target;
			registerExpressionFocusTarget(target);
		},
		[registerExpressionFocusTarget],
	);
	const [pendingReplacement, setPendingReplacement] = useState<{
		readonly source: ValueExpression;
		readonly target: ExpressionCardSchema<ValueExpression["kind"]>;
	} | null>(null);
	const ctx = usePredicateEditContext();
	const editCtx: ExpressionEditContext = {
		caseTypes: ctx.caseTypes,
		currentCaseType: ctx.currentCaseType,
		knownInputs: ctx.knownInputs,
	};
	const typeCtx = {
		caseTypes: [...ctx.caseTypes],
		currentCaseType: ctx.currentCaseType,
		knownInputs: [...ctx.knownInputs],
	};
	const currentKind = currentValue.kind;
	const pendingSourceLabel =
		pendingReplacement === null
			? "saved value"
			: expressionCardSchemas[pendingReplacement.source.kind].label;
	const pendingTargetLabel = pendingReplacement?.target.label ?? "new value";

	const requestReplacement = (
		schema: ExpressionCardSchema<ValueExpression["kind"]>,
	) => {
		const preserved = planPreservedExpressionReplacement(
			currentValue,
			schema.kind,
			typeCtx,
		);
		if (preserved !== null) {
			onChange(preserved);
			return;
		}
		replacementFocusFallbackRef.current =
			triggerRef.current
				?.closest<HTMLElement>("[data-workbench-focus-id]")
				?.querySelector<HTMLElement>("[data-workbench-active-heading]") ?? null;
		setPendingReplacement({ source: currentValue, target: schema });
	};

	return (
		<>
			<DropdownMenu>
				<DropdownMenuTrigger
					ref={setTriggerRef}
					aria-label="Change value type"
					render={
						<Button
							type="button"
							variant="ghost"
							size="xl"
							className="group px-2 text-sm text-nova-text-muted not-disabled:hover:bg-white/[0.04] not-disabled:hover:text-nova-violet-bright"
						/>
					}
				>
					<span>Change</span>
					<Icon
						icon={tablerChevronDown}
						width="14"
						height="14"
						className="shrink-0 transition-transform group-data-[popup-open]:rotate-180"
					/>
				</DropdownMenuTrigger>
				<DropdownMenuPortal>
					<DropdownMenuPositioner
						side="bottom"
						align="end"
						sideOffset={4}
						anchor={triggerRef}
						style={{ minWidth: "18rem", maxHeight: 360 }}
					>
						<DropdownMenuPopup className="max-h-80 min-w-0 overflow-y-auto">
							{expressionCardSchemaList
								.filter(
									(schema) =>
										schema.kind === currentKind ||
										isAuthorableExpressionKind(schema.kind),
								)
								.map((schema) => {
									const isCurrent = schema.kind === currentKind;
									const typeAdmission = isCurrent
										? { admitted: true, reason: undefined }
										: admitsValueExpressionKind(schema.kind, constraint);
									const countHasConnection =
										isCurrent ||
										schema.kind !== "count" ||
										hasCountableRelation(editCtx);
									const candidate = isCurrent
										? currentValue
										: (planPreservedExpressionReplacement(
												currentValue,
												schema.kind,
												typeCtx,
											) ??
											defaultExpressionForSlot(
												schema,
												editCtx,
												constraint,
												presentation,
											));
									const ruleAdmission = isCurrent
										? { admitted: true as const }
										: ctx.admitExpressionChange?.(path, candidate);
									const admitted =
										typeAdmission.admitted &&
										countHasConnection &&
										(ruleAdmission?.admitted ?? true);
									const reason = !countHasConnection
										? "Add a parent or child case type before counting related cases"
										: ruleAdmission?.admitted === false
											? ruleAdmission.reason
											: typeAdmission.reason;
									return (
										<DropdownMenuItem
											key={schema.kind}
											onClick={() => requestReplacement(schema)}
											disabled={isCurrent || !admitted}
											className={
												isCurrent
													? "bg-nova-violet/10 text-nova-violet-bright"
													: ""
											}
										>
											<Icon
												icon={schema.icon}
												width="14"
												height="14"
												className={
													isCurrent
														? "text-nova-violet-bright"
														: "text-nova-text-muted"
												}
											/>
											<span className="min-w-0 flex-1 text-left">
												<div className="break-words">{schema.label}</div>
												<div
													className={`break-words text-xs ${
														isCurrent
															? "text-nova-violet-bright"
															: "text-nova-text-muted"
													}`}
												>
													{admitted ? schema.description : reason}
												</div>
											</span>
										</DropdownMenuItem>
									);
								})}
						</DropdownMenuPopup>
					</DropdownMenuPositioner>
				</DropdownMenuPortal>
			</DropdownMenu>

			<AlertDialog
				open={pendingReplacement !== null}
				onOpenChange={(open) => {
					if (open) return;
					setPendingReplacement(null);
				}}
			>
				<AlertDialogContent
					finalFocus={() => resolve() ?? replacementFocusFallbackRef.current}
					className="text-left"
				>
					<AlertDialogHeader>
						<AlertDialogTitle className="font-display">
							Replace “{pendingSourceLabel}” with “{pendingTargetLabel}”?
						</AlertDialogTitle>
						<AlertDialogDescription className="text-left">
							Its current values and settings will be removed. Saved case data
							won’t change. You can undo this change.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Cancel</AlertDialogCancel>
						<AlertDialogAction
							variant="destructive"
							onClick={() => {
								const pending = pendingReplacement;
								setPendingReplacement(null);
								if (pending === null || pending.source !== currentValue) return;
								onChange(
									defaultExpressionForSlot(
										pending.target,
										editCtx,
										constraint,
										presentation,
									),
								);
								if (pending.target.kind === "term") {
									focusAfterReplacement(replacementFocusFallbackRef.current);
								}
							}}
						>
							Replace
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
	);
}
