// lib/case-store/sample/heuristic.ts
//
// `HeuristicCaseGenerator` — the shipped `SampleCaseGenerator`
// implementation. Schema-driven, deterministic per `(blueprint,
// caseType, seed)`. Picks values from the per-`data_type` pools
// under `./pools/` based on a property-name heuristic.
//
// ## Determinism contract
//
// Every randomness read flows through one seeded PRNG instance
// (`mulberry32`-driven, seeded by a string-hash of the supplied
// `seed`). The same `(blueprint, caseType, seed)` tuple produces
// the same row sequence on every call. The pools are static arrays
// (no clock reads, no external API calls); the date generators
// capture one reference timestamp per `generate()` call so clock
// drift between calls does not leak into the output.
//
// ## Property-name heuristic
//
// For each property, the generator picks a pool variant matching the
// property's name shape:
//
//   - `text` → name pool when the name contains "name", address
//     pool when it contains "address" / "street" / "village",
//     plain text fallback otherwise (a short readable token).
//   - `int` → bounded integer pool. Names containing "age" produce
//     ages 0-100 with adult-bias; names containing "count" /
//     "quantity" / "number" produce 0-1000; others 0-100.
//   - `decimal` → bounded float in [0, 100). Names containing
//     "weight" / "height" / "temperature" produce shape-specific
//     ranges.
//   - `date` / `datetime` → range picked by
//     `pickDateRangeKindForPropertyName` (`dob` / `registration` /
//     `recent-event`).
//   - `time` → working-hours range (08:00-18:00).
//   - `single_select` / `multi_select` → uniform sample over the
//     property's option set. Multi-select picks 1-3 elements.
//   - `geopoint` → city-cluster point in CCHQ wire shape.
//
// ## What the generator does NOT do
//
// The generator does not write to the database, does not derive
// `case_indices` rows, does not validate against JSON Schema. All
// of those happen at `CaseStore.insert` — generated rows flow
// through the same write path user-authored rows do.
//
// Parent linkages are written via `parent_case_id`; the case-store
// layer derives `case_indices` from that column at insert time.

import type {
	CaseProperty,
	CasePropertyDataType,
	CaseType,
} from "@/lib/domain";
import type { JsonObject, JsonValue } from "../sql/database";
import type { CaseInsert } from "../store";
import { findCaseTypeOrThrow } from "../store";
import type { SampleCaseGenerator, SampleGeneratorArgs } from "./generator";
import { pickAddressLine } from "./pools/addresses";
import {
	composeDateRangeGenerators,
	type DateRangeGenerators,
	pickDateRangeKindForPropertyName,
} from "./pools/dates";
import { pickCityClusteredGeopoint } from "./pools/geopoints";
import { pickFullName, pickGivenName } from "./pools/names";

// ---------------------------------------------------------------
// PRNG — mulberry32 + string-hash seed
// ---------------------------------------------------------------
//
// Zero-dependency seeded PRNG. `mulberry32` is the canonical
// 32-bit-state algorithm with good statistical distribution for
// non-cryptographic uses; the string-hash function is FNV-1a
// (32-bit) so the seed string folds deterministically into the
// algorithm's 32-bit state.
//
// Why not `seedrandom` (the npm package): zero npm-overrides churn,
// no peer-dep concerns, the implementation is ~15 lines and the
// behavior is identical for the seeded-PRNG use case the generator
// has. The function below is exported for the unit-test surface to
// pin the algorithm's deterministic output independently of the
// generator pipeline.

/**
 * Hash a string into a 32-bit unsigned integer via FNV-1a. The
 * algorithm is canonical and well-distributed for short string
 * inputs — `(appId, caseType, seed)` tuples fold into distinct
 * 32-bit states with high probability.
 */
export function hashStringToUint32(input: string): number {
	let hash = 0x811c9dc5; // FNV-1a 32-bit offset basis.
	for (let i = 0; i < input.length; i++) {
		hash ^= input.charCodeAt(i);
		// Multiplication by the FNV-1a 32-bit prime, masked to 32
		// bits. Bit-twiddling here avoids the precision loss that
		// would creep in with naive `*` over numbers > 2^32.
		hash = Math.imul(hash, 0x01000193);
	}
	return hash >>> 0;
}

/**
 * Seeded PRNG handle. The two methods together cover every
 * randomness read the generator needs:
 *
 *   - `pickFloat()` — uniform [0, 1) double. Matches `Math.random`'s
 *     contract.
 *   - `pickIndex(max)` — uniform [0, max) integer. Used for pool
 *     index selection.
 */
export interface SeededPrng {
	/** A uniform [0, 1) double. */
	pickFloat(): number;
	/** A uniform [0, max) integer. */
	pickIndex(max: number): number;
}

/**
 * Build a `SeededPrng` driven by mulberry32. The constructor folds
 * the string seed into a 32-bit state via FNV-1a; subsequent calls
 * to `pickFloat` / `pickIndex` advance the state and return derived
 * values.
 *
 * Exported for the unit-test surface to verify the algorithm's
 * deterministic output independently of the generator pipeline.
 */
export function createSeededPrng(seed: string): SeededPrng {
	let state = hashStringToUint32(seed);

	const next = (): number => {
		// mulberry32 step: state += 0x6D2B79F5; t = state;
		// t = (t ^ (t >>> 15)) * (t | 1);
		// t ^= t + ((t ^ (t >>> 7)) * (t | 61));
		// return ((t ^ (t >>> 14)) >>> 0) / 0x100000000;
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 0x100000000;
	};

	return {
		pickFloat: () => next(),
		pickIndex: (max: number) => Math.floor(next() * max),
	};
}

// ---------------------------------------------------------------
// `HeuristicCaseGenerator`
// ---------------------------------------------------------------

/**
 * The shipped `SampleCaseGenerator`. Schema-driven, deterministic
 * per `(blueprint, caseType, seed)`. The class holds no state
 * across calls — every `generate()` call constructs a fresh PRNG
 * + fresh date-range generators from the supplied seed.
 */
export class HeuristicCaseGenerator implements SampleCaseGenerator {
	generate(args: SampleGeneratorArgs): ReadonlyArray<CaseInsert> {
		const caseType = findCaseTypeOrThrow(args.blueprint, args.caseType);
		const prng = createSeededPrng(
			`${args.appId}::${args.caseType}::${args.seed}`,
		);
		const dateGenerators = composeDateRangeGenerators({
			referenceDate: REFERENCE_DATE,
			pickFloat: () => prng.pickFloat(),
		});

		// Resolve the parent id list for this child's parent type, if
		// the blueprint declares one. Empty list = the child generates
		// orphan rows (parent_case_id stays null) — still valid case
		// data.
		const parentIds = resolveParentIds({
			caseType,
			parentRefs: args.parentRefs,
		});

		const rows: CaseInsert[] = [];
		for (let i = 0; i < args.count; i++) {
			const properties: JsonObject = {};
			for (const property of caseType.properties) {
				properties[property.name] = pickValueForProperty({
					property,
					prng,
					dateGenerators,
				});
			}
			rows.push({
				case_type: args.caseType,
				status: "open",
				properties,
				// `pickIndex` returns a value in `[0, parentIds.length)`,
				// so the lookup is always defined when the array is
				// non-empty. The `?? null` satisfies TypeScript's
				// `noUncheckedIndexedAccess` without changing runtime
				// behavior.
				parent_case_id:
					parentIds.length > 0
						? (parentIds[prng.pickIndex(parentIds.length)] ?? null)
						: null,
			});
		}
		return rows;
	}
}

// ---------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------

/**
 * The reference date the date-range pools anchor against. Captured
 * as a module-level constant so each `generate()` call against the
 * same seed produces the same output regardless of when the call
 * runs. A test that needs to control the anchor stubs the constant
 * via a higher-order generator wrapper; the production path uses
 * the static value below.
 *
 * The date is pinned to a recent past so `recent-event` ranges
 * produce dates that read as plausibly recent in any test run.
 */
const REFERENCE_DATE = new Date("2026-05-01T00:00:00.000Z");

/**
 * Resolve the parent-id list for a case type. When the case type
 * declares a `parent_type` and the caller supplied a matching entry
 * in `parentRefs`, the list is returned. Otherwise the empty list
 * — the generator emits orphan rows in that case.
 */
function resolveParentIds(args: {
	caseType: CaseType;
	parentRefs: ReadonlyMap<string, ReadonlyArray<string>> | undefined;
}): ReadonlyArray<string> {
	if (args.caseType.parent_type === undefined) {
		return [];
	}
	if (args.parentRefs === undefined) {
		return [];
	}
	const matches = args.parentRefs.get(args.caseType.parent_type);
	return matches ?? [];
}

/**
 * Per-property dispatch. The `data_type` arms are exhaustive over
 * `CasePropertyDataType`; any future variant of the enum surfaces
 * a compile-time error on the `_exhaustive` `never` assignment in
 * the default arm. Within each arm, the property-name heuristic
 * picks a pool variant or applies a shape constraint.
 *
 * Returns a `JsonValue` so the caller's `properties` accumulator
 * stays typed against the JSONB column shape.
 */
function pickValueForProperty(args: {
	property: CaseProperty;
	prng: SeededPrng;
	dateGenerators: DateRangeGenerators;
}): JsonValue {
	// Explicit `CasePropertyDataType` annotation pins the switch
	// below as exhaustive at compile time. Any future variant of
	// the enum at `lib/domain/blueprint.ts` surfaces a TypeScript
	// error on the `_exhaustive` `never` assignment in the default
	// arm — the failure mode that keeps every consumer of the data-
	// type enum in lockstep.
	const dataType: CasePropertyDataType = args.property.data_type ?? "text";
	switch (dataType) {
		case "text":
			return pickTextValue(args.property, args.prng);
		case "int":
			return pickIntValue(args.property, args.prng);
		case "decimal":
			return pickDecimalValue(args.property, args.prng);
		case "date":
			return args.dateGenerators.pickDate(
				pickDateRangeKindForPropertyName(args.property.name),
			);
		case "datetime":
			return args.dateGenerators.pickDatetime(
				pickDateRangeKindForPropertyName(args.property.name),
			);
		case "time":
			return args.dateGenerators.pickTime();
		case "single_select":
			return pickSingleSelectValue(args.property, args.prng);
		case "multi_select":
			return pickMultiSelectValue(args.property, args.prng);
		case "geopoint":
			return pickCityClusteredGeopoint({
				pickIndex: (max) => args.prng.pickIndex(max),
				pickFloat: () => args.prng.pickFloat(),
			});
		default: {
			const _exhaustive: never = dataType;
			throw new Error(
				`HeuristicCaseGenerator: unhandled data_type '${String(_exhaustive)}'`,
			);
		}
	}
}

/**
 * `text` arm. Property-name heuristic picks a pool variant: name
 * pool, address pool, or a short readable token fallback.
 */
function pickTextValue(property: CaseProperty, prng: SeededPrng): string {
	const normalized = property.name.toLowerCase();
	if (normalized.includes("first_name") || normalized.includes("given")) {
		return pickGivenName((max) => prng.pickIndex(max));
	}
	if (normalized.includes("name")) {
		return pickFullName((max) => prng.pickIndex(max));
	}
	if (
		normalized.includes("address") ||
		normalized.includes("street") ||
		normalized.includes("village") ||
		normalized.includes("location")
	) {
		return pickAddressLine((max) => prng.pickIndex(max));
	}
	if (normalized.includes("phone")) {
		return pickPhoneNumber(prng);
	}
	if (normalized.includes("email")) {
		return pickEmail(prng);
	}
	// Fallback: a short readable token that visibly varies row to
	// row. Concatenating the property name + a 4-digit seeded
	// suffix yields stable but distinguishable output.
	return `${property.name}_${String(prng.pickIndex(10000)).padStart(4, "0")}`;
}

/**
 * Build a phone number in a CCHQ-typical wire shape. Country code +
 * 10-digit number; format ranges across regions to match the
 * generator's overall global variety.
 */
function pickPhoneNumber(prng: SeededPrng): string {
	// Country codes biased toward common CommCare-deployment regions.
	const countryCodes = ["+1", "+44", "+91", "+234", "+254", "+27", "+880"];
	const country = countryCodes[prng.pickIndex(countryCodes.length)] ?? "+1";
	const digits = String(prng.pickIndex(10_000_000_000)).padStart(10, "0");
	return `${country} ${digits}`;
}

/**
 * Build a plausible email address. First-name + family-name pool
 * picks fold into a `<given>.<family>@example.org` shape so the
 * generated value carries the same global variety the name pool
 * does.
 */
function pickEmail(prng: SeededPrng): string {
	const given = pickGivenName((max) => prng.pickIndex(max)).toLowerCase();
	const idx = prng.pickIndex(10_000);
	return `${given}${idx}@example.org`;
}

/**
 * `int` arm. Property-name heuristic picks a bounded range:
 *
 *   - name contains `age` → 0-100, biased toward 15-80
 *   - name contains `count` / `quantity` / `number` / `total` /
 *     `qty` → 0-1000
 *   - all others → 0-100
 */
function pickIntValue(property: CaseProperty, prng: SeededPrng): number {
	const normalized = property.name.toLowerCase();
	if (normalized.includes("age")) {
		// Adult-biased: square the [0, 1) draw shifts toward 0,
		// then scale into [0, 100). The bias produces visibly more
		// adult ages than child ones at the default 30-row count.
		return Math.floor(prng.pickFloat() ** 0.5 * 100);
	}
	if (
		normalized.includes("count") ||
		normalized.includes("quantity") ||
		normalized.includes("number") ||
		normalized.includes("total") ||
		normalized.includes("qty")
	) {
		return prng.pickIndex(1000);
	}
	return prng.pickIndex(100);
}

/**
 * `decimal` arm. Property-name heuristic picks shape-specific
 * ranges; default is uniform [0, 100).
 */
function pickDecimalValue(property: CaseProperty, prng: SeededPrng): number {
	const normalized = property.name.toLowerCase();
	if (normalized.includes("weight")) {
		// Weight in kg: 2.5-100 kg covers infant through adult.
		return Math.round((2.5 + prng.pickFloat() * 97.5) * 100) / 100;
	}
	if (normalized.includes("height")) {
		// Height in cm: 40-200 cm covers infant through adult.
		return Math.round((40 + prng.pickFloat() * 160) * 100) / 100;
	}
	if (normalized.includes("temperature")) {
		// Body temperature in C: 35.5-40.5 spans the clinically
		// meaningful range.
		return Math.round((35.5 + prng.pickFloat() * 5) * 100) / 100;
	}
	// Fallback: [0, 100) with two decimal places.
	return Math.round(prng.pickFloat() * 10000) / 100;
}

/**
 * `single_select` arm. Uniform sample over the property's option
 * set. When options are absent (mid-edit blueprints), returns an
 * empty string — matches the JSON Schema validator's permissive
 * fallback for empty-options select kinds.
 */
function pickSingleSelectValue(
	property: CaseProperty,
	prng: SeededPrng,
): string {
	if (property.options === undefined || property.options.length === 0) {
		return "";
	}
	const option = property.options[prng.pickIndex(property.options.length)];
	return option?.value ?? "";
}

/**
 * `multi_select` arm. Picks 1-3 distinct options uniformly over the
 * property's option set. When options are absent (mid-edit
 * blueprints), returns an empty array — matches the JSON Schema
 * validator's permissive fallback.
 */
function pickMultiSelectValue(
	property: CaseProperty,
	prng: SeededPrng,
): string[] {
	if (property.options === undefined || property.options.length === 0) {
		return [];
	}
	// Pick 1 to min(3, options.length) elements without replacement.
	// Shuffle a copy via Fisher-Yates and slice the prefix.
	const optionValues = property.options.map((o) => o.value);
	for (let i = optionValues.length - 1; i > 0; i--) {
		const j = prng.pickIndex(i + 1);
		const a = optionValues[i];
		const b = optionValues[j];
		// Defensive: array indices i / j are bounded by the loop +
		// pickIndex contract, so both reads are non-undefined. The
		// nullish guard satisfies TypeScript's noUncheckedIndexedAccess
		// without changing runtime behavior.
		if (a !== undefined && b !== undefined) {
			optionValues[i] = b;
			optionValues[j] = a;
		}
	}
	const sliceCount = Math.min(3, optionValues.length, prng.pickIndex(3) + 1);
	return optionValues.slice(0, sliceCount);
}
