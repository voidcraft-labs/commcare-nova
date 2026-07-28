/**
 * Select options carry a `uuid` so a mutation can address one.
 *
 * Every born-select path runs through here — the SA assembly, the builder's add
 * gesture, and its convert-to-select gesture — so an option minted on one
 * surface is addressable on all of them. It used to mint an `order` key beside
 * the uuid; sequence is the array now, so identity is all that is left.
 */

import { asUuid } from "@/lib/doc/types";
import type { SelectOption, Uuid } from "@/lib/domain";

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

/**
 * Give every select option in a document a uuid, in place.
 *
 * Runs at each hydration boundary because a mutation addresses an option by
 * uuid, and options authored before option identity existed have none — an edit
 * to one would otherwise resolve to nothing. Deterministic per
 * `(field uuid, option index)` so the client and the server agree on the same
 * legacy document.
 *
 * Its order-key twin retired with the keys: there is no sequence to backfill
 * when the array IS the sequence.
 */
export function backfillOptionUuids(doc: {
	fields: Record<string, unknown>;
}): void {
	for (const field of Object.values(doc.fields)) {
		const options = (field as { options?: { uuid?: string }[] }).options;
		if (!Array.isArray(options)) continue;
		const fieldUuid = (field as { uuid?: string }).uuid ?? "";
		options.forEach((option, index) => {
			if (option.uuid === undefined) {
				option.uuid = deterministicOptionUuid(fieldUuid, index);
			}
		});
	}
}

/**
 * A stable uuid for a legacy option, derived from its field and position.
 *
 * Deterministic rather than random because the client and the server hydrate
 * the same stored document independently; a random id would make their two
 * copies disagree about which option an edit addressed.
 */
function deterministicOptionUuid(fieldUuid: string, index: number): Uuid {
	const seed = `${fieldUuid}:${index}`;
	let h1 = 0x811c9dc5;
	for (let i = 0; i < seed.length; i++) {
		h1 ^= seed.charCodeAt(i);
		h1 = Math.imul(h1, 0x01000193) >>> 0;
	}
	const hex = (n: number): string => n.toString(16).padStart(8, "0");
	let h2 = h1;
	const parts: string[] = [];
	for (let i = 0; i < 4; i++) {
		h2 ^= h2 << 13;
		h2 ^= h2 >>> 17;
		h2 ^= h2 << 5;
		h2 >>>= 0;
		parts.push(hex(h2));
	}
	const raw = `${parts[0]}${parts[1]}${parts[2]}${parts[3]}`;
	return asUuid(
		`${raw.slice(0, 8)}-${raw.slice(8, 12)}-5${raw.slice(13, 16)}-8${raw.slice(17, 20)}-${raw.slice(20, 32)}`,
	);
}
