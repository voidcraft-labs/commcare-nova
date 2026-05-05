// lib/case-store/sample/prng.ts
//
// Zero-dependency seeded PRNG for the heuristic generator.
//
//   - `mulberry32` is a 32-bit-state algorithm with good statistical
//     distribution for non-cryptographic uses. Reference:
//     Tommy Ettinger's gist
//     `https://gist.github.com/tommyettinger/46a3a48eaee2bf32f3df40a35bbe6f5d`.
//   - FNV-1a (32-bit) folds the seed string deterministically into
//     the algorithm's 32-bit state. Reference:
//     `https://en.wikipedia.org/wiki/Fowler%E2%80%93Noll%E2%80%93Vo_hash_function`.
//
// Why not `Math.random`: it is not seedable. Deterministic per-
// `(blueprint, caseType, seed)` output is the contract of this
// module; without seedability the same generator call would emit
// different rows on every invocation.
//
// Why not `seedrandom` (the npm package): zero npm-overrides churn,
// no peer-dep concerns, the implementation is ~15 lines and the
// behavior is identical for the seeded-PRNG use case the generator
// has. The functions below are exported for the unit-test surface
// to pin the algorithm's deterministic output independently of the
// generator pipeline.
//
// ## Why a separate file from `heuristic.ts`
//
// The pool functions under `./pools/` take a `SeededPrng` directly
// so the generator's `prng` instance threads through without lambda
// adapters. A pool-side import of `SeededPrng` from `heuristic.ts`
// would form a cycle (heuristic.ts → pools/names.ts → heuristic.ts);
// pulling the PRNG into its own module breaks the cycle and lets
// every pool depend on the same canonical surface.

/**
 * Hash a string into a 32-bit unsigned integer via FNV-1a. The
 * algorithm is canonical and well-distributed for short string
 * inputs — `(appId, caseType, seed)` tuples fold into distinct
 * 32-bit states with high probability.
 */
export function hashStringToUint32(input: string): number {
	let hash = 0x811c9dc5; // FNV-1a 32-bit offset basis.
	for (let i = 0; i < input.length; i++) {
		hash ^= input.charCodeAt(i);
		// Multiplication by the FNV-1a 32-bit prime, masked to 32
		// bits. Bit-twiddling here avoids the precision loss that
		// would creep in with naive `*` over numbers > 2^32.
		hash = Math.imul(hash, 0x01000193);
	}
	return hash >>> 0;
}

/**
 * Seeded PRNG handle. The two methods together cover every
 * randomness read the generator needs:
 *
 *   - `pickFloat()` — uniform [0, 1) double. Matches `Math.random`'s
 *     contract.
 *   - `pickIndex(max)` — uniform [0, max) integer. Used for pool
 *     index selection.
 */
export interface SeededPrng {
	/** A uniform [0, 1) double. */
	pickFloat(): number;
	/** A uniform [0, max) integer. */
	pickIndex(max: number): number;
}

/**
 * Build a `SeededPrng` driven by mulberry32. The constructor folds
 * the string seed into a 32-bit state via FNV-1a; subsequent calls
 * to `pickFloat` / `pickIndex` advance the state and return derived
 * values.
 */
export function createSeededPrng(seed: string): SeededPrng {
	let state = hashStringToUint32(seed);

	const next = (): number => {
		// mulberry32 step: state += 0x6D2B79F5; t = state;
		// t = (t ^ (t >>> 15)) * (t | 1);
		// t ^= t + ((t ^ (t >>> 7)) * (t | 61));
		// return ((t ^ (t >>> 14)) >>> 0) / 0x100000000;
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 0x100000000;
	};

	return {
		pickFloat: () => next(),
		pickIndex: (max: number) => Math.floor(next() * max),
	};
}
