// lib/commcare/surface/standing.ts
//
// The standing of a manifest entry, derived and never authored: what becomes
// of the thing the entry covers when Nova reads an app that holds it. An
// entry's disposition decides it, and a REFUSED entry's reason kinds decide
// whether a change in CommCare HQ would lift the refusal. A `fix-in-hq`
// entry also has a cause, because a person reads a different sentence for a
// thing CommCare HQ will not save or build than for one that builds and then
// does not work when the app runs.

import type { FixCause, ReadStanding } from "@/lib/publish/hqFindings";
import type {
	InventoryEntry,
	REFUSAL_REASON_KINDS,
	RefusalReasonKind,
} from "./schema";

/** The reason kinds a fix in CommCare HQ does not lift. */
export const NEVER_REASON_KINDS = [
	"retiring",
	"freeform",
	"untypeable",
	"unrepresentable-identity",
] as const satisfies readonly RefusalReasonKind[];

/** The reason kinds a change in CommCare HQ lifts. */
export const FIX_IN_HQ_REASON_KINDS = [
	"not-hq-editable",
	"not-hq-buildable",
	"broken-at-runtime",
	"below-commcare-version-floor",
	"unavailable-on-declared-platform",
] as const satisfies readonly RefusalReasonKind[];

type NeverReasonKind = (typeof NEVER_REASON_KINDS)[number];
type FixInHqReasonKind = (typeof FIX_IN_HQ_REASON_KINDS)[number];

// The two lists partition the reason kinds: every kind is in one of them, and
// no kind is in both. A new kind that names no group, or a kind listed twice,
// fails to compile here.
type Unlisted = Exclude<
	(typeof REFUSAL_REASON_KINDS)[number],
	NeverReasonKind | FixInHqReasonKind
>;
type ListedTwice = Extract<NeverReasonKind, FixInHqReasonKind>;
const _partitioned: [Unlisted, ListedTwice] extends [never, never]
	? true
	: never = true;

const NEVER_KINDS: ReadonlySet<RefusalReasonKind> = new Set(NEVER_REASON_KINDS);

/** The reason kinds that say CommCare HQ will not save or build the thing. */
const HQ_REFUSES_KINDS: ReadonlySet<RefusalReasonKind> = new Set([
	"not-hq-editable",
	"not-hq-buildable",
]);

/** The reason kinds that say the thing builds and does not work when the app runs. */
const BREAKS_WHEN_RUN_KINDS: ReadonlySet<RefusalReasonKind> = new Set([
	"broken-at-runtime",
	"unavailable-on-declared-platform",
]);

/**
 * The standing of an entry: `held`, `kept`, `inert` and `not-yet` follow its
 * disposition; a REFUSED entry is `never` where any of its reasons is one a
 * fix in CommCare HQ does not lift, and `fix-in-hq` where every reason is one
 * such a fix lifts.
 */
export function standingOf(entry: InventoryEntry): ReadStanding {
	switch (entry.disposition) {
		case "HELD":
			return "held";
		case "TARGET-OWNED":
			return "kept";
		case "INERT":
			return "inert";
		case "HELD-NEW":
			return "not-yet";
		case "REFUSED":
			return entry.reasons.some((reason) => NEVER_KINDS.has(reason.kind))
				? "never"
				: "fix-in-hq";
	}
}

/** The cause of an entry whose standing is `fix-in-hq`, and `null` for every other entry. */
export function fixCauseOf(entry: InventoryEntry): FixCause | null {
	if (entry.disposition !== "REFUSED" || standingOf(entry) !== "fix-in-hq")
		return null;
	const kinds = entry.reasons.map((reason) => reason.kind);
	if (kinds.includes("below-commcare-version-floor")) return "below-floor";
	const refuses = kinds.some((kind) => HQ_REFUSES_KINDS.has(kind));
	const breaks = kinds.some((kind) => BREAKS_WHEN_RUN_KINDS.has(kind));
	if (refuses && breaks) return "either";
	return refuses ? "hq-refuses" : "breaks-when-run";
}
