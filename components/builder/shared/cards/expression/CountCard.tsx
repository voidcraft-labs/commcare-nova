// components/builder/shared/cards/expression/CountCard.tsx
//
// Renders the `count` ValueExpression — relational aggregation. Two
// slots:
//
//   - `via` — `RelationPath` to walk along. Routes through the
//     shared `RelationPathBuilder` primitive so non-canonical walks
//     (multi-hop ancestor, qualified subcase, any-relation) remain
//     editable through the complete path builder.
//   - `where` — optional `Predicate`. When present, the count is
//     filtered to related cases where the predicate holds. Routes
//     through `ChildPredicateEditor` so the full Predicate-side
//     editor is reachable inline.
//
// Type-checker rules (per `checkExpression`'s `case "count":`):
//   - The `via` walk must resolve to a destination case type.
//   - The `where` clause type-checks in the destination scope (per
//     `checkInDestinationScope`).
//   - `via.kind === "self"` counts the current case (1, or 0/1 when
//     filtered) and is valid across the expression emitters.
//
// Path encoding: errors emit at `[..., "count"]` (operator-level,
// e.g. "missing scope"), `[..., "count", "via"]`, `[..., "count",
// "where"]`. Use `appendKind(path, "count")` for operator-level and
// `appendKindSlot(path, "count", slot)` for sub-slots.

"use client";
import { useId, useMemo } from "react";
import { Button } from "@/components/shadcn/button";
import { FieldDescription } from "@/components/shadcn/field";
import {
	ancestorPath,
	count,
	type Predicate,
	type RelationPath,
	relationStep,
	selfPath,
	subcasePath,
	type ValueExpression,
} from "@/lib/domain/predicate";
import {
	CONDITION_SEED_UNAVAILABLE_REASON,
	firstConditionSeed,
} from "../../conditionSeed";
import {
	useEditorErrorsAt,
	usePredicateEditContext,
	WithCurrentCaseType,
} from "../../editorContext";
import type { ExpressionEditContext } from "../../expressionEditorSchemas";
import { appendKind, appendKindSlot, type EditorPath } from "../../path";
import { InlineError } from "../../primitives/CardShell";
import { RelationPathBuilder } from "../../primitives/RelationPathBuilder";
import { resolveRelationDestination } from "../../relationDestination";
import { PredicateFocusBoundary } from "../ChildPredicateEditor";

export function hasCountableRelation(ctx: ExpressionEditContext): boolean {
	const current = ctx.caseTypes.find(
		(caseType) => caseType.name === ctx.currentCaseType,
	);
	const hasParent =
		current?.parent_type !== undefined &&
		ctx.caseTypes.some((caseType) => caseType.name === current.parent_type);
	const hasChild = ctx.caseTypes.some(
		(caseType) => caseType.parent_type === ctx.currentCaseType,
	);
	return hasParent || hasChild;
}

/** Seed the first real catalog connection: parent first, then the first child.
 * A no-relation fallback remains valid for the total registry factory, but the
 * new-target menu disables Count in that scope with a specific explanation. */
export function countDefault(
	ctx: ExpressionEditContext,
): Extract<ValueExpression, { kind: "count" }> {
	const current = ctx.caseTypes.find(
		(caseType) => caseType.name === ctx.currentCaseType,
	);
	if (
		current?.parent_type !== undefined &&
		ctx.caseTypes.some((caseType) => caseType.name === current.parent_type)
	) {
		return count(ancestorPath(relationStep("parent")));
	}

	const child = ctx.caseTypes.find(
		(caseType) => caseType.parent_type === ctx.currentCaseType,
	);
	if (child !== undefined) {
		return count(subcasePath("parent", child.name));
	}

	return count(selfPath());
}

interface CountCardProps {
	readonly value: Extract<ValueExpression, { kind: "count" }>;
	readonly onChange: (next: ValueExpression) => void;
	readonly path: EditorPath;
}

export function CountCard({ value, onChange, path }: CountCardProps) {
	const ctx = usePredicateEditContext();
	const operatorErrors = useEditorErrorsAt(appendKind(path, "count"));
	const viaErrors = useEditorErrorsAt(appendKindSlot(path, "count", "via"));
	const unavailableReasonId = useId();

	const setVia = (next: RelationPath) => {
		// Preserve the complete filter tree when the connection changes.
		// A newly incompatible destination is a visible repair state, not
		// permission to silently replace the condition with match-all.
		onChange(
			value.where === undefined ? count(next) : count(next, value.where),
		);
	};

	const setWhere = (next: Predicate | undefined) => {
		// `count` builder's absent-not-undefined contract: passing
		// undefined produces `{ kind: "count", via }` with no `where`
		// key (rather than `where: undefined`), matching the schema's
		// `.optional()` strip behavior on parse.
		onChange(next === undefined ? count(value.via) : count(value.via, next));
	};

	// Resolve the destination case type from the relation path so
	// nested property pickers in the `where` clause show the
	// destination's properties. Same shared helper drives the
	// destination resolution in `ExistsCard`.
	const destinationCaseType = useMemo(
		() =>
			resolveRelationDestination(value.via, ctx.currentCaseType, ctx.caseTypes),
		[value.via, ctx.currentCaseType, ctx.caseTypes],
	);
	const whereSeed = useMemo(
		() =>
			destinationCaseType === undefined
				? undefined
				: firstConditionSeed({
						caseTypes: ctx.caseTypes,
						currentCaseType: destinationCaseType,
						knownInputs: ctx.knownInputs,
					}),
		[destinationCaseType, ctx.caseTypes, ctx.knownInputs],
	);
	const addWhere = () => {
		if (whereSeed === undefined) return;
		setWhere(whereSeed);
	};
	const addWhereUnavailable =
		value.where === undefined && whereSeed === undefined;

	return (
		<div className="space-y-2">
			<div>
				<RelationPathBuilder
					value={value.via}
					onChange={setVia}
					invalid={operatorErrors.length > 0 || viaErrors.length > 0}
					allowSelf
				/>
				<InlineError errors={viaErrors} />
				{operatorErrors.length > 0 && <InlineError errors={operatorErrors} />}
			</div>

			<div className="space-y-1.5">
				<div className="flex flex-wrap items-center justify-between gap-2">
					<div>
						<p className="text-[13px] font-medium text-nova-text-secondary">
							Cases to count
						</p>
						<p className="mt-0.5 text-[13px] leading-relaxed text-nova-text-muted">
							Without a condition, every case on this connection is counted
						</p>
					</div>
					<Button
						type="button"
						variant="ghost"
						size="xl"
						disabled={addWhereUnavailable}
						aria-describedby={
							addWhereUnavailable ? unavailableReasonId : undefined
						}
						onClick={() =>
							value.where === undefined ? addWhere() : setWhere(undefined)
						}
						className={
							value.where === undefined
								? "text-nova-text-secondary"
								: "text-nova-rose not-disabled:hover:bg-nova-rose/[0.08] not-disabled:hover:text-nova-rose"
						}
					>
						{value.where === undefined ? "Add condition" : "Delete condition"}
					</Button>
				</div>
				{addWhereUnavailable ? (
					<FieldDescription
						id={unavailableReasonId}
						className="text-[13px] leading-relaxed text-nova-text-muted"
					>
						{CONDITION_SEED_UNAVAILABLE_REASON}
					</FieldDescription>
				) : null}
				{value.where !== undefined && destinationCaseType !== undefined && (
					<WithCurrentCaseType caseType={destinationCaseType}>
						<PredicateFocusBoundary
							value={value.where}
							onChange={(next) => setWhere(next)}
							path={appendKindSlot(path, "count", "where")}
							variant="nested"
						/>
					</WithCurrentCaseType>
				)}
				{value.where !== undefined && destinationCaseType === undefined && (
					<div className="rounded-lg border border-dashed border-white/[0.06] px-3 py-2 text-[13px] text-nova-text-muted">
						Pick a valid connection before narrowing it with a condition
					</div>
				)}
			</div>
		</div>
	);
}
