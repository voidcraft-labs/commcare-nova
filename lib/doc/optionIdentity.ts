/**
 * Select options carry a `uuid` so a mutation can address one.
 *
 * Every born-select path runs through here — the SA assembly, the builder's add
 * gesture, and its convert-to-select gesture — so an option minted on one
 * surface is addressable on all of them. It used to mint an `order` key beside
 * the uuid; sequence is the array now, so identity is all that is left.
 */

import { asUuid } from "@/lib/doc/types";
import type { SelectOption } from "@/lib/domain";

/** Stamp a uuid onto any option that lacks one, preserving array order. */
export function withOptionUuids(
	options: readonly SelectOption[] | undefined,
): SelectOption[] | undefined {
	if (options === undefined) return undefined;
	return options.map((option) =>
		option.uuid === undefined
			? { ...option, uuid: asUuid(crypto.randomUUID()) }
			: option,
	);
}
