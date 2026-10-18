// components/builder/shared/PredicateCardEditor.tsx
//
// Top-level Expression AST authoring surface. Renders an arbitrary
// `Expression` as a tree of cards via the registry-driven dispatch
// in `editorSchemas.ts`. The editor:
//
//   1. Mounts a `PredicateEditProvider` carrying the schema-driven
//      type-checking context (`caseTypes`, `currentCaseType`,
//      `knownInputs`) plus the precomputed `validityIndex`:
//      cards look up their own path's errors via the context.
//
//   2. Runs `checkExpression` on every onChange to refresh the
//      validity index, propagates `valid: boolean` to the parent's
//      `onValidityChange` so the parent can disable save until
//      every diagnostic is resolved.
//
//   3. Hands the root predicate to `ChildPredicateEditor`, which
//      dispatches to the matching card. From there, every nested
//      operator (and / or / not / when-input-present / exists /
//      missing) recurses through the same shell so the editor
//      reads as one tree without per-level hacks.
//
// Every mutation flows through the typed builders in
// `lib/domain/expression/builders.ts`. Builders apply boolean-algebra
// reductions on every `and(...)` / `or(...)` / `not(...)` call
// (`and([])` → `match-all`, `and([single])` → single, `not(not(x))`
// → x, etc.) so the saved AST is always in canonical reduced form.
// Cards may therefore disappear mid-edit when their clause list
// collapses to one: the parent's onChange replaces the group with
// the unwrapped clause and the next render shows just the inner
// card.

"use client";
import { useCallback, useMemo } from "react";
import { useValidityPropagator } from "@/components/builder/shared/useInnerValidityShadow";
import type { CaseType, UserProperty } from "@/lib/domain";
import {
	type CheckError,
	checkExpression,
	type Expression,
	type ExpressionContext,
} from "@/lib/domain/expression";
import { ChildPredicateEditor } from "./cards/ChildPredicateEditor";
import { buildValidityIndex, PredicateEditProvider } from "./editorContext";
import { ROOT_PATH } from "./path";
import type { EditorSearchInputDecl } from "./searchInputPresentation";
import { workbenchExpressionAdmission } from "./workbenchAdmission";

interface PredicateCardEditorProps {
	readonly expressionContext: ExpressionContext;
	/** Current AST. */
	readonly value: Expression;
	/** Fired with the next AST whenever the user mutates the tree. */
	readonly onChange: (next: Expression) => void;
	/** Blueprint case-type definitions. */
	readonly caseTypes: readonly CaseType[];
	/**
	 * The originating case-type scope the predicate runs against.
	 * For a module's always-on Cases available rule this is the module's
	 * case type. Inside an `exists.where`
	 * clause the editor automatically rebinds `currentCaseType` to
	 * the relation walk's destination.
	 */
	readonly currentCaseType: string;
	/** Search inputs declared on the parent surface. */
	readonly knownInputs?: readonly EditorSearchInputDecl[];
	/** Current custom worker-information catalog for immutable user refs. */
	readonly userProperties?: readonly UserProperty[];
	/**
	 * Surfaces the boolean validity verdict to the parent on every
	 * onChange. The editor authors valid by construction: no sequence
	 * of picker choices yields a type-incorrect predicate, so for
	 * normally-authored trees this stays `true`. The parent gates its save
	 * affordance on the same verdict.
	 */
	readonly onValidityChange?: (valid: boolean) => void;
	/**
	 * Optional removal action supplied by a parent list composer. Standalone
	 * predicate slots omit it; surfaces that visibly list peer conditions (for
	 * example Results' Cases available card) pass it so the root condition is
	 * just as removable as a nested clause.
	 */
	readonly onRemove?: () => void;
}

/**
 * Top-level Expression card editor. Composes `PredicateEditProvider`
 * + `ChildPredicateEditor`. The dispatch shell handles every
 * predicate kind via the registry; this file's job is the type-
 * check pass + context plumbing.
 */
export function PredicateCardEditor({
	value,
	expressionContext,
	onChange,
	caseTypes,
	currentCaseType,
	knownInputs = [],
	userProperties = [],
	onValidityChange,
	onRemove,
}: PredicateCardEditorProps) {
	// Run the type checker on every value change. The checker is
	// pure (no I/O, no allocations beyond the error list), so
	// running it inside `useMemo` is the right shape: the
	// validity index is a derived value driven by `value` and the
	// context.
	const validityResult = useMemo(
		() => checkExpression(value, expressionContext),
		[value, expressionContext],
	);

	const errors: readonly CheckError[] = validityResult.errors;

	const validityIndex = useMemo(() => buildValidityIndex(errors), [errors]);

	// Standardized parent-validity propagation: fires on mount + on
	// every transition. Downstream consumers (the Filter-section save
	// button) gate on this and need the initial-mount fire so the
	// parent's save state initializes correctly. The helper ref-
	// stashes the callback internally so a fresh-each-render parent
	// identity doesn't trip the effect on non-transitions.
	const admitExpression = useCallback(
		(path: readonly (string | number)[], next: Expression) =>
			workbenchExpressionAdmission(value, path, next, expressionContext),
		[value, expressionContext],
	);
	const isValid = errors.length === 0;
	useValidityPropagator({ isValid, onValidityChange });

	return (
		<PredicateEditProvider
			expression={value}
			expressionContext={expressionContext}
			admitExpressionChange={admitExpression}
			caseTypes={caseTypes}
			currentCaseType={currentCaseType}
			knownInputs={knownInputs}
			userProperties={userProperties}
			validityIndex={validityIndex}
		>
			<ChildPredicateEditor
				value={value}
				onChange={onChange}
				onRemove={onRemove}
				path={ROOT_PATH}
			/>
		</PredicateEditProvider>
	);
}
