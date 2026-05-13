// lib/case-store/sample/prng.ts
//
// Zero-dependency seeded PRNG. `mulberry32` for the bit sequence
// (Tommy Ettinger's gist
// `https://gist.github.com/tommyettinger/46a3a48eaee2bf32f3df40a35bbe6f5d`);
// FNV-1a 32-bit hash for folding the seed string into the
// algorithm's state
// (`https://en.wikipedia.org/wiki/Fowler%E2%80%93Noll%E2%80%93Vo_hash_function`).
// `Math.random` is not seedable; the seedrandom npm package would
// add a peer-dep concern for a ~15-line implementation.
//
// Lives in its own module (not heuristic.ts) so pool modules can
// depend on `SeededPrng` without forming a cycle through
// heuristic.ts.

/** Hash a string into a 32-bit unsigned integer via FNV-1a. */
export function hashStringToUint32(input: string): number {
	let hash = 0x811c9dc5; // FNV-1a 32-bit offset basis.
	for (let i = 0; i < input.length; i++) {
		hash ^= input.charCodeAt(i);
		// `Math.imul` masks the multiply to 32 bits, avoiding the
		// precision loss naive `*` would hit above 2^32.
		hash = Math.imul(hash, 0x01000193);
	}
	return hash >>> 0;
}

export interface SeededPrng {
	/** Uniform [0, 1) double. Matches `Math.random`'s contract. */
	pickFloat(): number;
	/** Uniform [0, max) integer. */
	pickIndex(max: number): number;
}

/**
 * Build a `SeededPrng` driven by mulberry32. Folds the string seed
 * into a 32-bit state via FNV-1a; subsequent calls advance the
 * state.
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
