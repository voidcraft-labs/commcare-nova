/**
 * Claims as data. Every site of the reader that reads past a key of an HQ app
 * names, ahead of time, the manifest entry it reads that key under, the
 * surface key, and what it does with the value. Each module declares its
 * claims once with `defineClaims` and uses them by reference, so
 * `__tests__/claimsBindManifest.test.ts` can hold every claim to the manifest
 * without running the reader.
 */

import type { ReadStanding } from "@/lib/publish/hqFindings";

/**
 * What a claim's site does with the value: reads it into the document
 * (`take`), reads past a value the document holds through another slot
 * (`derived`), reads past it (`drop`), makes a finding (`refuse`), or carries
 * no value and drops or refuses as the entry's standing says (`account`).
 */
export type ClaimUse = "take" | "derived" | "drop" | "refuse" | "account";

export interface Claim<U extends ClaimUse = ClaimUse> {
	/** The inventory entry id, exactly as its area file holds it. */
	readonly entry: string;
	/** The surface key this site reads, one of the entry's `surfaceKeys`; null where it has none. */
	readonly key: string | null;
	readonly use: U;
}

function claim<U extends ClaimUse>(use: U) {
	return (entry: string, key: string | null): Claim<U> =>
		Object.freeze({ entry, key, use });
}

export const take = claim("take");
export const derived = claim("derived");
export const drop = claim("drop");
export const refuse = claim("refuse");
export const account = claim("account");

/** The standings each use is permitted under. */
export const PERMITTED_STANDINGS: Readonly<
	Record<ClaimUse, readonly ReadStanding[]>
> = {
	take: ["held"],
	derived: ["held"],
	drop: ["inert", "kept"],
	refuse: ["not-yet", "never", "fix-in-hq"],
	account: ["kept", "inert", "not-yet", "never", "fix-in-hq"],
};

/** Whether a claim of `use` may be made on an entry of `standing`. */
export function claimPermits(use: ClaimUse, standing: ReadStanding): boolean {
	return PERMITTED_STANDINGS[use].includes(standing);
}

const REGISTRY = new Map<string, Claim>();
const NAMES = new WeakMap<Claim, string>();
/** Each entry's first registered name: a name is added to `REGISTRY` once, at
 *  its end, so the first added for an entry is the first in its order. */
const FIRST_NAME_OF_ENTRY = new Map<string, string>();

function sameClaim(a: Claim, b: Claim): boolean {
	return a.entry === b.entry && a.key === b.key && a.use === b.use;
}

/**
 * Registers a module's claims under `<module>.<name>` and returns them
 * unchanged. A name registered again with the same claim is the module
 * evaluated again; a name registered with another claim is two modules that
 * chose one name, and throws.
 */
export function defineClaims<const T extends Record<string, Claim>>(
	module: string,
	claims: T,
): T {
	for (const [name, one] of Object.entries(claims)) {
		const full = `${module}.${name}`;
		const known = REGISTRY.get(full);
		if (known !== undefined && !sameClaim(known, one))
			throw new Error(
				`The reader's claim ${full} is declared twice with different entries. Give one of the two another name.`,
			);
		if (known === undefined && !FIRST_NAME_OF_ENTRY.has(one.entry))
			FIRST_NAME_OF_ENTRY.set(one.entry, full);
		REGISTRY.set(full, one);
		NAMES.set(one, full);
	}
	return claims;
}

/** Every registered claim by its `<module>.<name>`. */
export function claimRegistry(): ReadonlyMap<string, Claim> {
	return REGISTRY;
}

/** The registered name of a claim object, where `defineClaims` registered it. */
export function claimName(one: Claim): string | undefined {
	return NAMES.get(one);
}

/** The name of a registered claim on `entry`, the first registered; undefined where none is. */
export function claimNameForEntry(entry: string): string | undefined {
	return FIRST_NAME_OF_ENTRY.get(entry);
}
