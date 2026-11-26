/**
 * The accounting that makes admission a property of the reader's code: every
 * JSON key at a value other than HQ's default and every XML element and
 * attribute a reading meets is claimed against a manifest entry, the entry's
 * standing decides what a claim may do, a value held must be read, and
 * whatever is left at the close is the circumstance `unrecognized` at its
 * place. The accounting decides nothing about content: a stage picks the claim
 * by the value it read, and the accounting checks the use against the
 * standing, records it, and reports what is left.
 *
 * A key the source holds at HQ's default is no use and is never reported. A
 * claim on one is still recorded, with no surface key (`claimAtDefault`),
 * where the reading met the entry there: under a kept entry, which states that
 * the key stays at CommCare HQ whatever it holds, and under an allowing entry
 * that splits its key by value where the claim takes the value whole, since
 * the stage chose that entry by the value it read, so the default is of the
 * entry's class (`no-sort-elements` for a list holding `sort_elements: []`).
 * A container a stage only opens to claim what it holds names no class at its
 * default. Any other claim at a default records nothing.
 *
 * Two uses are handed off instead of claimed, because project data's rules
 * name their entry: a media path the index gives no file for, and an itemset
 * over a table the catalog lacks. They are listed in the log for the caller to
 * settle.
 */

import { type Document, type Element, isTag } from "domhandler";
import type { Uuid } from "@/lib/domain";
import { recordFromEntries } from "@/lib/domain/records";
import {
	type CircumstanceDetail,
	circumstanceFinding,
	cutFindingName,
	type Finding,
	type FindingDetail,
	type HqPlace,
	type ManifestFinding,
	type ReadCircumstance,
	type ReadStanding,
	type Subject,
	shownPlace,
} from "@/lib/publish/hqFindings";
import type { IndexedEntry, InventoryIndex } from "../surface/inventory";
import { chargeWork } from "../workMeter";
import { elementNamespace, namespaceScopes, splitName } from "../xmlNamespaces";
import {
	type Claim,
	claimName,
	claimNameForEntry,
	claimPermits,
	claimRegistry,
	defineClaims,
	drop,
} from "./claims";
import { type ReaderDefectWhy, readerDefect } from "./defects";
import type { IdentityClaim } from "./identity";
import {
	findingNodes,
	type HandOffKind,
	type JsonCursor,
	JsonCursorImpl,
} from "./jsonCursor";
import { placeOrder, whereText } from "./place";
import type { ReaderDefect, ReadWork } from "./types";
import {
	namesFormNodes,
	qualifiedElement,
	type XmlCursor,
	XmlCursorImpl,
	type XmlNode,
} from "./xmlCursor";

const CLAIMS = defineClaims("accounting", {
	/** A comment in a form's source, which CommCare HQ's build removes, or a processing
	 *  instruction in an element whose text Core does not read (`coreReadsTextOf`). */
	comment: drop("questions/xml-comments-processing-instructions", null),
});

/** A value a claim admitted. Reading it marks the claim consumed. */
export class Admitted<T> {
	#value: T;
	#read = false;

	constructor(value: T) {
		this.#value = value;
	}

	/** The claimed value. Reading it marks the claim consumed. */
	get value(): T {
		this.#read = true;
		return this.#value;
	}

	/** Whether the value has been read. */
	get consumed(): boolean {
		return this.#read;
	}
}

/** A node of the source: an element or attribute of a form, or a key of a JSON object. */
export type ClaimSite =
	| XmlNode
	| { readonly json: JsonCursor; readonly key: string };

export interface ClaimRecord {
	/** `app.json` or `form:<m>.<f>`. */
	readonly artifact: string;
	/** Where the value the record's key names sits (a key above the claimed value, where the claim
	 *  names that key's schema item), which is where the lane's use of the key stands. */
	readonly where: string;
	readonly key: string | null;
	readonly entry: string;
	readonly standing: ReadStanding;
	/** Where the value the claim reads sits, present only where that is not `where`: a key of a
	 *  map, or an object read whole, whose claim names the schema item of a key above it (a
	 *  language's strings under `schema:Application.translations`). */
	readonly at?: string;
}

/** A use handed to project data: a place and a key, and no entry yet. */
export interface HandOffRecord {
	readonly artifact: string;
	readonly where: string;
	readonly key: string;
	readonly to: HandOffKind;
	/** The media path or the table's tag, which the caller settles it by. */
	readonly subject: string;
}

export interface ClaimLog {
	/** Claims by entry id, in every mode. */
	readonly counts: Readonly<Record<string, number>>;
	/** Every hand-off, in every mode: there are few, and acceptance needs each. */
	readonly handOffs: readonly HandOffRecord[];
	/** Every claim, sorted by artifact, where, key and entry. Throws unless the log is `full`. */
	records(): IterableIterator<ClaimRecord>;
}

/** One JSON object per line, keys in `ClaimRecord`'s order, `at` only where a record holds one, in
 *  `records()` order, `\n` ended. */
export function serializeClaimLog(log: ClaimLog): string {
	let text = "";
	for (const record of log.records())
		text += `${JSON.stringify({
			artifact: record.artifact,
			where: record.where,
			key: record.key,
			entry: record.entry,
			standing: record.standing,
			...(record.at === undefined ? {} : { at: record.at }),
		})}\n`;
	return text;
}

/** A node as the ledger keeps it: its owner (a cursor or an element) and the
 *  key or attribute under it, with how the log and a finding spell it. */
export interface LedgerSite {
	readonly owner: object;
	/** The JSON key or the attribute's name; empty for an element itself. */
	readonly sub: string;
	readonly artifact: string;
	readonly where: () => string;
	/** Where the value a claim here reads sits, where it is not `where` (`ClaimRecord.at`). */
	readonly at?: () => string;
	/** The surface name an `unrecognized` finding here takes. */
	readonly name: string;
	/** Where in the app's JSON the value a finding here reads sits, where it is not `where`: the
	 *  object holding the key, or the object refused whole. */
	readonly reads?: () => string;
	/** Whether a surface key names the node a record here stands at (`xmlCursor.ts::keyNamesNode`);
	 *  absent where the site's own key is the only one a claim there names (the app's JSON). */
	readonly names?: (key: string) => boolean;
}

/** What the cursors ask of the accounting. */
/** How a claim at a default reads the key: its value whole, or a container it opens. */
export type ReadAtDefault = "whole" | "opened";

export interface ClaimLedger {
	registerJson(cursor: JsonCursorImpl): void;
	registerXml(cursor: XmlCursorImpl): void;
	/** Applies a declared claim at a site; true where it was recorded under its entry. */
	claim(
		site: LedgerSite,
		claim: Claim,
		place: HqPlace,
		detail?: FindingDetail,
	): boolean;
	/** A value a recorded `take` admitted, which must be read before the close. */
	admit<T>(
		value: T,
		site: LedgerSite,
		claim: Claim,
		place: HqPlace,
	): Admitted<T>;
	/** A value handed out with nothing recorded: at its default, or behind a finding. */
	unrecorded<T>(value: T): Admitted<T>;
	/**
	 * A claim on a key the source holds at HQ's default. It makes no use and no
	 * finding. A claim under a kept entry is recorded all the same, with no
	 * surface key, since what it keeps is the key staying at HQ whatever it
	 * holds; so is one that takes the value whole (`read` is `whole`) under an
	 * allowing entry with a value class, since the stage chose that entry by
	 * the default it read.
	 */
	claimAtDefault(site: LedgerSite, claim: Claim, read: ReadAtDefault): void;
	/**
	 * Where a claim that took a value whole, or refused or accounted it with a
	 * finding, also stands: a key inside that value, recorded at its own site
	 * under the claim's entry and the first of `keys` (the key's own surface
	 * key, then its class's undeclared-key item) the entry names. It is the
	 * same claim, so it adds no count; a key the entry names under none of
	 * `keys`, or a claim whose entry's standing neither permits the value nor
	 * makes a finding of it, is recorded nowhere here.
	 */
	within(site: LedgerSite, claim: Claim, keys: readonly string[]): void;
	/**
	 * A node that holds no surface key's value, claimed as part of what `claim` reads: an XHTML
	 * wrapper of a form, which Core's parser passes over, or an attribute of an instance's content,
	 * which Core copies into the instance as the app's answer data. Nothing is recorded there, since
	 * no surface item is used there; the claim's own record stands where its value sits. A claim
	 * whose entry's standing does not permit its use is the defect `claim` makes of it.
	 */
	partOf(site: LedgerSite, claim: Claim, place: HqPlace): void;
	/** The element's own text is claimed with it. */
	claimText(element: Element): void;
	/**
	 * Everything under the element is claimed. `reads` is whether the claim reads what it covers
	 * (`take`, `derived`), so the close still looks under it for a processing instruction in a
	 * text Core reads (`#closeXml`); a claim that reads past, refuses or hands off what it covers
	 * stands for every node under it.
	 */
	coverSubtree(element: Element, reads: boolean): void;
	handOff(
		site: LedgerSite,
		key: string,
		to: HandOffKind,
		subject: string,
	): void;
}

interface NodeState {
	/** The declared claim's registered name, where a declared claim holds the node. */
	declared?: string;
	declaredKey?: string | null;
	/** Claims `claimEntry` applied, by their surface key; made at the first, since most nodes a
	 *  reading claims hold a declared claim alone. */
	entries?: Map<string, string>;
	/** Covered by a finding already raised, handed off, or claimed as part of a claim that records
	 *  nothing there (`partOf`). */
	settled: boolean;
}

interface PendingRecord {
	readonly artifact: string;
	readonly where: () => string;
	readonly at?: () => string;
	readonly key: string | null;
	readonly entry: string;
	readonly standing: ReadStanding;
}

interface Watched {
	readonly admitted: Admitted<unknown>;
	readonly place: HqPlace;
	readonly name: string;
	readonly claim: string;
}

/** XML's whitespace, the only text between elements that is no construct. */
function isXmlWhitespace(text: string): boolean {
	for (const character of text)
		if (
			character !== " " &&
			character !== "\t" &&
			character !== "\n" &&
			character !== "\r"
		)
			return false;
	return true;
}

function compareText(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

/** The document an element belongs to. */
/** The surface key of the CommCare HQ object a place stands in: what a finding at a place with
 *  no node of its own names, where its claim names no surface key and its detail no value. */
function placeSurfaceKey(place: HqPlace): string {
	switch (place.kind) {
		case "menu":
			return "schema:Module";
		case "case-list":
		case "case-detail":
			return "schema:Detail";
		case "search":
			return "schema:CaseSearch";
		case "form":
		case "question":
			return "schema:Form";
		case "media":
			return "schema:HQMediaMapItem";
		default:
			return "schema:Application";
	}
}

function documentOf(element: Element): Document | null {
	let node: Element["parent"] = element.parent;
	while (node !== null && node.type !== "root") node = node.parent;
	return node === null ? null : (node as Document);
}

/**
 * Whether an element's default `xmlns` is a construct: exactly where it gives
 * an unprefixed element another namespace than its parent's. The root has no
 * parent to differ from, and a prefixed element takes its namespace from its
 * prefix.
 */
/**
 * The elements CommCare Core reads as text with their markup (`XFormParser.getLabel`, through
 * `getLabelOrTextId` for a repeat's captions) or with `getXMLText` whatever else they hold: a
 * label, hint, help text and alert, an itext text's or a choice's value, a repeat's captions and
 * headers, and the form's title. Core compares local names alone.
 */
const CORE_TEXT_ELEMENTS: ReadonlySet<string> = new Set([
	"label",
	"hint",
	"help",
	"alert",
	"value",
	"title",
	"chooseCaption",
	"addCaption",
	"delCaption",
	"doneCaption",
	"addEmptyCaption",
	"doneEmptyCaption",
	"entryHeader",
	"delHeader",
	"mainHeader",
]);

/**
 * Whether CommCare Core reads `element`'s text, where a processing instruction changes what it
 * reads. CommCare HQ's build removes a form's comments and keeps its processing instructions
 * (`xform.py::parse_xml`), and Core's parse keeps each as a node of its own: `getXMLText` stops
 * at it, reading a text it starts as null (a title, a choice's value, an instance's default, a
 * setvalue's text), and `getLabel` writes it as `null` (a label, an itext value). Core reads an
 * element that holds another element and is none of `CORE_TEXT_ELEMENTS` by its element children
 * alone (`parseElement`, `parseControlChildren`, `parseItem`, `loadInstanceData`, the itext
 * block's), so an instruction there changes nothing a runtime reads.
 */
function coreReadsTextOf(element: Element): boolean {
	return (
		!element.children.some(isTag) ||
		CORE_TEXT_ELEMENTS.has(splitName(element.name).local)
	);
}

function namespaceIsConstruct(
	element: Element,
	namespace: string | null,
	parentNamespace: string | null | undefined,
): boolean {
	return (
		parentNamespace !== undefined &&
		splitName(element.name).prefix === "" &&
		namespace !== parentNamespace
	);
}

export class Accounting implements ClaimLedger {
	readonly #index: InventoryIndex;
	readonly #full: boolean;
	readonly #nodes = new Map<object, Map<string, NodeState>>();
	readonly #json: JsonCursorImpl[] = [];
	readonly #xml = new Map<Document, XmlCursorImpl>();
	readonly #textClaimed = new Set<Element>();
	readonly #subtrees = new Set<Element>();
	/** The covered subtrees whose claim reads what it covers (`coverSubtree`). */
	readonly #readSubtrees = new Set<Element>();
	readonly #watched: Watched[] = [];
	readonly #findings: Finding[] = [];
	/** The place of every finding raised, as `whereText` spells it. */
	readonly #findingPlaces = new Set<string>();
	/** `findings()`'s answer until the next finding is raised. */
	#findingsView: readonly Finding[] | undefined;
	readonly #findingKeys = new Set<string>();
	readonly #defects: ReaderDefect[] = [];
	readonly #counts = recordFromEntries<number>([]);
	readonly #records: PendingRecord[] = [];
	readonly #handOffs: HandOffRecord[] = [];
	/** Each place, key and entry of the app's JSON a claim's reach or a finding's class records
	 *  (`within`, `#recordAround`), and each a claim's own record stands at (`#own`), so a record
	 *  stands there once whichever records it first, and each claim of the place keeps its own. */
	readonly #around = new Set<string>();
	readonly #own = new Set<string>();
	/** The sites a kept claim at HQ's default recorded, so a key is recorded once. */
	readonly #atDefault = new WeakMap<object, Set<string>>();
	#rebuilds = 0;
	#closed = false;

	constructor(
		index: InventoryIndex,
		options: { readonly log: "counts" | "full" },
	) {
		this.#index = index;
		this.#full = options.log === "full";
	}

	/** A cursor over the app's root object, class `Application`, artifact `app.json`. */
	json(root: Readonly<Record<string, unknown>>, place: HqPlace): JsonCursor {
		return new JsonCursorImpl(this, root, "Application", "", place, null);
	}

	/** A cursor over one parsed form, artifact `form:<m>.<f>`. */
	xml(
		document: Document,
		menu: number,
		form: number,
		place: HqPlace,
	): XmlCursor {
		const known = this.#xml.get(document);
		if (known !== undefined) return known;
		return new XmlCursorImpl(
			this,
			document,
			namespaceScopes(document),
			menu,
			form,
			place,
		);
	}

	/** An expected tree built for a generated node, for `ReadWork`. */
	noteRebuild(): void {
		this.#rebuilds += 1;
	}

	// ── The ledger the cursors write ───────────────────────────────────────

	registerJson(cursor: JsonCursorImpl): void {
		this.#json.push(cursor);
	}

	registerXml(cursor: XmlCursorImpl): void {
		this.#xml.set(cursor.document, cursor);
	}

	/** Whether a cursor of this reading already reads `document`: a second
	 *  form of the same text reads a copy of its own. */
	readsXml(document: Document): boolean {
		return this.#xml.has(document);
	}

	#state(site: LedgerSite): NodeState {
		let byOwner = this.#nodes.get(site.owner);
		if (byOwner === undefined) {
			byOwner = new Map();
			this.#nodes.set(site.owner, byOwner);
		}
		let state = byOwner.get(site.sub);
		if (state === undefined) {
			state = { settled: false };
			byOwner.set(site.sub, state);
		}
		return state;
	}

	#peekState(owner: object, sub: string): NodeState | undefined {
		return this.#nodes.get(owner)?.get(sub);
	}

	#record(
		site: LedgerSite,
		key: string | null,
		entry: string,
		standing: ReadStanding,
	) {
		this.#counts[entry] = (this.#counts[entry] ?? 0) + 1;
		if (!this.#full) return;
		// A claim's own record repeats no record a claim's reach or a finding's class made there
		// (`within`, `#recordAround`), and stands beside every other claim's of the place.
		if (site.artifact === "app.json" && key !== null) {
			const identity = `${site.where()}\u0000${key}\u0000${entry}`;
			if (this.#around.has(identity)) return;
			this.#own.add(identity);
		}
		this.#records.push({
			artifact: site.artifact,
			where: site.where,
			...(site.at === undefined ? {} : { at: site.at }),
			key,
			entry,
			standing,
		});
	}

	/**
	 * A finding's entry recorded at every node of the app's JSON its class reads around the
	 * value at `pointer` (`jsonCursor.ts::findingNodes`): the keys above and inside it the entry
	 * names, but `own`, the claim's own record (its place and key). It is the same claim, so it
	 * adds no count.
	 */
	#recordAround(pointer: string, entryId: string, own?: string): void {
		if (!this.#full) return;
		const root = this.#json.find((cursor) => cursor.parent === null);
		const entry = this.#index.entry(entryId);
		if (root === undefined || entry === undefined) return;
		for (const { where, key } of findingNodes(
			root.value,
			pointer,
			new Set(entry.surfaceKeys),
		)) {
			const identity = `${where}\u0000${key}\u0000${entry.id}`;
			if (
				this.#around.has(identity) ||
				this.#own.has(identity) ||
				own === `${where}\u0000${key}`
			)
				continue;
			this.#around.add(identity);
			this.#records.push({
				artifact: "app.json",
				where: () => where,
				key,
				entry: entry.id,
				standing: entry.standing,
			});
		}
	}

	/**
	 * Whether a record of `entry` under `key` may stand at `site`: one with no surface key, or one
	 * under a key the entry names and that names the node the record stands at.
	 */
	#recordable(
		site: LedgerSite,
		entry: IndexedEntry,
		key: string | null,
	): boolean {
		return (
			key === null ||
			(entry.surfaceKeys.includes(key) && (site.names?.(key) ?? true))
		);
	}

	/**
	 * The key a claim of `entry` that names `key` is recorded under at `site`: `key` where it may
	 * stand there (`#recordable`); where the node the record stands at is not one `key` names (a
	 * refused question's itext, binds and control, which its refusal reaches past its own node),
	 * the first key of the entry that names a form's node (`xmlCursor.ts::namesFormNodes`) and
	 * names that one, else no key, so the claim's record stands at its node naming no key another
	 * node holds; and `unnamed` where the entry does not name `key` at all, which is the defect
	 * `key-not-named` (`#keyNotNamed`).
	 */
	#recordKey(
		site: LedgerSite,
		entry: IndexedEntry,
		key: string | null,
	): { readonly key: string | null } | "unnamed" {
		if (this.#recordable(site, entry, key)) return { key };
		if (key === null || !entry.surfaceKeys.includes(key)) return "unnamed";
		const fits = entry.surfaceKeys.find(
			(one) => namesFormNodes(one) && this.#recordable(site, entry, one),
		);
		return { key: fits ?? null };
	}

	#keyNotNamed(
		site: LedgerSite,
		state: NodeState,
		place: HqPlace,
		claim: string,
		entry: IndexedEntry,
		key: string,
	): void {
		state.settled = true;
		this.defect(
			place,
			site.name,
			readerDefect.keyNotNamed(place, claim, entry.id, key),
		);
	}

	#push(finding: Finding): void {
		const key = `${finding.code}\u0000${whereText(finding.place)}\u0000${finding.detail.name ?? ""}`;
		if (this.#findingKeys.has(key)) return;
		this.#findingKeys.add(key);
		this.#findings.push(finding);
		this.#findingPlaces.add(whereText(finding.place));
		this.#findingsView = undefined;
	}

	#unrecognized(place: HqPlace, name: string): void {
		this.#push(circumstanceFinding("unrecognized", place, { name }));
	}

	#manifestFinding(
		entryId: string,
		place: HqPlace,
		detail: FindingDetail | undefined,
	): void {
		const entry = this.#index.entry(entryId);
		if (entry === undefined) return;
		const standing = entry.standing;
		if (
			standing !== "not-yet" &&
			standing !== "never" &&
			standing !== "fix-in-hq"
		)
			return;
		const name = detail?.name;
		const finding: ManifestFinding = {
			code: entry.id,
			standing,
			...(standing === "fix-in-hq" && entry.cause !== null
				? { cause: entry.cause }
				: {}),
			place: shownPlace(place),
			subject: entry.subject as Subject,
			detail: {
				...(name === undefined ? {} : { name: cutFindingName(name) }),
				...(detail?.reason === undefined ? {} : { reason: detail.reason }),
			},
		};
		this.#push(finding);
	}

	/** Whether a use under `entryId` makes a finding: `refuse` always, `account`
	 *  where the standing is one that makes one. */
	#makesFinding(use: Claim["use"], standing: ReadStanding): boolean {
		if (use === "refuse") return true;
		return (
			use === "account" &&
			(standing === "not-yet" ||
				standing === "never" ||
				standing === "fix-in-hq")
		);
	}

	claim(
		site: LedgerSite,
		claim: Claim,
		place: HqPlace,
		detail?: FindingDetail,
	): boolean {
		const state = this.#state(site);
		const name = claimName(claim) ?? "unregistered-claim";
		const first =
			state.declared ??
			(claim.key === null ? undefined : state.entries?.get(claim.key));
		if (first !== undefined) {
			this.defect(
				place,
				site.name,
				readerDefect.claimedTwice(place, first, name),
			);
			return false;
		}
		state.declared = name;
		state.declaredKey = claim.key;
		const entry = this.#index.entry(claim.entry);
		if (entry === undefined || !claimPermits(claim.use, entry.standing)) {
			state.settled = true;
			this.defect(
				place,
				site.name,
				readerDefect.claimNotPermitted(place, name, entry?.standing ?? null),
			);
			return false;
		}
		const at = this.#recordKey(site, entry, claim.key);
		if (at === "unnamed") {
			this.#keyNotNamed(site, state, place, name, entry, claim.key as string);
			return false;
		}
		this.#record(site, at.key, entry.id, entry.standing);
		if (this.#makesFinding(claim.use, entry.standing)) {
			this.#manifestFinding(entry.id, place, detail);
			if (site.artifact === "app.json")
				this.#recordAround(
					(site.reads ?? site.where)(),
					entry.id,
					`${site.where()}\u0000${claim.key}`,
				);
		}
		return true;
	}

	admit<T>(
		value: T,
		site: LedgerSite,
		claim: Claim,
		place: HqPlace,
	): Admitted<T> {
		const admitted = new Admitted(value);
		this.#watched.push({
			admitted: admitted as Admitted<unknown>,
			place,
			name: site.name,
			claim: claimName(claim) ?? "unregistered-claim",
		});
		return admitted;
	}

	unrecorded<T>(value: T): Admitted<T> {
		return new Admitted(value);
	}

	claimAtDefault(site: LedgerSite, claim: Claim, read: ReadAtDefault): void {
		const entry = this.#index.entry(claim.entry);
		if (entry === undefined) return;
		const kept =
			entry.standing === "kept" &&
			(claim.use === "drop" || claim.use === "account");
		const ofItsClass =
			read === "whole" &&
			entry.valueClass !== null &&
			claim.use !== "refuse" &&
			(entry.standing === "held" ||
				entry.standing === "kept" ||
				entry.standing === "inert");
		if (!kept && !ofItsClass) return;
		let subs = this.#atDefault.get(site.owner);
		if (subs === undefined) {
			subs = new Set();
			this.#atDefault.set(site.owner, subs);
		}
		if (subs.has(site.sub)) return;
		subs.add(site.sub);
		this.#record(site, null, entry.id, entry.standing);
	}

	within(site: LedgerSite, claim: Claim, keys: readonly string[]): void {
		const entry = this.#index.entry(claim.entry);
		if (
			entry === undefined ||
			(entry.standing !== "held" &&
				entry.standing !== "kept" &&
				entry.standing !== "inert" &&
				!this.#makesFinding(claim.use, entry.standing))
		)
			return;
		const key = keys.find((one) => this.#recordable(site, entry, one));
		if (key === undefined || !this.#full) return;
		// A node of the app's JSON stands once under an entry and a key, whichever of a claim's own
		// record, its reach and a finding's class (`#recordAround`) records it first.
		if (site.artifact === "app.json") {
			const identity = `${site.where()}\u0000${key}\u0000${entry.id}`;
			if (this.#around.has(identity) || this.#own.has(identity)) return;
			this.#around.add(identity);
		}
		this.#records.push({
			artifact: site.artifact,
			where: site.where,
			key,
			entry: entry.id,
			standing: entry.standing,
		});
	}

	partOf(site: LedgerSite, claim: Claim, place: HqPlace): void {
		const entry = this.#index.entry(claim.entry);
		if (entry === undefined || !claimPermits(claim.use, entry.standing)) {
			this.defect(
				place,
				site.name,
				readerDefect.claimNotPermitted(
					place,
					claimName(claim) ?? "unregistered-claim",
					entry?.standing ?? null,
				),
			);
			return;
		}
		this.#state(site).settled = true;
	}

	claimText(element: Element): void {
		this.#textClaimed.add(element);
	}

	coverSubtree(element: Element, reads: boolean): void {
		this.#subtrees.add(element);
		if (reads) this.#readSubtrees.add(element);
	}

	handOff(
		site: LedgerSite,
		key: string,
		to: HandOffKind,
		subject: string,
	): void {
		const state = this.#state(site);
		state.settled = true;
		this.#handOffs.push({
			artifact: site.artifact,
			where: site.where(),
			key,
			to,
			subject,
		});
	}

	// ── What a stage asks of the accounting directly ──────────────────────

	#site(site: ClaimSite): LedgerSite | undefined {
		if ("json" in site) {
			const cursor = site.json;
			return cursor instanceof JsonCursorImpl
				? cursor.site(site.key)
				: undefined;
		}
		const document = documentOf(site.element);
		const cursor = document === null ? undefined : this.#xml.get(document);
		return cursor?.site(site);
	}

	/** A finding no entry names, made through `circumstanceFinding`. */
	circumstance<C extends ReadCircumstance>(
		code: C,
		place: HqPlace,
		detail: CircumstanceDetail<C>,
	): void {
		this.#push(circumstanceFinding(code, place, detail));
	}

	/**
	 * A manifest finding that is a relation between several nodes, each already
	 * claimed. The claim's use must be `refuse` or `account` and its entry's
	 * standing one that makes a finding; any other is the defect `claim-not-permitted`, whose
	 * `unrecognized` finding names the claim's surface key, else the value
	 * `detail` names, else the surface key of the object the place stands in.
	 * It claims no node.
	 */
	finding(claim: Claim, place: HqPlace, detail?: FindingDetail): void {
		const entry = this.#index.entry(claim.entry);
		if (
			entry === undefined ||
			(claim.use !== "refuse" && claim.use !== "account") ||
			!this.#makesFinding("account", entry.standing)
		) {
			this.defect(
				place,
				claim.key ?? detail?.name ?? placeSurfaceKey(place),
				readerDefect.claimNotPermitted(
					place,
					claimName(claim) ?? "unregistered-claim",
					entry?.standing ?? null,
				),
			);
			return;
		}
		this.#manifestFinding(entry.id, place, detail);
	}

	/**
	 * `finding`'s relation, made of the value at `pointer` in the app's JSON (a basic case
	 * action's condition, judged against the question it names): its entry is recorded at
	 * every node its class reads there (`#recordAround`).
	 */
	findingAt(
		claim: Claim,
		place: HqPlace,
		pointer: string,
		detail?: FindingDetail,
	): void {
		this.finding(claim, place, detail);
		const entry = this.#index.entry(claim.entry);
		if (
			entry !== undefined &&
			(claim.use === "refuse" || claim.use === "account") &&
			this.#makesFinding("account", entry.standing)
		)
			this.#recordAround(pointer, entry.id);
	}

	/**
	 * `finding`'s relation, made of the value at `node` of a form's source (a control's `ref`
	 * that crosses a repeat, a data node's own text, a model iteration's role): its entry is
	 * recorded there under `key`, at the attribute `key` names where it names one
	 * (`xmlCursor.ts::recordedNode`), beside whatever claim already holds the node.
	 */
	findingAtNode(
		claim: Claim,
		place: HqPlace,
		node: XmlNode,
		key: string,
		detail?: FindingDetail,
	): void {
		this.finding(claim, place, detail);
		const entry = this.#index.entry(claim.entry);
		if (
			entry === undefined ||
			(claim.use !== "refuse" && claim.use !== "account") ||
			!this.#makesFinding("account", entry.standing)
		)
			return;
		const document = documentOf(node.element);
		const cursor = document === null ? undefined : this.#xml.get(document);
		cursor?.withinAt(node, claim, key);
	}

	/**
	 * Applies a claim another stage decided by entry id. The use follows the
	 * entry's standing: `held` is a consumed `take`, `inert` and `kept` a
	 * `drop`, any other a `refuse`. Several such claims may hold one node, one
	 * per surface key; with `unlessClaimed`, a key some claim at the node
	 * already names is left to that claim; with `keyless`, the claim records no key, where its
	 * caller decided its entry names none of the node's keys. Any other key the entry does not
	 * name is the defect `key-not-named`.
	 */
	claimEntry(
		site: ClaimSite,
		entryId: string,
		key: string,
		place: HqPlace,
		detail?: FindingDetail,
		options?: { readonly unlessClaimed?: true; readonly keyless?: true },
	): void {
		const ledgerSite = this.#site(site);
		if (ledgerSite === undefined) return;
		const state = this.#state(ledgerSite);
		// A use another claim at the node already names is that claim's.
		if (
			options?.unlessClaimed === true &&
			(state.entries?.has(key) === true || state.declaredKey === key)
		)
			return;
		const registered = claimNameForEntry(entryId);
		const entry = this.#index.entry(entryId);
		if (registered === undefined || entry === undefined) {
			state.settled = true;
			this.defect(
				place,
				ledgerSite.name,
				readerDefect.unregisteredExpressionClaim(place, entryId),
			);
			return;
		}
		// An entry that names no surface key (`noSurfaceKey`) claims the node beside whatever
		// holds it there, and its record names no key; so does a claim its caller made `keyless`,
		// whose entry names none of the node's keys.
		if (entry.surfaceKeys.length === 0 || options?.keyless === true) {
			state.settled = true;
			this.#record(ledgerSite, null, entry.id, entry.standing);
			if (this.#makesFinding("account", entry.standing))
				this.#manifestFinding(entry.id, place, detail);
			return;
		}
		const first =
			state.entries?.get(key) ??
			(state.declaredKey === key ? state.declared : undefined);
		if (first !== undefined) {
			this.defect(
				place,
				ledgerSite.name,
				readerDefect.claimedTwice(place, first, registered),
			);
			return;
		}
		const at = this.#recordKey(ledgerSite, entry, key);
		if (at === "unnamed") {
			this.#keyNotNamed(ledgerSite, state, place, registered, entry, key);
			return;
		}
		state.entries ??= new Map();
		state.entries.set(key, registered);
		this.#record(ledgerSite, at.key, entry.id, entry.standing);
		if (this.#makesFinding("account", entry.standing)) {
			this.#manifestFinding(entry.id, place, detail);
			if (ledgerSite.artifact === "app.json")
				this.#recordAround(
					(ledgerSite.reads ?? ledgerSite.where)(),
					entry.id,
					`${ledgerSite.where()}\u0000${key}`,
				);
		}
	}

	/**
	 * Applies, by entry id, a further class of a key the cursor or `claimEntry` already claims
	 * at the node under another entry: a value that holds the key in several
	 * classes (a search row, whose every text HQ's search parses on its own) is
	 * a use in each, recorded beside the first. The entry is answered as
	 * `claimEntry` answers it; a key not claimed there yet is `claimEntry`'s.
	 */
	claimEntryClass(
		site: ClaimSite,
		entryId: string,
		key: string,
		place: HqPlace,
		detail?: FindingDetail,
	): void {
		const ledgerSite = this.#site(site);
		if (ledgerSite === undefined) return;
		const state = this.#state(ledgerSite);
		// A key the node's `take` declared is claimed there as one claimed by entry.
		const first =
			state.entries?.get(key) ??
			(state.declaredKey === key ? state.declared : undefined);
		const entry = this.#index.entry(entryId);
		const registered = claimNameForEntry(entryId);
		if (
			first === undefined ||
			registered === undefined ||
			entry === undefined
		) {
			this.claimEntry(site, entryId, key, place, detail);
			return;
		}
		if (first === registered) return;
		const at = this.#recordKey(ledgerSite, entry, key);
		if (at === "unnamed") {
			this.#keyNotNamed(ledgerSite, state, place, registered, entry, key);
			return;
		}
		this.#record(ledgerSite, at.key, entry.id, entry.standing);
		if (this.#makesFinding("account", entry.standing)) {
			this.#manifestFinding(entry.id, place, detail);
			if (ledgerSite.artifact === "app.json")
				this.#recordAround(
					(ledgerSite.reads ?? ledgerSite.where)(),
					entry.id,
					`${ledgerSite.where()}\u0000${key}`,
				);
		}
	}

	/** Whether some finding already stands at exactly `place`: a check whose inputs a finding
	 *  there withheld is skipped, and that finding sends the person to the place. */
	hasFindingAt(place: HqPlace): boolean {
		return this.#findingPlaces.has(whereText(place));
	}

	/** Every finding raised so far, in the order raised: what a later stage names a node it covers
	 *  by. The close adds the unclaimed uses and sorts. One frozen copy, made again only once a
	 *  finding is raised, so a loop that asks between findings copies nothing. */
	findings(): readonly Finding[] {
		this.#findingsView ??= Object.freeze([...this.#findings]);
		return this.#findingsView;
	}

	/** How many findings have been raised so far: where a step's own findings will start. */
	findingCount(): number {
		return this.#findings.length;
	}

	/** The finding raised at `index` in the order raised, or undefined where none has been. */
	findingRaised(index: number): Finding | undefined {
		return this.#findings[index];
	}

	/** Hands the node at `site` to project data, as a cursor's `handOff` does, for a stage that
	 *  holds the node and not its cursor. `key` is the surface key a claim there would name. */
	handOffAt(
		site: ClaimSite,
		to: HandOffKind,
		subject: string,
		key?: string,
	): void {
		const ledgerSite = this.#site(site);
		if (ledgerSite === undefined) return;
		this.handOff(ledgerSite, key ?? ledgerSite.name, to, subject);
	}

	/**
	 * Marks a node as covered by a finding already raised: a log record under
	 * the finding's entry where it is a manifest finding, none where it is a
	 * circumstance, and no second finding.
	 */
	cover(site: ClaimSite, by: Finding): void {
		const ledgerSite = this.#site(site);
		if (ledgerSite === undefined) return;
		const state = this.#state(ledgerSite);
		state.settled = true;
		if (by.subject !== null) {
			const entry = this.#index.entry(by.code);
			if (entry !== undefined)
				this.#record(ledgerSite, null, entry.id, entry.standing);
		}
	}

	/**
	 * What holds the node at `site` so far: the claim declared there, `"held"` where only a claim
	 * by entry, a hand-off or a cover holds it, or undefined where nothing holds it yet.
	 */
	holder(site: ClaimSite): Claim | "held" | undefined {
		const ledgerSite = this.#site(site);
		if (ledgerSite === undefined) return undefined;
		const state = this.#peekState(ledgerSite.owner, ledgerSite.sub);
		if (state === undefined) return undefined;
		const declared =
			state.declared === undefined
				? undefined
				: claimRegistry().get(state.declared);
		if (declared !== undefined) return declared;
		return this.#claimed(ledgerSite.owner, ledgerSite.sub) ? "held" : undefined;
	}

	/**
	 * An identity the resolver answered. A key met twice that no stage claimed
	 * first under its manifest entry is `unrecognized` at the second place,
	 * with the surface key of the node being minted, and the defect `identity-met-twice`.
	 */
	identity(
		answer: IdentityClaim,
		place: HqPlace,
		name: string,
	): Uuid | undefined {
		if (answer.ok) return answer.uuid;
		this.defect(
			place,
			name,
			readerDefect.identityMetTwice(place, answer.key.kind),
		);
		return undefined;
	}

	/**
	 * A defect of the reader's own: `unrecognized` at the place, under `name`,
	 * the surface key of the node it stands behind, and the defect beside it.
	 * `why` comes from a constructor of `defects.ts::readerDefect` alone.
	 */
	defect(place: HqPlace, name: string, why: ReaderDefectWhy): void {
		this.#unrecognized(place, name);
		this.#defects.push({ place, name, why });
	}

	// ── The close ──────────────────────────────────────────────────────────

	#nodesVisited = 0;

	#claimed(owner: object, sub: string): boolean {
		const state = this.#peekState(owner, sub);
		return (
			state !== undefined &&
			(state.settled ||
				state.declared !== undefined ||
				(state.entries?.size ?? 0) > 0)
		);
	}

	#closeJson(cursor: JsonCursorImpl): void {
		const covered = cursor.covered();
		for (const key of Object.keys(cursor.value)) {
			chargeWork("visit", 1);
			this.#nodesVisited += 1;
			if (
				covered ||
				cursor.sealedOver(key) ||
				this.#claimed(cursor, key) ||
				!cursor.used(key)
			)
				continue;
			this.#unrecognized(cursor.place, cursor.keyName(key));
		}
	}

	#closeXml(cursor: XmlCursorImpl): void {
		const walk = (
			element: Element,
			parentNamespace: string | null | undefined,
		) => {
			chargeWork(
				"visit",
				1 + element.children.length + Object.keys(element.attribs).length,
			);
			this.#nodesVisited += 1;
			if (this.#subtrees.has(element)) {
				if (this.#readSubtrees.has(element)) instructionsIn(element);
				return;
			}
			const scope = cursor.scope(element);
			const place = () => cursor.resolvePlace(element);
			if (!this.#claimed(element, "")) {
				this.#unrecognized(place(), cursor.nodeName({ element }));
				return;
			}
			const namespace = elementNamespace(element, scope);
			for (const attribute of Object.keys(element.attribs)) {
				if (attribute.startsWith("xmlns:")) continue;
				if (
					attribute === "xmlns" &&
					!namespaceIsConstruct(element, namespace, parentNamespace)
				)
					continue;
				this.#nodesVisited += 1;
				if (this.#claimed(element, attribute)) continue;
				this.#unrecognized(place(), cursor.nodeName({ element, attribute }));
			}
			for (const child of element.children) {
				if (isTag(child)) {
					walk(child, namespace);
					continue;
				}
				if (child.type === "text") {
					if (isXmlWhitespace(child.data) || this.#textClaimed.has(element))
						continue;
					this.#nodesVisited += 1;
					this.#unrecognized(
						place(),
						`xform:${qualifiedElement(element, scope)}/text()`,
					);
					continue;
				}
				if (child.type === "directive" && coreReadsTextOf(element)) {
					instructionInText(element);
					continue;
				}
				if (child.type === "comment" || child.type === "directive") {
					this.#nodesVisited += 1;
					const kind =
						child.type === "comment" ? "comment()" : "processing-instruction()";
					this.claim(
						{
							owner: child,
							sub: "",
							artifact: cursor.artifact,
							where: () => `${cursor.site({ element }).where()}/${kind}`,
							name: `xform:${qualifiedElement(element, scope)}/${kind}`,
						},
						CLAIMS.comment,
						place(),
					);
				}
			}
		};
		/** A processing instruction in a text Core reads, which no claim holds: `unrecognized`. */
		const instructionInText = (element: Element) => {
			this.#nodesVisited += 1;
			this.#unrecognized(
				cursor.resolvePlace(element),
				`xform:${qualifiedElement(element, cursor.scope(element))}/processing-instruction()`,
			);
		};
		/** Each text Core reads under a subtree whose claim reads it, for a processing instruction
		 *  in it: the claim read the text without it, and Core does not. */
		const instructionsIn = (element: Element) => {
			chargeWork("visit", element.children.length);
			for (const child of element.children) {
				if (isTag(child)) instructionsIn(child);
				else if (child.type === "directive" && coreReadsTextOf(element))
					instructionInText(element);
			}
		};
		for (const child of cursor.document.children)
			if (isTag(child)) walk(child, undefined);
	}

	/** Every unclaimed use and unread admission becomes `unrecognized`; then the totals. */
	close(): {
		readonly findings: readonly Finding[];
		readonly work: Pick<ReadWork, "nodes" | "rebuilds">;
		readonly claims: ClaimLog;
		readonly defects: readonly ReaderDefect[];
	} {
		if (this.#closed)
			throw new Error(
				"The reader's accounting was closed twice. A reading closes its accounting once, at the end of its last stage.",
			);
		this.#closed = true;
		for (const cursor of this.#json) this.#closeJson(cursor);
		for (const cursor of this.#xml.values()) this.#closeXml(cursor);
		for (const watched of this.#watched) {
			if (watched.admitted.consumed) continue;
			this.defect(
				watched.place,
				watched.name,
				readerDefect.claimedNotRead(watched.place, watched.claim),
			);
		}
		const findings = this.#findings
			.map((finding, order) => ({ finding, order }))
			.sort(
				(a, b) =>
					placeOrder(a.finding.place, b.finding.place) || a.order - b.order,
			)
			.map(({ finding }) => finding);
		return {
			findings,
			...this.workAndClaims(),
			defects: [...this.#defects],
		};
	}

	/** Report only what the reading has already visited and claimed. A stopped
	 * reading uses this even if its final accounting pass was interrupted. */
	workAndClaims(): {
		work: Pick<ReadWork, "nodes" | "rebuilds">;
		claims: ClaimLog;
	} {
		const full = this.#full;
		const pending = this.#records;
		const claims: ClaimLog = {
			counts: Object.freeze({ ...this.#counts }),
			handOffs: Object.freeze([...this.#handOffs]),
			records(): IterableIterator<ClaimRecord> {
				if (!full)
					throw new Error(
						'This reading kept claim counts alone. Pass `claims: "full"` to `readHqApp` to keep every claim.',
					);
				const records: ClaimRecord[] = pending.map((record) => {
					const where = record.where();
					const at = record.at?.();
					return {
						artifact: record.artifact,
						where,
						key: record.key,
						entry: record.entry,
						standing: record.standing,
						...(at === undefined || at === where ? {} : { at }),
					};
				});
				records.sort(
					(a, b) =>
						compareText(a.artifact, b.artifact) ||
						compareText(a.where, b.where) ||
						compareText(a.key ?? "", b.key ?? "") ||
						compareText(a.entry, b.entry),
				);
				return records[Symbol.iterator]();
			},
		};
		return {
			work: {
				nodes: this.#nodesVisited,
				rebuilds: this.#rebuilds,
			},
			claims,
		};
	}
}
