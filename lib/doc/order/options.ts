// lib/doc/order/options.ts
//
// Select-option identity + order minting, shared by every construction path
// that lands a select field. A born option needs BOTH a stable `uuid` (the
// per-uuid option diff skips a uuid-less option, so a client edit to it would
// be lost) and an `order` key (a key-less option sorts ahead of its keyed
// siblings under `bySortKey` until a reload's backfill). The SA field assembly
// and the builder's add gesture both route their born options through here.

import { asUuid, type SelectOption } from "@/lib/domain";
import { sequenceOrderKeys } from "./append";

/**
 * Mint a stable `uuid` + a fresh sequential `order` key on every option that
 * lacks one, preserving those already set (a re-keyed clone keeps its copied
 * keys). Returns `undefined` when `options` is absent, so a caller can spread
 * the result conditionally.
 */
export function keyedOptions(
	options: readonly SelectOption[] | undefined,
): SelectOption[] | undefined {
	if (!Array.isArray(options)) return undefined;
	const keys = sequenceOrderKeys(options.length);
	return options.map((opt, i) => ({
		...opt,
		uuid: opt.uuid ?? asUuid(crypto.randomUUID()),
		order: opt.order ?? keys[i],
	}));
}
