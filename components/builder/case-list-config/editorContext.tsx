// components/builder/case-list-config/editorContext.tsx
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
// Scope flips at relational quantifiers — when a card descends into
// an `exists.where` or `missing.where`, the context's
// `currentCaseType` changes to the relation walk's destination so
// nested property dropdowns show the destination's properties (per
// the type-checker's `checkInDestinationScope` contract). The
// `WithCurrentCaseType` helper handles the rebind.

"use client";
import { createContext, type ReactNode, useContext, useMemo } from "react";
import type { CaseType } from "@/lib/domain";
import type { SearchInputDecl } from "@/lib/domain/predicate";
import type { EditorPath } from "./path";
import { serializePath } from "./path";

/**
 * Per-path error list. Mirrors `CheckError.message` from the type
 * checker; the path itself is the lookup key, not part of the
 * stored entry.
 */
export type EditorPathErrors = readonly string[];

/**
 * Opaque map type — components consume it through the helpers below
 * (`useEditorErrorsAt` / `useEditorIsValid`) rather than indexing
 * directly. Keeps the serialization format private.
 */
type ValidityIndex = ReadonlyMap<string, EditorPathErrors>;

interface PredicateEditContextValue {
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
	readonly knownInputs: readonly SearchInputDecl[];
	/**
	 * Errors keyed by serialized path. Cards look up their own path
	 * via `useEditorErrorsAt` to render inline diagnostics; the
	 * top-level editor uses the index size to gate the parent's save
	 * affordance (via `onValidityChange`).
	 */
	readonly validityIndex: ValidityIndex;
}

const PredicateEditContext = createContext<PredicateEditContextValue | null>(
	null,
);

interface PredicateEditProviderProps {
	readonly caseTypes: readonly CaseType[];
	readonly currentCaseType: string;
	readonly knownInputs: readonly SearchInputDecl[];
	readonly validityIndex: ValidityIndex;
	readonly children: ReactNode;
}

/**
 * Top-level provider — mounted once by `PredicateCardEditor` per
 * editor instance. The `validityIndex` is recomputed by the editor
 * on every onChange (via the type checker) and threaded through
 * here.
 */
export function PredicateEditProvider({
	caseTypes,
	currentCaseType,
	knownInputs,
	validityIndex,
	children,
}: PredicateEditProviderProps) {
	const value = useMemo<PredicateEditContextValue>(
		() => ({ caseTypes, currentCaseType, knownInputs, validityIndex }),
		[caseTypes, currentCaseType, knownInputs, validityIndex],
	);
	return (
		<PredicateEditContext.Provider value={value}>
			{children}
		</PredicateEditContext.Provider>
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
 * context unchanged — keeps `caseTypes`, `knownInputs`, and
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
	return (
		<PredicateEditContext.Provider value={value}>
			{children}
		</PredicateEditContext.Provider>
	);
}

/**
 * Read the editor context. Use this when a card needs the full
 * trio (case types + current scope + known inputs) — typical for
 * property pickers and value pickers that resolve dropdown content
 * from the schema. Throws if called outside a
 * `<PredicateEditProvider>` — every card mounts beneath the
 * top-level editor's provider, so the throw indicates a structural
 * authoring bug rather than a runtime branch the editor can recover
 * from.
 */
export function usePredicateEditContext(): PredicateEditContextValue {
	const ctx = useContext(PredicateEditContext);
	if (ctx === null) {
		throw new Error(
			"usePredicateEditContext must be called inside <PredicateEditProvider>. The provider mounts at the top of `PredicateCardEditor`; nested cards should not be rendered outside that tree.",
		);
	}
	return ctx;
}

/**
 * Read errors attached to a specific path. Returns an empty array
 * when no errors landed on the path. Cards call this with their
 * own path or with a slot-level path to surface inline diagnostics
 * next to the offending input.
 */
export function useEditorErrorsAt(path: EditorPath): EditorPathErrors {
	const { validityIndex } = usePredicateEditContext();
	const key = serializePath(path);
	return validityIndex.get(key) ?? [];
}

/**
 * Read every error attached to a slot OR any descendant of it.
 * Used by cards whose type-checker emits per-slot errors at deeper
 * paths than the operator-level slot — e.g. `match` emits term-
 * resolution failures (Unknown property, Unknown search input) at
 * `[..., "value", "term"]` while emitting operator-level mode-
 * mismatch errors at `[..., "value"]`. Both must reach the same
 * inline UI, so the lookup widens to a path-prefix capture.
 *
 * The merged list is deduplicated — multiple checker passes can
 * leave duplicate messages at adjacent paths, and React's key
 * uniqueness contract on the rendered diagnostic rows demands a
 * unique identifier per row. Stable-order (insertion-order) dedup
 * preserves the message ordering authors see.
 */
export function useEditorErrorsAtOrBelow(path: EditorPath): EditorPathErrors {
	const { validityIndex } = usePredicateEditContext();
	const prefix = serializePath(path);
	// Two prefix forms match: the slot itself (exact-key match) and
	// any descendant (the segment-separator '\0' in `serializePath`
	// makes the prefix-with-separator check structurally distinct
	// from a same-named sibling slot).
	const prefixWithSep = prefix === "" ? "" : `${prefix}\0`;
	const seen = new Set<string>();
	const merged: string[] = [];
	for (const [key, list] of validityIndex) {
		const matches =
			key === prefix ||
			(prefixWithSep !== "" && key.startsWith(prefixWithSep)) ||
			// Root path captures every error.
			prefix === "";
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
 * strings — React keys derived from message content stay unique
 * per slot.
 */
export function buildValidityIndex(
	errors: readonly { path: readonly (string | number)[]; message: string }[],
): ValidityIndex {
	const map = new Map<string, string[]>();
	const seen = new Map<string, Set<string>>();
	for (const error of errors) {
		const key = serializePath(error.path);
		let list = map.get(key);
		let dedup = seen.get(key);
		if (list === undefined || dedup === undefined) {
			list = [];
			dedup = new Set<string>();
			map.set(key, list);
			seen.set(key, dedup);
		}
		if (dedup.has(error.message)) continue;
		dedup.add(error.message);
		list.push(error.message);
	}
	return map;
}
