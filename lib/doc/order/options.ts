// lib/doc/order/options.ts
//
// Select-option identity + order minting, shared by every construction path
// that lands a select field. A born option needs BOTH a stable `uuid` (the
// per-uuid option diff skips a uuid-less option, so a client edit to it would
// be lost) and an `order` key (a key-less option sorts ahead of its keyed
// siblings under `bySortKey` until a reload's backfill). The SA field assembly
// and the builder's add gesture both route their born options through here.

import { asUuid, type SelectOption } from "@/lib/domain";
import { keyBetween } from "./keys";

/**
 * Mint a stable `uuid` + a fresh `order` key on every option that lacks one,
 * preserving those already set (a re-keyed clone keeps its copied keys).
 * Returns `undefined` when `options` is absent, so a caller can spread the
 * result conditionally.
 *
 * A keyless option is keyed AFTER the previous option's key (its own existing
 * key, or the one just minted) rather than from a fresh 0..n run: threading the
 * key forward keeps a minted key sorting after an already-keyed predecessor, so
 * a MIXED input (some options keyed, some not) doesn't mis-order the fresh keys
 * relative to the existing ones. On the common all-keyless born set this is
 * byte-identical to a fresh ascending run (`keyBetween(null, null)`, then
 * `keyBetween(prev, null)` per option). A keyless option that PRECEDES a
 * lower-keyed one is not resolved here (no caller hands such a set — born
 * options are all keyless); a reload's backfill settles any residual.
 */
export function keyedOptions(
	options: readonly SelectOption[] | undefined,
): SelectOption[] | undefined {
	if (!Array.isArray(options)) return undefined;
	let last: string | null = null;
	return options.map((opt) => {
		const order = opt.order ?? keyBetween(last, null);
		last = order;
		return {
			...opt,
			uuid: opt.uuid ?? asUuid(crypto.randomUUID()),
			order,
		};
	});
}
