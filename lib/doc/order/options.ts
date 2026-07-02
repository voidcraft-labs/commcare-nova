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

/**
 * Reconcile a WHOLESALE option replacement (the SA's `edit_field` sends a full
 * uuid-less list — identity is off its wire) against the field's CURRENT
 * options: an incoming option whose `value` matches an existing one (first
 * unconsumed match) KEEPS that option's `uuid`, the rest mint fresh ones, and
 * every option gets a fresh ascending `order` run — the incoming list order IS
 * the SA's intended sequence, and the patch replaces the whole array anyway.
 *
 * Without the uuid carry-forward the committed doc holds identity-less options
 * mid-session (backfill runs only at hydration boundaries), and the per-uuid
 * option diff SKIPS a uuid-less option — so a collaborator's (or the same
 * user's) next builder edit to one of them silently never persists. Preserving
 * the uuid also keeps a peer's concurrent granular `updateOption` /
 * `moveOption` addressed at a surviving option valid instead of conflicting.
 */
export function reconciledOptions(
	incoming: readonly SelectOption[],
	existing: readonly SelectOption[] | undefined,
): SelectOption[] {
	const pool = [...(existing ?? [])];
	let last: string | null = null;
	return incoming.map((opt) => {
		const i = pool.findIndex((e) => e.value === opt.value);
		const prior = i >= 0 ? pool.splice(i, 1)[0] : undefined;
		const order = keyBetween(last, null);
		last = order;
		return {
			...opt,
			uuid: prior?.uuid ?? opt.uuid ?? asUuid(crypto.randomUUID()),
			order,
		};
	});
}
