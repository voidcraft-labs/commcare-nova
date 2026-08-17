// lib/domain/languageRegistry/load.ts
//
// The lazy seam client surfaces load the full-name registry data through, so
// the ~100 KB name catalog stays out of the main client bundle. The picker
// and any surface labeling a language outside the baked common set await
// this once; the promise is shared.

let pending: Promise<typeof import("./search")> | undefined;

export function loadLanguageRegistrySearch(): Promise<
	typeof import("./search")
> {
	// A rejected chunk load is not shared: the promise unlatches so a caller's
	// retry issues a fresh import instead of replaying the same failure.
	pending ??= import("./search").catch((error: unknown) => {
		pending = undefined;
		throw error;
	});
	return pending;
}

export type LanguageRegistrySearch = Awaited<
	ReturnType<typeof loadLanguageRegistrySearch>
>;
