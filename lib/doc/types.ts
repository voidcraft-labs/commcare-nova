/**
 * Builder state re-architecture — domain type definitions.
 *
 * This file is imported by every later phase of the re-architecture:
 *   - Phase 1 uses `BlueprintDoc`, entity types, and the `Mutation` union to
 *     build the normalized Zustand store and its mutation reducer.
 *   - Phase 2 uses `Uuid` as the selection/screen identifier type in the URL.
 *   - Phase 3 uses entity types when dissolving the engine into hooks.
 *   - Phase 4 uses `Mutation` to translate agent events via `toMutations`.
 *   - Phase 5 uses `Uuid` for virtual-list row keys.
 *
 * NOTHING in this file is wired into the running app yet. Phase 0 is inert.
 */

/**
 * Branded UUID type. Prevents accidental mixing with ordinary strings.
 *
 * Branding is a compile-time-only construct — at runtime a Uuid is just a
 * string. Use `asUuid(s)` to cast an existing crypto UUID string into the
 * branded type when entering the doc layer (e.g. when converting a legacy
 * blueprint into the normalized doc shape).
 */
export type Uuid = string & { readonly __brand: "Uuid" };

/** Narrowing cast from `string` to `Uuid`. Prefer this over `as Uuid`. */
export function asUuid(s: string): Uuid {
	return s as Uuid;
}
