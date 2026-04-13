/**
 * Builder state re-architecture — URL location types.
 *
 * `Location` is a discriminated union over every valid URL shape the builder
 * can occupy. Phase 0 ships the type and the pure parser/serializer/
 * validator in `lib/routing/location.ts`. Phase 2 builds the `useLocation`,
 * `useNavigate`, and `useSelect` hooks that read/write these via Next.js's
 * `useSearchParams` and `useRouter`.
 *
 * URL schema (query params on the single /build/[id] route):
 *
 *   /build/[id]                                   → home
 *   /build/[id]?s=m&m=<uuid>                      → module
 *   /build/[id]?s=cases&m=<uuid>                  → case list
 *   /build/[id]?s=cases&m=<uuid>&case=<caseId>    → case detail
 *   /build/[id]?s=f&m=<uuid>&f=<uuid>             → form
 *   /build/[id]?s=f&m=<uuid>&f=<uuid>&sel=<uuid>  → form + selected question
 *
 * UUIDs are used instead of indices so URLs are stable across renames and
 * reordering. The schema uses short param keys (`s`, `m`, `f`, `sel`,
 * `case`) to keep URLs short for bookmarking.
 */

import type { Uuid } from "@/lib/doc/types";

/**
 * Every valid builder location. Home is the default when `s` is absent or
 * unrecognized. Cases and Form require their respective UUID params; a
 * missing param on a screen that requires it collapses to home.
 */
export type Location =
	| { kind: "home" }
	| { kind: "module"; moduleUuid: Uuid }
	| { kind: "cases"; moduleUuid: Uuid; caseId?: string }
	| {
			kind: "form";
			moduleUuid: Uuid;
			formUuid: Uuid;
			selectedUuid?: Uuid;
	  };

/**
 * The short query-param keys used in the URL. Kept as a typed constant so
 * the parser, serializer, and any future consumer (tests, docs) agree on
 * spelling.
 */
export const LOCATION_PARAM = {
	screen: "s",
	module: "m",
	form: "f",
	caseId: "case",
	selected: "sel",
} as const;

/** Values of the `s` (screen) param for each non-home screen. */
export const SCREEN_KIND = {
	module: "m",
	cases: "cases",
	form: "f",
} as const;
