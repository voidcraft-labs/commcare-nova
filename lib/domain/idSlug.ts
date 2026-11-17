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

/**
 * Turn an identifier into a person-facing label: separators to spaces, trimmed,
 * first letter capitalized (`home_visit` → "Home visit"). The inverse-ish of
 * `slugifyId` — a default display name derived from a slug/id. Falls back to the
 * input when sanitizing leaves nothing.
 */
export function humanizeId(name: string): string {
	const words = name.replace(/[_-]+/g, " ").trim();
	return words.length > 0
		? words.charAt(0).toUpperCase() + words.slice(1)
		: name;
}

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
	return suffixUntilFree(slugifyId(name, fallback), taken);
}

/**
 * `base` itself when nothing in `taken` holds it, else the first of
 * `base_2`, `base_3`, … that is free. The one collision policy for every
 * slug Nova mints beside its siblings: module and form ids here, a choice's
 * stored value in `selectOptionValue.ts`.
 */
export function suffixUntilFree(
	base: string,
	taken: ReadonlySet<string>,
): string {
	if (!taken.has(base)) return base;
	for (let i = 2; ; i++) {
		const candidate = `${base}_${i}`;
		if (!taken.has(candidate)) return candidate;
	}
}

/**
 * Slugs handed out one at a time beside names already taken, each taken as
 * it is handed out: `take(name, fallback)` is `uniqueSlug(name, fallback,
 * taken)` at the moment it is asked. The set only grows, so every suffix a
 * base was handed, or found taken, before stays taken, and a base asked
 * again starts its search past the last suffix it was handed: n names of one
 * base cost n checks rather than n²/2, which a reading of an app with
 * hundreds of copies of one menu meets.
 */
export class SlugsTaken {
	readonly #taken: Set<string>;
	/** Each base's first suffix not yet known to be taken. */
	readonly #nextSuffix = new Map<string, number>();

	constructor(taken: Iterable<string> = []) {
		this.#taken = new Set(taken);
	}

	/** Marks `id` taken, as an id the caller holds already. */
	add(id: string): void {
		this.#taken.add(id);
	}

	take(name: string, fallback: string): string {
		const base = slugifyId(name, fallback);
		let id = base;
		if (this.#taken.has(base)) {
			let suffix = this.#nextSuffix.get(base) ?? 2;
			while (this.#taken.has(`${base}_${suffix}`)) suffix++;
			id = `${base}_${suffix}`;
			this.#nextSuffix.set(base, suffix + 1);
		}
		this.#taken.add(id);
		return id;
	}
}

/**
 * How a refusal offers its replacement name. `free-here`: the name was
 * checked against everything beside the refused one, so taking it meets no
 * second refusal. `suggested`: nothing beside it was known when it was
 * minted (a tool's input schema, read before the document is), so the
 * sentence offers it without claiming it is free; the commit's own verdict,
 * which knows the siblings, says so if it is not.
 */
export type FreeNameOffer = "free-here" | "suggested";

/** The closing sentence of a refusal that offers `name` in its place. */
export function freeNameClause(
	name: string,
	offer: FreeNameOffer = "free-here",
): string {
	return offer === "free-here"
		? `"${name}" is free here.`
		: `You could call it "${name}" instead.`;
}
