/**
 * Pure URL validation + recovery helper used by the build route's
 * RSC page handler (`app/build/[id]/page.tsx`).
 *
 * The RSC handler's original validation logic was a 15-line inline
 * block that mixed three concerns: (1) coerce the awaited `searchParams`
 * record into a `URLSearchParams`, (2) parse into a `Location` and
 * recover against the doc, and (3) compute the final redirect URL.
 * Pulling the pure parse-and-recover step out into this helper lets
 * unit tests exercise every branch of the validator without standing
 * up a full Next.js route harness, and keeps the handler focused on
 * HTTP-level concerns (`notFound`, `redirect`).
 *
 * Redirect-loop guard
 * -------------------
 * The identity-preservation contract on `recoverLocation` means
 * `recovered === incoming` only when the parse yielded the same
 * reference — i.e. nothing changed. Callers can safely use that check
 * to gate the `redirect()` call, but the caller must also verify the
 * *serialized* target differs from the incoming query string. Duplicate
 * or malformed params that parse to the same valid location would
 * otherwise cause a redirect loop, because `parseLocation` normalizes
 * them to a canonical shape that re-serializes differently from the
 * raw input. This helper reports both the recovered location and an
 * `ok` flag so the caller does one compare and makes one decision.
 */

import type { LocationDoc } from "@/lib/routing/location";
import { parseLocation, recoverLocation } from "@/lib/routing/location";
import type { Location } from "@/lib/routing/types";

/**
 * Result of validating an incoming `URLSearchParams` against the live
 * doc.
 *
 * - `ok`: every reference resolved — the RSC handler should render the
 *   builder without redirecting.
 * - `redirect`: the URL referenced a stale entity. The caller should
 *   serialize the returned `location` and issue `redirect()`.
 *
 * Callers must still guard against duplicate-param edge cases by
 * comparing the serialized target URL against the incoming query
 * string before redirecting — two different raw inputs can parse to
 * the same canonical `Location`, and re-serializing would cause a loop
 * if the identity check alone drove the redirect decision.
 */
export type ValidationResult =
	| { kind: "ok" }
	| { kind: "redirect"; location: Location };

/**
 * Validate an incoming `URLSearchParams` against the current doc.
 *
 * Parses the params into a `Location`, then runs `recoverLocation`.
 * If the recovered location is identical (by reference) to the parsed
 * location, every reference resolved cleanly and the caller can render
 * without redirecting. Otherwise the caller should redirect to the
 * recovered location's serialized URL.
 */
export function validateAndRecover(
	incoming: URLSearchParams,
	doc: LocationDoc,
): ValidationResult {
	const loc = parseLocation(incoming);
	const recovered = recoverLocation(loc, doc);
	if (recovered === loc) return { kind: "ok" };
	return { kind: "redirect", location: recovered };
}
