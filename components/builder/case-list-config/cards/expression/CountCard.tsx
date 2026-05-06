// components/builder/case-list-config/cards/expression/CountCard.tsx
//
// Renders the `count` ValueExpression — relational aggregation. Two
// slots:
//
//   - `via` — `RelationPath` to walk along. Routes through the
//     shared `RelationPathBuilder` primitive so non-canonical walks
//     (multi-hop ancestor, qualified subcase, any-relation) round-trip
//     through the read-only badge.
//   - `where` — optional `Predicate`. When present, the count is
//     filtered to related cases where the predicate holds. Routes
//     through `ChildPredicateEditor` so the full Predicate-side
//     editor is reachable inline.
//
// Type-checker rules (per `checkExpression`'s `case "count":`):
//   - The `via` walk must resolve to a destination case type.
//   - The `where` clause type-checks in the destination scope (per
//     `checkInDestinationScope`).
//   - Top-level `via.kind === "self"` is rejected (no useful semantic).
//
// Path encoding: errors emit at `[..., "count"]` (operator-level,
// e.g. "missing scope"), `[..., "count", "via"]`, `[..., "count",
// "where"]`. Use `appendKind(path, "count")` for operator-level and
// `appendKindSlot(path, "count", slot)` for sub-slots.

"use client";
import { useMemo } from "react";
import {
	ancestorPath,
	count,
	matchAll,
	type Predicate,
	type RelationPath,
	relationStep,
	type ValueExpression,
} from "@/lib/domain/predicate";
import {
	useEditorErrorsAt,
	usePredicateEditContext,
	WithCurrentCaseType,
} from "../../editorContext";
import type { ExpressionEditContext } from "../../expressionEditorSchemas";
import { appendKind, appendKindSlot, type EditorPath } from "../../path";
import { InlineError } from "../../primitives/CardShell";
import { RelationPathBuilder } from "../../primitives/RelationPathBuilder";
import { ChildPredicateEditor } from "../ChildPredicateEditor";

/** Default `count` — one-step ancestor walk via `parent` with no
 *  filter. Mirrors `existsDefault` on the Predicate side; authors
 *  pivot via the relation-path builder. */
export function countDefault(
	_ctx: ExpressionEditContext,
): Extract<ValueExpression, { kind: "count" }> {
	return count(ancestorPath(relationStep("parent")));
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

	const setVia = (next: RelationPath) => {
		onChange(count(next, value.where));
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
	// destination's properties. Mirrors `ExistsCard`'s
	// `resolveDestination` shape.
	const destinationCaseType = useMemo(
		() => resolveDestination(value.via, ctx.currentCaseType, ctx.caseTypes),
		[value.via, ctx.currentCaseType, ctx.caseTypes],
	);

	return (
		<div className="space-y-2">
			<div>
				<div className="text-[10px] text-nova-text-muted/70 uppercase tracking-wider mb-1">
					Count related cases via
				</div>
				<RelationPathBuilder
					value={value.via}
					onChange={setVia}
					invalid={operatorErrors.length > 0 || viaErrors.length > 0}
				/>
				<InlineError errors={viaErrors} />
				{operatorErrors.length > 0 && <InlineError errors={operatorErrors} />}
			</div>

			<div>
				<div className="flex items-center justify-between mb-1">
					<div className="text-[10px] text-nova-text-muted/70 uppercase tracking-wider">
						Where (optional)
					</div>
					<button
						type="button"
						onClick={() =>
							setWhere(value.where === undefined ? matchAll() : undefined)
						}
						className="text-[10px] uppercase tracking-wider text-nova-text-muted/70 hover:text-nova-violet-bright transition-colors cursor-pointer"
					>
						{value.where === undefined ? "+ Add filter" : "Remove filter"}
					</button>
				</div>
				{value.where !== undefined && destinationCaseType !== undefined && (
					<WithCurrentCaseType caseType={destinationCaseType}>
						<ChildPredicateEditor
							value={value.where}
							onChange={(next) => setWhere(next)}
							path={appendKindSlot(path, "count", "where")}
							variant="nested"
						/>
					</WithCurrentCaseType>
				)}
				{value.where !== undefined && destinationCaseType === undefined && (
					<div className="text-[11px] text-nova-text-muted/60 italic px-2 py-1.5 rounded-md border border-dashed border-white/[0.06]">
						Pick a valid relation walk to author a where clause.
					</div>
				)}
			</div>
		</div>
	);
}

/** Resolve the destination case-type name for a relation walk. Same
 *  shape as `ExistsCard`'s helper — mirrors `checkRelationPath`'s
 *  walk semantics. Returns undefined when the walk is structurally
 *  unresolvable; the surrounding card surfaces the error inline via
 *  the type checker's verdict. */
function resolveDestination(
	via: RelationPath,
	originCaseType: string,
	caseTypes: readonly { name: string; parent_type?: string }[],
): string | undefined {
	switch (via.kind) {
		case "self":
			// `count(via: self)` is rejected by the type checker as a
			// no-op walk; the editor still renders the where-clause
			// against the origin so transient picks don't blank the
			// inner editor.
			return originCaseType;
		case "ancestor": {
			let current: string | undefined = originCaseType;
			for (const _step of via.via) {
				if (current === undefined) return undefined;
				const ct = caseTypes.find((c) => c.name === current);
				if (ct === undefined) return undefined;
				current = ct.parent_type;
			}
			return current;
		}
		case "subcase":
		case "any-relation": {
			const candidates = caseTypes.filter(
				(c) => c.parent_type === originCaseType,
			);
			if (via.ofCaseType !== undefined) {
				const named = candidates.find((c) => c.name === via.ofCaseType);
				return named?.name;
			}
			return candidates[0]?.name;
		}
	}
}
