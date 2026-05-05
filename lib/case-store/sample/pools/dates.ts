// lib/case-store/sample/pools/dates.ts
//
// Date / datetime / time generators for the heuristic sample-data
// generator. The shapes here cover the three temporal arms of
// `CasePropertyDataType` (`date`, `datetime`, `time`) and the
// property-name heuristics that pick which range a generated value
// draws from.
//
// Three semantic ranges the generator uses:
//
//   - DOB-shaped — a date in the past 0-100 years, biased toward
//     adult ages (15-80) but admitting child / elder ages so the
//     output exhibits visible variety.
//   - Registration-shaped — a recent date in the past 0-2 years, the
//     typical "when did this case open" range.
//   - Recent-event-shaped — a date in the past 0-30 days, the
//     "follow-up event" range used when the property name suggests
//     a recent activity.
//
// Wire format: ISO date `YYYY-MM-DD`, ISO datetime
// `YYYY-MM-DDTHH:MM:SS.sssZ`, ISO time `HH:MM:SS`. Each shape matches
// the JSON Schema validator at
// `lib/domain/predicate/jsonSchema.ts`'s `format: date|time|date-time`
// arms.
//
// Determinism: every range generator is driven by the caller's
// seeded PRNG. The reference date is the caller-supplied anchor
// every age / range computation reads from;
// `composeDateRangeGenerators` takes it as an argument rather than
// reading the clock, so output is deterministic without any clock
// read at all. The heuristic generator passes a module-level
// constant pinned at module load.

import type { SeededPrng } from "../prng";

/**
 * The shape ranges we support for the property-name heuristic. The
 * heuristic picks one of these arms based on the property's name;
 * each arm has a generator below.
 */
export type DateRangeKind = "dob" | "registration" | "recent-event";

/**
 * Generator handle for the three date-shaped ranges. Returned from
 * `composeDateRangeGenerators(prng, referenceDate)` so the caller
 * binds one stable reference date and one PRNG instance — the
 * determinism contract holds because every pool call threads
 * through the same PRNG and the same anchor.
 */
export interface DateRangeGenerators {
	/** A YYYY-MM-DD ISO date in the supplied range. */
	pickDate(kind: DateRangeKind): string;
	/** A YYYY-MM-DDTHH:MM:SS.sssZ ISO datetime in the supplied range. */
	pickDatetime(kind: DateRangeKind): string;
	/** A HH:MM:SS ISO time in working-hours range (08:00 - 18:00). */
	pickTime(): string;
}

/**
 * Build the three temporal generators against a stable reference
 * date and a seeded PRNG. The reference date is the anchor every
 * range computation reads from; the caller threads it in so the
 * function never reads the clock and the output is deterministic
 * across runs. The PRNG is the caller's seeded instance, passed
 * in so all randomness flows through one source.
 */
export function composeDateRangeGenerators(
	prng: SeededPrng,
	referenceDate: Date,
): DateRangeGenerators {
	const reference = referenceDate.getTime();
	const oneDay = 24 * 60 * 60 * 1000;

	/**
	 * Generate a Date object inside the specified range kind. Used
	 * by both the date-only and the datetime arms; the time
	 * formatting differs but the underlying date selection is
	 * shared.
	 */
	const pickDateInRange = (kind: DateRangeKind): Date => {
		switch (kind) {
			case "dob": {
				// Uniform 15-80 years back — covers the working-age
				// population in roughly the right band for a
				// case-management demo. Child + elder ages out of
				// scope for this distribution.
				const yearsBack = 15 + prng.pickFloat() * 65;
				const offsetDays = yearsBack * 365.25;
				return new Date(reference - offsetDays * oneDay);
			}
			case "registration": {
				// 0-2 years back, uniform.
				const offsetDays = prng.pickFloat() * 730;
				return new Date(reference - offsetDays * oneDay);
			}
			case "recent-event": {
				// 0-30 days back, uniform.
				const offsetDays = prng.pickFloat() * 30;
				return new Date(reference - offsetDays * oneDay);
			}
		}
	};

	/**
	 * Format a Date as `YYYY-MM-DD`. The matching JSON Schema arm is
	 * `format: date`.
	 */
	const formatIsoDate = (date: Date): string => date.toISOString().slice(0, 10);

	/**
	 * Format a Date as `YYYY-MM-DDTHH:MM:SS.sssZ`. The matching JSON
	 * Schema arm is `format: date-time`.
	 */
	const formatIsoDatetime = (date: Date): string => date.toISOString();

	/**
	 * A working-hours time `HH:MM:SSZ`. Range 08:00 - 18:00 — the
	 * narrow band keeps generated times realistic for typical case-
	 * management interactions.
	 *
	 * The trailing `Z` (UTC offset) satisfies AJV's strict
	 * `format: time` validator from `ajv-formats`, which follows
	 * RFC 3339 §5.6's full-time grammar — that grammar requires a
	 * timezone offset. Without the suffix, generated rows would
	 * fail the case-store's write-side schema validator the moment
	 * they're routed through `CaseStore.insert`.
	 */
	const pickWorkingHoursTime = (): string => {
		const minuteOfDay = Math.floor(prng.pickFloat() * 600) + 480; // 480 minutes = 08:00; +600 = 18:00
		const hours = Math.floor(minuteOfDay / 60);
		const minutes = minuteOfDay % 60;
		const seconds = Math.floor(prng.pickFloat() * 60);
		return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}Z`;
	};

	return {
		pickDate: (kind) => formatIsoDate(pickDateInRange(kind)),
		pickDatetime: (kind) => formatIsoDatetime(pickDateInRange(kind)),
		pickTime: () => pickWorkingHoursTime(),
	};
}

/**
 * Property-name heuristic: pick a `DateRangeKind` that suits the
 * supplied property name. The shape decisions:
 *
 *   - names containing `birth` / `dob` → `dob`
 *   - names containing `registration` / `enroll` / `intake` /
 *     `opened` → `registration`
 *   - names containing `last_visit` / `event` / `follow_up` /
 *     `recent` → `recent-event`
 *   - all others → `registration` (the broadest sensible default)
 *
 * The match is case-insensitive and substring-based; property names
 * tend to be snake_case-with-underscores, so the substring rule
 * matches both `dob` and `date_of_birth` without enumerating every
 * spelling.
 */
export function pickDateRangeKindForPropertyName(
	propertyName: string,
): DateRangeKind {
	const normalized = propertyName.toLowerCase();
	if (normalized.includes("birth") || normalized.includes("dob")) {
		return "dob";
	}
	if (
		normalized.includes("last_visit") ||
		normalized.includes("event") ||
		normalized.includes("follow") ||
		normalized.includes("recent")
	) {
		return "recent-event";
	}
	return "registration";
}
