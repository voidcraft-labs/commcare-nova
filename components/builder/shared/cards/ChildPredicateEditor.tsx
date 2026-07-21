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
import { Icon } from "@iconify/react/offline";
import tablerChevronDown from "@iconify-icons/tabler/chevron-down";
import { type ReactNode, useRef, useState } from "react";
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
import {
	ANY_CONSTRAINT,
	and,
	COMPARISON_KINDS,
	type ComparisonKind,
	exists,
	isBlank,
	isNull,
	missing,
	not,
	or,
	type Predicate,
	type SlotConstraint,
} from "@/lib/domain/predicate";
import {
	useEditorErrorsAt,
	useEditorErrorsBelow,
	usePredicateEditContext,
} from "../editorContext";
import {
	isAuthorablePredicateKind,
	type PredicateCardSchema,
	type PredicateEditContext,
	predicateCardSchemaList,
	predicateCardSchemas,
	predicateUnavailableReason,
} from "../editorSchemas";
import type { EditorPath } from "../path";
import { CardShell, PredicateRowShell } from "../primitives/CardShell";
import {
	pathsEqual,
	predicateFocusDescription,
	predicateFocusTitle,
	RuleFocusSummary,
	useRuleFocusContext,
} from "../RuleFocusContext";
import { KIND_BUILDERS as COMPARISON_BUILDERS } from "./ComparisonCard";
import { wrapSiblingDefault } from "./comparisonSeed";

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
	/** User-facing consequence for the remove action. */
	readonly removeLabel?: string;
	/** Optional card-bound action row supplied by a list composer. */
	readonly footerAction?: ReactNode;
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

/** Focus-aware boundary for Predicate slots inside a ValueExpression. The
 * workbench shows the child as one semantic row; opening it promotes that
 * subtree into the same full-width editor as every other condition. Outside
 * the workbench this remains the ordinary recursive card editor. */
export function PredicateFocusBoundary(props: ChildPredicateEditorProps) {
	const {
		value,
		path,
		onRemove,
		removeLabel,
		footerAction,
		dragHandleRef,
		variant = "normal",
	} = props;
	const focus = useRuleFocusContext();
	const editContext = usePredicateEditContext();
	const operatorErrors = useEditorErrorsAt(path);
	const descendantErrors = useEditorErrorsBelow(path);

	if (focus !== null && !pathsEqual(path, focus.activePath)) {
		const schema = predicateCardSchemas[value.kind];
		return (
			<PredicateRowShell
				variant={variant}
				onRemove={onRemove}
				removeLabel={removeLabel}
				footerAction={footerAction}
				dragHandleRef={dragHandleRef}
				errors={operatorErrors}
			>
				<RuleFocusSummary
					path={path}
					icon={schema.icon}
					title={predicateFocusTitle(value)}
					description={predicateFocusDescription(
						value,
						editContext.knownInputs,
					)}
					hasErrors={operatorErrors.length > 0 || descendantErrors.length > 0}
				/>
			</PredicateRowShell>
		);
	}

	return <ChildPredicateEditor {...props} />;
}

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
	removeLabel,
	footerAction,
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
				removeLabel={removeLabel}
				footerAction={footerAction}
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
			removeLabel={removeLabel}
			footerAction={footerAction}
			dragHandleRef={dragHandleRef}
			errors={operatorErrors}
			kindAccent={
				<PredicateKindReplaceMenu currentValue={value} onChange={onChange} />
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

interface PredicateKindReplaceMenuProps {
	readonly currentValue: Predicate;
	readonly onChange: (next: Predicate) => void;
	readonly label?: string;
}

export interface PredicateTransitionConfirmation {
	readonly title: string;
	readonly description: string;
}

export interface PredicateTransitionPlan {
	readonly next: Predicate;
	readonly confirmation?: PredicateTransitionConfirmation;
}

interface PreservationGroup {
	readonly values: readonly object[];
	readonly allLost: string;
	readonly partlyLost?: string;
}

function subjectNodes(
	value: Extract<
		Predicate,
		{
			kind: ComparisonKind | "in" | "between" | "is-null" | "is-blank";
		}
	>["left"],
): readonly object[] {
	// Property-only target shapes (`match`, containment, near) unwrap the
	// ordinary `term(prop)` subject. Treat that as preservation of the same
	// subject, while keeping a computed/input subject atomic so replacing its
	// expression still requires confirmation.
	return value.kind === "term" && value.term.kind === "prop"
		? [value.term]
		: [value];
}

function valueNodes(value: object): readonly object[] {
	// Literal-only targets store the Literal directly, while comparisons and
	// matches wrap it in `term(literal)`. Reusing that same Literal is a lossless
	// move, so track the authored leaf instead of treating the envelope as data.
	if (
		"kind" in value &&
		value.kind === "term" &&
		"term" in value &&
		value.term !== null &&
		typeof value.term === "object" &&
		"kind" in value.term &&
		value.term.kind === "literal"
	) {
		return [value.term];
	}
	return [value];
}

/** AST nodes are immutable plain objects. Builders that preserve authored work
 * reuse those exact nodes, even when they wrap them in a different envelope.
 * Reference containment therefore lets both predicate menus distinguish a
 * genuine reset from a lossless move without brittle kind-pair checklists. */
function containsReference(root: unknown, target: object): boolean {
	if (root === target) return true;
	if (Array.isArray(root)) {
		return root.some((item) => containsReference(item, target));
	}
	if (root === null || typeof root !== "object") return false;
	return Object.values(root).some((item) => containsReference(item, target));
}

function preservationGroups(value: Predicate): readonly PreservationGroup[] {
	switch (value.kind) {
		case "eq":
		case "neq":
		case "gt":
		case "gte":
		case "lt":
		case "lte":
			return [
				{ values: subjectNodes(value.left), allLost: "the subject" },
				{ values: valueNodes(value.right), allLost: "the comparison value" },
			];
		case "in":
			return [
				{ values: subjectNodes(value.left), allLost: "the subject" },
				{
					values: value.values,
					allLost: "the list values",
					partlyLost: "some list values",
				},
			];
		case "between": {
			const bounds = [value.lower, value.upper]
				.filter(
					(bound): bound is NonNullable<typeof bound> => bound !== undefined,
				)
				.flatMap(valueNodes);
			return [
				{ values: subjectNodes(value.left), allLost: "the subject" },
				{
					values: bounds,
					allLost: bounds.length === 1 ? "the range bound" : "the range bounds",
					partlyLost: "one range bound",
				},
			];
		}
		case "match":
			return [
				{ values: [value.property], allLost: "the subject" },
				{ values: valueNodes(value.value), allLost: "the match value" },
			];
		case "multi-select-contains":
			return [
				{ values: [value.property], allLost: "the subject" },
				{
					values: value.values,
					allLost: "the selected options",
					partlyLost: "some selected options",
				},
			];
		case "within-distance":
			return [
				{ values: [value.property], allLost: "the location" },
				{ values: valueNodes(value.center), allLost: "the center point" },
			];
		case "is-null":
		case "is-blank":
			return [{ values: subjectNodes(value.left), allLost: "the subject" }];
		case "and":
		case "or":
			return [
				{
					values: value.clauses,
					allLost: "the grouped conditions",
					partlyLost: "some grouped conditions",
				},
			];
		case "not":
			return [{ values: [value.clause], allLost: "the condition inside" }];
		case "when-input-present":
			return [
				{ values: [value.input], allLost: "the search answer" },
				{ values: [value.clause], allLost: "the condition inside" },
			];
		case "exists":
		case "missing":
			return [
				{ values: [value.via], allLost: "the case connection" },
				...(value.where === undefined
					? []
					: [
							{
								values: [value.where],
								allLost: "the related-case condition",
							},
						]),
			];
		case "match-all":
		case "match-none":
			return [];
	}
}

function structurallyEqual(left: unknown, right: unknown): boolean {
	if (left === right) return true;
	if (left === null || right === null) return false;
	if (typeof left !== "object" || typeof right !== "object") return false;
	if (Array.isArray(left) || Array.isArray(right)) {
		return (
			Array.isArray(left) &&
			Array.isArray(right) &&
			left.length === right.length &&
			left.every((item, index) => structurallyEqual(item, right[index]))
		);
	}
	const leftRecord = left as Record<string, unknown>;
	const rightRecord = right as Record<string, unknown>;
	const leftKeys = Object.keys(leftRecord);
	const rightKeys = Object.keys(rightRecord);
	return (
		leftKeys.length === rightKeys.length &&
		leftKeys.every(
			(key) =>
				Object.hasOwn(rightRecord, key) &&
				structurallyEqual(leftRecord[key], rightRecord[key]),
		)
	);
}

function preservesBetweenBoundaryChoices(
	current: Extract<Predicate, { kind: "between" }>,
	next: Predicate,
): boolean {
	if (containsReference(next, current)) return true;
	if (next.kind === "between") {
		return (
			next.lowerInclusive === current.lowerInclusive &&
			next.upperInclusive === current.upperInclusive
		);
	}
	if (current.lower !== undefined && current.upper === undefined) {
		return (
			(next.kind === "gte" && current.lowerInclusive) ||
			(next.kind === "gt" && !current.lowerInclusive)
		);
	}
	if (current.upper !== undefined && current.lower === undefined) {
		return (
			(next.kind === "lte" && current.upperInclusive) ||
			(next.kind === "lt" && !current.upperInclusive)
		);
	}
	return (
		next.kind === "eq" &&
		current.lower !== undefined &&
		current.upper !== undefined &&
		current.lowerInclusive &&
		current.upperInclusive &&
		structurallyEqual(current.lower, current.upper)
	);
}

function formatConsequenceList(parts: readonly string[]): string {
	if (parts.length === 1) return parts[0] ?? "part of this condition";
	if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
	return `${parts.slice(0, -1).join(", ")}, and ${parts.at(-1)}`;
}

/** Produce a confirmation only when the proposed AST no longer contains an
 * authored operand, subtree, or setting. Callers are expected to build the
 * most-preserving target first; this function is the shared loss backstop. */
export function planPredicateTransition(
	current: Predicate,
	next: Predicate,
	targetLabel: string,
): PredicateTransitionPlan {
	const losses = preservationGroups(current).flatMap((group) => {
		const lostCount = group.values.filter(
			(value) => !containsReference(next, value),
		).length;
		if (lostCount === 0) return [];
		if (lostCount < group.values.length && group.partlyLost !== undefined) {
			return [group.partlyLost];
		}
		return [group.allLost];
	});

	if (
		current.kind === "between" &&
		!preservesBetweenBoundaryChoices(current, next)
	) {
		losses.push("the range boundary choices");
	}
	if (
		current.kind === "within-distance" &&
		!containsReference(next, current) &&
		(next.kind !== "within-distance" ||
			next.distance !== current.distance ||
			next.unit !== current.unit)
	) {
		losses.push("the distance and unit");
	}

	const uniqueLosses = [...new Set(losses)];
	if (uniqueLosses.length === 0) return { next };
	const consequence = formatConsequenceList(uniqueLosses);
	return {
		next,
		confirmation: {
			title: `Change to “${targetLabel}”?`,
			description: `This removes ${consequence}. Saved case data won’t change. You can undo this change.`,
		},
	};
}

export function PredicateTransitionAlert({
	plan,
	onCancel,
	onConfirm,
	finalFocus,
}: {
	readonly plan: PredicateTransitionPlan | null;
	readonly onCancel: () => void;
	readonly onConfirm: () => void;
	readonly finalFocus?: React.ComponentProps<
		typeof AlertDialogContent
	>["finalFocus"];
}) {
	return (
		<AlertDialog
			open={plan?.confirmation !== undefined}
			onOpenChange={(open) => {
				if (!open) onCancel();
			}}
		>
			<AlertDialogContent finalFocus={finalFocus} className="text-left">
				<AlertDialogHeader>
					<AlertDialogTitle className="font-display">
						{plan?.confirmation?.title}
					</AlertDialogTitle>
					<AlertDialogDescription className="text-left">
						{plan?.confirmation?.description}
					</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogCancel>Cancel</AlertDialogCancel>
					<AlertDialogAction variant="destructive" onClick={onConfirm}>
						Change condition
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
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

/** Build the most-preserving replacement available to the structural-card
 * menu. Groups and wrappers keep the current tree inside them. Removing a
 * `not` or search-answer wrapper can return its exact child (or a structural
 * twin of that child) instead of reseeding a blank condition. Shapes that
 * cannot represent the existing work still fall back to their valid default;
 * `planPredicateTransition` then requires an explicit confirmation. */
export function buildPredicateKindReplacement(
	currentValue: Predicate,
	targetKind: Predicate["kind"],
	ctx: PredicateEditContext,
): Predicate {
	const preserved = preservedOperandSwap(currentValue, targetKind);
	if (preserved !== null) return preserved;

	if (targetKind === "and" || targetKind === "or") {
		if (
			currentValue.kind === "match-all" ||
			currentValue.kind === "match-none"
		) {
			return predicateCardSchemas[targetKind].defaultValue(ctx);
		}
		const sibling = wrapSiblingDefault(targetKind, ctx);
		return targetKind === "and"
			? and(currentValue, sibling)
			: or(currentValue, sibling);
	}
	if (targetKind === "not") return not(currentValue);
	if (targetKind === "when-input-present") {
		const fallback =
			predicateCardSchemas["when-input-present"].defaultValue(ctx);
		return { ...fallback, clause: currentValue };
	}

	const wrappedClause =
		currentValue.kind === "not" || currentValue.kind === "when-input-present"
			? currentValue.clause
			: undefined;
	if (wrappedClause !== undefined) {
		if (wrappedClause.kind === targetKind) return wrappedClause;
		const swappedClause = preservedOperandSwap(wrappedClause, targetKind);
		if (swappedClause !== null) return swappedClause;
	}

	return predicateCardSchemas[targetKind].defaultValue(ctx);
}

/** Structural-card kind menu. Lossless changes are immediate. A change that
 * would discard an authored subtree or setting closes the menu and stages the
 * shared consequence-first confirmation instead. */
export function PredicateKindReplaceMenu({
	currentValue,
	onChange,
	label = "Change condition",
}: PredicateKindReplaceMenuProps) {
	const triggerRef = useRef<HTMLButtonElement>(null);
	const [pendingKind, setPendingKind] = useState<Predicate["kind"] | null>(
		null,
	);
	const ctx = usePredicateEditContext();
	const editCtx: PredicateEditContext = {
		caseTypes: ctx.caseTypes,
		currentCaseType: ctx.currentCaseType,
		knownInputs: ctx.knownInputs,
		caseDataScope: ctx.caseDataScope,
	};
	const currentKind = currentValue.kind;
	const pendingPlan =
		pendingKind === null
			? null
			: planPredicateTransition(
					currentValue,
					buildPredicateKindReplacement(currentValue, pendingKind, editCtx),
					predicateCardSchemas[pendingKind].label,
				);

	const replaceWith = <K extends Predicate["kind"]>(
		schema: PredicateCardSchema<K>,
	) => {
		const plan = planPredicateTransition(
			currentValue,
			buildPredicateKindReplacement(currentValue, schema.kind, editCtx),
			schema.label,
		);
		if (plan.confirmation !== undefined) {
			setPendingKind(schema.kind);
			return;
		}
		onChange(plan.next);
	};

	return (
		<>
			<DropdownMenu>
				<DropdownMenuTrigger
					ref={triggerRef}
					aria-label={`${label} type`}
					render={
						<Button
							type="button"
							variant="ghost"
							size="xl"
							className="group px-2 text-sm text-nova-text-muted not-disabled:hover:bg-white/[0.04] not-disabled:hover:text-nova-violet-bright"
						/>
					}
				>
					<span>{label}</span>
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
						style={{ minWidth: "18rem", maxHeight: 320 }}
					>
						<DropdownMenuPopup className="max-h-80 min-w-0">
							{predicateCardSchemaList
								.filter(
									(s) =>
										s.kind === currentKind || isAuthorablePredicateKind(s.kind),
								)
								.map((s) => {
									const isCurrent = s.kind === currentKind;
									const isApplicable = s.applicable(editCtx);
									return (
										<DropdownMenuItem
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
											className={`h-auto min-h-11 items-start whitespace-normal py-2 ${
												isCurrent
													? "bg-nova-violet/10 text-nova-violet-bright"
													: ""
											}`}
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
												<div className="break-words">{s.label}</div>
												<div
													className={`break-words text-xs ${
														isCurrent
															? "text-nova-violet-bright"
															: "text-nova-text-muted"
													}`}
												>
													{isApplicable
														? s.description
														: predicateUnavailableReason(s.kind, editCtx)}
												</div>
											</span>
										</DropdownMenuItem>
									);
								})}
						</DropdownMenuPopup>
					</DropdownMenuPositioner>
				</DropdownMenuPortal>
			</DropdownMenu>
			<PredicateTransitionAlert
				plan={pendingPlan}
				finalFocus={triggerRef}
				onCancel={() => setPendingKind(null)}
				onConfirm={() => {
					if (pendingPlan === null) return;
					const next = pendingPlan.next;
					setPendingKind(null);
					onChange(next);
				}}
			/>
		</>
	);
}
