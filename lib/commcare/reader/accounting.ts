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
 * Two uses are handed off instead of claimed, because project data's rules
 * name their entry: a media path the index gives no file for, and an itemset
 * over a table the catalog lacks. They are listed in the log for the caller to
 * settle.
 */

import { type Document, type Element, isTag } from "domhandler";
import type { Uuid } from "@/lib/domain";
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
} from "@/lib/publish/hqFindings";
import type { InventoryIndex } from "../surface/inventory";
import { elementNamespace, namespaceScopes, splitName } from "../xmlNamespaces";
import {
	type Claim,
	claimName,
	claimNameForEntry,
	claimPermits,
	defineClaims,
	drop,
} from "./claims";
import { type ReaderDefectWhy, readerDefect } from "./defects";
import type { IdentityClaim } from "./identity";
import {
	type HandOffKind,
	type JsonCursor,
	JsonCursorImpl,
} from "./jsonCursor";
import { placeOrder, whereText } from "./place";
import type { ReaderDefect, ReadWork } from "./types";
import {
	qualifiedElement,
	type XmlCursor,
	XmlCursorImpl,
	type XmlNode,
} from "./xmlCursor";

const CLAIMS = defineClaims("accounting", {
	/** A comment or a processing instruction in a form's source, which no reader reads. */
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
	readonly where: string;
	readonly key: string | null;
	readonly entry: string;
	readonly standing: ReadStanding;
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

/** One JSON object per line, keys in `ClaimRecord`'s order, in `records()` order, `\n` ended. */
export function serializeClaimLog(log: ClaimLog): string {
	let text = "";
	for (const record of log.records())
		text += `${JSON.stringify({
			artifact: record.artifact,
			where: record.where,
			key: record.key,
			entry: record.entry,
			standing: record.standing,
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
	/** The surface name an `unrecognized` finding here takes. */
	readonly name: string;
}

/** What the cursors ask of the accounting. */
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
	/** The element's own text is claimed with it. */
	claimText(element: Element): void;
	/** Everything under the element is claimed. */
	coverSubtree(element: Element): void;
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
	/** Claims `claimEntry` applied, by their surface key. */
	readonly entries: Map<string, string>;
	/** Covered by a finding already raised, or handed off. */
	settled: boolean;
}

interface PendingRecord {
	readonly artifact: string;
	readonly where: () => string;
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
	readonly #watched: Watched[] = [];
	readonly #findings: Finding[] = [];
	readonly #findingKeys = new Set<string>();
	readonly #defects: ReaderDefect[] = [];
	readonly #counts: Record<string, number> = {};
	readonly #records: PendingRecord[] = [];
	readonly #handOffs: HandOffRecord[] = [];
	#syntaxReads = 0;
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

	/** A text read with `readFormSyntax`, for `ReadWork`. */
	noteSyntaxRead(): void {
		this.#syntaxReads += 1;
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

	#state(site: LedgerSite): NodeState {
		let byOwner = this.#nodes.get(site.owner);
		if (byOwner === undefined) {
			byOwner = new Map();
			this.#nodes.set(site.owner, byOwner);
		}
		let state = byOwner.get(site.sub);
		if (state === undefined) {
			state = { entries: new Map(), settled: false };
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
		if (this.#full)
			this.#records.push({
				artifact: site.artifact,
				where: site.where,
				key,
				entry,
				standing,
			});
	}

	#push(finding: Finding): void {
		const key = `${finding.code}\u0000${whereText(finding.place)}\u0000${finding.detail.name ?? ""}`;
		if (this.#findingKeys.has(key)) return;
		this.#findingKeys.add(key);
		this.#findings.push(finding);
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
			place,
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
			(claim.key === null ? undefined : state.entries.get(claim.key));
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
		this.#record(site, claim.key, entry.id, entry.standing);
		if (this.#makesFinding(claim.use, entry.standing))
			this.#manifestFinding(entry.id, place, detail);
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

	claimText(element: Element): void {
		this.#textClaimed.add(element);
	}

	coverSubtree(element: Element): void {
		this.#subtrees.add(element);
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
	 * standing one that makes a finding; any other is the defect D2, whose
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
	 * Applies a claim another stage decided by entry id. The use follows the
	 * entry's standing: `held` is a consumed `take`, `inert` and `kept` a
	 * `drop`, any other a `refuse`. Several such claims may hold one node, one
	 * per surface key.
	 */
	claimEntry(
		site: ClaimSite,
		entryId: string,
		key: string,
		place: HqPlace,
		detail?: FindingDetail,
	): void {
		const ledgerSite = this.#site(site);
		if (ledgerSite === undefined) return;
		const state = this.#state(ledgerSite);
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
		const first =
			state.entries.get(key) ??
			(state.declaredKey === key ? state.declared : undefined);
		if (first !== undefined) {
			this.defect(
				place,
				ledgerSite.name,
				readerDefect.claimedTwice(place, first, registered),
			);
			return;
		}
		state.entries.set(key, registered);
		this.#record(ledgerSite, key, entry.id, entry.standing);
		if (this.#makesFinding("account", entry.standing))
			this.#manifestFinding(entry.id, place, detail);
	}

	/** Whether some finding already stands at exactly `place`: a check whose inputs a finding
	 *  there withheld is skipped, and that finding sends the person to the place. */
	hasFindingAt(place: HqPlace): boolean {
		const where = whereText(place);
		return this.#findings.some((finding) => whereText(finding.place) === where);
	}

	/** Every finding raised so far, in the order raised: what a later stage names a node it covers
	 *  by. The close adds the unclaimed uses and sorts. */
	findings(): readonly Finding[] {
		return [...this.#findings];
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
	 * An identity the resolver answered. A key met twice that no stage claimed
	 * first under its manifest entry is `unrecognized` at the second place,
	 * with the surface key of the node being minted, and the defect D4.
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
			(state.settled || state.declared !== undefined || state.entries.size > 0)
		);
	}

	#closeJson(cursor: JsonCursorImpl): void {
		const covered = cursor.covered();
		for (const key of Object.keys(cursor.value)) {
			this.#nodesVisited += 1;
			if (covered || this.#claimed(cursor, key) || !cursor.used(key)) continue;
			this.#unrecognized(cursor.place, cursor.keyName(key));
		}
	}

	#closeXml(cursor: XmlCursorImpl): void {
		const walk = (
			element: Element,
			parentNamespace: string | null | undefined,
		) => {
			this.#nodesVisited += 1;
			if (this.#subtrees.has(element)) return;
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
		for (const child of cursor.document.children)
			if (isTag(child)) walk(child, undefined);
	}

	/** Every unclaimed use and unread admission becomes `unrecognized`; then the totals. */
	close(): {
		readonly findings: readonly Finding[];
		readonly work: ReadWork;
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
				const records: ClaimRecord[] = pending.map((record) => ({
					artifact: record.artifact,
					where: record.where(),
					key: record.key,
					entry: record.entry,
					standing: record.standing,
				}));
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
			findings,
			work: {
				nodes: this.#nodesVisited,
				syntaxReads: this.#syntaxReads,
				rebuilds: this.#rebuilds,
			},
			claims,
			defects: [...this.#defects],
		};
	}
}
