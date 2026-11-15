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

/** T1: the badge beside a table CommCare HQ manages. */
export const MANAGED_TABLE_BADGE = "Managed in CommCare HQ";

/** T2: the banner's first line. */
export function managedTableBanner(domain: string): string {
	return `This table lives in ${domain} on CommCare HQ. Nova keeps a copy so your apps and Preview can read it, and never changes it there.`;
}

/** T3: the banner's second line. `date` is the day of the last refresh, spelled by the caller. */
export function managedTableBannerRefreshed(date: string): string {
	return `You can change it on CommCare HQ's Lookup Tables page, then refresh. Nova's copy was refreshed on ${date}.`;
}

/** The banner's three actions on a table CommCare HQ manages. */
export const REFRESH_FROM_HQ = "Refresh from CommCare HQ";
export const OPEN_IN_HQ = "Open in CommCare HQ";
export const MANAGE_IN_NOVA = "Manage in Nova";

/** T4: in place of Refresh and the hand-back, without a CommCare HQ connection on that server. */
export const CONNECT_TO_REFRESH_TABLE =
	"Connect CommCare HQ to refresh this table";

/** T5: a refresh that finds the table gone. */
export function managedTableGone(tag: string, domain: string): string {
	return `CommCare HQ no longer has a lookup table named ${tag} in ${domain}. Nova kept its copy as it was. You can make the table again in CommCare HQ, or choose Manage in Nova to publish this copy there.`;
}

/** T6's and P8's `{holds}` for a field with more than one value. */
export const HOLDS_MORE_THAN_ONE_VALUE = "a field with more than one value";

/** T6's `{holds}` for a field name Nova can't hold. */
export function holdsColumnNamed(name: string): string {
	return `a column named ${name}`;
}

/**
 * T6: a refresh that finds what Nova can't hold. `holds` is
 * `describeUnsupportedLookupContent`'s phrase, `HOLDS_MORE_THAN_ONE_VALUE`
 * or `holdsColumnNamed`'s.
 */
export function managedTableUnsupported(holds: string): string {
	return `This table now holds ${holds} in CommCare HQ, which Nova can't hold yet. Nova kept its copy as it was.`;
}

/** T7: a refresh over a cap. `phrases` are the caps' phrases without the tag, joined with " and ". */
export function managedTableOverCap(phrases: readonly string[]): string {
	return `This table now has ${phrases.join(" and ")} in CommCare HQ. Nova kept its copy as it was.`;
}

/** T8: every refused write to a lookup table CommCare HQ manages. */
export function managedLookupTableRefusal(
	name: string,
	domain: string,
): string {
	return `The lookup table ${name} is managed in CommCare HQ (${domain}), so Nova can't change it here. You can change it in CommCare HQ and refresh Nova's copy, or choose Manage in Nova on the table's page.`;
}

/**
 * The line naming the apps that read a table, in the two confirmations
 * (T9, T11); null where no app reads it, and the line is left out.
 */
export function appsThatReadIt(apps: readonly NamedApp[]): string | null {
	if (apps.length === 0) return null;
	return apps.length === 1
		? `One app reads it: ${appsInWords(apps)}.`
		: `These apps read it: ${appsInWords(apps)}.`;
}

/** T9: Manage in Nova's confirmation, its title. */
export function manageInNovaTitle(name: string): string {
	return `Manage ${name} in Nova?`;
}

/**
 * T9's body before the facts a push clears. The dialog follows these with
 * `LOOKUP_DISCARD_NOTE` (`lib/deployment/remoteChanges.ts`), unchanged, and
 * then `appsThatReadIt`.
 */
export function manageInNovaBody(domain: string): readonly string[] {
	return [
		`From now on you change this table in Nova, and each publish to ${domain} replaces the table there with Nova's columns and rows.`,
		"If someone changes it in CommCare HQ after this, your next publish there stops and shows you what changed before it sends anything.",
	];
}

/** T9's two buttons. */
export const MANAGE_IN_NOVA_CONFIRM = MANAGE_IN_NOVA;
export const KEEP_IN_HQ = "Keep it in CommCare HQ";

/** T10: the banner on a table Nova manages that came from CommCare HQ. */
export function managedInNovaBanner(domain: string): string {
	return `Nova manages this table. It came from ${domain} on CommCare HQ, and publishing there replaces that table with Nova's.`;
}

/** T10's button. */
export const LET_HQ_MANAGE_AGAIN = "Let CommCare HQ manage it again";

/** T11: the hand-back's confirmation, its title. */
export function letHqManageTitle(name: string): string {
	return `Let CommCare HQ manage ${name} again?`;
}

/** T11's first line. */
export function letHqManageBody(domain: string): string {
	return `Nova takes CommCare HQ's columns and rows as they are in ${domain} right now, and stops changing the table there. Changes made in Nova that were never published there are replaced.`;
}

/**
 * The line for columns that become text (T11, and R8's under its answer):
 * `columns` are their labels; null where there are none, and the line is left
 * out.
 */
export function columnsBecomeText(columns: readonly string[]): string | null {
	if (columns.length === 0) return null;
	return `Every column becomes text, as CommCare HQ holds it. ${namesInWords(columns)} held numbers or dates in Nova, so apps that compare them will compare text.`;
}

/** T11's two buttons. */
export const LET_HQ_MANAGE_CONFIRM = "Let CommCare HQ manage it";
export const KEEP_MANAGING_IN_NOVA = "Keep managing it in Nova";

/** T12: the header badge of a column CommCare HQ's table no longer has. */
export const COLUMN_GONE_IN_HQ = "Gone in CommCare HQ";

/** T13: a refresh that changed nothing. */
export const MANAGED_TABLE_ALREADY_MATCHES =
	"Nova's copy already matches CommCare HQ.";
/** T14: a refresh that took new rows. */
export const MANAGED_TABLE_REFRESHED_ROWS =
	"Nova's copy now has CommCare HQ's rows.";
/** T15: a refresh that took new columns and rows. */
export const MANAGED_TABLE_REFRESHED_COLUMNS =
	"Nova's copy now has CommCare HQ's columns and rows.";

/** T16: a refresh that kept a column CommCare HQ's table no longer has, because apps read it. */
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

/** T17: a refresh CommCare HQ refused to answer the account. */
export function cannotReadManagedTables(domain: string): string {
	return `Nova couldn't read lookup tables in ${domain} with your CommCare HQ account. It needs API access on that project space, and the Edit Apps and Access APIs permissions on your account.`;
}

/** T18: any other failed read, of a table or of places. */
export const HQ_UNAVAILABLE =
	"CommCare HQ didn't answer just now. You can try again in a moment.";

/** T19: Manage in Nova or the hand-back, for a member who isn't an admin. */
export const MANAGEMENT_NEEDS_ADMIN =
	"An admin of this Project can choose this.";
/** T19: a refresh of a table or of places, for a member who can't edit. */
export const REFRESH_NEEDS_EDITOR =
	"An editor of this Project can refresh this copy.";

/** T20: a refresh that met a table someone had just taken over. */
export const TABLE_TAKEN_OVER_MEANWHILE =
	"Someone chose Manage in Nova for this table a moment ago, so there was nothing to refresh.";

/** T21: a refresh that finds a character CommCare can't carry. */
export function managedTableUnrepresentable(column: string): string {
	return `The column ${column} now holds a character CommCare can't carry in a value. Nova kept its copy as it was. You can take that character out in CommCare HQ, then refresh.`;
}

// ---------------------------------------------------------------------------
// Organization
// ---------------------------------------------------------------------------

/** O1: the banner's label. */
export const MANAGED_PLACES_LABEL = "Places managed in CommCare HQ";

/** O2: the banner. `date` is the day of the last refresh, spelled by the caller. */
export function managedPlacesBanner(domain: string, date: string): string {
	return `These places live in ${domain} on CommCare HQ. Nova keeps a copy so Preview can show them, and never changes them there. You can add or change places in CommCare HQ, then refresh. Nova's copy was refreshed on ${date}.`;
}

/** O3: above the levels, while places are managed. */
export function managedPlacesLevelsNote(domain: string): string {
	return `CommCare HQ doesn't tell Nova which levels hold workers or how far a worker's phone carries places. Nova assumed every level holds workers and each worker carries their own branch. If ${domain} is set up differently, you can match it here so Preview shows what workers see.`;
}

/** O4: under personas, where the app has managed places and no persona. */
export const MANAGED_PLACES_NO_PERSONA =
	"Preview shows a worker's places through a persona. You can add a persona and stand them in a place to see this app's place lists.";

/** O5: the banner's small line. */
export const MANAGED_PLACES_NO_EXTERNAL_IDS =
	"CommCare HQ doesn't send external IDs for places, so Nova's copy has none.";

/** O6: after a refresh, the places gone from CommCare HQ that a persona or an owner rule still uses. */
export function managedPlacesKeptInUse(names: readonly string[]): string {
	const one = names.length === 1;
	return `${count(names.length)} ${one ? "place is" : "places are"} gone from CommCare HQ, and a persona or an owner rule still uses ${one ? "it" : "them"}: ${namesInWords(names)}. Nova kept ${one ? "it" : "them"}. You can move those personas or rules, then refresh again.`;
}

/** O7: every refused write to places CommCare HQ manages. */
export function organizationManagedRefusal(domain: string): string {
	return `This app's places are managed in CommCare HQ (${domain}), so Nova can't change them here. You can change them in CommCare HQ, then refresh Nova's copy in Organization.`;
}

/**
 * O8: places Nova's copy leaves out because they sit at a level code the app
 * doesn't have. `leftOut` is the count of places by code, as the state row
 * holds it; null where it is empty, and the line is left out.
 */
export function managedPlacesLeftOut(
	leftOut: Readonly<Record<string, number>>,
): string | null {
	const codes = Object.keys(leftOut);
	if (codes.length === 0) return null;
	const total = codes.reduce((sum, code) => sum + leftOut[code], 0);
	const one = total === 1;
	return `${count(total)} ${one ? "place" : "places"} in CommCare HQ ${one ? "sits" : "sit"} at a level this app doesn't have (${namesInWords(codes)}), so Nova's copy leaves ${one ? "it" : "them"} out. You can add ${codes.length === 1 ? "a level with that code" : "a level for each of those codes"}, then refresh.`;
}

/** O9: a refresh that changed the copy. */
export function managedPlacesRefreshed(
	added: number,
	changed: number,
	archived: number,
): string {
	return `Nova's copy now matches CommCare HQ: ${count(added)} added, ${count(changed)} changed, ${count(archived)} archived.`;
}

/** O10: a refresh that changed nothing. */
export const MANAGED_PLACES_ALREADY_MATCH =
	"Nova's copy already matches CommCare HQ.";

/**
 * O11: a refresh that finds more places than Nova holds for an app. `total`
 * is CommCare HQ's count, null where its list named none and the read
 * stopped once it passed Nova's limit.
 */
export function managedPlacesOverLimit(
	domain: string,
	total: number | null,
): string {
	return `${domain} now has ${total === null ? "more than 10,000" : count(total)} places, and Nova holds up to 10,000 for an app. Nova kept its copy as it was.`;
}

/** O12: a refresh CommCare HQ refused to answer the account. */
export function cannotReadManagedPlaces(domain: string): string {
	return `Nova couldn't read the organization in ${domain} with your CommCare HQ account. That project space needs Locations and API access on its plan, and your account needs the Edit Locations and Access APIs permissions.`;
}

/** O13: a refresh that finds a place Nova can't hold. `name` is the first such finding's name. */
export function managedPlaceNotHoldable(name: string, domain: string): string {
	return `${name} in ${domain} has a code, a name or a value Nova can't hold yet. Nova kept its copy as it was.`;
}

/** A refusal of an organization commit's integrity checks, where CommCare HQ manages the places. */
export type ManagedOrganizationCommitRefusal =
	/** O14: levels removed while places stand at them, by name. */
	| { readonly kind: "level-in-use"; readonly levels: readonly string[] }
	/** O15: a place left with no valid parent or level by a level change. */
	| { readonly kind: "placement"; readonly place: string }
	/** O16: a property change a place's value doesn't fit. `issue` is `locationValueCatalogIssue`'s sentence. */
	| { readonly kind: "value"; readonly place: string; readonly issue: string };

/**
 * O14 to O16: an organization commit refused where CommCare HQ manages the
 * app's places, with the way forward through CommCare HQ.
 */
export function managedOrganizationCommitRefusal(
	refusal: ManagedOrganizationCommitRefusal,
	domain: string,
): string {
	switch (refusal.kind) {
		case "level-in-use": {
			const several = refusal.levels.length > 1;
			return `${namesInWords(refusal.levels)} still ${several ? "have places in them" : "has places in it"}, and this app's places are managed in CommCare HQ (${domain}). You can move those places to another level there and refresh, then remove ${several ? "the levels" : "the level"}.`;
		}
		case "placement":
			return `${refusal.place} wouldn't fit where it stands after this level change, and this app's places are managed in CommCare HQ (${domain}). You can move it there and refresh, then try the change again.`;
		case "value":
			return `${refusal.place} blocks this change. ${refusal.issue} This app's places are managed in CommCare HQ (${domain}), so you can change that value there and refresh, then try the change again.`;
	}
}

/** O17: in place of Refresh, without a CommCare HQ connection on that server. */
export const CONNECT_TO_REFRESH_PLACES =
	"Connect CommCare HQ to refresh these places";

// ---------------------------------------------------------------------------
// Publish
// ---------------------------------------------------------------------------

/** P1: the `managed-data` check, passed. */
export const MANAGED_DATA_PASSED =
	"Nova checked the lookup tables CommCare HQ manages for this app. Nothing this app reads is missing, and Nova sends none of them.";

/** P2: `hq_managed_data_changed`, before one item per change. */
export const MANAGED_DATA_CHANGED =
	"A lookup table this app reads changed in CommCare HQ in a way the app depends on, so Nova stopped before sending anything.";

/** P3: the managed tables unreadable for the key or the account. */
export function managedDataUnreadablePermission(domain: string): string {
	return `Nova can't read the lookup tables ${domain} manages for this app, so it can't tell whether they still hold what the app reads, and it stopped before sending anything. Reading them needs API access on that project space, and the Edit Apps and Access APIs permissions on your CommCare HQ account.`;
}

/** P4: the managed tables unreadable for any other reason. */
export function managedDataUnreadable(domain: string): string {
	return `Nova couldn't ask ${domain} about the lookup tables it manages for this app, so it stopped before sending anything. You can try publishing again in a moment.`;
}

/** P5: one table's rows unreadable while CommCare HQ was unavailable. */
export function managedTableRowsUnreadable(
	name: string,
	domain: string,
): string {
	return `Nova couldn't read the rows of the lookup table ${name} in ${domain}, so it stopped before sending anything. A row there with an empty value can cause this. Filling that value in CommCare HQ, or trying again in a moment, lets the next publish read it.`;
}

/** P6: an item, a column the app reads gone. `uses` is how many places of the app read it. */
export function managedColumnGoneItem(
	column: string,
	tag: string,
	uses: number,
): string {
	return `The column ${column} is gone from ${tag} in CommCare HQ, and this app reads it in ${count(uses)} ${uses === 1 ? "place" : "places"}. You can put it back in CommCare HQ, or choose Manage in Nova on the table's page and publish Nova's columns.`;
}

/** P7: an item, the table gone. */
export function managedTableGoneItem(tag: string): string {
	return `CommCare HQ no longer has the lookup table ${tag}. You can make it again in CommCare HQ, or choose Manage in Nova on the table's page and publish Nova's copy.`;
}

/** P8: an item, content Nova can't hold. `holds` is `describeUnsupportedLookupContent`'s phrase. */
export function managedTableUnsupportedItem(
	tag: string,
	holds: string,
): string {
	return `${tag} now holds ${holds} in CommCare HQ, which Nova can't hold yet. You can take those out in CommCare HQ, then publish again.`;
}

/** P9: an item, a field with more than one value. */
export function managedTableManyValuesItem(tag: string): string {
	return `${tag} now has a field with more than one value in CommCare HQ, which Nova can't hold yet. You can give each field one value there, then publish again.`;
}

/** P10: an item, over a cap. `phrases` are the caps' phrases without the tag, joined with " and ". */
export function managedTableOverCapItem(
	tag: string,
	phrases: readonly string[],
): string {
	return `${tag} now has ${phrases.join(" and ")} in CommCare HQ. You can shorten it there, then publish again.`;
}

/** P11: an item, a field name Nova can't hold. */
export function managedTableNameItem(tag: string, name: string): string {
	return `${tag} now has a column named ${name} in CommCare HQ, which Nova can't hold yet. You can rename it there, then publish again.`;
}

/** P12: a passed check's item, a copy of another project space's table. `date` is spelled by the caller. */
export function managedTableFromElsewhereItem(
	tag: string,
	originDomain: string,
	date: string,
	domain: string,
): string {
	return `Nova's copy of ${tag} was last refreshed from ${originDomain} on ${date}. This publish puts that copy in ${domain}.`;
}

/** P13: the `project-data` check, passed, with tables left out of the workbook. */
export function managedTablesLeftOut(
	tags: readonly string[],
	domain: string,
): string {
	return `CommCare HQ manages ${namesInWords(tags)} in ${domain}, so Nova leaves them as they are.`;
}

/** P14: the last sentence of a drift item on a table Nova manages that came from CommCare HQ. */
export const HAND_BACK_OFFERED =
	"You can also choose Let CommCare HQ manage it again on the table's page to take CommCare HQ's version.";

/** P15: the `organization` check, passed, with managed places. */
export function managedPlacesPassed(domain: string): string {
	return `${domain} manages this app's places. Nova refreshed its copy and sends none.`;
}

/** P16: the `organization` check's item where the copy couldn't be refreshed. */
export const MANAGED_PLACES_NOT_REFRESHED =
	"Nova's copy of these places couldn't be refreshed. Organization says why.";

/** P17: an item, a character CommCare can't carry. */
export function managedTableUnrepresentableItem(
	column: string,
	tag: string,
): string {
	return `The column ${column} of ${tag} now holds a character CommCare can't carry in a value. You can take it out in CommCare HQ, then publish again.`;
}

/** P18: `managed_table_handed_back`. */
export const MANAGED_TABLE_HANDED_BACK =
	"A lookup table this app reads was handed back to CommCare HQ while Nova was publishing, so nothing was sent. You can publish again, and Nova will leave that table as it is.";

/** P18, on a first publish, which has made the empty app by the time it stops. */
export const MANAGED_TABLE_HANDED_BACK_AFTER_CREATE =
	"A lookup table this app reads was handed back to CommCare HQ while Nova was publishing, so Nova stopped before sending the tables or the app's content. Nova created the app there, and it is empty for now. You can publish again, and Nova will fill that app and leave that table as it is.";

// ---------------------------------------------------------------------------
// The HQ app file's guide
// ---------------------------------------------------------------------------

/** G1: the title of the guide's step for the second workbook. */
export const MANAGED_LOOKUP_GUIDE_TITLE =
	"Lookup tables managed in CommCare HQ";

/** One table the second workbook carries. `refreshedOn` is the UTC day of its last refresh. */
export interface ManagedLookupGuideTable {
	readonly tag: string;
	readonly domain: string;
	readonly refreshedOn: string;
}

/**
 * G1: the guide's lines for the second workbook, named `workbook`. Where the
 * file carries no first workbook, the guide has no step above to point to,
 * so the last paragraph says how to upload it.
 */
export function managedLookupGuideLines(
	tables: readonly ManagedLookupGuideTable[],
	workbook: string,
	afterLookupTablesStep: boolean,
): readonly string[] {
	return [
		"These tables are managed in CommCare HQ, and Nova only keeps a copy:",
		...tables.map(
			(table) =>
				`  ${table.tag} (in ${table.domain}, copied on ${table.refreshedOn})`,
		),
		"",
		"If you're importing into that project space, it already has them, so leave",
		`"${workbook}" out. Uploading it there would`,
		"replace their rows with Nova's copy.",
		"",
		...(afterLookupTablesStep
			? [
					"For any other project space, upload it on the Lookup Tables page too, the",
					"same way as the file above.",
				]
			: [
					"For any other project space, open the Lookup Tables page in CommCare HQ:",
					"  https://www.commcarehq.org/a/<your-project>/fixtures/",
					"",
					`Upload "${workbook}" there, tick "Replace existing`,
					'tables", and click Upload Tables.',
				]),
	];
}

// ---------------------------------------------------------------------------
// The review
// ---------------------------------------------------------------------------

/** R1: the tables managed in CommCare HQ. */
export function reviewManagedTables(
	tags: readonly string[],
	domain: string,
): string {
	return `Lookup tables managed in CommCare HQ: ${namesInWords(tags)}. Nova copies them so Preview can read them, and never changes them in ${domain}.`;
}

/** R2: a table already in the Project, equal and published there by the Project's other apps. */
export function reviewSameEqualTable(
	tag: string,
	project: string,
	domain: string,
): string {
	return `${tag} is already in ${project} with the same columns and rows, so this app will use that table. Your other apps publish it to ${domain} already, so nothing changes there.`;
}

/** R3: media references that point at no file and that no worker sees. */
export function reviewMediaLeftOut(references: number): string {
	const one = references === 1;
	return `${count(references)} media ${one ? "reference points" : "references point"} at no file, and no worker sees anything for ${one ? "it" : "them"}. Nova leaves ${one ? "it" : "them"} out.`;
}

/** R4: the files the bring-in adds to the Project. */
export function reviewMediaAdded(files: number, project: string): string {
	return files === 1
		? `1 picture, sound or video, added to ${project}'s files.`
		: `${count(files)} pictures, sounds and videos, added to ${project}'s files.`;
}

/** R5: the places managed in CommCare HQ. */
export function reviewManagedPlaces(places: number, domain: string): string {
	const one = places === 1;
	return `${count(places)} ${one ? "place" : "places"} from ${domain}, managed in CommCare HQ. Nova copies ${one ? "it" : "them"} so Preview can show ${one ? "it" : "them"}, and never changes ${one ? "it" : "them"} there. CommCare HQ doesn't tell Nova which levels hold workers or how far a worker's phone reaches, so Nova assumed its defaults. You can change them in Organization.`;
}

/** Why an answer to a table's choice is not offered. */
export type LookupChoiceRefusal =
	| "needs-admin"
	| "managed-elsewhere"
	| "app-reads-a-missing-column"
	| "fails-a-project-space-rule";

/** An answer's offer, as a review table's choice carries it. */
export type ReviewChoiceOffer =
	| { readonly offered: true }
	| {
			readonly offered: false;
			readonly why: LookupChoiceRefusal;
			/** The other project space, or the first missing column; null for the other two. */
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

/** R6: the choice's title. */
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
 * R7: the choice's body. Its form is read from the choice alone: tables that
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

/** R8: answer one. */
export const HQ_TABLE_ANSWER = "Use CommCare HQ's table";

/** R8's line under answer one. `apps` read the Project's table; with none, their sentence is dropped. */
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
 * R8's line for the columns the apps read that CommCare HQ's table lacks;
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

/** R9: answer two. */
export function projectTableAnswer(project: string): string {
	return `Use ${project}'s table`;
}

/** R9's line under answer two. */
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
			`An answer refused as "${offer.why}" names what it is about (the other project space, or the missing column), and this one names nothing. The review's offer carries that name as \`name\`.`,
		);
	return offer.name;
}

/** R10: why an answer is not offered. */
export function choiceNotOffered(
	offer: Extract<ReviewChoiceOffer, { offered: false }>,
	project: string,
): string {
	switch (offer.why) {
		case "needs-admin":
			return `An admin of ${project} can choose this.`;
		case "managed-elsewhere":
			return `${project}'s table is managed in CommCare HQ (${offerName(offer)}), so it can't follow two project spaces.`;
		case "app-reads-a-missing-column":
			return `This app reads the column ${offerName(offer)}, which ${project}'s table doesn't have.`;
		case "fails-a-project-space-rule":
			return `${project}'s table, as it stands, holds something this app couldn't be published or exported with, so this app can't use it.`;
	}
}

/** R11: beside the choice, always. */
export const CHOICE_OTHER_PROJECT =
	"Or go back and add this app to another Project.";

/** R12: an account answered before the files are judged. */
export const MEDIA_CHECKED_LATER =
	"Nova checks pictures and sounds once everything else can come in.";
