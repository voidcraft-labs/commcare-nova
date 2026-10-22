// components/builder/shared/editorContext.tsx
//
// React context for the predicate card editor. Carries the schema-
// driven type-checking inputs (`caseTypes`, `currentCaseType`,
// `knownInputs`) and the precomputed `validityIndex` mapping from
// serialized `CheckPath` strings to per-node errors.
//
// The context is the spine of the editor: every card looks up its
// own path in the index to surface inline diagnostics, and the
// property pickers / value pickers read `caseTypes` / `knownInputs`
// to drive their dropdown content.
//
// Scope flips at relational quantifiers: when a card descends into
// an `exists.where` or `missing.where`, the context's
// `currentCaseType` changes to the relation walk's destination so
// nested property dropdowns show the destination's properties (per
// the type-checker's `checkInDestinationScope` contract). The
// `WithExpressionContext` helper derives that scope;
// `WithCurrentCaseType` updates only the labels and menus.

"use client";
import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useMemo,
	useRef,
} from "react";
import type { CaseType, UserProperty } from "@/lib/domain";
import {
	type CheckError,
	type Expression,
	type ExpressionContext,
	expressionContextAtPath,
	type ScalarType,
	scalarDataType,
	typeOf,
} from "@/lib/domain/expression";
import { presentCheckErrorForEditor } from "./checkErrorPresentation";
import { type EditorAxes, editorAxesOf } from "./editorAxes";
import type {
	CaseDataScope,
	EvaluationTarget,
	PredicateEditContext as PredicateEditContextShape,
} from "./editorSchemas";
import { EMPTY_FORM_FIELDS, EMPTY_USER_PROPERTIES } from "./editorTypeContext";
import type { OperationValueScope } from "./expressionEditorSchemas";
import type { EditorFormFieldDecl } from "./formFieldPresentation";
import type {
	EditorLookupTableDecl,
	EditorLookupTableScope,
} from "./lookupTablePresentation";
import type { EditorPath } from "./path";
import { serializePath } from "./path";
import type { EditorSearchInputDecl } from "./searchInputPresentation";

/** Re-exported from its dependency-free home so the pure cascade-reseed
 *  helpers can read the same context without importing this React
 *  module: see `editorTypeContext.ts` for why that separation exists. */
export { editorExpressionContext } from "./editorTypeContext";

/**
 * Per-path user-facing diagnostic list. Raw `CheckError.message`
 * stays at the checker boundary for agents, logs, and developer
 * diagnostics; the path itself is the lookup key, not part of the
 * stored entry.
 */
export type EditorPathErrors = readonly string[];

/**
 * Opaque map type: components consume it through the helpers below
 * (`useEditorErrorsAt` / `useEditorIsValid`) rather than indexing
 * directly. Keeps the serialization format private.
 */
type ValidityIndex = ReadonlyMap<string, EditorPathErrors>;

export type ExpressionChangeAdmission =
	| { readonly admitted: true }
	| { readonly admitted: false; readonly reason: string };

export type AdmitExpressionChange = (
	path: EditorPath,
	next: Expression,
) => ExpressionChangeAdmission;

interface EditorVocabularyValue {
	readonly expressionPath: EditorPath;
	readonly expression?: Expression;
	readonly rootExpressionContext?: ExpressionContext;
	readonly expressionContext?: ExpressionContext;
	/** Blueprint case-type definitions. Drives property dropdowns. */
	readonly caseTypes: readonly CaseType[];
	/**
	 * The originating case-type scope the predicate runs against.
	 * Inside an `exists.where` clause this rebinds to the relation
	 * walk's destination so nested property pickers show the
	 * destination's properties; the type checker's
	 * `checkInDestinationScope` enforces the same scope at validation
	 * time.
	 */
	readonly currentCaseType: string;
	/** Declared search inputs in scope at the editor's mount site. */
	readonly knownInputs: readonly EditorSearchInputDecl[];
	/** Custom worker information available to identity-backed user terms. */
	readonly userProperties: readonly UserProperty[];
	/**
	 * Form answers this editor may read, ALREADY narrowed by the mounting
	 * surface to the ones its slot admits: a case operation running once
	 * per submission drops every answer that has one value per repeat
	 * iteration, because the commit gate refuses that reference. Empty on
	 * every surface that reads no form answers at all.
	 */
	readonly formFields: readonly EditorFormFieldDecl[];
	readonly formCaseTypes?: ReadonlySet<string>;
	readonly lookupTables: readonly EditorLookupTableDecl[];
	/**
	 * The submission-local vocabulary, present only inside a case
	 * operation: the acting user, no owner, and the case an earlier create
	 * made. Absent everywhere else, where the type checker refuses all
	 * three.
	 */
	readonly operationScope: OperationValueScope | undefined;
	/** See `PredicateEditContext.allowsNeverMatch`. Carried on the React
	 *  context because nested cards rebuild their edit context from it. */
	readonly allowsNeverMatch: boolean;
	/** The menu axes, read from the slot's context by `editorAxesOf`
	 *  (`editorAxes.ts`) and carried here because nested cards rebuild their
	 *  edit context from the React context. Each nested node reads them from
	 *  its own context (`WithExpressionContext`), so a data-table query's
	 *  condition reads that table's row. */
	readonly tableScope: EditorLookupTableScope | undefined;
	readonly ownerValues: boolean;
	readonly caseDataScope: CaseDataScope;
	readonly evaluationTarget: EvaluationTarget;
	readonly patternMatching: true | undefined;
	/**
	 * Errors keyed by serialized path. Cards look up their own path
	 * via `useEditorErrorsAt` to render inline diagnostics; the
	 * top-level editor uses the index size to gate the parent's save
	 * affordance (via `onValidityChange`).
	 */
	readonly validityIndex: ValidityIndex;
	/**
	 * Optional whole-rule admission oracle for a value replacement. Slot
	 * constraints prove type correctness; some execution surfaces impose an
	 * additional rule-level contract that cannot be inferred from one slot in
	 * isolation. The callback receives the exact editor path and proposed value
	 * so menus can disable a guaranteed rejection before it reaches onChange.
	 */
	readonly admitExpressionChange: AdmitExpressionChange | undefined;
	/** The current primary control for each expression slot. Unlike component
	 * refs, this registry survives a value-kind replacement that remounts the
	 * picker at the same editor path. */
	readonly expressionFocusTargets: Map<string, HTMLElement>;
}

type PredicateEditContextValue = EditorVocabularyValue & {
	readonly expression: Expression;
	readonly rootExpressionContext: ExpressionContext;
	readonly expressionContext: ExpressionContext;
};

const PredicateEditContext = createContext<EditorVocabularyValue | null>(null);

const EMPTY_LOOKUP_TABLES: readonly EditorLookupTableDecl[] = [];
const CATALOG_ONLY_AXES: EditorAxes = {
	caseDataScope: "per-case",
	evaluationTarget: "on-device",
	ownerValues: false,
};

interface EditorVocabularyProviderProps {
	readonly caseTypes: readonly CaseType[];
	readonly currentCaseType: string;
	readonly knownInputs: readonly EditorSearchInputDecl[];
	readonly userProperties?: readonly UserProperty[];
	readonly formFields?: readonly EditorFormFieldDecl[];
	readonly formCaseTypes?: ReadonlySet<string>;
	readonly lookupTables?: readonly EditorLookupTableDecl[];
	readonly operationScope?: OperationValueScope;
	readonly allowsNeverMatch?: boolean;
	readonly validityIndex: ValidityIndex;
	readonly admitExpressionChange?: AdmitExpressionChange | undefined;
	readonly children: ReactNode;
}

/** The root expression and its slot context stay fixed as nested cards derive
 * lexical scopes. Catalog-only controls use EditorVocabularyProvider directly. */
export function PredicateEditProvider(
	props: EditorVocabularyProviderProps & {
		readonly expression: Expression;
		readonly expressionContext: ExpressionContext;
		readonly expressionPath?: EditorPath;
	},
) {
	return <EditorVocabularyProvider {...props} />;
}

/** Property-only controls need catalogs, but do not own an expression slot. */
export function EditorVocabularyProvider({
	expression,
	expressionContext,
	expressionPath = [],
	caseTypes,
	currentCaseType,
	knownInputs,
	userProperties = EMPTY_USER_PROPERTIES,
	formFields = EMPTY_FORM_FIELDS,
	formCaseTypes,
	lookupTables = EMPTY_LOOKUP_TABLES,
	operationScope,
	allowsNeverMatch = true,
	validityIndex,
	admitExpressionChange,
	children,
}: EditorVocabularyProviderProps & {
	readonly expression?: Expression;
	readonly expressionContext?: ExpressionContext;
	readonly expressionPath?: EditorPath;
}) {
	const expressionFocusTargets = useRef(new Map<string, HTMLElement>()).current;
	const effectiveAdmit = admitExpressionChange;
	const currentContext = useMemo(
		() =>
			expression === undefined || expressionContext === undefined
				? undefined
				: expressionContextAtPath(
						expression,
						expressionContext,
						expressionPath,
					),
		[expression, expressionContext, expressionPath],
	);
	// The menus' axes are read from the slot at the edited path, never passed
	// by a surface: the same context the edit's verdict is judged with. A
	// catalog-only control (no slot) reads the ordinary per-case defaults.
	const axes = useMemo(
		() =>
			currentContext === undefined
				? CATALOG_ONLY_AXES
				: editorAxesOf(currentContext, lookupTables),
		[currentContext, lookupTables],
	);
	const { caseDataScope, evaluationTarget, ownerValues, tableScope } = axes;
	const patternMatching = axes.patternMatching;
	const value = useMemo<EditorVocabularyValue>(
		() => ({
			expression,
			expressionPath,
			rootExpressionContext: expressionContext,
			expressionContext: currentContext,
			caseTypes,
			currentCaseType,
			knownInputs,
			userProperties,
			formFields,
			formCaseTypes,
			lookupTables,
			tableScope,
			operationScope,
			ownerValues,
			caseDataScope,
			allowsNeverMatch,
			evaluationTarget,
			patternMatching,
			validityIndex,
			admitExpressionChange: effectiveAdmit,
			expressionFocusTargets,
		}),
		[
			expression,
			expressionContext,
			currentContext,
			expressionPath,
			caseTypes,
			currentCaseType,
			knownInputs,
			userProperties,
			formFields,
			formCaseTypes,
			lookupTables,
			tableScope,
			operationScope,
			ownerValues,
			caseDataScope,
			allowsNeverMatch,
			evaluationTarget,
			patternMatching,
			validityIndex,
			effectiveAdmit,
			expressionFocusTargets,
		],
	);
	if (expression !== undefined && currentContext === undefined) return null;
	return <PredicateEditContext value={value}>{children}</PredicateEditContext>;
}

/** Register and resolve the primary control for one expression slot. Cleanup
 * removes only the element owned by this mount, so an old kind unmounting
 * cannot erase the new kind's control when both share the same path. */
export function useExpressionFocusTarget(path: EditorPath): {
	readonly register: (target: HTMLElement | null) => void;
	readonly resolve: () => HTMLElement | null;
	readonly focusAfterReplacement: (fallback?: HTMLElement | null) => void;
} {
	const { expressionFocusTargets } = usePredicateEditContext();
	const key = serializePath(path);
	const ownedTargetRef = useRef<HTMLElement | null>(null);
	const register = useCallback(
		(target: HTMLElement | null) => {
			const ownedTarget = ownedTargetRef.current;
			if (target === null) {
				if (
					ownedTarget !== null &&
					expressionFocusTargets.get(key) === ownedTarget
				) {
					expressionFocusTargets.delete(key);
				}
				ownedTargetRef.current = null;
				return;
			}
			ownedTargetRef.current = target;
			expressionFocusTargets.set(key, target);
		},
		[expressionFocusTargets, key],
	);
	const resolve = useCallback(() => {
		const target = expressionFocusTargets.get(key);
		if (target?.isConnected === true) return target;
		if (target !== undefined) expressionFocusTargets.delete(key);
		return null;
	}, [expressionFocusTargets, key]);
	const focusAfterReplacement = useCallback(
		(fallback: HTMLElement | null = null) => {
			// A term/calculation replacement unmounts the control that opened its
			// confirmation. Base UI therefore has no surviving trigger to restore
			// focus to. Wait for React to register the equivalent control at the
			// same editor path, then run after the dialog's own close-focus task.
			// This is intentionally the narrow exception to `finalFocus`; ordinary
			// closes keep using the primitive's built-in focus restoration.
			queueMicrotask(() => {
				queueMicrotask(() => {
					const target = expressionFocusTargets.get(key);
					if (target?.isConnected === true) {
						target.focus({ preventScroll: true });
						return;
					}
					if (fallback?.isConnected === true) {
						fallback.focus({ preventScroll: true });
					}
				});
			});
		},
		[expressionFocusTargets, key],
	);
	return useMemo(
		() => ({ register, resolve, focusAfterReplacement }),
		[register, resolve, focusAfterReplacement],
	);
}

/** Every nested node reads the same context derivation as the checker, and
 * its menus read their axes from that context. */
export function WithExpressionContext({
	path,
	children,
}: {
	readonly path: EditorPath;
	readonly children: ReactNode;
}) {
	const outer = usePredicateEditContext();
	const expressionContext = useMemo(
		() =>
			expressionContextAtPath(
				outer.expression,
				outer.rootExpressionContext,
				path,
			),
		[outer.expression, outer.rootExpressionContext, path],
	);
	const value = useMemo(() => {
		if (expressionContext === undefined) return undefined;
		const axes = editorAxesOf(expressionContext, outer.lookupTables);
		return {
			...outer,
			expressionContext,
			expressionPath: path,
			caseDataScope: axes.caseDataScope,
			evaluationTarget: axes.evaluationTarget,
			ownerValues: axes.ownerValues,
			tableScope: axes.tableScope,
			patternMatching: axes.patternMatching,
		};
	}, [outer, expressionContext, path]);
	return value === undefined ? null : (
		<PredicateEditContext value={value}>{children}</PredicateEditContext>
	);
}

interface WithCurrentCaseTypeProps {
	readonly caseType: string;
	readonly children: ReactNode;
}

/**
 * Inner provider that flips `currentCaseType` for nested
 * property pickers. Mounted by `ExistsCard` (and any other card
 * walking into a destination scope) so descendants resolve property
 * references against the new scope. Inherits the rest of the
 * context unchanged: keeps `caseTypes`, `knownInputs`, and
 * `validityIndex` consistent across the entire predicate tree.
 */
export function WithCurrentCaseType({
	caseType,
	children,
}: WithCurrentCaseTypeProps) {
	const outer = usePredicateEditContext();
	const value = useMemo<PredicateEditContextValue>(
		() => ({ ...outer, currentCaseType: caseType }),
		[outer, caseType],
	);
	return <PredicateEditContext value={value}>{children}</PredicateEditContext>;
}

export function WithLookupTableScope({
	table,
	children,
}: {
	readonly table: EditorLookupTableDecl;
	readonly children: ReactNode;
}) {
	const outer = usePredicateEditContext();
	const value = useMemo<PredicateEditContextValue>(
		() => ({
			...outer,
			caseDataScope: "table-row",
			tableScope: { tableId: table.id, columns: table.columns },
		}),
		[outer, table],
	);
	return <PredicateEditContext value={value}>{children}</PredicateEditContext>;
}

/**
 * Read the editor context. Use this when a card needs the full
 * trio (case types + current scope + known inputs): typical for
 * property pickers and value pickers that resolve dropdown content
 * from the schema. Throws if called outside a
 * `<PredicateEditProvider>`: every card mounts beneath the
 * top-level editor's provider, so the throw indicates a structural
 * authoring bug rather than a runtime branch the editor can recover
 * from.
 */
/**
 * Project the React context onto the plain `PredicateEditContext` the
 * schemas, seeds, and verb builds consume.
 *
 * Every card that opens a menu needs this, and each used to spell it as
 * its own object literal: four literals, four independent chances to
 * omit an axis, and omitting one is silent: the narrower context still
 * type-checks, still renders, and only shows up as a menu offering
 * something the gate refuses or withholding something it admits. One
 * projection means a new axis reaches every menu by construction.
 */
export function predicateEditContextFrom(
	ctx: PredicateEditContextValue,
): PredicateEditContextShape {
	return {
		expressionContext: ctx.expressionContext,
		caseTypes: ctx.caseTypes,
		currentCaseType: ctx.currentCaseType,
		knownInputs: ctx.knownInputs,
		userProperties: ctx.userProperties,
		formFields: ctx.formFields,
		formCaseTypes: ctx.formCaseTypes,
		lookupTables: ctx.lookupTables,
		tableScope: ctx.tableScope,
		operationScope: ctx.operationScope,
		ownerValues: ctx.ownerValues,
		caseDataScope: ctx.caseDataScope,
		allowsNeverMatch: ctx.allowsNeverMatch,
		evaluationTarget: ctx.evaluationTarget,
		...(ctx.patternMatching && { patternMatching: true }),
	};
}

export function useEditorVocabulary(): EditorVocabularyValue {
	const ctx = useContext(PredicateEditContext);
	if (ctx === null) {
		throw new Error(
			"usePredicateEditContext must be called inside <PredicateEditProvider>. The provider mounts at the top of `PredicateCardEditor`; nested cards should not be rendered outside that tree.",
		);
	}
	return ctx;
}

export function usePredicateEditContext(): PredicateEditContextValue {
	const ctx = useEditorVocabulary();
	if (
		ctx.expression === undefined ||
		ctx.rootExpressionContext === undefined ||
		ctx.expressionContext === undefined
	) {
		throw new Error(
			"The expression editor needs its owning document slot context.",
		);
	}
	return ctx as PredicateEditContextValue;
}

/**
 * Resolve a value expression's type against the live editor scope:
 * the bridge that makes the editor's "valid choices" provably a
 * function of the type checker. A card calls this on its SUBJECT
 * (e.g. a comparison's left operand) to derive the type constraint it
 * hands its dependent slots (`comparisonObjectConstraint(kind, subjectType)`),
 * so the offered set is exactly what `checkExpression` would accept.
 *
 * Runs the pure checker with a throwaway error sink: only the resolved
 * type is used; diagnostics already surface through `validityIndex`.
 * Returns `undefined` for an absent or unresolved subject (an empty
 * property name, an unknown ref), which the constraint factories read
 * as "no narrowing" so an incomplete subject never disables a choice.
 */
export function useResolvedType(
	expr: Expression | undefined,
): ScalarType | undefined {
	const context = useEditorExpressionContext();
	return useMemo(
		() =>
			expr === undefined
				? undefined
				: scalarDataType(typeOf(expr, context)?.data),
		[expr, context],
	);
}

/** The current node's context, already derived from its actual owning slot. */
export function useEditorExpressionContext(): ExpressionContext {
	return usePredicateEditContext().expressionContext;
}

/**
 * Read errors attached to a specific path. Returns an empty array
 * when no errors landed on the path. Cards call this with their
 * own path or with a slot-level path to surface inline diagnostics
 * next to the offending input.
 */
export function useEditorErrorsAt(path: EditorPath): EditorPathErrors {
	const { validityIndex } = useEditorVocabulary();
	const key = serializePath(path);
	return validityIndex.get(key) ?? [];
}

/**
 * Read errors attached to a STRICT descendant of `path`: excludes
 * the slot itself. Used by term-arm cards inside an outer slot that
 * need to surface deeper-path errors which no inner card reads at
 * its own depth, WITHOUT duplicating the slot-level errors the
 * outer shell already renders via `useEditorErrorsAt(path)` exact
 * lookup.
 *
 * Concretely (the `TermCard` consumer at `cards/expression/TermCard.tsx`):
 * `match.value`'s term-resolution failures emit at
 * `[..., "value", "term"]` because `checkMatch` resolves the term
 * directly with that path rather than routing through
 * `checkExpression`'s general term-arm branch (which would push at
 * the slot path itself). The `ExpressionPicker` mounted at
 * `[..., "value"]` renders shell-footer errors at the slot exactly;
 * `TermCard` inside the picker reads this strict-descendant lookup
 * to surface the deeper match-side errors below the input WITHOUT
 * re-reading the slot's own errors.
 *
 * The merged list is deduplicated: multiple checker passes can
 * leave duplicate messages at adjacent paths, and React's key
 * uniqueness contract on the rendered diagnostic rows demands a
 * unique identifier per row. Stable-order (insertion-order) dedup
 * preserves the message ordering authors see.
 */
export function useEditorErrorsBelow(path: EditorPath): EditorPathErrors {
	const { validityIndex } = useEditorVocabulary();
	const prefix = serializePath(path);
	// Strict-descendant: only the prefix-with-separator form matches.
	// Exact-key match is excluded structurally by the trailing `\0`
	// on `prefixWithSep`, which exact-match keys lack: the slot's
	// own serialized form ends after its last segment, so it can't
	// `startsWith(prefixWithSep)`. The root path's empty
	// serialization gets the same strict treatment via the explicit
	// `key !== ""` guard on the root branch: every non-empty key is
	// a descendant of the root, so excluding the empty key gives
	// strict-descendant semantics there too.
	const prefixWithSep = prefix === "" ? "" : `${prefix}\0`;
	const seen = new Set<string>();
	const merged: string[] = [];
	for (const [key, list] of validityIndex) {
		const matches =
			(prefixWithSep !== "" && key.startsWith(prefixWithSep)) ||
			(prefix === "" && key !== "");
		if (!matches) continue;
		for (const message of list) {
			if (seen.has(message)) continue;
			seen.add(message);
			merged.push(message);
		}
	}
	return merged;
}

/**
 * Build a `ValidityIndex` from a flat list of `CheckError`s. The
 * top-level editor calls this on every onChange to convert the
 * checker's verdict into a render-time lookup table. Same-path
 * errors collapse into a single list with duplicates removed so
 * the rendered diagnostic rows don't collide on identical message
 * strings: React keys derived from message content stay unique
 * per slot.
 */
export function buildValidityIndex(
	errors: readonly CheckError[],
): ValidityIndex {
	const map = new Map<string, string[]>();
	const seen = new Map<string, Set<string>>();
	for (const error of errors) {
		const key = serializePath(error.path);
		const message = presentCheckErrorForEditor(error);
		let list = map.get(key);
		let dedup = seen.get(key);
		if (list === undefined || dedup === undefined) {
			list = [];
			dedup = new Set<string>();
			map.set(key, list);
			seen.set(key, dedup);
		}
		if (dedup.has(message)) continue;
		dedup.add(message);
		list.push(message);
	}
	return map;
}
