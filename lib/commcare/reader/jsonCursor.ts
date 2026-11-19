/**
 * The cursor over one JSON object of an HQ app. Every key a reader stage
 * reads past goes through one of its claims; what no claim reaches is left for
 * `Accounting.close` to report. A key holding HQ's default for its class
 * (`surface/schemaDefaults.ts`) is no use: a claim on it records nothing but
 * a kept entry's and, where the claim takes the value whole, an allowing
 * entry's that splits the key by value (`ClaimLedger.claimAtDefault`), and an
 * absent declared key reads as that default and records nothing at all.
 */

import { NO_ENTRIES } from "@/lib/domain/records";
import type { FindingDetail, HqPlace } from "@/lib/publish/hqFindings";
import { schemaPropertyDefault } from "../surface/schemaDefaults";
import { chargeWork } from "../workMeter";
import type {
	Admitted,
	ClaimLedger,
	LedgerSite,
	ReadAtDefault,
} from "./accounting";
import type { Claim } from "./claims";

/** What a hand-off waits on: project data's media rules, or its lookup table rules. */
export type HandOffKind = "media-reference" | "lookup-table-read";

export interface JsonCursor {
	/** HQ's class of this object: `Application`, `Module`, `Form`, `DetailColumn` and so on. */
	readonly cls: string;
	/** RFC 6901 pointer from the app's root. */
	readonly pointer: string;
	readonly place: HqPlace;
	/** The stored value, or HQ's default for the class where the key is absent. Claims nothing. */
	peek(key: string): unknown;
	/** Whether the key holds a value other than the class's default, compared as JSON values. */
	used(key: string): boolean;
	/** Keys the class does not declare (`schemaPropertyDefault(cls, key).known` is false). */
	undeclared(): readonly string[];
	take<T>(
		key: string,
		claim: Claim<"take">,
		read: (value: unknown) => T,
	): Admitted<T>;
	/**
	 * The stage read `key` at HQ's default, stored or left out, as the value
	 * class of `claim`'s entry: recorded with no surface key, as a held claim
	 * that takes a default whole is (`ClaimLedger.claimAtDefault`). A key
	 * holding another value is no default and records nothing here.
	 */
	takeDefault(key: string, claim: Claim<"take">): void;
	derived(key: string, claim: Claim<"derived">): void;
	drop(key: string, claim: Claim<"drop">): void;
	/** `place` is where the finding stands where it is not this object's own:
	 *  a key of a menu that a person edits on its case list's page. */
	refuse(
		key: string,
		claim: Claim<"refuse">,
		detail?: FindingDetail,
		place?: HqPlace,
	): void;
	account(key: string, claim: Claim<"account">, detail?: FindingDetail): void;
	/**
	 * Record `claim` at `key`'s pointer for one part of what its value means
	 * that no key under it holds (`part` names it, one record a part), beside
	 * the key's own claim: a language a stored map leaves a catalog key out of.
	 */
	accountPart(key: string, part: string, claim: Claim<"account">): void;
	/**
	 * Record `claim` at `key`'s pointer for one part of what its held value holds that no key
	 * under it holds (`part` names it, one record a part), beside the key's own claim: a class of
	 * the runtime values a search row reads.
	 */
	takePart(key: string, part: string, claim: Claim<"take">): void;
	/**
	 * Refuse one part of `key`'s value (`part` names it, one finding a part) at
	 * `key`'s pointer, where the value the claim names sits, beside the key's
	 * own claim: a slot of `logo_refs` CommCare HQ's uploader did not write.
	 */
	refusePart(
		key: string,
		part: string,
		claim: Claim<"refuse">,
		detail?: FindingDetail,
	): void;
	/** Claim the container key and descend. The children are accounted on their own cursors. */
	object(
		key: string,
		cls: string,
		claim: ContainerClaim,
		place?: HqPlace,
	): JsonCursor;
	/**
	 * `cls` names every element's class, or picks each element's (a menu's from its `doc_type`).
	 * A list holding any member that is not an object is no list of the class: its key is left
	 * unclaimed and no cursor is given (`objectMembers`), so a cursor's index is always the
	 * member's stored position. `map` reads a map the same way.
	 */
	list(
		key: string,
		cls: ElementClass,
		claim: ContainerClaim,
		place?: (index: number, value: unknown) => HqPlace,
	): readonly JsonCursor[];
	map(
		key: string,
		cls: ElementClass,
		claim: ContainerClaim,
	): ReadonlyMap<string, JsonCursor>;
	/**
	 * Cursors on the objects of a list `key` whose own claim already covers it whole (a refusal),
	 * each covered by that claim, so none accounts a key: a stage records on them only the uses
	 * a value inside makes, at the value's own pointer (a detail tab's filter, which HQ's build
	 * writes into the suite).
	 */
	coveredList(key: string, cls: ElementClass): readonly JsonCursor[];
	/**
	 * Cover this object, every key at every depth, by one finding: at this
	 * object's place, or at `place` where the finding is another object's
	 * refusal this one belongs to. The claim is recorded at this object's
	 * pointer, or, for a claim naming a key of this object or the schema key
	 * of a key above it, at that key's pointer. A finding's entry is recorded
	 * also at each key it names around this object (`jsonCursor.ts::findingNodes`),
	 * or around `reads`, the pointer of the object its class reads where that
	 * is one holding this one (an open action whose index is refused for the
	 * repeat both stand in).
	 */
	refuseWhole(
		claim: Claim<"refuse" | "account">,
		detail?: FindingDetail,
		place?: HqPlace,
		reads?: string,
	): void;
	/**
	 * Record this object, which `refuseWhole` refused under a narrower class, as a value of
	 * `claim`'s wider class too: at the object, under its own class's key, and at each key in it,
	 * where `claim`'s entry names each, with no finding of its own (a mirror under a mirror
	 * menu is a version 2 mirror as well).
	 */
	alsoOfClass(claim: Claim<"refuse">): void;
	/**
	 * Cover this entry of a map (a `DictProperty`: an update map's
	 * `ConditionalCaseUpdate`), every key at every depth, by one finding about
	 * the entry's key. The claim names the map's own surface key, whose value is
	 * the map, so its record stands at the map's pointer, as every claim of a
	 * key stands where the key's value sits; `detail.name` names the entry.
	 */
	refuseMapEntry(claim: Claim<"refuse">, detail: FindingDetail): void;
	/**
	 * Record what this entry's key of a map is read as, under a claim that
	 * names the map's own surface key, at the map's pointer, as
	 * `refuseMapEntry` records a refusal there; the entry's own keys are each
	 * claimed on their own.
	 */
	holdMapEntry(claim: Claim<"take">): void;
	/** Read the class this object was dispatched to, at its own pointer
	 *  (`schema:<cls>`): its keys stay each one's own to claim. */
	takeClass(claim: Claim<"take">): Admitted<string>;
	/** Hand the key's value to project data: no claim here, a `HandOffRecord` in the log.
	 *  `subject` is the media path or the table's tag. */
	handOff(key: string, to: HandOffKind, subject: string): void;
}

/** A container's own claim: a finding is made with `refuseWhole`, never by descending. */
export type ContainerClaim = Claim<"take" | "derived" | "drop" | "account">;

/** The class of a container's elements: one for all, or one per element by what it holds. */
export type ElementClass =
	| string
	| ((element: Readonly<Record<string, unknown>>) => string);

function classOf(
	cls: ElementClass,
	element: Readonly<Record<string, unknown>>,
): string {
	return typeof cls === "string" ? cls : cls(element);
}

/** One JSON Pointer reference token (RFC 6901): `~` as `~0`, `/` as `~1`. */
export function pointerToken(key: string | number): string {
	return String(key).replaceAll("~", "~0").replaceAll("/", "~1");
}

type JsonObject = Readonly<Record<string, unknown>>;

export function isJsonObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether `cls` names one of HQ's object classes (the surface declares its `doc_type`), or picks
 *  each element's class, as a list of menus or forms does: a collection of it holds objects. */
function ofObjects(cls: ElementClass): boolean {
	return (
		typeof cls === "function" || schemaPropertyDefault(cls, "doc_type").known
	);
}

/**
 * The members of a list whose every member is an object, in their stored
 * positions; undefined for anything else. A list of HQ's objects is read
 * whole or not at all: a member of another shape (a `null`, which HQ's own
 * load reads as an object of the class at its defaults, or a string) leaves
 * the whole list unread, so its key is left unclaimed for the close to
 * report, and no reader ever holds a list whose positions are not the
 * stored ones. A list of another class (strings) is claimed whole and gives
 * no cursor.
 */
export function objectMembers(
	value: unknown,
): readonly JsonObject[] | undefined {
	return Array.isArray(value) && value.every(isJsonObject) ? value : undefined;
}

/** The entries of a map whose every value is an object; undefined for
 *  anything else, as `objectMembers` answers for a list. */
export function objectEntries(
	value: unknown,
): readonly (readonly [string, JsonObject])[] | undefined {
	if (!isJsonObject(value)) return undefined;
	const entries = Object.entries(value).filter(
		([, element]) => element !== undefined,
	);
	return entries.every(([, element]) => isJsonObject(element))
		? (entries as (readonly [string, JsonObject])[])
		: undefined;
}

/** The keys of `value` that hold a value: a key whose value is `undefined` is no key of JSON. */
function definedKeys(value: JsonObject): string[] {
	return Object.keys(value).filter((key) => value[key] !== undefined);
}

/** The class of an object of HQ's: its `doc_type` where the surface declares it, the app's own at the root. */
function hqClassOf(value: unknown, root: boolean): string | undefined {
	if (!isJsonObject(value)) return undefined;
	const cls = value.doc_type;
	if (typeof cls === "string" && schemaPropertyDefault(cls, "doc_type").known)
		return cls;
	return root ? "Application" : undefined;
}

/** Whether `name` is a key `cls` declares that `value` holds at another value than its default. */
function heldOff(cls: string, name: string, value: unknown): boolean {
	const declared = schemaPropertyDefault(cls, name);
	return (
		declared.known &&
		value !== undefined &&
		(declared.default === undefined || !sameJson(value, declared.default))
	);
}

/**
 * Every node a finding under an entry naming `keys` reads around the value at
 * `pointer` in the app's JSON (`root`): each key on the path from the root to
 * that value, and each key inside it, of an object of HQ's, that holds a value
 * other than its class's default and whose surface key `keys` holds. An
 * entry's class is a fact about every such value (a child case's index name is
 * one about the case's actions and the form's), so the lane's check decides
 * each of them under the entry, and the finding's claim stands at each.
 */
export function findingNodes(
	root: JsonObject,
	pointer: string,
	keys: ReadonlySet<string>,
): { readonly where: string; readonly key: string }[] {
	const found: { where: string; key: string }[] = [];
	let holder: unknown = root;
	let at = "";
	const tokens =
		pointer === ""
			? []
			: pointer
					.slice(1)
					.split("/")
					.map((token) => token.replaceAll("~1", "/").replaceAll("~0", "~"));
	for (const [index, token] of tokens.entries()) {
		const cls = hqClassOf(holder, index === 0);
		const value = Array.isArray(holder)
			? holder[Number(token)]
			: isJsonObject(holder)
				? holder[token]
				: undefined;
		at = `${at}/${pointerToken(token)}`;
		const key = `schema:${cls}.${token}`;
		if (cls !== undefined && keys.has(key) && heldOff(cls, token, value))
			found.push({ where: at, key });
		holder = value;
	}
	const inside = (value: unknown, where: string): void => {
		if (Array.isArray(value)) {
			value.forEach((element: unknown, index: number) => {
				inside(element, `${where}/${index}`);
			});
			return;
		}
		if (!isJsonObject(value)) return;
		const cls = hqClassOf(value, false);
		for (const name of definedKeys(value)) {
			const element = value[name];
			const child = `${where}/${pointerToken(name)}`;
			const key = `schema:${cls}.${name}`;
			if (cls !== undefined && keys.has(key) && heldOff(cls, name, element))
				found.push({ where: child, key });
			inside(element, child);
		}
	};
	inside(holder, at);
	return found;
}

/**
 * Two JSON values alike, as their JSON text would be once each object's keys
 * were sorted: equal scalars, arrays alike element by element, objects alike
 * key by key whatever order their keys were written in. A key whose value is
 * `undefined` is absent, as `JSON.stringify` and every store Nova writes
 * through leave it out. The reader's one structural equality of stored values.
 */
export function sameJson(a: unknown, b: unknown): boolean {
	const compared = { nodes: 0 };
	const same = alikeJson(a, b, compared);
	// The work meter's `compare` door: one unit a pair of values compared.
	chargeWork("compare", compared.nodes);
	return same;
}

function alikeJson(
	a: unknown,
	b: unknown,
	compared: { nodes: number },
): boolean {
	compared.nodes += 1;
	if (a === b) return true;
	if (Array.isArray(a)) {
		return (
			Array.isArray(b) &&
			a.length === b.length &&
			a.every((value, index) => alikeJson(value, b[index], compared))
		);
	}
	if (isJsonObject(a) && isJsonObject(b)) {
		const keys = definedKeys(a);
		return (
			keys.length === definedKeys(b).length &&
			keys.every(
				(key) => Object.hasOwn(b, key) && alikeJson(a[key], b[key], compared),
			)
		);
	}
	return false;
}

/**
 * The claim a key a class does not declare stands under where no stage visits
 * the object that holds it: an object a held claim took whole with its key.
 * Undefined leaves the key for the close, as `unrecognized`.
 */
export type UndeclaredKeyRule = (
	key: string,
) => Claim<"drop" | "refuse"> | undefined;

const UNDECLARED_KEY_RULES = new Map<string, UndeclaredKeyRule>();

/**
 * Registers the rule of the keys `cls` does not declare, which the stage that
 * reads such an object applies to its own cursor too, so a key reads alike
 * whether a stage visits its object or a held claim took it whole. One rule a
 * class: the module that registers it, evaluated again, replaces it.
 */
export function registerUndeclaredKeys(
	cls: string,
	rule: UndeclaredKeyRule,
): UndeclaredKeyRule {
	UNDECLARED_KEY_RULES.set(cls, rule);
	return rule;
}

/** The marker of a whole-object claim among a cursor's key sites. */
const WHOLE = "\u0000whole";
/** The marker of the object's own class among a cursor's key sites. */
const CLASS = "\u0000class";
/** The marker of a map entry's key, read at the map, among a cursor's key sites. */
const MAP_KEY = "\u0000mapKey";
/** What separates a key from one part of its meaning among a cursor's key sites. */
const PART = "\u0000part\u0000";

/** The cursor `Accounting.json` and the container claims make. */
export class JsonCursorImpl implements JsonCursor {
	/** Set by `refuseWhole`: every key at every depth is covered. */
	whole = false;
	/**
	 * Set on an object of HQ's (one carrying a `doc_type` the surface declares)
	 * inside a value a held claim took whole with its key (`take`, `derived`):
	 * the claim stands for every key the class declares, and a key it does not
	 * declare is this object's own use, claimed by the class's
	 * `UndeclaredKeyRule` or left for the close, which reports it.
	 */
	sealed = false;

	constructor(
		private readonly ledger: ClaimLedger,
		readonly value: JsonObject,
		readonly cls: string,
		readonly pointer: string,
		readonly place: HqPlace,
		readonly parent: JsonCursorImpl | null,
	) {
		ledger.registerJson(this);
	}

	/** Whether a whole-object claim covers this object, here or above. */
	covered(): boolean {
		for (let at: JsonCursorImpl | null = this; at !== null; at = at.parent)
			if (at.whole) return true;
		return false;
	}

	/** Whether the held claim that took this object whole stands for `key`. */
	sealedOver(key: string): boolean {
		return this.sealed && schemaPropertyDefault(this.cls, key).known;
	}

	/**
	 * After a held claim took `key`'s value whole: every object of HQ's inside
	 * it gets a sealed cursor, so a key its class does not declare is claimed by
	 * the class's rule or reported at the close, never held under the claim.
	 * HQ's model keeps such a key as a dynamic property (jsonobject's
	 * `_allow_dynamic_properties`), which no reading of the value holds.
	 */
	private seal(key: string): void {
		this.sealWithin(
			this.value[key],
			`${this.pointer}/${pointerToken(key)}`,
			this,
		);
	}

	private sealWithin(
		value: unknown,
		pointer: string,
		parent: JsonCursorImpl,
	): void {
		if (Array.isArray(value)) {
			value.forEach((element: unknown, index: number) => {
				this.sealWithin(element, `${pointer}/${index}`, parent);
			});
			return;
		}
		if (!isJsonObject(value)) return;
		const cls = value.doc_type;
		if (
			typeof cls !== "string" ||
			!schemaPropertyDefault(cls, "doc_type").known
		) {
			for (const [name, element] of Object.entries(value))
				this.sealWithin(element, `${pointer}/${pointerToken(name)}`, parent);
			return;
		}
		const child = new JsonCursorImpl(
			this.ledger,
			value,
			cls,
			pointer,
			this.place,
			parent,
		);
		child.sealed = true;
		const rule = UNDECLARED_KEY_RULES.get(cls);
		for (const [name, element] of Object.entries(value)) {
			if (schemaPropertyDefault(cls, name).known) {
				this.sealWithin(element, `${pointer}/${pointerToken(name)}`, child);
				continue;
			}
			const claim = rule?.(name);
			if (claim === undefined) continue;
			child.plain(name, claim, claim.use === "refuse" ? { name } : undefined);
		}
	}

	/** The surface name of a key, as an `unrecognized` finding names it. */
	keyName(key: string): string {
		return schemaPropertyDefault(this.cls, key).known
			? `schema:${this.cls}.${key}`
			: `${this.cls}.${key}`;
	}

	/** `key`'s node; `claim`, where given, is the claim recorded there, which decides where its
	 *  record stands (`recordedAt`). */
	site(key: string, claim?: Claim): LedgerSite {
		const name = this.keyName(key);
		return {
			owner: this,
			sub: key,
			artifact: "app.json",
			where: this.recordedAt(key, name, claim?.key ?? null),
			at: () => `${this.pointer}/${pointerToken(key)}`,
			name,
			reads: () => this.pointer,
		};
	}

	/**
	 * Where a claim on `key` is recorded: where the value of the surface key it
	 * names sits. That is the key's own pointer, unless the claim names the
	 * schema key of an object this one stands in (a profile setting refused
	 * under `schema:Application.profile`, whose value is the whole profile):
	 * then it is that key's pointer.
	 */
	private recordedAt(
		key: string,
		name: string,
		named: string | null,
	): () => string {
		const own = `${this.pointer}/${pointerToken(key)}`;
		if (named === null || named === name) return () => own;
		const above = this.heldAbove(named);
		return () => above ?? own;
	}

	/**
	 * The pointer of the key above this object whose surface key is `named`:
	 * where the value of a schema key of an object this one stands in sits.
	 * Undefined where no key above names it.
	 */
	private heldAbove(named: string): string | undefined {
		if (!named.startsWith("schema:")) return undefined;
		for (
			let child: JsonCursorImpl = this, holder = this.parent;
			holder !== null;
			child = holder, holder = holder.parent
		) {
			const [token = ""] = child.pointer
				.slice(holder.pointer.length + 1)
				.split("/");
			const held = token.replaceAll("~1", "/").replaceAll("~0", "~");
			if (holder.keyName(held) === named) return `${holder.pointer}/${token}`;
		}
		return undefined;
	}

	/** The pointer of this object's own key whose surface key is `named`, where it holds one. */
	private heldHere(named: string): string | undefined {
		const prefix = `schema:${this.cls}.`;
		if (!named.startsWith(prefix)) return undefined;
		const key = named.slice(prefix.length);
		return Object.hasOwn(this.value, key) && this.value[key] !== undefined
			? `${this.pointer}/${pointerToken(key)}`
			: undefined;
	}

	peek(key: string): unknown {
		return Object.hasOwn(this.value, key)
			? this.value[key]
			: schemaPropertyDefault(this.cls, key).default;
	}

	used(key: string): boolean {
		if (!Object.hasOwn(this.value, key)) return false;
		const known = schemaPropertyDefault(this.cls, key);
		if (!known.known || known.default === undefined) return true;
		return !sameJson(this.value[key], known.default);
	}

	undeclared(): readonly string[] {
		return Object.keys(this.value).filter(
			(key) => !schemaPropertyDefault(this.cls, key).known,
		);
	}

	take<T>(
		key: string,
		claim: Claim<"take">,
		read: (value: unknown) => T,
	): Admitted<T> {
		const value = read(this.peek(key));
		if (!this.used(key)) {
			this.atDefault(key, claim, "whole");
			return this.ledger.unrecorded(value);
		}
		const site = this.site(key, claim);
		if (!this.ledger.claim(site, claim, this.place))
			return this.ledger.unrecorded(value);
		this.seal(key);
		this.within(key, claim);
		return this.ledger.admit(value, site, claim, this.place);
	}

	takeDefault(key: string, claim: Claim<"take">): void {
		if (this.used(key)) return;
		this.ledger.claimAtDefault(this.site(key, claim), claim, "whole");
	}

	derived(key: string, claim: Claim<"derived">): void {
		this.plain(key, claim);
	}

	drop(key: string, claim: Claim<"drop">): void {
		this.plain(key, claim);
	}

	refuse(
		key: string,
		claim: Claim<"refuse">,
		detail?: FindingDetail,
		place?: HqPlace,
	): void {
		this.plain(key, claim, detail, place);
	}

	account(key: string, claim: Claim<"account">, detail?: FindingDetail): void {
		this.plain(key, claim, detail);
	}

	accountPart(key: string, part: string, claim: Claim<"account">): void {
		if (!this.used(key)) return;
		this.ledger.claim(
			{ ...this.site(key), sub: `${key}${PART}${part}` },
			claim,
			this.place,
		);
	}

	takePart(key: string, part: string, claim: Claim<"take">): void {
		if (!this.used(key)) return;
		this.ledger.claim(
			{ ...this.site(key), sub: `${key}${PART}${part}` },
			claim,
			this.place,
		);
	}

	refusePart(
		key: string,
		part: string,
		claim: Claim<"refuse">,
		detail?: FindingDetail,
	): void {
		if (!this.used(key)) return;
		this.ledger.claim(
			{ ...this.site(key, claim), sub: `${key}${PART}${part}` },
			claim,
			this.place,
			detail,
		);
	}

	private plain(
		key: string,
		claim: Claim,
		detail?: FindingDetail,
		place: HqPlace = this.place,
	): void {
		if (!this.used(key)) {
			this.atDefault(key, claim, "whole");
			return;
		}
		if (!this.ledger.claim(this.site(key, claim), claim, place, detail)) return;
		if (claim.use === "derived") this.seal(key);
		if (claim.use !== "refuse") this.within(key, claim);
	}

	/**
	 * Where a claim that took `key`'s value whole stands inside it: each key of
	 * each of HQ's objects in the value (one carrying a `doc_type` the surface
	 * declares) that holds a value other than its class's default, at the key's
	 * own pointer, under the claim's entry where the entry names the key
	 * (`ClaimLedger.within`), so the claim's record stands where each value it
	 * reads sits. A key the class does not declare is its undeclared-key item
	 * (`schema:<cls>.<undeclared>`) and is recorded here only under a claim that
	 * reads past the value (`drop`, `account`): under one that reads it
	 * (`take`, `derived`) the class's own rule claims it (`seal`).
	 */
	private within(key: string, claim: Claim): void {
		this.withinValue(
			this.value[key],
			`${this.pointer}/${pointerToken(key)}`,
			claim,
		);
	}

	private withinValue(value: unknown, pointer: string, claim: Claim): void {
		if (Array.isArray(value)) {
			value.forEach((element: unknown, index: number) => {
				this.withinValue(element, `${pointer}/${index}`, claim);
			});
			return;
		}
		if (!isJsonObject(value)) return;
		const cls = value.doc_type;
		const hqObject =
			typeof cls === "string" && schemaPropertyDefault(cls, "doc_type").known;
		const readsPast = claim.use === "drop" || claim.use === "account";
		for (const name of definedKeys(value)) {
			const at = `${pointer}/${pointerToken(name)}`;
			const element = value[name];
			if (hqObject) {
				const declared = schemaPropertyDefault(cls, name);
				const keys = declared.known
					? declared.default === undefined ||
						!sameJson(element, declared.default)
						? [`schema:${cls}.${name}`]
						: []
					: readsPast
						? [`schema:${cls}.<undeclared>`, `schema:${cls}.${name}`]
						: [];
				if (keys.length > 0)
					this.ledger.within(
						{
							owner: value,
							sub: name,
							artifact: "app.json",
							where: () => at,
							name: keys[0] as string,
						},
						claim,
						keys,
					);
			}
			this.withinValue(element, at, claim);
		}
	}

	/** A claim on a key the object holds at HQ's default, which the ledger
	 *  records only where the reading met the entry there
	 *  (`ClaimLedger.claimAtDefault`). `read` says whether the claim takes the
	 *  value whole or only opens the container to claim what it holds. */
	private atDefault(key: string, claim: Claim, read: ReadAtDefault): void {
		if (Object.hasOwn(this.value, key) && this.value[key] !== undefined)
			this.ledger.claimAtDefault(this.site(key, claim), claim, read);
	}

	/** A child cursor no key reaches: it holds nothing to account. */
	private empty(cls: string, pointer: string, place: HqPlace): JsonCursorImpl {
		return new JsonCursorImpl(
			this.ledger,
			NO_ENTRIES,
			cls,
			pointer,
			place,
			this,
		);
	}

	/**
	 * Claims a container key whose value has the expected shape: an object, or
	 * a list or map every member of which is one. A used value of another
	 * shape is left unclaimed, for the close to report; a value at
	 * its default is no use and claims nothing but a kept entry's record.
	 * Answers whether to descend, and
	 * whether the children stand under the claim (false where the claim was a
	 * second one, whose children the first claim's cursors already account).
	 */
	private container(
		key: string,
		claim: ContainerClaim,
		shaped: boolean,
	): "descend" | "covered" | "skip" {
		if (!shaped) return "skip";
		if (!this.used(key)) {
			this.atDefault(key, claim, "opened");
			return "descend";
		}
		return this.ledger.claim(this.site(key, claim), claim, this.place)
			? "descend"
			: "covered";
	}

	object(
		key: string,
		cls: string,
		claim: ContainerClaim,
		place: HqPlace = this.place,
	): JsonCursor {
		const value = this.peek(key);
		const pointer = `${this.pointer}/${pointerToken(key)}`;
		const verdict = this.container(key, claim, isJsonObject(value));
		if (verdict === "skip" || !isJsonObject(value))
			return this.empty(cls, pointer, place);
		const child = new JsonCursorImpl(
			this.ledger,
			value,
			cls,
			pointer,
			place,
			this,
		);
		if (verdict === "covered") child.whole = true;
		return child;
	}

	list(
		key: string,
		cls: ElementClass,
		claim: ContainerClaim,
		place?: (index: number, value: unknown) => HqPlace,
	): readonly JsonCursor[] {
		const value = this.peek(key);
		const members = objectMembers(value);
		const verdict = this.container(
			key,
			claim,
			members !== undefined || (Array.isArray(value) && !ofObjects(cls)),
		);
		if (verdict === "skip" || members === undefined) return [];
		const base = `${this.pointer}/${pointerToken(key)}`;
		return members.map((element, index) => {
			const child = new JsonCursorImpl(
				this.ledger,
				element,
				classOf(cls, element),
				`${base}/${index}`,
				place === undefined ? this.place : place(index, element),
				this,
			);
			if (verdict === "covered") child.whole = true;
			return child;
		});
	}

	coveredList(key: string, cls: ElementClass): readonly JsonCursor[] {
		const members = objectMembers(this.peek(key));
		if (members === undefined) return [];
		const base = `${this.pointer}/${pointerToken(key)}`;
		const children: JsonCursor[] = [];
		members.forEach((element, index) => {
			const child = new JsonCursorImpl(
				this.ledger,
				element,
				classOf(cls, element),
				`${base}/${index}`,
				this.place,
				this,
			);
			child.whole = true;
			children.push(child);
		});
		return children;
	}

	map(
		key: string,
		cls: ElementClass,
		claim: ContainerClaim,
	): ReadonlyMap<string, JsonCursor> {
		const value = this.peek(key);
		const entries = objectEntries(value);
		const verdict = this.container(
			key,
			claim,
			entries !== undefined || (isJsonObject(value) && !ofObjects(cls)),
		);
		const children = new Map<string, JsonCursor>();
		if (verdict === "skip" || entries === undefined) return children;
		const base = `${this.pointer}/${pointerToken(key)}`;
		for (const [name, element] of entries) {
			const child = new JsonCursorImpl(
				this.ledger,
				element,
				classOf(cls, element),
				`${base}/${pointerToken(name)}`,
				this.place,
				this,
			);
			if (verdict === "covered") child.whole = true;
			children.set(name, child);
		}
		return children;
	}

	refuseWhole(
		claim: Claim<"refuse" | "account">,
		detail?: FindingDetail,
		place?: HqPlace,
		reads?: string,
	): void {
		// A whole object refused or read past under a key of its own (a load refused for its
		// auto-select) or under the schema key of a key above it (a language the app does not
		// hold, under `schema:Application.translations`) stands where that key's value sits, as
		// every claim naming a key above does (`recordedAt`).
		const where =
			claim.key === null
				? undefined
				: (this.heldHere(claim.key) ?? this.heldAbove(claim.key));
		this.ledger.claim(
			{
				owner: this,
				sub: WHOLE,
				artifact: "app.json",
				where: () => where ?? this.pointer,
				at: () => this.pointer,
				name: `schema:${this.cls}`,
				reads: () => reads ?? this.pointer,
			},
			claim,
			place ?? this.place,
			detail,
		);
		this.whole = true;
	}

	alsoOfClass(claim: Claim<"refuse">): void {
		const key = `schema:${this.cls}`;
		this.ledger.within(
			{
				owner: this,
				sub: WHOLE,
				artifact: "app.json",
				where: () => this.pointer,
				name: key,
			},
			claim,
			[key],
		);
		this.withinValue(this.value, this.pointer, claim);
	}

	/** This entry's site at the map that holds it: where the map's own key sits. */
	private mapSite(sub: string): LedgerSite {
		const map = this.pointer.slice(0, this.pointer.lastIndexOf("/"));
		return {
			owner: this,
			sub,
			artifact: "app.json",
			where: () => map,
			at: () => this.pointer,
			name: `schema:${this.cls}`,
			reads: () => this.pointer,
		};
	}

	refuseMapEntry(claim: Claim<"refuse">, detail: FindingDetail): void {
		this.ledger.claim(this.mapSite(WHOLE), claim, this.place, detail);
		this.whole = true;
	}

	holdMapEntry(claim: Claim<"take">): void {
		this.ledger.claim(this.mapSite(MAP_KEY), claim, this.place);
	}

	takeClass(claim: Claim<"take">): Admitted<string> {
		const site: LedgerSite = {
			owner: this,
			sub: CLASS,
			artifact: "app.json",
			where: () => this.pointer,
			name: `schema:${this.cls}`,
		};
		return this.ledger.claim(site, claim, this.place)
			? this.ledger.admit(this.cls, site, claim, this.place)
			: this.ledger.unrecorded(this.cls);
	}

	handOff(key: string, to: HandOffKind, subject: string): void {
		if (!this.used(key)) return;
		const site = this.site(key);
		this.ledger.handOff(site, `schema:${this.cls}.${key}`, to, subject);
	}
}
