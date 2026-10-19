// lib/domain/javaZoneOffset.ts
//
// The UTC offset `java.util.TimeZone` gives a zone at an instant, which is
// the offset every CommCare device and Core JVM reads dates in. Java's zone
// is `sun.util.calendar.ZoneInfo`, built by `ZoneInfoFile`, which keeps a
// zone's transitions only from 1900-01-01T00:00:00Z (`ZoneInfoFile.UTC1900`).
// For an instant before that, `ZoneInfo.getOffsets` finds no transition and
// answers the zone's last raw offset: its current standard offset, without
// daylight saving. From that instant on, the offset is the tzdb's own, local
// mean time included (Kolkata is +5:21:10 until 1941, and Kiritimati's
// -10:29:20 begins exactly at the cutoff).
//
// JavaScript's `Date` and `Intl` follow the IANA history all the way back,
// so a reader of a zone's IANA offset is passed in, and this module applies
// Java's rule on top of it. Every place Nova models a device zone's offset
// reads it here.
//
// The current standard offset is the smaller of the zone's offsets on
// 1 January and 1 July 2025, the offset outside daylight saving on either
// hemisphere. Java's raw offset is that in every zone the JDK names except
// three whose tzdb data the JDK compiles with daylight saving recast as a
// positive shift: Africa/Casablanca and Africa/El_Aaiun (Java's raw offset
// is 0, this gives +1:00) and Africa/Windhoek (Java's is +1:00, this gives
// +2:00). An instant before 1900 in those zones reads an hour off Java's.

/** 1900-01-01T00:00:00Z, the first instant Java's zone history holds. */
export const JAVA_ZONE_HISTORY_START_MS = -2_208_988_800_000;

/** The two instants whose smaller offset is a zone's standard offset. */
const STANDARD_OFFSET_PROBES = [Date.UTC(2025, 0, 1), Date.UTC(2025, 6, 1)];

/** A zone's IANA offset at an instant, in milliseconds east of UTC. */
export type IanaOffsetReader = (instantMs: number) => number;

/** The offset Java gives the zone `ianaOffsetMs` reads, at an instant. */
export function javaZoneOffsetMs(
	instantMs: number,
	ianaOffsetMs: IanaOffsetReader,
): number {
	if (instantMs >= JAVA_ZONE_HISTORY_START_MS) return ianaOffsetMs(instantMs);
	return Math.min(
		...STANDARD_OFFSET_PROBES.map((probe) => ianaOffsetMs(probe)),
	);
}

/** The instant whose IANA offset is the zone's standard offset, for reading
 * a standard-time name the way Java names a zone before 1900. */
export function standardOffsetInstant(ianaOffsetMs: IanaOffsetReader): number {
	const [january, july] = STANDARD_OFFSET_PROBES as [number, number];
	return ianaOffsetMs(july) < ianaOffsetMs(january) ? july : january;
}
