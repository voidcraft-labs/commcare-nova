/**
 * The level a held slot was read at, and the control that prints the slot's
 * tree at that level again (`emissionRewrites.ts`). A slot is held exact
 * where Nova's own print is the source, with every rewrite withheld where the
 * print that leaves them all out is, and site by site where the source spells
 * a rewrite at some of the slot's sites and not at others (a test that reads
 * one Search answer inside Nova's guard on its rows and another bare). A
 * stage that settles a whole menu after the expression stage prints each slot
 * through `levelControl`, so its projection prints the slot as the reading
 * held it.
 */
import {
	EMISSION_REWRITE_IDS,
	type EmissionRewriteId,
	type RewriteControl,
} from "../../emissionRewrites";

export type PrintLevel =
	/** Every rewrite withheld. */
	| { readonly kind: "withheld" }
	/** The sites, by the order the print reaches them from 0, whose rewrite is withheld. */
	| { readonly kind: "sites"; readonly withheld: ReadonlySet<number> };

const WITHHOLD_ALL: ReadonlySet<EmissionRewriteId> = new Set(
	EMISSION_REWRITE_IDS,
);
const WITHHOLD_NONE: ReadonlySet<EmissionRewriteId> = new Set();

/**
 * A fresh control that prints one slot at `level`, reporting each site it
 * reaches to `reached`; undefined for a slot held exact. A site level counts
 * the sites of one print, so each print takes a control of its own.
 */
export function levelControl(
	level: PrintLevel | undefined,
	reached?: (id: EmissionRewriteId, withheld: boolean) => void,
): RewriteControl | undefined {
	if (level === undefined) return undefined;
	if (level.kind === "withheld")
		return {
			withhold: WITHHOLD_ALL,
			...(reached === undefined ? {} : { reached: (id) => reached(id, true) }),
		};
	let at = 0;
	return {
		withhold: WITHHOLD_NONE,
		withholdSite: (id) => {
			const withheld = level.withheld.has(at);
			at += 1;
			reached?.(id, withheld);
			return withheld;
		},
	};
}
