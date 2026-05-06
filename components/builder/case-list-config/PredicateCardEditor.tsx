// components/builder/case-list-config/PredicateCardEditor.tsx
//
// Top-level Predicate AST authoring surface. Renders an arbitrary
// `Predicate` as a tree of cards via the registry-driven dispatch
// in `editorSchemas.ts`. The editor:
//
//   1. Mounts a `PredicateEditProvider` carrying the schema-driven
//      type-checking context (`caseTypes`, `currentCaseType`,
//      `knownInputs`) plus the precomputed `validityIndex` —
//      cards look up their own path's errors via the context.
//
//   2. Runs `checkPredicate` on every onChange to refresh the
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
// `lib/domain/predicate/builders.ts`. Builders apply the boolean-
// algebra reductions (per `lib/domain/predicate/CLAUDE.md` §
// "Reduction module") so the saved AST is always in canonical
// reduced form. Cards may therefore disappear mid-edit when their
// clause list collapses to one — the parent's onChange replaces
// the group with the unwrapped clause and the next render shows
// just the inner card.

"use client";
import { useEffect, useMemo, useRef } from "react";
import type { CaseType } from "@/lib/domain";
import {
	type CheckError,
	checkPredicate,
	type Predicate,
	type SearchInputDecl,
	type TypeContext,
} from "@/lib/domain/predicate";
import { ChildPredicateEditor } from "./cards/ChildPredicateEditor";
import { buildValidityIndex, PredicateEditProvider } from "./editorContext";
import { ROOT_PATH } from "./path";

interface PredicateCardEditorProps {
	/** Current AST. */
	readonly value: Predicate;
	/** Fired with the next AST whenever the user mutates the tree. */
	readonly onChange: (next: Predicate) => void;
	/** Blueprint case-type definitions. */
	readonly caseTypes: readonly CaseType[];
	/**
	 * The originating case-type scope the predicate runs against.
	 * For a case-list filter this is the module's case type; for a
	 * search default filter it's the same. Inside an `exists.where`
	 * clause the editor automatically rebinds `currentCaseType` to
	 * the relation walk's destination.
	 */
	readonly currentCaseType: string;
	/** Search inputs declared on the parent surface. */
	readonly knownInputs?: readonly SearchInputDecl[];
	/**
	 * Surfaces the boolean validity verdict to the parent on every
	 * onChange. The parent gates its save affordance on this. The
	 * editor does not gate the onChange itself — invalid edits flow
	 * through so the user can keep authoring.
	 */
	readonly onValidityChange?: (valid: boolean) => void;
}

/**
 * Top-level Predicate card editor. Composes `PredicateEditProvider`
 * + `ChildPredicateEditor`. The dispatch shell handles every
 * predicate kind via the registry; this file's job is the type-
 * check pass + context plumbing.
 */
export function PredicateCardEditor({
	value,
	onChange,
	caseTypes,
	currentCaseType,
	knownInputs = [],
	onValidityChange,
}: PredicateCardEditorProps) {
	// Build the type-check context from props. The same context
	// reaches both the validation pass below and the per-card
	// helpers (`PropertyPicker`, `LiteralValueInput`, etc.) via the
	// React context provider.
	const typeCtx = useMemo<TypeContext>(
		() => ({
			caseTypes: [...caseTypes],
			knownInputs: [...knownInputs],
			currentCaseType,
		}),
		[caseTypes, knownInputs, currentCaseType],
	);

	// Run the type checker on every value change. The checker is
	// pure (no I/O, no allocations beyond the error list), so
	// running it inside `useMemo` is the right shape — the
	// validity index is a derived value driven by `value` and the
	// context.
	const validityResult = useMemo(
		() => checkPredicate(value, typeCtx),
		[value, typeCtx],
	);

	const errors: readonly CheckError[] = validityResult.ok
		? []
		: validityResult.errors;

	const validityIndex = useMemo(() => buildValidityIndex(errors), [errors]);

	// Propagate the validity verdict to the parent. The effect
	// fires on mount and on every subsequent `isValid` transition;
	// downstream consumers (the Filter-section save button) gate
	// on this and need the initial-mount fire so the parent's
	// save state initializes correctly. The `onValidityChange`
	// callback is stashed in a ref so a fresh-each-render parent
	// callback identity doesn't trip the effect on non-transitions
	// — same pattern `AndOrBody` uses for the monitor's
	// `onChange` ref. Render-time write keeps the ref current
	// before the effect phase runs.
	const onValidityChangeRef = useRef(onValidityChange);
	onValidityChangeRef.current = onValidityChange;
	const isValid = errors.length === 0;
	useEffect(() => {
		onValidityChangeRef.current?.(isValid);
	}, [isValid]);

	return (
		<PredicateEditProvider
			caseTypes={caseTypes}
			currentCaseType={currentCaseType}
			knownInputs={knownInputs}
			validityIndex={validityIndex}
		>
			<ChildPredicateEditor
				value={value}
				onChange={onChange}
				path={ROOT_PATH}
			/>
		</PredicateEditProvider>
	);
}
