// components/builder/shared/ExpressionCardEditor.tsx
//
// Top-level ValueExpression AST authoring surface. Renders an
// arbitrary `ValueExpression` as a tree of cards via the registry-
// driven dispatch in `expressionEditorSchemas.ts`. Symmetric with
// `PredicateCardEditor` (the boolean-side editor) — both editors
// share the same `PredicateEditProvider` context, so a card from
// either family can mount inside the other's tree (the predicate
// card's value slots compose `ExpressionPicker` directly; the
// expression card's `if.cond` / `count.where` slots compose
// `ChildPredicateEditor`).
//
// The editor:
//
//   1. Mounts a `PredicateEditProvider` carrying the schema-driven
//      type-checking context (`caseTypes`, `currentCaseType`,
//      `knownInputs`) plus the precomputed `validityIndex` —
//      cards look up their own path's errors via the context.
//
//   2. Runs `checkValueExpression` (the public-API wrapper around
//      the recursive `checkExpression` walker) on every onChange
//      to refresh the validity index. Propagates `valid: boolean`
//      to the parent's `onValidityChange` so the parent can
//      disable save until every diagnostic is resolved.
//
//   3. Hands the root expression to `ExpressionPicker`, which
//      dispatches to the matching card via the registry. From
//      there, every nested operator (`arith` / `if` / `switch` /
//      `concat` / `coalesce` / `count` / etc.) recurses through
//      the same shell so the editor reads as one tree without
//      per-level hacks.
//
// Every mutation flows through the typed builders in
// `lib/domain/predicate/builders.ts`. Builders apply the per-arm
// invariants the schema requires (non-empty `concat.parts`,
// `coalesce.values`, `switch.cases`; ordered numeric promotion at
// `arith`; absent-not-undefined contract on optional `count.where`
// / `between.lower` etc.). Cards that drive variadic arrays cast
// at the call site (the runtime contract guarantees non-empty;
// every mutation path refuses the last-row removal).

"use client";
import { useMemo } from "react";
import { useValidityPropagator } from "@/components/builder/shared/useInnerValidityShadow";
import type { CaseType } from "@/lib/domain";
import {
	ANY_CONSTRAINT,
	acceptsType,
	type CheckError,
	checkExpression,
	checkValueExpression,
	describe,
	type SlotConstraint,
	type TypeContext,
	type ValueExpression,
} from "@/lib/domain/predicate";
import { buildValidityIndex, PredicateEditProvider } from "./editorContext";
import { ROOT_PATH } from "./path";
import { ExpressionPicker } from "./primitives/ExpressionPicker";
import type { EditorSearchInputDecl } from "./searchInputPresentation";

interface ExpressionCardEditorProps {
	/** Current AST. */
	readonly value: ValueExpression;
	/** Fired with the next AST whenever the user mutates the tree. */
	readonly onChange: (next: ValueExpression) => void;
	/** Blueprint case-type definitions. */
	readonly caseTypes: readonly CaseType[];
	/**
	 * The originating case-type scope the expression runs against.
	 * For a calculated-column expression this is the module's case
	 * type; for a sort-key expression it's the same. Inside a
	 * `count.where` clause the editor automatically rebinds
	 * `currentCaseType` to the relation walk's destination.
	 */
	readonly currentCaseType: string;
	/** Search inputs declared on the parent surface. */
	readonly knownInputs?: readonly EditorSearchInputDecl[];
	/**
	 * The root slot's type constraint. Flows to the root
	 * `ExpressionPicker` so the kind menu + value sources offer ONLY
	 * types the slot accepts (valid by construction). The same
	 * accept-set also feeds the DISPLAY backstop — a pre-existing
	 * (legacy / hypothetical) expression that resolves to a type
	 * outside the constraint surfaces a root error, even though no
	 * sequence of picker choices can author one. Defaults to
	 * `ANY_CONSTRAINT` (no narrowing).
	 */
	readonly constraint?: SlotConstraint;
	/**
	 * Surfaces the boolean validity verdict to the parent on every
	 * onChange. The editor authors valid by construction — no sequence
	 * of picker choices yields a type-incorrect expression — so for
	 * normally-authored trees this stays `true`. The verdict (and the
	 * inline diagnostics it summarizes, including the root-constraint
	 * backstop) is a DISPLAY BACKSTOP for a pre-existing (legacy /
	 * hypothetical) invalid AST a user opens; the parent gates its save
	 * affordance on it so such a tree can't be re-saved while broken.
	 */
	readonly onValidityChange?: (valid: boolean) => void;
}

/**
 * Top-level ValueExpression card editor. Composes
 * `PredicateEditProvider` + `ExpressionPicker`. The dispatch shell
 * handles every ValueExpression kind via the registry; this file's
 * job is the type-check pass + context plumbing.
 */
export function ExpressionCardEditor({
	value,
	onChange,
	caseTypes,
	currentCaseType,
	knownInputs = [],
	constraint = ANY_CONSTRAINT,
	onValidityChange,
}: ExpressionCardEditorProps) {
	// Build the type-check context from props. The same context
	// reaches both the validation pass below and the per-card
	// helpers (`PropertyRefPicker`, `LiteralValueInput`, etc.) via
	// the React context provider.
	const typeCtx = useMemo<TypeContext>(
		() => ({
			caseTypes: [...caseTypes],
			knownInputs: [...knownInputs],
			currentCaseType,
		}),
		[caseTypes, knownInputs, currentCaseType],
	);

	// Run the type checker on every value change (pure — running
	// inside `useMemo` is the right shape). The per-node verdict comes
	// from `checkValueExpression`; the root-constraint backstop adds a
	// root error when the whole expression resolves to a type the slot
	// won't accept. Valid-by-construction editing can't reach that
	// backstop — the kind menu + value sources only offer admissible
	// values — but a pre-existing invalid AST still surfaces it.
	const errors = useMemo<readonly CheckError[]>(() => {
		const result = checkValueExpression(value, typeCtx);
		const collected: CheckError[] = result.ok ? [] : [...result.errors];
		if (constraint.accepts !== "any") {
			const resolved = checkExpression(value, typeCtx, [], []);
			if (resolved !== undefined && !acceptsType(constraint, resolved)) {
				collected.push({
					path: [],
					code: "constraint-value",
					message: `This value works out to ${describe(resolved)}, which doesn't fit this spot`,
				});
			}
		}
		return collected;
	}, [value, typeCtx, constraint]);

	const validityIndex = useMemo(() => buildValidityIndex(errors), [errors]);

	// Standardized parent-validity propagation — fires on mount + on
	// every transition. The helper ref-stashes the callback so a
	// fresh-each-render parent identity doesn't trip the effect on
	// non-transitions.
	const isValid = errors.length === 0;
	useValidityPropagator({ isValid, onValidityChange });

	return (
		<PredicateEditProvider
			caseTypes={caseTypes}
			currentCaseType={currentCaseType}
			knownInputs={knownInputs}
			validityIndex={validityIndex}
		>
			<ExpressionPicker
				value={value}
				onChange={onChange}
				path={ROOT_PATH}
				constraint={constraint}
			/>
		</PredicateEditProvider>
	);
}
