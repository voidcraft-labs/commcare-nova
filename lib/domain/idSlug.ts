// lib/domain/idSlug.ts
//
// Derive an entity's semantic id slug from its display name. Lowercased,
// non-alphanumerics collapsed to `_`, with leading/trailing underscores
// trimmed. Falls back to a caller-supplied word when sanitizing strips
// everything (e.g. a name that is all punctuation).
//
// One shared home so every creation site — the SA's mutation builders
// (`lib/agent/blueprintHelpers.ts`) and the builder's in-tree scaffolds
// (`lib/doc/scaffolds.ts`) — derives ids the same way. Module and form ids
// don't have to be globally unique (no validator rule enforces it), so this
// is a readability convenience, not a correctness gate.

/** Slugify `name` into a semantic id; returns `fallback` if nothing survives. */
export function slugifyId(name: string, fallback: string): string {
	const slug = name
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "");
	return slug.length > 0 ? slug : fallback;
}

/**
 * Slugify `name` and suffix it (`_2`, `_3`, …) until it's not in `taken`.
 * Keeps tree-created module/form ids readable and distinct even when two
 * entities share a display name.
 */
export function uniqueSlug(
	name: string,
	fallback: string,
	taken: ReadonlySet<string>,
): string {
	const base = slugifyId(name, fallback);
	if (!taken.has(base)) return base;
	for (let i = 2; ; i++) {
		const candidate = `${base}_${i}`;
		if (!taken.has(candidate)) return candidate;
	}
}
