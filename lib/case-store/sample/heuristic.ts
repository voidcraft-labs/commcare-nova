// lib/case-store/sample/heuristic.ts
//
// `HeuristicCaseGenerator` — the shipped `SampleCaseGenerator`.
// Schema-driven, deterministic per `(blueprint, caseType, seed)`.
// Per-`data_type` dispatch with a property-name heuristic that
// picks a matching pool variant (e.g. `name` → names pool,
// `address` → address pool, `age` → uniform 15-80, etc.); pools
// live under `./pools/`.
//
// The generator does NOT write to the database, derive
// `case_indices`, or validate against JSON Schema —
// `CaseStore.generateSampleData` routes generated rows through the
// same bulk-insert path real inserts use, so all three concerns
// run uniformly at the case-store layer.

import type {
	CaseProperty,
	CasePropertyDataType,
	CaseType,
} from "@/lib/domain";
import { unhandledKindMessage } from "@/lib/domain/predicate/errors";
import type { JsonObject, JsonValue } from "../sql/database";
import type { CaseInsert } from "../store";
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
 * The shipped `SampleCaseGenerator`. Stateless — every call
 * constructs a fresh PRNG and date-range generators from the seed.
 */
export class HeuristicCaseGenerator implements SampleCaseGenerator {
	generate(args: SampleGeneratorArgs): ReadonlyArray<CaseInsert> {
		const caseType = args.caseType;
		const prng = createSeededPrng(
			`${args.appId}::${caseType.name}::${args.seed}`,
		);
		const dateGenerators = composeDateRangeGenerators(prng, REFERENCE_DATE);

		// Empty parent-id list produces orphan rows (parent_case_id
		// stays null) — still valid case data.
		const parentIds = resolveParentIds({
			caseType,
			parentRefs: args.parentRefs,
		});

		const rows: CaseInsert[] = [];
		for (let i = 0; i < args.count; i++) {
			const properties: JsonObject = {};
			for (const property of caseType.properties) {
				// `case_name` routes to the top-level column, not the
				// JSONB document — emitted directly from the names
				// pool below. The blueprint surface admits the
				// property declaration (the SA + author UI carry its
				// label / default-value config there), so the loop
				// routes around it rather than fighting the upstream
				// shape.
				if (property.name === "case_name") continue;
				properties[property.name] = pickValueForProperty({
					property,
					prng,
					dateGenerators,
				});
			}
			rows.push({
				case_type: caseType.name,
				// Pool contract guarantees non-empty, satisfying the
				// column's `length > 0` CHECK.
				case_name: pickFullName(prng),
				status: "open",
				properties,
				// `?? null` is defensive — `pickIndex(N)` returns
				// `[0, N)` so the lookup is defined whenever
				// `length > 0`, but surfacing `null` is safer than
				// `undefined` reaching the JSONB serializer.
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
 * Module-level reference date for date-range pools. Pinned so the
 * same `(blueprint, caseType, seed)` yields the same output without
 * any clock read. Bumping this shifts every `dob` / `registration`
 * / `recent-event` value; snapshot-style tests would re-baseline.
 */
const REFERENCE_DATE = new Date("2026-05-01T00:00:00.000Z");

/**
 * Resolve the parent-id list for the case type. Empty list when
 * the case type has no `parent_type` or no matching entry in
 * `parentRefs` — the generator emits orphan rows.
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
 * Per-`data_type` dispatch. The explicit `CasePropertyDataType`
 * annotation pins the switch as exhaustive at compile time; a
 * future enum variant surfaces as a `never` assignment.
 */
function pickValueForProperty(args: {
	property: CaseProperty;
	prng: SeededPrng;
	dateGenerators: DateRangeGenerators;
}): JsonValue {
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

/** Property-name heuristic: name / address / phone / email / fallback token. */
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
	// Fallback: stable but distinguishable token —
	// `<property-name>_NNNN`.
	return `${property.name}_${String(prng.pickIndex(10000)).padStart(4, "0")}`;
}

function pickPhoneNumber(prng: SeededPrng): string {
	// Country codes biased toward common CommCare-deployment regions.
	const countryCodes = ["+1", "+44", "+91", "+234", "+254", "+27", "+880"];
	const country = countryCodes[prng.pickIndex(countryCodes.length)] ?? "+1";
	const digits = String(prng.pickIndex(10_000_000_000)).padStart(10, "0");
	return `${country} ${digits}`;
}

function pickEmail(prng: SeededPrng): string {
	const given = pickGivenName(prng).toLowerCase();
	const idx = prng.pickIndex(10_000);
	return `${given}${idx}@example.org`;
}

/**
 * Property-name heuristic: `age` → uniform 15-80;
 * `count` / `quantity` / `number` / `total` / `qty` → 0-1000;
 * default 0-100.
 */
function pickIntValue(property: CaseProperty, prng: SeededPrng): number {
	const normalized = property.name.toLowerCase();
	if (normalized.includes("age")) {
		// Working-age band for case-management demos; child + elder
		// out of scope for this distribution.
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
 * Property-name heuristic: `weight` → 2.5-100 kg;
 * `height` → 40-200 cm; `temperature` → 35.5-40.5 °C;
 * default `[0, 100)`.
 */
function pickDecimalValue(property: CaseProperty, prng: SeededPrng): number {
	const normalized = property.name.toLowerCase();
	if (normalized.includes("weight")) {
		return Math.round((2.5 + prng.pickFloat() * 97.5) * 100) / 100;
	}
	if (normalized.includes("height")) {
		return Math.round((40 + prng.pickFloat() * 160) * 100) / 100;
	}
	if (normalized.includes("temperature")) {
		return Math.round((35.5 + prng.pickFloat() * 5) * 100) / 100;
	}
	return Math.round(prng.pickFloat() * 10000) / 100;
}

/**
 * Uniform sample over the option set. Empty-options blueprints
 * (mid-edit) return `""` — matches the JSON Schema validator's
 * permissive fallback.
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
 * 1 to min(3, options.length) distinct options without replacement
 * via Fisher-Yates. Empty-options returns `[]`.
 *
 * `pickIndex(k) + 1` lifts uniform `[0, k)` to uniform `[1, k]`
 * without the clamp bias a fixed-3 draw would have when the option
 * set is smaller than 3.
 */
function pickMultiSelectValue(
	property: CaseProperty,
	prng: SeededPrng,
): string[] {
	if (property.options === undefined || property.options.length === 0) {
		return [];
	}
	const optionValues = property.options.map((o) => o.value);
	for (let i = optionValues.length - 1; i > 0; i--) {
		const j = prng.pickIndex(i + 1);
		const a = optionValues[i] as string;
		const b = optionValues[j] as string;
		optionValues[i] = b;
		optionValues[j] = a;
	}
	const sliceCount = prng.pickIndex(Math.min(3, optionValues.length)) + 1;
	return optionValues.slice(0, sliceCount);
}
