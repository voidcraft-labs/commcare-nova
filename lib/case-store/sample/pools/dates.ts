// lib/case-store/sample/pools/dates.ts
//
// Date / datetime / time generators driven by a seeded PRNG and a
// caller-supplied reference date (no clock reads). Three semantic
// ranges via property-name heuristic: DOB (0-100 years past),
// registration (0-2 years past), recent-event (0-30 days past).
// Wire shapes match `lib/domain/predicate/jsonSchema.ts`'s
// `format: date | time | date-time` arms.

import type { SeededPrng } from "../prng";

export type DateRangeKind = "dob" | "registration" | "recent-event";

/**
 * Generator handle bound to a single PRNG + reference date so
 * every pool call threads through the same anchor.
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

	const pickDateInRange = (kind: DateRangeKind): Date => {
		switch (kind) {
			case "dob": {
				// Working-age band 15-80; child + elder out of scope
				// for this distribution.
				const yearsBack = 15 + prng.pickFloat() * 65;
				const offsetDays = yearsBack * 365.25;
				return new Date(reference - offsetDays * oneDay);
			}
			case "registration": {
				const offsetDays = prng.pickFloat() * 730;
				return new Date(reference - offsetDays * oneDay);
			}
			case "recent-event": {
				const offsetDays = prng.pickFloat() * 30;
				return new Date(reference - offsetDays * oneDay);
			}
		}
	};

	const formatIsoDate = (date: Date): string => date.toISOString().slice(0, 10);
	const formatIsoDatetime = (date: Date): string => date.toISOString();

	/**
	 * Working-hours range 08:00-18:00. The trailing `Z` is required
	 * — AJV's strict `format: time` follows RFC 3339 §5.6's full-time
	 * grammar which requires a timezone offset. Without it,
	 * generated rows fail the case-store's write-side validator.
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
 * Pick a `DateRangeKind` from the property name:
 * `birth` / `dob` → `dob`; `last_visit` / `event` / `follow` /
 * `recent` → `recent-event`; default `registration`. Substring
 * matching catches snake_case variants without enumerating every
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
