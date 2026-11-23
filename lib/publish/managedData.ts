/**
 * The words Nova says about data CommCare HQ manages for an app: a lookup
 * table Nova keeps a copy of, the places it keeps a copy of, what a publish
 * checks about them, the review that brings them in, and the HQ app file's
 * guide to them.
 *
 * Client-safe: the builder, MCP and the docs read one text. Its one run-time
 * import, `namesInWords`, imports nothing. A day (`date`) is spelled by the
 * caller: in the reader's locale everywhere but the HQ app file's guide, which
 * is made on the server for no one reader and spells the UTC day. A project
 * space's name always stands bare, never quoted.
 */

import type { LookupReferencingAppSummary } from "@/lib/lookup/types";
import { namesInWords } from "./planFeatures";

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

/**
 * The note on a lookup table change whose discard replaces a table HQ still
 * holds under that tag and id: a change to its definition or rows, or one
 * whose baseline Nova could not read. HQ's table key holds a description
 * and each field's indexed flag (`fixtures/upload/run_upload.py::table_key`),
 * which no API-key read returns and no workbook carries a description of,
 * so the push makes such a table again without them.
 */
export const LOOKUP_DISCARD_NOTE =
	"If it has a description or indexed fields in CommCare HQ, publishing removes them: CommCare HQ doesn't show those to Nova, and a lookup upload can't carry a description.";

/** An app as these sentences name it: its name, and where it is when it is in the trash. */
export type NamedApp = Pick<LookupReferencingAppSummary, "appName" | "deleted">;

const COUNT_FORMAT = new Intl.NumberFormat("en-US");

/** A count as these sentences spell it: "1", "12,400". */
function count(n: number): string {
	return COUNT_FORMAT.format(n);
}

/**
 * The apps, joined as a sentence lists them. An app in the trash still reads
 * the table and still counts, so its name says where it is, or a person
 * looking for it would find nothing.
 */
function appsInWords(apps: readonly NamedApp[]): string {
	return namesInWords(
		apps.map((app) =>
			app.deleted ? `${app.appName} (in the trash)` : app.appName,
		),
	);
}

/** "different columns", "different rows", "different columns and rows". */
function differsInWords(differs: readonly ("columns" | "rows")[]): string {
	const parts = (["columns", "rows"] as const).filter((part) =>
		differs.includes(part),
	);
	return `different ${namesInWords(parts)}`;
}

// ---------------------------------------------------------------------------
// The table page
// ---------------------------------------------------------------------------

/** The badge beside a table CommCare HQ manages. */
export const MANAGED_TABLE_BADGE = "Managed in CommCare HQ";

/** The banner's first line. */
export function managedTableBanner(domain: string): string {
	return `This table lives in ${domain} on CommCare HQ. Nova keeps a copy so your apps and Preview can read it, and never changes it there.`;
}

/** The banner's second line. `date` is the day of the last refresh, spelled by the caller. */
export function managedTableBannerRefreshed(date: string): string {
	return `You can change it on CommCare HQ's Lookup Tables page, then refresh. Nova's copy was refreshed on ${date}.`;
}

/** The banner's three actions on a table CommCare HQ manages. */
export const REFRESH_FROM_HQ = "Refresh from CommCare HQ";
export const OPEN_IN_HQ = "Open in CommCare HQ";
export const MANAGE_IN_NOVA = "Manage in Nova";

/** In place of Refresh and the hand-back, without a CommCare HQ connection on that server. */
export const CONNECT_TO_REFRESH_TABLE =
	"Connect CommCare HQ to refresh this table";

/** A refresh that finds the table gone. */
export function managedTableGone(tag: string, domain: string): string {
	return `CommCare HQ no longer has a lookup table named ${tag} in ${domain}. Nova kept its copy as it was. You can make the table again in CommCare HQ, or choose Manage in Nova to publish this copy there.`;
}

/** The `holds` of `managedTableUnsupported` and `managedTableUnsupportedItem` for a field with more than one value. */
export const HOLDS_MORE_THAN_ONE_VALUE = "a field with more than one value";

/** The `holds` of `managedTableUnsupported` for a field name Nova can't hold. */
export function holdsColumnNamed(name: string): string {
	return `a column named ${name}`;
}

/**
 * A refresh that finds what Nova can't hold. `holds` is
 * `describeUnsupportedLookupContent`'s phrase, `HOLDS_MORE_THAN_ONE_VALUE`
 * or `holdsColumnNamed`'s.
 */
export function managedTableUnsupported(holds: string): string {
	return `This table now holds ${holds} in CommCare HQ, which Nova can't hold yet. Nova kept its copy as it was.`;
}

/** A refresh over a cap. `phrases` are the caps' phrases without the tag, joined with " and ". */
export function managedTableOverCap(phrases: readonly string[]): string {
	return `This table now has ${phrases.join(" and ")} in CommCare HQ. Nova kept its copy as it was.`;
}

/** A refresh that finds the table holds no column in CommCare HQ. */
export const MANAGED_TABLE_NO_COLUMNS =
	"This table now has no columns in CommCare HQ, and Nova holds a lookup table only with at least one. Nova kept its copy as it was. You can add a column there, then refresh.";

/** Every refused write to a lookup table CommCare HQ manages. */
export function managedLookupTableRefusal(
	name: string,
	domain: string,
): string {
	return `The lookup table ${name} is managed in CommCare HQ (${domain}), so Nova can't change it here. You can change it in CommCare HQ and refresh Nova's copy, or choose Manage in Nova on the table's page.`;
}

/**
 * The line naming the apps that read a table, in the two confirmations
 * (Manage in Nova's and the hand-back's); null where no app reads it, and the line is left out.
 */
export function appsThatReadIt(apps: readonly NamedApp[]): string | null {
	if (apps.length === 0) return null;
	return apps.length === 1
		? `One app reads it: ${appsInWords(apps)}.`
		: `These apps read it: ${appsInWords(apps)}.`;
}

/** Manage in Nova's confirmation, its title. */
export function manageInNovaTitle(name: string): string {
	return `Manage ${name} in Nova?`;
}

/**
 * Manage in Nova's confirmation, its body before the facts a push clears. The dialog follows these with
 * `LOOKUP_DISCARD_NOTE` unchanged, and
 * then `appsThatReadIt`.
 */
export function manageInNovaBody(domain: string): readonly string[] {
	return [
		`From now on you change this table in Nova, and each publish to ${domain} replaces the table there with Nova's columns and rows.`,
		"If someone changes it in CommCare HQ after this, your next publish there stops and shows you what changed before it sends anything.",
	];
}

/** Manage in Nova's confirmation, its two buttons. */
export const MANAGE_IN_NOVA_CONFIRM = MANAGE_IN_NOVA;
export const KEEP_IN_HQ = "Keep it in CommCare HQ";

/** The banner on a table Nova manages that came from CommCare HQ. */
export function managedInNovaBanner(domain: string): string {
	return `Nova manages this table. It came from ${domain} on CommCare HQ, and publishing there replaces that table with Nova's.`;
}

/** The button on that banner. */
export const LET_HQ_MANAGE_AGAIN = "Let CommCare HQ manage it again";

/** The hand-back's confirmation, its title. */
export function letHqManageTitle(name: string): string {
	return `Let CommCare HQ manage ${name} again?`;
}

/** The hand-back's confirmation, its first line. */
export function letHqManageBody(domain: string): string {
	return `Nova takes CommCare HQ's columns and rows as they are in ${domain} right now, and stops changing the table there. Changes made in Nova that were never published there are replaced.`;
}

/**
 * The line for columns that become text (the hand-back's confirmation, and
 * the line under the choice's first answer):
 * `columns` are their labels; null where there are none, and the line is left
 * out.
 */
export function columnsBecomeText(columns: readonly string[]): string | null {
	if (columns.length === 0) return null;
	return `Every column becomes text, as CommCare HQ holds it. ${namesInWords(columns)} held numbers or dates in Nova, so apps that compare them will compare text.`;
}

/** The hand-back's confirmation, its two buttons. */
export const LET_HQ_MANAGE_CONFIRM = "Let CommCare HQ manage it";
export const KEEP_MANAGING_IN_NOVA = "Keep managing it in Nova";

/** The header badge of a column CommCare HQ's table no longer has. */
export const COLUMN_GONE_IN_HQ = "Gone in CommCare HQ";

/** A refresh that changed nothing. */
export const MANAGED_TABLE_ALREADY_MATCHES =
	"Nova's copy already matches CommCare HQ.";
/** A refresh that took new rows. */
export const MANAGED_TABLE_REFRESHED_ROWS =
	"Nova's copy now has CommCare HQ's rows.";
/** A refresh that took new columns and rows. */
export const MANAGED_TABLE_REFRESHED_COLUMNS =
	"Nova's copy now has CommCare HQ's columns and rows.";
/** A refresh whose read a newer refresh or hand-back overtook, so it wrote nothing. */
export const MANAGED_TABLE_REFRESHED_SINCE =
	"Nova's copy was refreshed again while this one was reading CommCare HQ, so it already holds the newer read.";

/** A refresh that kept a column CommCare HQ's table no longer has, because apps read it. */
export function managedColumnKept(
	column: string,
	apps: readonly NamedApp[],
	domain: string,
): string {
	if (apps.length === 0)
		throw new Error(
			`Nova kept the column ${column} because an app reads it, so the sentence about it names those apps, and none was given. Pass the apps whose references kept the column.`,
		);
	const one = apps.length === 1;
	return `CommCare HQ no longer has the column ${column}, and ${appsInWords(apps)} still ${one ? "reads" : "read"} it. Nova kept the column, with no values, so ${one ? "that app keeps" : "those apps keep"} opening. ${one ? "Its" : "Their"} next publish to ${domain} stops until the column is back in CommCare HQ or ${one ? "it stops" : "they stop"} reading it.`;
}

/**
 * What a table action answered, as `lib/deployment/managedData.ts`'s
 * `ManagedTableOutcome` holds it, taken structurally so this file imports
 * nothing of `lib/deployment`.
 */
export type ManagedTableAnswer =
	| {
			readonly ok: true;
			readonly receipt: {
				readonly changed: "nothing" | "rows" | "definition" | "superseded";
				readonly keptGoneColumns: readonly {
					readonly wireName: string;
					readonly apps: readonly NamedApp[];
				}[];
			} | null;
	  }
	| { readonly ok: false; readonly message: string };

/**
 * What is said after a table action answered, on the table's banner and in
 * MCP's answer. A refresh that landed says what changed, then each column it
 * kept because an app still reads it; Manage in Nova
 * and a hand-back that met the table as it stands say nothing, since the
 * table's banner itself turns over. A refusal says its own sentence, and
 * the copy is as it was.
 */
export function managedTableOutcomeLines(
	outcome: ManagedTableAnswer,
	domain: string,
): { readonly tone: "status" | "alert"; readonly lines: readonly string[] } {
	if (!outcome.ok) return { tone: "alert", lines: [outcome.message] };
	const receipt = outcome.receipt;
	if (receipt === null) return { tone: "status", lines: [] };
	const changed = {
		nothing: MANAGED_TABLE_ALREADY_MATCHES,
		rows: MANAGED_TABLE_REFRESHED_ROWS,
		definition: MANAGED_TABLE_REFRESHED_COLUMNS,
		superseded: MANAGED_TABLE_REFRESHED_SINCE,
	}[receipt.changed];
	return {
		tone: "status",
		lines: [
			changed,
			/* A column an accepted design names stays with no app reading it,
			 * and the sentence about a kept column is about the apps that do. */
			...receipt.keptGoneColumns
				.filter((column) => column.apps.length > 0)
				.map((column) =>
					managedColumnKept(column.wireName, column.apps, domain),
				),
		],
	};
}

/** A refresh CommCare HQ refused to answer the account. */
export function cannotReadManagedTables(domain: string): string {
	return `Nova couldn't read lookup tables in ${domain} with your CommCare HQ account. It needs API access on that project space, and the Edit Apps and Access APIs permissions on your account.`;
}

/** Any other failed read, of a table or of places. */
export const HQ_UNAVAILABLE =
	"CommCare HQ didn't answer just now. You can try again in a moment.";

/** Manage in Nova or the hand-back, for a member who isn't an admin. */
export const MANAGEMENT_NEEDS_ADMIN =
	"An admin of this Project can choose this.";
/** A refresh of a table or of places, for a member who can't edit. */
export const REFRESH_NEEDS_EDITOR =
	"An editor of this Project can refresh this copy.";

/** A hand-back whose read began before someone chose Manage in Nova again. */
export const HAND_BACK_OVERTAKEN =
	"Someone chose Manage in Nova for this table while CommCare HQ was being read, so Nova kept it as they left it.";

/** A hand-back of a table a publish is sending to CommCare HQ right now. */
export function handBackWhilePublishing(domain: string): string {
	return `Nova is publishing this table to “${domain}” right now, so it stays managed in Nova for the moment. You can try again once that publish finishes.`;
}

/**
 * Manage in Nova or the hand-back, where the table, or the apps that read it,
 * are no longer what the confirmation showed. The surface shows the table as
 * it stands now beside it.
 */
export const MANAGEMENT_REVIEW_MOVED =
	"This table, or the apps that read it, changed while you were deciding, so Nova changed nothing. Here is how it stands now.";

/** A refresh that met a table someone had just taken over. */
export const TABLE_TAKEN_OVER_MEANWHILE =
	"Someone chose Manage in Nova for this table a moment ago, so there was nothing to refresh.";

/** A refresh that finds a character CommCare can't carry. */
export function managedTableUnrepresentable(column: string): string {
	return `The column ${column} now holds a character CommCare can't carry in a value. Nova kept its copy as it was. You can take that character out in CommCare HQ, then refresh.`;
}

// ---------------------------------------------------------------------------
// Organization
// ---------------------------------------------------------------------------

/** The banner's label. */
export const MANAGED_PLACES_LABEL = "Places managed in CommCare HQ";

/** The banner. `date` is the day of the last refresh, spelled by the caller. */
export function managedPlacesBanner(domain: string, date: string): string {
	return `These places live in ${domain} on CommCare HQ. Nova keeps a copy so Preview can show them, and never changes them there. You can add or change places in CommCare HQ, then refresh. Nova's copy was refreshed on ${date}.`;
}

/** Above the levels, while places are managed. */
export function managedPlacesLevelsNote(domain: string): string {
	return `CommCare HQ doesn't tell Nova which levels hold workers or how far a worker's phone carries places. Nova assumed every level holds workers and each worker carries their own branch. If ${domain} is set up differently, you can match it here so Preview shows what workers see.`;
}

/** Under personas, where the app has managed places and no persona. */
export const MANAGED_PLACES_NO_PERSONA =
	"Preview shows a worker's places through a persona. You can add a persona and stand them in a place to see this app's place lists.";

/** The banner's small line. */
export const MANAGED_PLACES_NO_EXTERNAL_IDS =
	"CommCare HQ doesn't send external IDs for places, so Nova's copy has none.";

/**
 * After a refresh, the places gone from CommCare HQ that a persona, an
 * owner rule or an automation still uses (every edge of
 * `app_location_references`).
 */
export function managedPlacesKeptInUse(names: readonly string[]): string {
	const one = names.length === 1;
	return `${count(names.length)} ${one ? "place is" : "places are"} gone from CommCare HQ, and a persona, an owner rule or an automation still uses ${one ? "it" : "them"}: ${namesInWords(names)}. Nova kept ${one ? "it" : "them"}. You can move or change what uses ${one ? "it" : "them"}, then refresh again.`;
}

/**
 * After a refresh, the places CommCare HQ made again as new places under their
 * site codes that a persona, an owner rule or an automation still uses. Nova
 * never carries what uses a place across to another CommCare HQ place, so the
 * old one stays, marked gone, beside the new one.
 */
export function managedPlacesRemade(names: readonly string[]): string {
	const one = names.length === 1;
	return `CommCare HQ made ${namesInWords(names)} again as ${one ? "a new place" : "new places"}. A persona, an owner rule or an automation still uses the old ${one ? "one" : "ones"}, so Nova kept ${one ? "it" : "them"}. You can move what uses ${one ? "it" : "them"} to the new ${one ? "place" : "places"}, then refresh again.`;
}

/** Every refused write to places CommCare HQ manages. */
export function organizationManagedRefusal(domain: string): string {
	return `This app's places are managed in CommCare HQ (${domain}), so Nova can't change them here. You can change them in CommCare HQ, then refresh Nova's copy in Organization.`;
}

/**
 * Places Nova's copy leaves out because they sit at a level code the app
 * doesn't have. `leftOut` is the count of places by code, as the state row
 * holds it; null where it is empty, and the line is left out. A place the
 * copy already held that a persona, an owner rule or an automation names is
 * kept as it stood before (`refreshManagedPlacesInTransaction`), which the
 * line says, since the state row does not tell which places those are.
 */
export function managedPlacesLeftOut(
	leftOut: Readonly<Record<string, number>>,
): string | null {
	const codes = Object.keys(leftOut);
	if (codes.length === 0) return null;
	const total = codes.reduce((sum, code) => sum + leftOut[code], 0);
	const one = total === 1;
	return `${count(total)} ${one ? "place" : "places"} in CommCare HQ ${one ? "sits" : "sit"} at a level this app doesn't have (${namesInWords(codes)}), so Nova's copy leaves ${one ? "it" : "them"} out. Where this app uses ${one ? "it, Nova keeps it" : "one of them, Nova keeps that place"} as it stood before. You can add ${codes.length === 1 ? "a level with that code" : "a level for each of those codes"}, then refresh.`;
}

/**
 * After a refresh, the places CommCare HQ now holds at a level the app
 * doesn't have that a persona, an owner rule or an automation still uses
 * (an `app_location_references` edge). The copy keeps each as it stood before
 * the refresh, at its old level.
 */
export function managedPlacesKeptLeftOut(names: readonly string[]): string {
	const one = names.length === 1;
	return `${count(names.length)} ${one ? "place" : "places"} in CommCare HQ ${one ? "sits" : "sit"} at a level this app doesn't have, and a persona, an owner rule or an automation still uses ${one ? "it" : "them"}: ${namesInWords(names)}. Nova kept ${one ? "it as it stood" : "them as they stood"} before. You can add ${one ? "that level" : "the levels they sit at"}, or move or change what uses ${one ? "it" : "them"}, then refresh again.`;
}

/** A refresh that changed the copy. */
export function managedPlacesRefreshed(
	added: number,
	changed: number,
	archived: number,
): string {
	return `Nova's copy now matches CommCare HQ: ${count(added)} added, ${count(changed)} changed, ${count(archived)} archived.`;
}

/** A refresh that changed nothing. */
export const MANAGED_PLACES_ALREADY_MATCH =
	"Nova's copy already matches CommCare HQ.";

/** A places refresh whose read a newer refresh overtook, so it wrote nothing. */
export const MANAGED_PLACES_REFRESHED_SINCE =
	"Nova's copy was refreshed again while this one was reading CommCare HQ, so it already holds the newer read.";

/**
 * What a refresh of places answered, as `lib/deployment/managedData.ts`'s
 * `ManagedPlacesOutcome` holds it, taken structurally.
 */
export type ManagedPlacesAnswer =
	| {
			readonly ok: true;
			readonly refresh: {
				readonly added: number;
				readonly changed: number;
				readonly archived: number;
				readonly keptInUse: readonly string[];
				readonly remade: readonly string[];
				readonly keptLeftOut: readonly string[];
				/** True where a later refresh had already landed, so this one changed nothing. */
				readonly superseded?: boolean;
			};
	  }
	| { readonly ok: false; readonly message: string };

/**
 * What is said after a refresh of places answered, on the Organization
 * banner and in MCP's answer: what changed, then the places gone from
 * CommCare HQ that Nova kept because a persona or an owner rule still uses
 * them, then the ones of those CommCare HQ made again as new places, then the places CommCare HQ holds at a level the app lacks that Nova
 * kept as they stood. The places left out for a level the app lacks are the
 * copy's standing fact (`managedPlacesLeftOut`), which the banner shows
 * from the organization's own read, not from this answer. A refusal says its own sentence, and the
 * copy is as it was.
 */
export function managedPlacesOutcomeLines(outcome: ManagedPlacesAnswer): {
	readonly tone: "status" | "alert";
	readonly lines: readonly string[];
} {
	if (!outcome.ok) return { tone: "alert", lines: [outcome.message] };
	const {
		added,
		changed,
		archived,
		keptInUse,
		remade,
		keptLeftOut,
		superseded,
	} = outcome.refresh;
	if (superseded) {
		return { tone: "status", lines: [MANAGED_PLACES_REFRESHED_SINCE] };
	}
	return {
		tone: "status",
		lines: [
			added === 0 && changed === 0 && archived === 0
				? MANAGED_PLACES_ALREADY_MATCH
				: managedPlacesRefreshed(added, changed, archived),
			...(keptInUse.length === 0 ? [] : [managedPlacesKeptInUse(keptInUse)]),
			...(remade.length === 0 ? [] : [managedPlacesRemade(remade)]),
			...(keptLeftOut.length === 0
				? []
				: [managedPlacesKeptLeftOut(keptLeftOut)]),
		],
	};
}

/**
 * A refresh whose project space lists more places than Nova reads from one,
 * by count or by the bytes of its place lists. `maxPlaces` is that count.
 * Retrying changes nothing, so the sentence offers the copy Nova kept.
 */
export function managedPlacesPastInventory(
	domain: string,
	maxPlaces: number,
): string {
	return `${domain} holds more places than Nova reads from one project space, which is up to ${count(maxPlaces)} places. Nova kept its copy as it was, and you can keep working with it.`;
}

/** A refresh CommCare HQ refused to answer the account. */
export function cannotReadManagedPlaces(domain: string): string {
	return `Nova couldn't read the organization in ${domain} with your CommCare HQ account. That project space needs Locations and API access on its plan, and your account needs the Edit Locations and Access APIs permissions.`;
}

/** A refresh that finds a place Nova can't hold. `name` is the first such finding's name. */
export function managedPlaceNotHoldable(name: string, domain: string): string {
	return `${name} in ${domain} has a code, a name or a value Nova can't hold yet. Nova kept its copy as it was.`;
}

/**
 * A refusal of an organization commit's integrity checks, where CommCare HQ
 * manages the places. The places of a removed level, a place a level change
 * leaves stranded and a value that no longer fits come quoted; the places and
 * levels of an owner rule's source come bare, and the sentence quotes them. `kept` marks a place
 * CommCare HQ no longer has, which the copy keeps live only because something
 * in the app uses it or a place below it: its step is to change what uses it.
 */
export type ManagedOrganizationCommitRefusal =
	/** Levels removed while places stand at them, by name. `kept`: every such place is kept. */
	| {
			readonly kind: "level-in-use";
			readonly levels: readonly string[];
			readonly kept?: boolean;
	  }
	/** A place left with no valid parent or level by a level change. */
	| {
			readonly kind: "placement";
			readonly place: string;
			readonly kept?: boolean;
	  }
	/** A property change a place's value doesn't fit. `issue` is `locationValueCatalogIssue`'s sentence. */
	| {
			readonly kind: "value";
			readonly place: string;
			readonly issue: string;
			readonly kept?: boolean;
	  }
	/** An owner rule's source place with no place at the rule's level below it. */
	| {
			readonly kind: "owner-none-below";
			readonly level: string;
			readonly source: string;
			readonly sourceKept: boolean;
	  }
	/** An owner rule's source place with two places at the rule's level below it. `kept` names one of the two where it is kept. */
	| {
			readonly kind: "owner-ambiguous";
			readonly level: string;
			readonly source: string;
			readonly places: readonly [string, string];
			readonly kept: string | null;
	  };

/**
 * An organization commit refused where CommCare HQ
 * manages the app's places, with the way forward through CommCare HQ, or,
 * for a place it no longer has, through what in the app uses it.
 */
export function managedOrganizationCommitRefusal(
	refusal: ManagedOrganizationCommitRefusal,
	domain: string,
): string {
	const keptOnlyWhileUsed = (it: "it" | "them") =>
		`Nova keeps ${it} only while something in this app uses ${it} or a place below ${it}`;
	switch (refusal.kind) {
		case "level-in-use": {
			const several = refusal.levels.length > 1;
			const level = several ? "the levels" : "the level";
			return refusal.kept === true
				? `${namesInWords(refusal.levels)} still ${several ? "have places in them" : "has places in it"} that CommCare HQ (${domain}) no longer has, and ${keptOnlyWhileUsed("them")}. You can move or change what uses them and refresh, then remove ${level}.`
				: `${namesInWords(refusal.levels)} still ${several ? "have places in them" : "has places in it"}, and this app's places are managed in CommCare HQ (${domain}). You can move those places to another level there and refresh, then remove ${level}.`;
		}
		case "placement":
			return refusal.kept === true
				? `${refusal.place} wouldn't fit where it stands after this level change. CommCare HQ (${domain}) no longer has it, and ${keptOnlyWhileUsed("it")}. You can move or change what uses it and refresh, then try the change again.`
				: `${refusal.place} wouldn't fit where it stands after this level change, and this app's places are managed in CommCare HQ (${domain}). You can move it there and refresh, then try the change again.`;
		case "value":
			return refusal.kept === true
				? `${refusal.place} blocks this change. ${refusal.issue} CommCare HQ (${domain}) no longer has it, and ${keptOnlyWhileUsed("it")}. You can move or change what uses it and refresh, then try the change again.`
				: `${refusal.place} blocks this change. ${refusal.issue} This app's places are managed in CommCare HQ (${domain}), so you can change that value there and refresh, then try the change again.`;
		case "owner-none-below": {
			const needs = `The owner rule for ${refusal.level} needs exactly one live ${refusal.level.toLowerCase()} below "${refusal.source}"`;
			return refusal.sourceKept
				? `${needs}, which CommCare HQ (${domain}) no longer has. ${keptOnlyWhileUsed("it")}. You can move or change what uses it and refresh, or change the rule.`
				: `${needs}, and this app's places are managed in CommCare HQ (${domain}), which has none there. You can add one there and refresh, or change the rule.`;
		}
		case "owner-ambiguous": {
			const [first, second] = refusal.places;
			const needs = `The owner rule for ${refusal.level} needs exactly one live ${refusal.level.toLowerCase()} below "${refusal.source}", and both "${first}" and "${second}" stand there`;
			return refusal.kept === null
				? `${needs}. This app's places are managed in CommCare HQ (${domain}), so you can archive one of them there and refresh, or change the rule.`
				: `${needs}. CommCare HQ (${domain}) no longer has "${refusal.kept}", and ${keptOnlyWhileUsed("it")}. You can move or change what uses it and refresh, or change the rule.`;
		}
	}
}

/**
 * A refresh refused because the copy it would write doesn't fit the app.
 * Place and level names are bare; the sentence quotes them. A place is
 * `kept` where CommCare HQ no longer lists it and the copy keeps it live
 * because something in the app uses it or a place below it.
 */
export type ManagedPlacesRefreshRefusal =
	/** A place CommCare HQ lists at a level or under a parent the app's levels refuse. */
	| { readonly kind: "placement"; readonly place: string }
	/** A place CommCare HQ lists with a value the place information refuses. `issue` is `locationValueCatalogIssue`'s sentence. */
	| { readonly kind: "value"; readonly place: string; readonly issue: string }
	/** A kept place that no longer fits where it stands. */
	| { readonly kind: "kept"; readonly place: string }
	/** An owner rule's source place with no place at the rule's level below it. */
	| {
			readonly kind: "owner-none-below";
			readonly level: string;
			readonly source: string;
			readonly sourceKept: boolean;
	  }
	/** An owner rule's source place with two places at the rule's level below it. `kept` names one of the two where it is kept. */
	| {
			readonly kind: "owner-ambiguous";
			readonly level: string;
			readonly source: string;
			readonly places: readonly [string, string];
			readonly kept: string | null;
	  }
	/** An owner rule that resolves to a place outside a persona's address book. */
	| {
			readonly kind: "owner-outside-address-book";
			readonly level: string;
			readonly place: string;
			readonly persona: string;
	  };

/**
 * A refresh of managed places refused because the rows it would
 * write don't fit the app, with a step that works where Nova can't change the
 * places.
 */
export function managedPlacesRefreshRefusal(
	refusal: ManagedPlacesRefreshRefusal,
	domain: string,
): string {
	const kept = "Nova kept its copy as it was.";
	const keptOnlyWhileUsed = `is gone from CommCare HQ (${domain}) and kept only while something in this app uses it or a place below it`;
	switch (refusal.kind) {
		case "placement":
			return `"${refusal.place}" stands in CommCare HQ (${domain}) at a level, or under a parent, that this app's levels don't allow. You can match the levels in Nova or move the place in CommCare HQ, then refresh. ${kept}`;
		case "value":
			return `"${refusal.place}" in CommCare HQ (${domain}) doesn't fit this app's place information. ${refusal.issue} You can change the value in CommCare HQ or the place information in Nova, then refresh. ${kept}`;
		case "kept":
			return `"${refusal.place}" ${keptOnlyWhileUsed}, and after this refresh it no longer fits this app's levels or place information. You can move or change what uses it, then refresh. ${kept}`;
		case "owner-none-below": {
			const needs = `The owner rule for ${refusal.level} needs exactly one live ${refusal.level.toLowerCase()} below "${refusal.source}"`;
			return refusal.sourceKept
				? `${needs}, which ${keptOnlyWhileUsed}. You can move or change what uses it, or change the rule in Nova, then refresh. ${kept}`
				: `${needs}, and CommCare HQ (${domain}) now has none there. You can add one there or change the rule in Nova, then refresh. ${kept}`;
		}
		case "owner-ambiguous": {
			const [first, second] = refusal.places;
			const needs = `The owner rule for ${refusal.level} needs exactly one live ${refusal.level.toLowerCase()} below "${refusal.source}"`;
			return refusal.kept === null
				? `${needs}, and CommCare HQ (${domain}) now has two there: "${first}" and "${second}". You can archive one of them there or change the rule in Nova, then refresh. ${kept}`
				: `${needs}, and after this refresh "${first}" and "${second}" would both stand there. "${refusal.kept}" ${keptOnlyWhileUsed}. You can move or change what uses it, or change the rule in Nova, then refresh. ${kept}`;
		}
		case "owner-outside-address-book":
			return `The ${refusal.level} owner rule can resolve to "${refusal.place}", but after this refresh that place is outside ${refusal.persona}'s address book. You can widen the address book or change the rule in Nova, then refresh. ${kept}`;
	}
}

/** In place of Refresh, without a CommCare HQ connection on that server. */
export const CONNECT_TO_REFRESH_PLACES =
	"Connect CommCare HQ to refresh these places";

// ---------------------------------------------------------------------------
// Publish
// ---------------------------------------------------------------------------

/**
 * The `managed-data` check, passed. `here` counts the tables the app
 * reads that `domain`, the project space this publish writes to, manages;
 * `elsewhere` those another project space manages, which this publish puts
 * in `domain` from Nova's copy. So the sentence says Nova sends none of them
 * only of the tables `domain` manages.
 */
export function managedDataPassed(input: {
	readonly domain: string;
	readonly here: number;
	readonly elsewhere: number;
}): string {
	const { domain, here, elsewhere } = input;
	if (elsewhere === 0) {
		return "Nova checked the lookup tables CommCare HQ manages for this app. Nothing this app reads is missing, and Nova sends none of them.";
	}
	if (here > 0) {
		return `Nova checked the lookup tables CommCare HQ manages for this app. Nothing this app reads is missing in ${domain}, and Nova sends none of the tables ${domain} manages.`;
	}
	return elsewhere === 1
		? `Nova checked the lookup table CommCare HQ manages for this app. Another project space manages it, so this publish puts Nova's copy in ${domain}.`
		: `Nova checked the lookup tables CommCare HQ manages for this app. Other project spaces manage them, so this publish puts Nova's copy of each in ${domain}.`;
}

/** `hq_managed_data_changed`, before one item per change. */
export const MANAGED_DATA_CHANGED =
	"A lookup table this app reads changed in CommCare HQ in a way the app depends on, so Nova stopped before sending anything.";

/** The managed tables unreadable for the key or the account. */
export function managedDataUnreadablePermission(domain: string): string {
	return `Nova can't read the lookup tables ${domain} manages for this app, so it can't tell whether they still hold what the app reads, and it stopped before sending anything. Reading them needs API access on that project space, and the Edit Apps and Access APIs permissions on your CommCare HQ account.`;
}

/** The managed tables unreadable for any other reason. */
export function managedDataUnreadable(domain: string): string {
	return `Nova couldn't ask ${domain} about the lookup tables it manages for this app, so it stopped before sending anything. You can try publishing again in a moment.`;
}

/** One table's rows unreadable while CommCare HQ was unavailable. */
export function managedTableRowsUnreadable(
	name: string,
	domain: string,
): string {
	return `Nova couldn't read the rows of the lookup table ${name} in ${domain}, so it stopped before sending anything. A row there with an empty value can cause this. Filling that value in CommCare HQ, or trying again in a moment, lets the next publish read it.`;
}

/** An item, a column the app reads gone. `uses` is how many places of the app read it. */
export function managedColumnGoneItem(
	column: string,
	tag: string,
	uses: number,
): string {
	return `The column ${column} is gone from ${tag} in CommCare HQ, and this app reads it in ${count(uses)} ${uses === 1 ? "place" : "places"}. You can put it back in CommCare HQ, or choose Manage in Nova on the table's page and publish Nova's columns.`;
}

/** An item, the table gone. */
export function managedTableGoneItem(tag: string): string {
	return `CommCare HQ no longer has the lookup table ${tag}. You can make it again in CommCare HQ, or choose Manage in Nova on the table's page and publish Nova's copy.`;
}

/** An item, content Nova can't hold. `holds` is `describeUnsupportedLookupContent`'s phrase. */
export function managedTableUnsupportedItem(
	tag: string,
	holds: string,
): string {
	return `${tag} now holds ${holds} in CommCare HQ, which Nova can't hold yet. You can take those out in CommCare HQ, then publish again.`;
}

/** An item, a field with more than one value. */
export function managedTableManyValuesItem(tag: string): string {
	return `${tag} now has a field with more than one value in CommCare HQ, which Nova can't hold yet. You can give each field one value there, then publish again.`;
}

/** An item, over a cap. `phrases` are the caps' phrases without the tag, joined with " and ". */
export function managedTableOverCapItem(
	tag: string,
	phrases: readonly string[],
): string {
	return `${tag} now has ${phrases.join(" and ")} in CommCare HQ. You can shorten it there, then publish again.`;
}

/** An item, a table that holds no column. */
export function managedTableNoColumnsItem(tag: string): string {
	return `${tag} now has no columns in CommCare HQ, and Nova holds a lookup table only with at least one. You can add a column there, then publish again.`;
}

/** An item, a field name Nova can't hold. */
export function managedTableNameItem(tag: string, name: string): string {
	return `${tag} now has a column named ${name} in CommCare HQ, which Nova can't hold yet. You can rename it there, then publish again.`;
}

/** A passed check's item, a copy of another project space's table. `date` is spelled by the caller. */
export function managedTableFromElsewhereItem(
	tag: string,
	originDomain: string,
	date: string,
	domain: string,
): string {
	return `Nova's copy of ${tag} was last refreshed from ${originDomain} on ${date}. This publish puts that copy in ${domain}.`;
}

/** A passed check's item, a copy of another project space's table that Nova read just now. */
export function managedTableFromElsewhereCurrentItem(
	tag: string,
	originDomain: string,
	domain: string,
): string {
	return `Nova's copy of ${tag} matches ${originDomain} as it is now. This publish puts that copy in ${domain}.`;
}

/** The `project-data` check, passed, with tables left out of the workbook. */
export function managedTablesLeftOut(
	tags: readonly string[],
	domain: string,
): string {
	return tags.length === 1
		? `CommCare HQ manages ${tags[0]} in ${domain}, so Nova leaves it as it is.`
		: `CommCare HQ manages ${namesInWords(tags)} in ${domain}, so Nova leaves them as they are.`;
}

/** The last sentence of a drift item on a table Nova manages that came from CommCare HQ. */
export const HAND_BACK_OFFERED =
	"You can also choose Let CommCare HQ manage it again on the table's page to take CommCare HQ's version.";

/**
 * The `organization` check, passed, with managed places. `refreshed`
 * says whether the publish's read refreshed Nova's copy; where it could not,
 * the check's one item is the refresh's own refusal.
 */
export function managedPlacesPassed(
	domain: string,
	refreshed: boolean,
): string {
	return refreshed
		? `${domain} manages this app's places. Nova refreshed its copy and sends none.`
		: `${domain} manages this app's places, and Nova sends none.`;
}

/** An item, a character CommCare can't carry. */
export function managedTableUnrepresentableItem(
	column: string,
	tag: string,
): string {
	return `The column ${column} of ${tag} now holds a character CommCare can't carry in a value. You can take it out in CommCare HQ, then publish again.`;
}

/** `managed_table_handed_back`. */
export const MANAGED_TABLE_HANDED_BACK =
	"A lookup table this app reads was handed back to CommCare HQ while Nova was publishing, so nothing was sent. You can publish again, and Nova will leave that table as it is.";

/** `managed_table_handed_back` on a first publish, which has made the empty app by the time it stops. */
export const MANAGED_TABLE_HANDED_BACK_AFTER_CREATE =
	"A lookup table this app reads was handed back to CommCare HQ while Nova was publishing, so Nova stopped before sending the tables or the app's content. Nova created the app there, and it is empty for now. You can publish again, and Nova will fill that app and leave that table as it is.";

// ---------------------------------------------------------------------------
// The HQ app file's guide
// ---------------------------------------------------------------------------

/** The title of the guide's step for the tables CommCare HQ manages, where one project space manages them all. */
export const MANAGED_LOOKUP_GUIDE_TITLE =
	"Lookup tables managed in CommCare HQ";

/**
 * One workbook of the HQ app file's tables CommCare HQ manages, as the guide
 * names it: its file, the project space that manages its tables, and each
 * table with the UTC day Nova's copy was last refreshed (`refreshedOn`).
 */
export interface ManagedLookupGuideFile {
	readonly fileName: string;
	/** The project space by its domain, with its server where two files share one domain. */
	readonly projectSpace: string;
	readonly tables: readonly {
		readonly tag: string;
		readonly refreshedOn: string;
	}[];
}

/**
 * The title of one workbook's step. Where several project spaces manage
 * the app's tables, each step names its own, since each file is left out of
 * a different import.
 */
export function managedLookupGuideTitle(
	file: ManagedLookupGuideFile,
	several: boolean,
): string {
	return several
		? `Lookup tables managed in ${file.projectSpace}`
		: MANAGED_LOOKUP_GUIDE_TITLE;
}

/**
 * The guide's lines for one workbook of tables CommCare HQ manages.
 * `several` says whether other project spaces manage tables of their own in
 * files of their own; then the lines name this file's project space, since a
 * person importing into it leaves this file out and uploads the others.
 * Where no step above says how to upload a lookup table file
 * (`afterUploadStep` false), the last paragraph says how.
 */
export function managedLookupGuideLines(
	file: ManagedLookupGuideFile,
	options: { readonly several: boolean; readonly afterUploadStep: boolean },
): readonly string[] {
	const { fileName, projectSpace, tables } = file;
	return [
		...(options.several
			? [
					`These tables are managed in ${projectSpace} on CommCare HQ, and Nova only keeps a copy:`,
					...tables.map(
						(table) => `  ${table.tag} (copied on ${table.refreshedOn})`,
					),
					"",
					`If you're importing into ${projectSpace}, it already has them, so leave`,
				]
			: [
					"These tables are managed in CommCare HQ, and Nova only keeps a copy:",
					...tables.map(
						(table) =>
							`  ${table.tag} (in ${projectSpace}, copied on ${table.refreshedOn})`,
					),
					"",
					"If you're importing into that project space, it already has them, so leave",
				]),
		`"${fileName}" out. Uploading it there would`,
		"replace their rows with Nova's copy.",
		"",
		...(options.afterUploadStep
			? [
					"For any other project space, upload it on the Lookup Tables page too, the",
					"same way as the file above.",
				]
			: [
					"For any other project space, open the Lookup Tables page in CommCare HQ:",
					"  https://www.commcarehq.org/a/<your-project>/fixtures/",
					"",
					`Upload "${fileName}" there, tick "Replace existing`,
					'tables", and click Upload Tables.',
				]),
	];
}

// ---------------------------------------------------------------------------
// The review
// ---------------------------------------------------------------------------

/** The tables managed in CommCare HQ. */
export function reviewManagedTables(
	tags: readonly string[],
	domain: string,
): string {
	return `Lookup tables managed in CommCare HQ: ${namesInWords(tags)}. Nova copies them so Preview can read them, and never changes them in ${domain}.`;
}

/** A table already in the Project, equal and published there by the Project's other apps. */
export function reviewSameEqualTable(
	tag: string,
	project: string,
	domain: string,
): string {
	return `${tag} is already in ${project} with the same columns and rows, so this app will use that table. Your other apps publish it to ${domain} already, so nothing changes there.`;
}

/** Media references that point at no file and that no worker sees. */
export function reviewMediaLeftOut(references: number): string {
	const one = references === 1;
	return `${count(references)} media ${one ? "reference points" : "references point"} at no file, and no worker sees anything for ${one ? "it" : "them"}. Nova leaves ${one ? "it" : "them"} out.`;
}

/** The files the bring-in adds to the Project. */
export function reviewMediaAdded(files: number, project: string): string {
	return files === 1
		? `1 picture, sound or video, added to ${project}'s files.`
		: `${count(files)} pictures, sounds and videos, added to ${project}'s files.`;
}

/** The places managed in CommCare HQ. */
export function reviewManagedPlaces(places: number, domain: string): string {
	const one = places === 1;
	return `${count(places)} ${one ? "place" : "places"} from ${domain}, managed in CommCare HQ. Nova copies ${one ? "it" : "them"} so Preview can show ${one ? "it" : "them"}, and never changes ${one ? "it" : "them"} there. CommCare HQ doesn't tell Nova which levels hold workers or how far a worker's phone reaches, so Nova assumed its defaults. You can change them in Organization.`;
}

/** Why an answer to a table's choice is not offered. */
export type LookupChoiceRefusal =
	| "needs-source-evidence"
	| "needs-admin"
	| "managed-elsewhere"
	| "app-reads-a-missing-column"
	| "fails-a-project-space-rule"
	| "too-many-columns";

/** An answer's offer, as a review table's choice carries it. */
export type ReviewChoiceOffer =
	| { readonly offered: true }
	| {
			readonly offered: false;
			readonly why: LookupChoiceRefusal;
			/** The other project space, the first missing column, or the count of columns the
			 *  table would hold; null for the other two. */
			readonly name: string | null;
	  };

/** A review table's choice, as the sentences about it read it. */
export interface ReviewChoice {
	readonly differs: readonly ("columns" | "rows")[];
	readonly apps: readonly NamedApp[];
	readonly options: Readonly<
		Record<"use-commcare-hq" | "use-project", ReviewChoiceOffer>
	>;
}

/** The choice's title. */
export function reviewChoiceTitle(
	tag: string,
	project: string,
	choice: Pick<ReviewChoice, "differs">,
): string {
	return choice.differs.length > 0
		? `${tag} is already in ${project}, and it's different`
		: `${tag} is already in ${project}`;
}

/**
 * The choice's body. Its form is read from the choice alone: tables that
 * differ take the first; equal tables whose `use-commcare-hq` is refused as
 * `managed-elsewhere` the third, naming that project space; others the
 * second, without its last sentence where `use-project` is refused as
 * `fails-a-project-space-rule`. Where no app reads the Project's table, the
 * clause naming the apps is dropped.
 */
export function reviewChoiceBody(
	tag: string,
	project: string,
	domain: string,
	choice: ReviewChoice,
): string {
	const offer = choice.options["use-project"];
	if (!offer.offered && offer.why === "needs-source-evidence")
		return `This app reads ${tag} from ${domain}. ${project} already has a table by that name. Nova needs current access to the rows and their assignments to compare the two. You can choose another Project or update the source connection.`;
	const lead = `This app reads the lookup table ${tag} from ${domain}. ${project} already has a table by that name with`;
	const readBy =
		choice.apps.length > 0 ? ` read by ${appsInWords(choice.apps)}` : "";
	if (choice.differs.length > 0)
		return `${lead} ${differsInWords(choice.differs)}${readBy === "" ? "" : `,${readBy}`}.`;
	const fromHq = choice.options["use-commcare-hq"];
	if (!fromHq.offered && fromHq.why === "managed-elsewhere")
		return `${lead} the same columns and rows, managed in CommCare HQ from ${offerName(fromHq)}${readBy === "" ? "" : ` and${readBy}`}.`;
	const own = choice.options["use-project"];
	const open =
		own.offered || own.why !== "fails-a-project-space-rule"
			? ` No app of ${project} publishes it to ${domain} yet, so it's yours to say which one this app uses.`
			: "";
	return `${lead} the same columns and rows, managed in Nova${readBy === "" ? "" : ` and${readBy}`}.${open}`;
}

/** The choice's first answer. */
export const HQ_TABLE_ANSWER = "Use CommCare HQ's table";

/** The line under the first answer. `apps` read the Project's table; with none, their sentence is dropped. */
export function hqTableAnswerConsequence(
	project: string,
	tag: string,
	apps: readonly NamedApp[],
): string {
	const lead = `${project}'s ${tag} takes CommCare HQ's columns and rows and becomes managed in CommCare HQ.`;
	return apps.length === 0
		? `${lead} Nova keeps it read-only until someone chooses Manage in Nova.`
		: `${lead} ${appsInWords(apps)} will read CommCare HQ's rows from then on, and Nova keeps it read-only until someone chooses Manage in Nova.`;
}

/**
 * The first answer's line for the columns the apps read that CommCare HQ's table lacks;
 * null where there are none, and the line is left out.
 */
export function hqTableAnswerGoneColumns(
	apps: readonly NamedApp[],
	columns: readonly string[],
): string | null {
	if (columns.length === 0) return null;
	if (apps.length === 0)
		throw new Error(
			`The columns ${namesInWords(columns)} are named because apps of the Project read them, and no app was given. Pass the choice's apps, which read the Project's table.`,
		);
	const readers = `${appsInWords(apps)} ${apps.length === 1 ? "reads" : "read"}`;
	return columns.length === 1
		? `${readers} the column ${columns[0]}, which CommCare HQ's table doesn't have. It stays, with no values.`
		: `${readers} the columns ${namesInWords(columns)}, which CommCare HQ's table doesn't have. They stay, with no values.`;
}

/** The choice's second answer. */
export function projectTableAnswer(project: string): string {
	return `Use ${project}'s table`;
}

/** The line under the second answer. */
export function projectTableAnswerConsequence(
	project: string,
	domain: string,
): string {
	return `This app reads ${project}'s rows in Preview. The table in ${domain} stays as it is until someone publishes, and that publish asks before replacing it.`;
}

function offerName(offer: {
	readonly why: LookupChoiceRefusal;
	readonly name: string | null;
}): string {
	if (offer.name === null)
		throw new Error(
			`An answer refused as "${offer.why}" names what it is about (the other project space, the missing column, or the count of columns), and this one names nothing. The review's offer carries that name as \`name\`.`,
		);
	return offer.name;
}

/** Why an answer is not offered. */
export function choiceNotOffered(
	offer: Extract<ReviewChoiceOffer, { offered: false }>,
	project: string,
): string {
	switch (offer.why) {
		case "needs-source-evidence":
			return "This table needs verified source inventory and worker access before it can replace a Project table.";
		case "needs-admin":
			return `An admin of ${project} can choose this.`;
		case "managed-elsewhere":
			return `${project}'s table is managed in CommCare HQ (${offerName(offer)}), so it can't follow two project spaces.`;
		case "app-reads-a-missing-column":
			return `This app reads the column ${offerName(offer)}, which ${project}'s table doesn't have.`;
		case "fails-a-project-space-rule":
			return `${project}'s table, as it stands, holds something this app couldn't be published or exported with, so this app can't use it.`;
		case "too-many-columns":
			return `${project}'s table would have ${offerName(offer)} columns with the ones its apps still read, and Nova takes 250.`;
	}
}

/** Beside the choice, always. */
export const CHOICE_OTHER_PROJECT =
	"Or go back and add this app to another Project.";

/** An account answered before the files are judged. */
export const MEDIA_CHECKED_LATER =
	"Nova checks pictures and sounds once everything else can come in.";
