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
	type CheckError,
	checkValueExpression,
	type ResolvedType,
	type SearchInputDecl,
	type TypeContext,
	type ValueExpression,
} from "@/lib/domain/predicate";
import { buildValidityIndex, PredicateEditProvider } from "./editorContext";
import { ROOT_PATH } from "./path";
import { ExpressionPicker } from "./primitives/ExpressionPicker";

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
	readonly knownInputs?: readonly SearchInputDecl[];
	/**
	 * Optional caller-side type expectation. The editor threads it
	 * into the kind-replace menu's applicability gate so unrelated
	 * kinds de-emphasize, AND into `checkValueExpression` so a
	 * top-level "Expected X; resolves to Y" error fires when the
	 * authored shape doesn't satisfy the slot's type.
	 */
	readonly expectedType?: ResolvedType;
	/**
	 * Surfaces the boolean validity verdict to the parent on every
	 * onChange. The parent gates its save affordance on this. The
	 * editor does not gate the onChange itself — invalid edits flow
	 * through so the user can keep authoring.
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
	expectedType,
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

	// Run the type checker on every value change. The checker is
	// pure (no I/O), so running inside `useMemo` is the right shape
	// — the validity index is a derived value driven by `value`,
	// the context, and the optional expectedType.
	const validityResult = useMemo(
		() => checkValueExpression(value, typeCtx, expectedType),
		[value, typeCtx, expectedType],
	);

	const errors: readonly CheckError[] = validityResult.ok
		? []
		: validityResult.errors;

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
				expectedType={expectedType}
			/>
		</PredicateEditProvider>
	);
}
