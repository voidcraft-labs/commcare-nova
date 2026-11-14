/**
 * The words a person and a client read about an app that lives in CommCare
 * HQ: the standing of each thing the app holds, the subject a finding is
 * about, the group of later work that will hold what Nova does not hold
 * yet, and the finding a reading reports: about a thing a manifest entry
 * names, or about a circumstance of the reading itself.
 *
 * Safe for browser, HTTP and MCP consumers, and free of CommCare's wire
 * vocabulary. The surface manifest (`lib/commcare/surface`) reads these
 * lists: its schema takes a subject and an owner from them, and its standing
 * rule maps each entry to a standing.
 */

// ---------------------------------------------------------------------------
// Standings
// ---------------------------------------------------------------------------

/**
 * What becomes of one thing an app in CommCare HQ holds when Nova reads it:
 * Nova holds it (`held`), keeps CommCare HQ's value for it (`kept`), reads it
 * as changing nothing (`inert`), does not hold it yet (`not-yet`), will never
 * hold it (`never`), or holds it once it is changed in CommCare HQ
 * (`fix-in-hq`).
 */
export const READ_STANDINGS = [
	"held",
	"kept",
	"inert",
	"not-yet",
	"never",
	"fix-in-hq",
] as const;
export type ReadStanding = (typeof READ_STANDINGS)[number];

/** The standings an account shows. */
export type FindingStanding = Extract<
	ReadStanding,
	"not-yet" | "never" | "fix-in-hq"
>;

/** Why a `fix-in-hq` thing needs a change in CommCare HQ. It chooses the sentence a person reads. */
export const FIX_CAUSES = [
	"hq-refuses",
	"breaks-when-run",
	"either",
	"below-floor",
] as const;
export type FixCause = (typeof FIX_CAUSES)[number];

// ---------------------------------------------------------------------------
// Subjects
// ---------------------------------------------------------------------------

/**
 * What a finding is about, each a noun a person would use. Every HELD-NEW and
 * REFUSED manifest entry names one, and every member is the subject of some
 * entry.
 */
export const SUBJECTS = [
	"advanced-forms",
	"after-submit",
	"android-app-dependencies",
	"app-document",
	"app-logos",
	"app-settings",
	"auto-select",
	"blank-form",
	"call-center-indicators",
	"case-attachments",
	"case-detail-tabs",
	"case-list-callout",
	"case-list-columns",
	"case-list-filter",
	"case-list-optimizations",
	"case-list-registration",
	"case-list-setup",
	"case-list-sorting",
	"case-list-text",
	"case-preloads",
	"case-property-names",
	"case-sharing",
	"case-tiles",
	"case-types",
	"child-cases",
	"commcare-version",
	"connect-blocks",
	"custom-assertions",
	"custom-device-properties",
	"data-registry",
	"data-sources",
	"deep-links",
	"display-conditions",
	"display-only-forms",
	"expressions",
	"form-case-management",
	"form-settings",
	"form-source",
	"hand-written-content",
	"hierarchical-locations",
	"instance-text",
	"language-codes",
	"lookup-selection",
	"lookup-tables",
	"media-by-language",
	"media-files",
	"menu-badges",
	"menu-display",
	"menu-settings",
	"menu-structure",
	"mirror-menus",
	"missing-media-files",
	"mobile-reports",
	"parent-selection",
	"print-templates",
	"question-appearance",
	"question-choices",
	"question-ids",
	"question-logic",
	"question-media",
	"question-text",
	"question-types",
	"repeats",
	"save-to-case",
	"search-default-filters",
	"search-expressions",
	"search-fields",
	"search-setup",
	"shadow-forms",
	"supply-features",
	"training-menus",
	"visit-scheduler",
	"worker-record",
	"writer-types",
] as const;
export type Subject = (typeof SUBJECTS)[number];

// ---------------------------------------------------------------------------
// The groups of later work
// ---------------------------------------------------------------------------

/**
 * The groups of work that will hold what Nova does not hold yet. Every
 * HELD-NEW manifest entry names the one that owns it.
 */
export const STEP_7_GROUPS = [
	"project-data-at-hq-size",
	"settings-nova-comes-to-own",
	"question-display",
	"case-list-and-detail",
	"menus",
	"case-search",
	"forms-and-case-management",
	"xform",
] as const;
export type Step7Group = (typeof STEP_7_GROUPS)[number];

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

/** Where in the HQ app, by the names its author sees. Indexes are 0-based positions in HQ's lists. */
export type HqPlace =
	| { readonly kind: "app" }
	| { readonly kind: "app-settings" }
	| { readonly kind: "languages" }
	| { readonly kind: "menu"; readonly menu: number; readonly name: string }
	| {
			readonly kind: "case-list" | "case-detail" | "search";
			readonly menu: number;
			readonly name: string;
	  }
	| {
			readonly kind: "form";
			readonly menu: number;
			readonly form: number;
			readonly menuName: string;
			readonly name: string;
	  }
	| {
			readonly kind: "question";
			readonly menu: number;
			readonly form: number;
			readonly menuName: string;
			readonly formName: string;
			/** The question's path under the form's data node, as its author reads it. */
			readonly path: string;
	  }
	| { readonly kind: "lookup-table"; readonly tag: string }
	| { readonly kind: "media"; readonly path: string }
	| { readonly kind: "organization" };

/** Who holds an HQ app that is already in Nova, as the viewer may know it. */
export type HqAppClaimDetail =
	/** The viewer is a member of the holding Project. */
	| { readonly kind: "open"; readonly appId: string; readonly appName: string }
	| {
			readonly kind: "elsewhere";
			/** When the Nova app began to manage the HQ app. */
			readonly at: string;
			readonly contact: {
				readonly role: "person" | "owners";
				readonly names: readonly string[];
			};
	  };

/** What the finding is about, in the app's own words where it has some. */
export interface FindingDetail {
	/**
	 * The thing's own name: an appearance, a setting, a property, a key, a file. At most 200
	 * characters. On a circumstance it is present exactly where the code's row of
	 * `CIRCUMSTANCE_STANDINGS` holds `name`, which also says where it is shown.
	 */
	readonly name?: string;
	/**
	 * Nova's checker reason, for an expression the checker refuses; `split-refused` on
	 * `no-platform-runs-everything` at a date and time question whose split is refused.
	 */
	readonly reason?: string;
	/** Present only on `already-in-nova`, where the holder is known. */
	readonly claim?: HqAppClaimDetail;
}

/** A finding about something the app holds, named by the manifest entry that covers it. */
export type ManifestFinding = {
	/** An inventory entry id. */
	readonly code: string;
	readonly standing: FindingStanding;
	/** Present exactly when standing is "fix-in-hq": the entry's fix cause. */
	readonly cause?: FixCause;
	readonly place: HqPlace;
	readonly subject: Subject;
	readonly detail: FindingDetail;
};

/** A finding about the reading itself, or about something no manifest entry can name. */
export type CircumstanceFinding = {
	readonly code: ReadCircumstance;
	readonly standing: FindingStanding | "stop";
	readonly place: HqPlace;
	readonly subject: null;
	readonly detail: FindingDetail;
};

export type Finding = ManifestFinding | CircumstanceFinding;

/** The most characters a finding's name holds. */
export const FINDING_NAME_MAX_LENGTH = 200;

const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * `name` cut to the bound, its last character `…` where it was cut. A
 * character is what a person reads as one, a grapheme cluster (a letter with
 * its combining marks, an emoji sequence joined by a zero-width joiner), so a
 * cut never splits one.
 */
export function cutFindingName(name: string): string {
	const characters = Array.from(
		GRAPHEMES.segment(name),
		(part) => part.segment,
	);
	if (characters.length <= FINDING_NAME_MAX_LENGTH) return name;
	return `${characters.slice(0, FINDING_NAME_MAX_LENGTH - 1).join("")}…`;
}

// ---------------------------------------------------------------------------
// Circumstances
// ---------------------------------------------------------------------------

/**
 * The circumstances of a reading: the codes that end it (`stop`), then the
 * ones an account can hold.
 */
export const READ_CIRCUMSTANCES = [
	"not-connected",
	"key-not-accepted",
	"key-cannot-reach-space",
	"plan-lacks-api-access",
	"api-cut-off",
	"not-a-member",
	"cannot-edit-apps",
	"cannot-access-apis",
	"cannot-read-organization",
	"app-gone",
	"app-deleted",
	"linked-app",
	"remote-app",
	"rate-limited",
	"hq-unavailable",
	"hq-gateway-refused",
	"browser-only",
	"changed-while-reading",
	"already-in-nova",
	"too-large",
	"menu-unreadable-in-hq",
	"app-unreadable-in-hq",
	"shadow-disagrees",
	"media-file-unreadable",
	"media-not-played-where-app-runs",
	"table-rows-unreadable",
	"table-cell-unrepresentable",
	"table-choices-unusable",
	"no-platform-runs-everything",
	"places-over-nova-limit",
	"place-not-holdable",
	"owner-rule-needs-one-place",
	"unrecognized",
	"read-back-differs",
] as const;
export type ReadCircumstance = (typeof READ_CIRCUMSTANCES)[number];

/**
 * One row per code: its standing, its step 7 owner where it has one, and where
 * its name goes. `body`: the block's body names it. `line`: it is shown after
 * the block's body as "In CommCare HQ: {name}". `internal`: it is Nova's own
 * word, for the log and for telling two findings apart, and no surface shows
 * it. A code with no `name` carries none.
 */
export const CIRCUMSTANCE_STANDINGS = {
	"not-connected": { standing: "stop" },
	"key-not-accepted": { standing: "stop" },
	"key-cannot-reach-space": { standing: "stop" },
	"plan-lacks-api-access": { standing: "stop" },
	"api-cut-off": { standing: "stop" },
	"not-a-member": { standing: "stop" },
	"cannot-edit-apps": { standing: "stop" },
	"cannot-access-apis": { standing: "stop" },
	"cannot-read-organization": { standing: "stop" },
	"app-gone": { standing: "stop" },
	"app-deleted": { standing: "stop" },
	"linked-app": { standing: "stop" },
	"remote-app": { standing: "stop" },
	"rate-limited": { standing: "stop" },
	"hq-unavailable": { standing: "stop" },
	"hq-gateway-refused": { standing: "stop" },
	"browser-only": { standing: "stop" },
	"changed-while-reading": { standing: "stop" },
	"already-in-nova": { standing: "stop" },
	"too-large": { standing: "not-yet" },
	"menu-unreadable-in-hq": { standing: "fix-in-hq" },
	"app-unreadable-in-hq": { standing: "fix-in-hq" },
	"shadow-disagrees": { standing: "fix-in-hq", name: "line" },
	"media-file-unreadable": { standing: "fix-in-hq", name: "body" },
	"media-not-played-where-app-runs": { standing: "fix-in-hq", name: "body" },
	"table-rows-unreadable": { standing: "fix-in-hq", name: "body" },
	"table-cell-unrepresentable": { standing: "fix-in-hq", name: "body" },
	"table-choices-unusable": { standing: "fix-in-hq", name: "body" },
	"no-platform-runs-everything": { standing: "fix-in-hq", name: "body" },
	"places-over-nova-limit": {
		standing: "not-yet",
		owner: "project-data-at-hq-size",
		name: "body",
	},
	"place-not-holdable": {
		standing: "not-yet",
		owner: "project-data-at-hq-size",
		name: "body",
	},
	"owner-rule-needs-one-place": {
		standing: "not-yet",
		owner: "project-data-at-hq-size",
		name: "body",
	},
	unrecognized: { standing: "not-yet", name: "line" },
	"read-back-differs": { standing: "not-yet", name: "internal" },
} as const satisfies Record<
	ReadCircumstance,
	{
		readonly standing: FindingStanding | "stop";
		readonly owner?: Step7Group;
		/** Where `detail.name` goes: in the block's body, on its own line, or to the log alone. */
		readonly name?: "body" | "line" | "internal";
	}
>;

/** The `not-yet` circumstances that are Nova's own fault: reported, and cleared by a Nova update. */
export const NOVA_FAULT_CIRCUMSTANCES = [
	"unrecognized",
	"read-back-differs",
] as const satisfies readonly ReadCircumstance[];

// Each of Nova's own faults is `not-yet` and holds no owner: a fault of Nova's
// is no piece of later work, and its block promises only a Nova update.
type NovaFaultRows =
	(typeof CIRCUMSTANCE_STANDINGS)[(typeof NOVA_FAULT_CIRCUMSTANCES)[number]];
const _novaFaultsAreNotYetWithNoOwner: NovaFaultRows extends {
	readonly standing: "not-yet";
	readonly owner?: never;
}
	? true
	: never = true;

/** The codes that end a reading. A table keyed by this type is total over them. */
export type StopCircumstance = {
	[K in ReadCircumstance]: (typeof CIRCUMSTANCE_STANDINGS)[K]["standing"] extends "stop"
		? K
		: never;
}[ReadCircumstance];

/** What `detail` holds for one code, read off its row of `CIRCUMSTANCE_STANDINGS`. */
export type CircumstanceDetail<C extends ReadCircumstance> =
	((typeof CIRCUMSTANCE_STANDINGS)[C] extends { readonly name: string }
		? { readonly name: string }
		: { readonly name?: never }) &
		(C extends "no-platform-runs-everything"
			? { readonly reason?: "split-refused" }
			: { readonly reason?: never }) &
		(C extends "already-in-nova"
			? { readonly claim?: HqAppClaimDetail }
			: { readonly claim?: never });

/** The one way a circumstance finding is made. `standing` is the row's, and the name is cut. */
export function circumstanceFinding<C extends ReadCircumstance>(
	code: C,
	place: HqPlace,
	detail: CircumstanceDetail<C>,
): CircumstanceFinding {
	const { name, reason, claim } = detail as FindingDetail;
	return {
		code,
		standing: CIRCUMSTANCE_STANDINGS[code].standing,
		place,
		subject: null,
		detail: {
			...(name === undefined ? {} : { name: cutFindingName(name) }),
			...(reason === undefined ? {} : { reason }),
			...(claim === undefined ? {} : { claim }),
		},
	};
}
