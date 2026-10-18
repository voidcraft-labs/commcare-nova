// components/builder/shared/ExpressionCardEditor.tsx
//
// Top-level Expression AST authoring surface. Renders an
// arbitrary `Expression` as a tree of cards via the registry-
// driven dispatch in `expressionEditorSchemas.ts`. Symmetric with
// `PredicateCardEditor` (the boolean-side editor): both editors
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
//      `knownInputs`) plus the precomputed `validityIndex`:
//      cards look up their own path's errors via the context.
//
//   2. Runs `checkExpression` (the public-API wrapper around
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
// `lib/domain/expression/builders.ts`. Builders apply the per-arm
// invariants the schema requires (non-empty `concat.parts`,
// `coalesce.values`, `switch.cases`; ordered numeric promotion at
// `arith`; absent-not-undefined contract on optional `count.where`
// / `between.lower` etc.). Cards that drive variadic arrays cast
// at the call site (the runtime contract guarantees non-empty;
// every mutation path refuses the last-row removal).

"use client";
import { useCallback, useMemo } from "react";
import { useBuilderLookupCatalog } from "@/components/builder/lookup/catalogContext";
import { useValidityPropagator } from "@/components/builder/shared/useInnerValidityShadow";
import {
	expressionEditVerdict,
	type PredicateEditVerdict,
} from "@/lib/doc/hooks/predicateVerdicts";
import type { CaseType, UserProperty } from "@/lib/domain";
import {
	ANY_CONSTRAINT,
	type Expression,
	type ExpressionContext,
	type SlotConstraint,
} from "@/lib/domain/expression";
import { buildValidityIndex, PredicateEditProvider } from "./editorContext";
import type { CaseDataScope, EvaluationTarget } from "./editorSchemas";
import type { OperationValueScope } from "./expressionEditorSchemas";
import { expressionEditorErrors } from "./expressionEditorValidity";
import type { EditorFormFieldDecl } from "./formFieldPresentation";
import type {
	EditorLookupTableDecl,
	EditorLookupTableScope,
} from "./lookupTablePresentation";
import { ROOT_PATH } from "./path";
import { ExpressionPicker } from "./primitives/ExpressionPicker";
import { replaceExpressionNodeAtPath } from "./ruleNavigation";
import type { EditorSearchInputDecl } from "./searchInputPresentation";

interface ExpressionCardEditorProps {
	readonly expressionContext: ExpressionContext;
	/** Current AST. */
	readonly value: Expression;
	/** Fired with the next AST whenever the user mutates the tree. */
	readonly onChange: (next: Expression) => void;
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
	/** Current custom worker-information catalog for immutable user refs. */
	readonly userProperties?: readonly UserProperty[];
	/** Form answers this expression may read: already narrowed by the
	 *  owning surface to the ones its slot admits. */
	readonly formFields?: readonly EditorFormFieldDecl[];
	readonly lookupTables?: readonly EditorLookupTableDecl[];
	readonly tableScope?: EditorLookupTableScope;
	/** Present only inside a case operation, where the submission's own
	 *  vocabulary (the acting user, no owner, an earlier create's case) is
	 *  available. */
	readonly operationScope?: OperationValueScope;
	/** Enables acting-user/unowned only for a case-owner value slot. */
	readonly ownerValues?: boolean;
	/** When the slot evaluates relative to a case row. `"global"` slots
	 *  (a search input's starting value) resolve once, before any case
	 *  is selected: the provider-derived admission oracle drops every
	 *  case-property / relationship source there. */
	readonly caseDataScope?: CaseDataScope;
	/** Runtime that evaluates this value. Defaults to the strict on-device path. */
	readonly evaluationTarget?: EvaluationTarget;
	/**
	 * The root slot's type constraint. Flows to the root
	 * `ExpressionPicker` so the kind menu + value sources offer ONLY
	 * types the slot accepts (valid by construction). The same
	 * accept-set also feeds the defensive root verdict, so a caller that
	 * bypasses the authoring choices cannot commit a mismatched tree.
	 * Defaults to
	 * `ANY_CONSTRAINT` (no narrowing).
	 */
	readonly constraint?: SlotConstraint;
	/** Optional whole-candidate admission owned by the mounting surface. */
	readonly candidateEditVerdict?: (
		candidate: Expression,
		context: ExpressionContext,
	) => PredicateEditVerdict;
	/**
	 * Surfaces the boolean validity verdict to the parent on every
	 * onChange. The editor authors valid by construction: no sequence
	 * of picker choices yields a type-incorrect expression, so for
	 * normally-authored trees this stays `true`. The parent gates its save
	 * affordance on the same verdict, including the root constraint.
	 */
	readonly onValidityChange?: (valid: boolean) => void;
}

/**
 * Top-level Expression card editor. Composes
 * `PredicateEditProvider` + `ExpressionPicker`. The dispatch shell
 * handles every Expression kind via the registry; this file's
 * job is the type-check pass + context plumbing.
 */
export function ExpressionCardEditor({
	value,
	expressionContext,
	onChange,
	caseTypes,
	currentCaseType,
	knownInputs = [],
	userProperties,
	formFields,
	lookupTables,
	tableScope,
	operationScope,
	ownerValues = false,
	caseDataScope = "per-case",
	evaluationTarget = "on-device",
	constraint = ANY_CONSTRAINT,
	candidateEditVerdict,
	onValidityChange,
}: ExpressionCardEditorProps) {
	const lookupCatalog = useBuilderLookupCatalog();
	const effectiveLookupTables =
		lookupTables ??
		(lookupCatalog.kind === "ready" ? lookupCatalog.tables : []);

	// Run the type checker on every value change (pure: running
	// inside `useMemo` is the right shape). The per-node verdict comes
	// from `checkExpression`; the root-constraint backstop adds a
	// root error when the whole expression resolves to a type the slot
	// won't accept. Valid-by-construction editing can't reach that
	// backstop: the kind menu + value sources only offer admissible
	// values, but a checker-invalid in-memory draft still surfaces it.
	const errors = useMemo(
		() => expressionEditorErrors(value, expressionContext, constraint),
		[value, expressionContext, constraint],
	);

	const validityIndex = useMemo(() => buildValidityIndex(errors), [errors]);
	const admitRuntimeExpression = useCallback(
		(path: readonly (string | number)[], next: Expression) => {
			const candidate = replaceExpressionNodeAtPath(value, path, {
				family: "expression",
				value: next,
			});
			const verdict = expressionEditVerdict(candidate, expressionContext);
			const surfaceVerdict = verdict.ok
				? candidateEditVerdict?.(candidate, expressionContext)
				: undefined;
			const finalVerdict = verdict.ok ? surfaceVerdict : verdict;
			return finalVerdict === undefined || finalVerdict.ok
				? ({ admitted: true } as const)
				: ({ admitted: false, reason: finalVerdict.reason } as const);
		},
		[value, expressionContext, candidateEditVerdict],
	);

	// Standardized parent-validity propagation: fires on mount + on
	// every transition. The helper ref-stashes the callback so a
	// fresh-each-render parent identity doesn't trip the effect on
	// non-transitions.
	const isValid = errors.length === 0;
	useValidityPropagator({ isValid, onValidityChange });

	return (
		<PredicateEditProvider
			expression={value}
			expressionContext={expressionContext}
			caseTypes={caseTypes}
			currentCaseType={currentCaseType}
			knownInputs={knownInputs}
			userProperties={userProperties}
			formFields={formFields}
			lookupTables={effectiveLookupTables}
			tableScope={tableScope}
			operationScope={operationScope}
			ownerValues={ownerValues}
			caseDataScope={caseDataScope}
			evaluationTarget={evaluationTarget}
			validityIndex={validityIndex}
			admitExpressionChange={admitRuntimeExpression}
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
