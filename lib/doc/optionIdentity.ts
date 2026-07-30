/**
 * Select options carry a `uuid` so a mutation can address one.
 *
 * Every born-select path runs through here — the SA assembly, the builder's add
 * gesture, and its convert-to-select gesture — so an option minted on one
 * surface is addressable on all of them. Identity is the whole job: an option's
 * place is the array position it sits in.
 */

import { asUuid } from "@/lib/doc/types";
import type { SelectOption, Uuid } from "@/lib/domain";

export type UnidentifiedSelectOption = Omit<SelectOption, "uuid"> & {
	uuid?: Uuid;
};

/** Stamp a uuid onto any option that lacks one, preserving array order. */
export function withOptionUuids(
	options: readonly UnidentifiedSelectOption[] | undefined,
): SelectOption[] | undefined {
	if (options === undefined) return undefined;
	return options.map<SelectOption>((option) =>
		option.uuid === undefined
			? { ...option, uuid: asUuid(crypto.randomUUID()) }
			: { ...option, uuid: option.uuid },
	);
}
