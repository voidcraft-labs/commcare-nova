/**
 * The cursor over one JSON object of an HQ app. Every key a reader stage
 * reads past goes through one of its claims; what no claim reaches is left for
 * `Accounting.close` to report. A key holding HQ's default for its class
 * (`surface/schemaDefaults.ts`) is no use: a claim on it records nothing, and
 * an absent declared key reads as that default.
 */

import type { FindingDetail, HqPlace } from "@/lib/publish/hqFindings";
import { schemaPropertyDefault } from "../surface/schemaDefaults";
import type { Admitted, ClaimLedger, LedgerSite } from "./accounting";
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
	derived(key: string, claim: Claim<"derived">): void;
	drop(key: string, claim: Claim<"drop">): void;
	refuse(key: string, claim: Claim<"refuse">, detail?: FindingDetail): void;
	account(key: string, claim: Claim<"account">, detail?: FindingDetail): void;
	/** Claim the container key and descend. The children are accounted on their own cursors. */
	object(
		key: string,
		cls: string,
		claim: ContainerClaim,
		place?: HqPlace,
	): JsonCursor;
	/** `cls` names every element's class, or picks each element's (a menu's from its `doc_type`). */
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
	/** Cover this object, every key at every depth, by one finding. */
	refuseWhole(claim: Claim<"refuse" | "account">, detail?: FindingDetail): void;
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

/** Two JSON values alike: equal scalars, arrays alike element by element, objects alike key by key. */
export function sameJson(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (Array.isArray(a)) {
		return (
			Array.isArray(b) &&
			a.length === b.length &&
			a.every((value, index) => sameJson(value, b[index]))
		);
	}
	if (isJsonObject(a) && isJsonObject(b)) {
		const keys = Object.keys(a);
		return (
			keys.length === Object.keys(b).length &&
			keys.every((key) => Object.hasOwn(b, key) && sameJson(a[key], b[key]))
		);
	}
	return false;
}

/** The marker of a whole-object claim among a cursor's key sites. */
const WHOLE = "\u0000whole";

/** The cursor `Accounting.json` and the container claims make. */
export class JsonCursorImpl implements JsonCursor {
	/** Set by `refuseWhole`: every key at every depth is covered. */
	whole = false;

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

	/** The surface name of a key, as an `unrecognized` finding names it. */
	keyName(key: string): string {
		return schemaPropertyDefault(this.cls, key).known
			? `schema:${this.cls}.${key}`
			: `${this.cls}.${key}`;
	}

	site(key: string): LedgerSite {
		return {
			owner: this,
			sub: key,
			artifact: "app.json",
			where: () => `${this.pointer}/${pointerToken(key)}`,
			name: this.keyName(key),
		};
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
		if (!this.used(key)) return this.ledger.unrecorded(value);
		const site = this.site(key);
		return this.ledger.claim(site, claim, this.place)
			? this.ledger.admit(value, site, claim, this.place)
			: this.ledger.unrecorded(value);
	}

	derived(key: string, claim: Claim<"derived">): void {
		this.plain(key, claim);
	}

	drop(key: string, claim: Claim<"drop">): void {
		this.plain(key, claim);
	}

	refuse(key: string, claim: Claim<"refuse">, detail?: FindingDetail): void {
		this.plain(key, claim, detail);
	}

	account(key: string, claim: Claim<"account">, detail?: FindingDetail): void {
		this.plain(key, claim, detail);
	}

	private plain(key: string, claim: Claim, detail?: FindingDetail): void {
		if (this.used(key))
			this.ledger.claim(this.site(key), claim, this.place, detail);
	}

	/** A child cursor no key reaches: it holds nothing to account. */
	private empty(cls: string, pointer: string, place: HqPlace): JsonCursorImpl {
		return new JsonCursorImpl(this.ledger, {}, cls, pointer, place, this);
	}

	/**
	 * Claims a container key whose value has the expected shape. A used value
	 * of another shape is left unclaimed, for the close to report; a value at
	 * its default is no use and claims nothing. Answers whether to descend, and
	 * whether the children stand under the claim (false where the claim was a
	 * second one, whose children the first claim's cursors already account).
	 */
	private container(
		key: string,
		claim: ContainerClaim,
		shaped: boolean,
	): "descend" | "covered" | "skip" {
		if (!shaped) return "skip";
		if (!this.used(key)) return "descend";
		return this.ledger.claim(this.site(key), claim, this.place)
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
		const verdict = this.container(key, claim, Array.isArray(value));
		if (verdict === "skip" || !Array.isArray(value)) return [];
		const base = `${this.pointer}/${pointerToken(key)}`;
		const children: JsonCursor[] = [];
		value.forEach((element: unknown, index: number) => {
			if (!isJsonObject(element)) return;
			const child = new JsonCursorImpl(
				this.ledger,
				element,
				classOf(cls, element),
				`${base}/${index}`,
				place === undefined ? this.place : place(index, element),
				this,
			);
			if (verdict === "covered") child.whole = true;
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
		const verdict = this.container(key, claim, isJsonObject(value));
		const children = new Map<string, JsonCursor>();
		if (verdict === "skip" || !isJsonObject(value)) return children;
		const base = `${this.pointer}/${pointerToken(key)}`;
		for (const [name, element] of Object.entries(value)) {
			if (!isJsonObject(element)) continue;
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
	): void {
		this.ledger.claim(
			{
				owner: this,
				sub: WHOLE,
				artifact: "app.json",
				where: () => this.pointer,
				name: `schema:${this.cls}`,
			},
			claim,
			this.place,
			detail,
		);
		this.whole = true;
	}

	handOff(key: string, to: HandOffKind, subject: string): void {
		if (!this.used(key)) return;
		const site = this.site(key);
		this.ledger.handOff(site, `schema:${this.cls}.${key}`, to, subject);
	}
}
