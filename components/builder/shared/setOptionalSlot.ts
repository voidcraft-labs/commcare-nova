// components/builder/shared/setOptionalSlot.ts
//
// Per-slot "set or drop" helper for objects with optional keys.
// Sectional authoring panels patch the parent one slot at a time;
// clearing a slot needs the emitted object to omit the key entirely
// rather than carry `key: undefined`.
//
// The doc store applies module patches via `Object.assign(mod, patch)`,
// which lands a `key: undefined` source as a real own enumerable
// property on the persisted document. That breaks the `key in config`
// presence checks downstream (SA cluster pickers, wire-emission tie-
// breaks). Branching the emitted shape — set carries the key, clear
// destructures it out — is what makes `key in obj` the genuine
// slot-presence check on every persisted document.

/**
 * Keys on `C` whose value type includes `undefined` — the slots a
 * Zod `.optional()` declaration produces in the inferred type.
 *
 * Constraining the slot key to this set is what keeps the clear path
 * type-sound: a destructured drop on a required key would produce an
 * object missing a key the caller's static type still claims is
 * present. The constraint surfaces that mismatch as a compile error
 * rather than a silent runtime gap.
 */
type OptionalKeyOf<C> = {
	[K in keyof C]-?: undefined extends C[K] ? K : never;
}[keyof C];

/**
 * Build the next value of an object with an optional slot. `next ===
 * undefined` destructures the key out; a defined `next` writes the
 * key. Other keys on `current` flow through unchanged.
 *
 * `current: C | undefined` lets authoring sections whose parent slot
 * is itself optional route through the same helper — the `undefined`
 * arm materializes an empty object first.
 *
 * @param current The current object, or `undefined` if the parent
 *                slot is absent.
 * @param slot    Key to set or drop. Must be an optional key on `C`
 *                — the constraint surfaces a non-optional slot as a
 *                compile error rather than a runtime gap.
 * @param next    Next value, or `undefined` to drop the key.
 */
export function setOptionalSlot<C extends object, K extends OptionalKeyOf<C>>(
	current: C | undefined,
	slot: K,
	next: C[K] | undefined,
): C {
	const base = current ?? ({} as C);
	if (next === undefined) {
		// Destructure-and-rest emits the object WITHOUT the slot key —
		// distinct from a `key: undefined` write that would land as an
		// own enumerable property and fool downstream `key in obj`.
		const { [slot]: _drop, ...rest } = base;
		void _drop;
		return rest as C;
	}
	return { ...base, [slot]: next };
}
