// components/builder/shared/setOptionalSlot.ts
//
// Per-slot "set or drop" helper for objects whose schema treats every
// key as optional. Sectional authoring panels apply patches to a parent
// object one slot at a time; clearing a slot needs the emitted object
// to omit the key entirely, not carry it as `key: undefined`.
//
// The doc store applies module patches via `Object.assign(mod, patch)`,
// which lands a `key: undefined` source as a real own enumerable
// property on the persisted document. That breaks the "key in config"
// genuine-presence check downstream consumers rely on (the SA-side
// cluster pickers, the wire-emission layer's distinguish-cleared-vs-
// untouched tie-break). The destructure-and-drop emitted shape solves
// it: clear emits the object WITHOUT the slot key (a structural drop);
// set emits the object WITH the slot key bound to the next value.
//
// Set-vs-clear branches the emitted shape so `key in obj` is the
// genuine slot-presence check on every persisted document. This
// matters across the case-search authoring surfaces — Display +
// Advanced both compose against `caseSearchConfig`, both share this
// emit-shape contract, and downstream emitters and pickers both
// depend on the shape being honest.

/**
 * Build the next value of an object with an optional slot. When `next`
 * is `undefined`, the returned object omits the slot key entirely (a
 * destructured drop, not a `key: undefined` assignment); when `next`
 * is defined, the returned object carries the slot key bound to the
 * value. Other keys on `current` flow through unchanged.
 *
 * Generic over the container `C` and the slot key `K extends keyof C`,
 * so the returned object's static shape stays equivalent to the input
 * — consumers don't need a cast at the call site.
 *
 * The helper accepts `current: C | undefined` so authoring sections
 * whose parent slot is itself optional (a section receiving
 * `caseSearchConfig: CaseSearchConfig | undefined`) can route through
 * the same helper. The `undefined` arm materializes an empty object
 * before the slot patch, mirroring the `...(value ?? {})` pattern
 * sections used before this helper centralized the spread.
 *
 * @param current The current object value, or `undefined` if the
 *                parent slot is itself absent.
 * @param slot    The key of the slot to set or drop.
 * @param next    The next value for the slot, or `undefined` to drop
 *                the key from the returned object.
 * @returns       The next object value with the slot set or omitted.
 */
export function setOptionalSlot<C extends object, K extends keyof C>(
	current: C | undefined,
	slot: K,
	next: C[K] | undefined,
): C {
	const base = current ?? ({} as C);
	if (next === undefined) {
		// Destructured drop. The destructure-and-rest emits the object
		// WITHOUT the slot key, so a downstream `key in obj` check sees
		// genuine absence — distinct from a `key: undefined` write that
		// would land as an own enumerable property.
		const { [slot]: _drop, ...rest } = base;
		void _drop;
		return rest as C;
	}
	return { ...base, [slot]: next };
}
