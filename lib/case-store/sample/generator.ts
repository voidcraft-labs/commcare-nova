// lib/case-store/sample/generator.ts
//
// `SampleCaseGenerator` interface — the seam every implementation
// of "generate sample case data" binds against. Spec source:
// `docs/superpowers/specs/2026-04-30-case-list-search-design.md`,
// "Sample data — an action, not a mode" section.
//
// The interface is the wire between `CaseStore.generateSampleData`
// and the concrete generator. `PostgresCaseStore` consumes a
// `SampleCaseGenerator` reference at construction; the factory at
// `withOwnerContext` wires the default `HeuristicCaseGenerator`. The
// same interface accepts an LLM-driven implementation (e.g. an
// `LlmCaseGenerator` against Haiku); the heuristic is the shipped
// implementation and the seam is in place for any alternative.
//
// ## Why the interface lives here, not in `store.ts`
//
// `store.ts` owns the `CaseStore` interface and its row-shape types;
// it intentionally does not import the sample-data layer. Keeping
// `SampleCaseGenerator` in its own module under `sample/` mirrors the
// dependency direction at the top of the package — `withOwnerContext`
// composes the two surfaces; neither owns the other.

import type { BlueprintDoc } from "@/lib/domain";
import type { CaseInsert } from "../store";

/**
 * Arguments for `SampleCaseGenerator.generate`. The generator is
 * pure — it consumes the prospective blueprint state plus a seed and
 * a count, and returns a list of `CaseInsert` rows the caller writes
 * through `CaseStore.insert`. The generator does not write to the
 * database.
 *
 * `parentRefs` is an optional map from parent case-type name to a
 * list of already-generated parent case ids. When the generator
 * builds a child case type whose blueprint declares a `parent_type`,
 * each row picks a random parent id from the matching list and sets
 * `parent_case_id` on the row — the case-store derives the matching
 * `case_indices` row at insert time. When the map is absent or no
 * entry matches the child's parent type, the generated rows carry
 * `parent_case_id: null` (still a valid orphan case).
 */
export interface SampleGeneratorArgs {
	/** The prospective blueprint state. Read for case-type definitions. */
	blueprint: BlueprintDoc;
	/** The owning app — written through into the row's `app_id` slot. */
	appId: string;
	/** The case-type name being generated. */
	caseType: string;
	/** Number of rows to generate. */
	count: number;
	/**
	 * The seed for the deterministic PRNG. Same `(blueprint,
	 * caseType, seed)` tuple yields the same row sequence on every
	 * call.
	 */
	seed: string;
	/**
	 * Optional pre-resolved parent case ids by parent case-type name.
	 * The case-store layer typically populates this by querying the
	 * existing parent rows from `cases` before invoking the generator
	 * for a child case type.
	 */
	parentRefs?: ReadonlyMap<string, ReadonlyArray<string>>;
}

/**
 * The contract every sample-data generator implementation honors.
 * One method: take a blueprint + count + seed, return a typed
 * insert-shape list the caller writes through `CaseStore.insert`.
 *
 * The generator does NOT write to the database. The case-store
 * layer is the single seam writes flow through; routing the
 * generated rows through `insert` ensures `case_indices` derivation
 * + JSON Schema validation + tenant scope all run for sample data
 * the same way they run for user-authored data.
 */
export interface SampleCaseGenerator {
	/**
	 * Generate `args.count` rows for `args.caseType` against the
	 * blueprint's case-type definition. Pure — no I/O, no
	 * randomness outside the seeded PRNG, output is structurally
	 * derived from the input.
	 */
	generate(args: SampleGeneratorArgs): ReadonlyArray<CaseInsert>;
}
