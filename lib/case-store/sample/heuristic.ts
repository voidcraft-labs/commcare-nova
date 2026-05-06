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
// read from a static module-level reference date threaded in
// through `composeDateRangeGenerators`, so output is deterministic
// without any clock read at all.
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
//     uniform 15-80 (working-age band); names containing "count" /
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
// of those happen at the case-store's bulk-insert path —
// `CaseStore.generateSampleData` routes the rows through it so
// generated rows participate in the same JSON Schema validation +
// `case_indices` derivation real inserts use.
//
// Parent linkages are written via `parent_case_id`; the case-store
// layer derives `case_indices` from that column at insert time.

import type {
	CaseProperty,
	CasePropertyDataType,
	CaseType,
} from "@/lib/domain";
import { unhandledKindMessage } from "@/lib/domain/predicate/errors";
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
import { createSeededPrng, type SeededPrng } from "./prng";

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
		const caseType = findCaseTypeOrThrow(
			args.blueprint,
			args.appId,
			args.caseType,
		);
		const prng = createSeededPrng(
			`${args.appId}::${args.caseType}::${args.seed}`,
		);
		const dateGenerators = composeDateRangeGenerators(prng, REFERENCE_DATE);

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
				// `case_name` is a top-level scalar column on `cases`,
				// not a JSONB property. Skip the JSONB write here; the
				// generator emits the scalar directly in the row
				// constructor below from the names pool. The blueprint
				// surface still admits `case_name` on the property
				// declaration (the SA + author UI carry the field's
				// label / default-value config there), so the loop
				// encounters it and routes around it rather than
				// fighting the upstream shape.
				if (property.name === "case_name") continue;
				properties[property.name] = pickValueForProperty({
					property,
					prng,
					dateGenerators,
				});
			}
			rows.push({
				case_type: args.caseType,
				// Generated case_name is a full name from the names
				// pool. Guaranteed non-empty by the pool's contract,
				// satisfying the column's `length > 0` CHECK.
				case_name: pickFullName(prng),
				status: "open",
				properties,
				// Pick a parent at random from the resolved list; the
				// empty-list arm produces an orphan row. The `?? null`
				// is a defensive coalesce against an out-of-range
				// index — `pickIndex(N)` returns `[0, N)` so the
				// lookup is defined whenever `length > 0`, but
				// surfacing `null` here is safer than `undefined`
				// reaching the JSONB serializer.
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
 * The reference date the date-range pools anchor against. Pinned
 * as a module-level constant so the same `(blueprint, caseType,
 * seed)` tuple yields the same output on every call without any
 * clock read.
 *
 * Bumping this constant shifts every `dob` / `registration` /
 * `recent-event` value the generator emits; downstream snapshot-
 * style tests that pin specific dates would re-baseline.
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
			return pickCityClusteredGeopoint(args.prng);
		default: {
			const _exhaustive: never = dataType;
			throw new Error(
				unhandledKindMessage({
					where: "case-store.HeuristicCaseGenerator.pickValueForProperty",
					family: "CasePropertyDataType",
					received: _exhaustive,
					knownKinds: [
						"text",
						"int",
						"decimal",
						"date",
						"datetime",
						"time",
						"single_select",
						"multi_select",
						"geopoint",
					],
				}),
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
		return pickGivenName(prng);
	}
	if (normalized.includes("name")) {
		return pickFullName(prng);
	}
	if (
		normalized.includes("address") ||
		normalized.includes("street") ||
		normalized.includes("village") ||
		normalized.includes("location")
	) {
		return pickAddressLine(prng);
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
	const given = pickGivenName(prng).toLowerCase();
	const idx = prng.pickIndex(10_000);
	return `${given}${idx}@example.org`;
}

/**
 * `int` arm. Property-name heuristic picks a bounded range:
 *
 *   - name contains `age` → uniform 15-80 (working-age band)
 *   - name contains `count` / `quantity` / `number` / `total` /
 *     `qty` → uniform 0-1000
 *   - all others → uniform 0-100
 */
function pickIntValue(property: CaseProperty, prng: SeededPrng): number {
	const normalized = property.name.toLowerCase();
	if (normalized.includes("age")) {
		// Uniform 15-80 — covers the working-age population in
		// roughly the right band for a case-management demo. Child +
		// elder ages out of scope for this distribution.
		return 15 + prng.pickIndex(65);
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
	// Shuffle a copy via Fisher-Yates and slice the prefix; the
	// `slice(0, k)` then takes the first `k` elements.
	const optionValues = property.options.map((o) => o.value);
	for (let i = optionValues.length - 1; i > 0; i--) {
		const j = prng.pickIndex(i + 1);
		const a = optionValues[i] as string;
		const b = optionValues[j] as string;
		optionValues[i] = b;
		optionValues[j] = a;
	}
	// `pickIndex(min(3, options.length))` is uniform over [0, k)
	// where k = min(3, options.length); +1 lifts it to [1, k], giving
	// uniform "1 to min(3, options.length)" without the clamp bias a
	// fixed-3 draw would have when the option set is smaller than 3.
	const sliceCount = prng.pickIndex(Math.min(3, optionValues.length)) + 1;
	return optionValues.slice(0, sliceCount);
}
