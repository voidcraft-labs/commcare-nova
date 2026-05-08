// lib/case-store/sample/generator.ts
//
// `SampleCaseGenerator` interface — the seam between
// `CaseStore.generateSampleData` and the concrete generator. Spec
// source: `docs/superpowers/specs/2026-04-30-case-list-search-design.md`,
// "Sample data — an action, not a mode".
//
// `PostgresCaseStore` takes a `SampleCaseGenerator` at construction
// so tests can pass alternative implementations. `withOwnerContext`
// wires `HeuristicCaseGenerator` for production. The interface
// lives here (not on `store.ts`) so `store.ts` can stay independent
// of the sample-data layer; `withOwnerContext` composes the two.

import type { CaseType } from "@/lib/domain";
import type { CaseInsert } from "../store";

/**
 * Arguments for `SampleCaseGenerator.generate`. Same `(appId,
 * caseType.name, seed)` tuple yields the same row sequence on
 * every call — `caseType` carries the property declarations the
 * generator's per-property dispatch reads.
 *
 * `parentRefs` is the case-store layer's pre-resolved parent ids.
 * When the case type declares a `parent_type` and an entry
 * matches, each child row picks one at random; otherwise rows
 * carry `parent_case_id: null` (orphan).
 */
export interface SampleGeneratorArgs {
	appId: string;
	caseType: CaseType;
	count: number;
	seed: string;
	parentRefs?: ReadonlyMap<string, ReadonlyArray<string>>;
}

/**
 * Generator contract. Pure — the generator does NOT write to the
 * database. `CaseStore.generateSampleData` routes the rows through
 * the case-store's bulk-insert path so JSON Schema validation,
 * `case_indices` derivation, and tenant scoping run uniformly.
 */
export interface SampleCaseGenerator {
	generate(args: SampleGeneratorArgs): ReadonlyArray<CaseInsert>;
}
