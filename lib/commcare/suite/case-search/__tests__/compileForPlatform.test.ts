// lib/commcare/suite/case-search/__tests__/compileForPlatform.test.ts
//
// Acceptance tests for `compileForPlatform` — the pure decision
// tree that produces a `WireShape` flag set from authored content
// + platform context.
//
// Tests organize around the three branches of the decision tree
// plus a structural-purity shell:
//
//   1. **Android** — always list-first regardless of authored
//      content. Three test cases pin invariance over filter set /
//      filter absent / non-zero search inputs.
//   2. **Web — skip-to-results vs list-first** — the four sub-shapes:
//      filter set + zero inputs (skip-to-results), filter set +
//      inputs present (list-first), no filter + zero inputs
//      (list-first), match-all filter + zero inputs (list-first;
//      match-all is structurally a no-op and must not trip skip-
//      to-results).
//   3. **Purity** — same input always produces same output (no
//      module-level state, no side effects); the function never
//      mutates either config.
//
// Branch coverage is 1:1 against the decision tree's three
// branches.

import { describe, expect, it } from "vitest";
import {
	asUuid,
	type CaseListConfig,
	type CaseSearchConfig,
	simpleSearchInputDef,
} from "@/lib/domain";
import { eq, literal, matchAll, prop } from "@/lib/domain/predicate/builders";
import { compileForPlatform } from "../compileForPlatform";
import type { PlatformContext, WireShape } from "../types";

// ============================================================
// Test helpers
// ============================================================

/**
 * Sentinel `caseSearchConfig` for branches where the slot is
 * required by the function signature but unused by the decision
 * tree. Every slot is optional, so an empty object is the minimal
 * valid persisted shape.
 */
const SEARCH_CONFIG: CaseSearchConfig = {};

/** Empty case list — no columns, no filter, no search inputs. */
const EMPTY_LIST_CONFIG: CaseListConfig = {
	columns: [],
	searchInputs: [],
};

/** Case list with an effective (non-`match-all`) filter and zero
 *  search inputs. Triggers skip-to-results on the web branch. */
const FILTER_ONLY_CONFIG: CaseListConfig = {
	columns: [],
	filter: eq(prop("patient", "is_active"), literal(true)),
	searchInputs: [],
};

/** Case list with a `match-all` filter and zero search inputs.
 *  `match-all` is the boolean-algebra identity element; it must not
 *  trip skip-to-results because it does not narrow the case list. */
const MATCH_ALL_FILTER_CONFIG: CaseListConfig = {
	columns: [],
	filter: matchAll(),
	searchInputs: [],
};

/** Case list with one search input and no filter. Inputs present
 *  blocks skip-to-results. */
const INPUTS_ONLY_CONFIG: CaseListConfig = {
	columns: [],
	searchInputs: [
		simpleSearchInputDef(
			asUuid("00000000-0000-4000-8000-000000000001"),
			"name",
			"Name",
			"text",
			"name",
		),
	],
};

/** Case list with both an effective filter AND search inputs.
 *  Inputs-present blocks skip-to-results even when the filter is
 *  set. */
const FILTER_AND_INPUTS_CONFIG: CaseListConfig = {
	columns: [],
	filter: eq(prop("patient", "is_active"), literal(true)),
	searchInputs: [
		simpleSearchInputDef(
			asUuid("00000000-0000-4000-8000-000000000002"),
			"name",
			"Name",
			"text",
			"name",
		),
	],
};

const ANDROID: PlatformContext = { platform: "android" };
const WEB: PlatformContext = { platform: "web" };

/**
 * Pin every flag of a `WireShape` literal — `expect(...).toEqual(shape)`
 * gives the same coverage but reading a wire-shape constant per
 * branch makes the three flag sets self-documenting.
 */
const ANDROID_SHAPE: WireShape = {
	autoLaunch: false,
	defaultSearch: false,
	inlineSearch: true,
};
const SKIP_TO_RESULTS_SHAPE: WireShape = {
	autoLaunch: true,
	defaultSearch: true,
	inlineSearch: false,
};
const LIST_FIRST_SHAPE: WireShape = {
	autoLaunch: false,
	defaultSearch: false,
	inlineSearch: false,
};

// ============================================================
// SHELL 1 — Android always emits list-first / inline shape
// ============================================================

describe("compileForPlatform — Android always list-first", () => {
	it("emits inline shape for Android with no filter and no inputs", () => {
		// Baseline Android case: empty case list. The runtime shows the
		// case list first regardless of any wire flag, so the compiler
		// emits `inlineSearch: true` (the inline storage-instance
		// reference is the Android-compatible wire shape) and every
		// other flag false.
		expect(
			compileForPlatform(EMPTY_LIST_CONFIG, SEARCH_CONFIG, ANDROID),
		).toEqual(ANDROID_SHAPE);
	});

	it("emits inline shape for Android with filter set and no inputs", () => {
		// On web this combination would trip skip-to-results; on
		// Android it never does. The decision tree's first branch
		// dominates regardless of authored content.
		expect(
			compileForPlatform(FILTER_ONLY_CONFIG, SEARCH_CONFIG, ANDROID),
		).toEqual(ANDROID_SHAPE);
	});

	it("emits inline shape for Android with inputs present", () => {
		// Search inputs configured. Android still emits the same
		// list-first inline shape — the runtime player ignores
		// auto-launch / default-search semantics regardless.
		expect(
			compileForPlatform(INPUTS_ONLY_CONFIG, SEARCH_CONFIG, ANDROID),
		).toEqual(ANDROID_SHAPE);
	});
});

// ============================================================
// SHELL 2 — Web skip-to-results vs list-first
// ============================================================

describe("compileForPlatform — web skip-to-results vs list-first", () => {
	it("emits skip-to-results when filter is set and zero inputs", () => {
		// Author intent is unambiguous: the filter narrows the case
		// list and there is nothing for the user to type. The runtime
		// executes the search on screen entry; the user sees the
		// filtered results immediately.
		expect(compileForPlatform(FILTER_ONLY_CONFIG, SEARCH_CONFIG, WEB)).toEqual(
			SKIP_TO_RESULTS_SHAPE,
		);
	});

	it("emits list-first when filter is match-all and zero inputs (match-all is no-op)", () => {
		// `match-all` is the boolean-algebra identity element of
		// conjunction; it does not narrow the case list. Treating it
		// as an effective filter would erroneously trip skip-to-
		// results when the author has not authored any narrowing
		// predicate — the resulting wire would silently widen to "all
		// cases" but skip the case-list-first UX.
		expect(
			compileForPlatform(MATCH_ALL_FILTER_CONFIG, SEARCH_CONFIG, WEB),
		).toEqual(LIST_FIRST_SHAPE);
	});

	it("emits list-first when no filter and zero inputs", () => {
		// Empty case list. No authored filter means the runtime
		// defaults to list-first; reach search via the explicit
		// search action.
		expect(compileForPlatform(EMPTY_LIST_CONFIG, SEARCH_CONFIG, WEB)).toEqual(
			LIST_FIRST_SHAPE,
		);
	});

	it("emits list-first when filter is set and inputs present", () => {
		// Skip-to-results requires zero inputs. With inputs configured
		// the user has something to type, so the natural UX is list-
		// first — the author can hit search to fill inputs and execute
		// against the filtered scope.
		expect(
			compileForPlatform(FILTER_AND_INPUTS_CONFIG, SEARCH_CONFIG, WEB),
		).toEqual(LIST_FIRST_SHAPE);
	});

	it("emits list-first when no filter and inputs present", () => {
		// No filter, inputs configured. Forcing the user to fill the
		// search form before they see whether they have any local
		// cases at all is a worse UX than letting them see the list
		// first; the search button reaches the input flow on demand.
		expect(compileForPlatform(INPUTS_ONLY_CONFIG, SEARCH_CONFIG, WEB)).toEqual(
			LIST_FIRST_SHAPE,
		);
	});
});

// ============================================================
// SHELL 3 — Structural purity
// ============================================================

describe("compileForPlatform — structural purity", () => {
	it("produces the same output for the same inputs across multiple calls", () => {
		// Pure function — no module-level state, no Date / Math.random,
		// no side effects. Repeated invocation against the same triple
		// yields identical outputs structurally.
		const first = compileForPlatform(FILTER_ONLY_CONFIG, SEARCH_CONFIG, WEB);
		const second = compileForPlatform(FILTER_ONLY_CONFIG, SEARCH_CONFIG, WEB);
		expect(first).toEqual(second);
		expect(first).toEqual(SKIP_TO_RESULTS_SHAPE);
	});

	it("does not mutate the caseListConfig argument", () => {
		// The function reads `filter` / `searchInputs` from the
		// passed `caseListConfig` and produces a fresh `WireShape`;
		// it never writes back to the input. Snapshotting the config
		// before and after the call pins that the function does not
		// mutate the slot the caller passed in.
		const before = JSON.stringify(FILTER_ONLY_CONFIG);
		compileForPlatform(FILTER_ONLY_CONFIG, SEARCH_CONFIG, WEB);
		expect(JSON.stringify(FILTER_ONLY_CONFIG)).toBe(before);
	});

	it("does not mutate the caseSearchConfig argument", () => {
		// `caseSearchConfig` is unused by the decision tree but the
		// function signature accepts it. Snapshot pin that the slot
		// is never touched regardless of branch.
		const before = JSON.stringify(SEARCH_CONFIG);
		compileForPlatform(EMPTY_LIST_CONFIG, SEARCH_CONFIG, ANDROID);
		compileForPlatform(EMPTY_LIST_CONFIG, SEARCH_CONFIG, WEB);
		expect(JSON.stringify(SEARCH_CONFIG)).toBe(before);
	});
});
