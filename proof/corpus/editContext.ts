/**
 * The deterministic toolkit the edit-batch generator draws with: a seeded
 * random source, an identity minter keyed by (document id, kind, seed,
 * counter), the rewrite that gives every identity a production planner minted
 * at random a deterministic one, and read-only walks over a hydrated document.
 *
 * Production planners mint new entities with `crypto.randomUUID()` because an
 * editor gesture happens once. A corpus edit must happen the same way on every
 * run, so every UUID a planner's batch introduces is renamed, consistently
 * across the whole batch, to one this minter derives. The rename is an
 * identity rename over opaque tokens: it changes which UUID an entity has,
 * never what the batch does.
 */

import { createHash } from "node:crypto";
import { produce } from "immer";
import { applyMutations } from "@/lib/doc/mutations";
import type { Mutation } from "@/lib/doc/types";
import {
	asMediaAssetId,
	asUuid,
	type BlueprintDoc,
	CANONICAL_UUID_PATTERN,
	type Field,
	isContainer,
	type MediaAssetId,
	type Uuid,
} from "@/lib/domain";

/** A seeded pseudo-random source (sfc32, seeded from SHA-256 of the key). */
export class Rng {
	private a: number;
	private b: number;
	private c: number;
	private d: number;

	constructor(key: string) {
		const digest = createHash("sha256").update(key).digest();
		this.a = digest.readUInt32LE(0);
		this.b = digest.readUInt32LE(4);
		this.c = digest.readUInt32LE(8);
		this.d = digest.readUInt32LE(12);
		for (let i = 0; i < 12; i += 1) this.next();
	}

	/** A float in [0, 1). */
	next(): number {
		this.a >>>= 0;
		this.b >>>= 0;
		this.c >>>= 0;
		this.d >>>= 0;
		let t = (this.a + this.b) | 0;
		this.a = this.b ^ (this.b >>> 9);
		this.b = (this.c + (this.c << 3)) | 0;
		this.c = (this.c << 21) | (this.c >>> 11);
		this.d = (this.d + 1) | 0;
		t = (t + this.d) | 0;
		this.c = (this.c + t) | 0;
		return (t >>> 0) / 4294967296;
	}

	/** An integer in [0, bound). */
	int(bound: number): number {
		return Math.floor(this.next() * bound);
	}

	/** A seeded permutation of `items`; the input is left untouched. */
	shuffle<T>(items: readonly T[]): T[] {
		const out = [...items];
		for (let i = out.length - 1; i > 0; i -= 1) {
			const j = this.int(i + 1);
			const held = out[i] as T;
			out[i] = out[j] as T;
			out[j] = held;
		}
		return out;
	}
}

/** Stable 32-bit hash of a key, for ordering documents and kinds by seed. */
export function stableHash(key: string): number {
	return createHash("sha256").update(key).digest().readUInt32LE(0);
}

/**
 * Mints every new identity an edit needs from (key, seed, counter), where the
 * key names the document and the kind being drawn, so the same document,
 * kind and seed always receive the same batch whatever else was tried.
 */
export class Minter {
	private counter = 0;
	private readonly minted = new Set<string>();

	constructor(
		private readonly key: string,
		private readonly seed: number,
	) {}

	/** The next counter value; also the suffix of every minted name. */
	private tick(): number {
		this.counter += 1;
		return this.counter;
	}

	uuid(): Uuid {
		const hex = createHash("sha256")
			.update(`${this.key}\u0000${this.seed}\u0000${this.tick()}`)
			.digest("hex");
		const uuid = asUuid(
			[
				hex.slice(0, 8),
				hex.slice(8, 12),
				`5${hex.slice(13, 16)}`,
				`${"89ab"[Number.parseInt(hex.slice(16, 17), 16) % 4]}${hex.slice(17, 20)}`,
				hex.slice(20, 32),
			].join("-"),
		);
		this.minted.add(uuid);
		return uuid;
	}

	mediaId(): MediaAssetId {
		return asMediaAssetId(this.uuid());
	}

	/** A fresh semantic name, `<prefix>_<n>`, for ids, slugs and codes. */
	name(prefix: string): string {
		return `${prefix}_${this.tick()}`;
	}

	isMinted(uuid: string): boolean {
		return this.minted.has(uuid);
	}
}

/**
 * Rebuild a JSON value with every string value and object key that is a
 * whole canonical UUID passed through `rename`. Identities are whole values in
 * the document and in mutations (record keys, `uuid` slots, reference leaves),
 * so nothing inside a longer string is touched.
 */
function mapUuidTokens(
	value: unknown,
	rename: (token: string) => string,
): unknown {
	if (typeof value === "string") {
		return CANONICAL_UUID_PATTERN.test(value) ? rename(value) : value;
	}
	if (Array.isArray(value)) return value.map((v) => mapUuidTokens(v, rename));
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value).map(([key, v]) => [
				CANONICAL_UUID_PATTERN.test(key) ? rename(key) : key,
				mapUuidTokens(v, rename),
			]),
		);
	}
	return value;
}

/** Every whole canonical UUID token (value or key) in a JSON value. */
export function uuidTokensOf(value: unknown): Set<string> {
	const tokens = new Set<string>();
	mapUuidTokens(JSON.parse(JSON.stringify(value)), (token) => {
		tokens.add(token);
		return token;
	});
	return tokens;
}

/**
 * Rename every UUID the batch introduces at random to a minted one.
 *
 * A token is kept when the document already holds it or this minter produced
 * it; every other token is a planner's `crypto.randomUUID()` and is renamed in
 * order of first appearance, the same token always to the same minted UUID.
 * The batch is JSON (the commit gate refuses anything else), so the rewrite
 * runs over its JSON form.
 */
export function mintFreshIdentities(
	mutations: readonly Mutation[],
	known: ReadonlySet<string>,
	mint: Minter,
): Mutation[] {
	const renamed = new Map<string, string>();
	return mapUuidTokens(JSON.parse(JSON.stringify(mutations)), (token) => {
		if (known.has(token) || mint.isMinted(token)) return token;
		let next = renamed.get(token);
		if (next === undefined) {
			next = mint.uuid();
			renamed.set(token, next);
		}
		return next;
	}) as Mutation[];
}

/**
 * The document a batch prefix leaves, for planning the rest of a batch
 * against. It is reduced without validation: the commit gate judges the
 * whole batch against the original document afterwards.
 */
export function docAfter(
	doc: BlueprintDoc,
	mutations: readonly Mutation[],
): BlueprintDoc {
	if (mutations.length === 0) return doc;
	return produce(doc, (draft) => {
		applyMutations(draft, mutations);
	});
}

export interface FormAt {
	readonly moduleUuid: Uuid;
	readonly formUuid: Uuid;
}

/** Every form in module order, then form order. */
export function formsInOrder(doc: BlueprintDoc): FormAt[] {
	const out: FormAt[] = [];
	for (const moduleUuid of doc.moduleOrder) {
		for (const formUuid of doc.formOrder[moduleUuid] ?? []) {
			out.push({ moduleUuid, formUuid });
		}
	}
	return out;
}

export interface FieldAt {
	readonly field: Field;
	readonly parentUuid: Uuid;
	readonly formUuid: Uuid;
	readonly moduleUuid: Uuid;
	readonly index: number;
}

/** Every field in document order, with its parent and owning form. */
export function fieldsInOrder(doc: BlueprintDoc): FieldAt[] {
	const out: FieldAt[] = [];
	const walk = (parentUuid: Uuid, at: FormAt) => {
		for (const [index, uuid] of (doc.fieldOrder[parentUuid] ?? []).entries()) {
			const field = doc.fields[uuid];
			if (field === undefined) continue;
			out.push({ field, parentUuid, index, ...at });
			if (isContainer(field)) walk(uuid, at);
		}
	};
	for (const at of formsInOrder(doc)) walk(at.formUuid, at);
	return out;
}

/** Every UUID-keyed entity parent a field can be added under. */
export function fieldParentsInOrder(
	doc: BlueprintDoc,
): { readonly parentUuid: Uuid; readonly formUuid: Uuid }[] {
	const out: { parentUuid: Uuid; formUuid: Uuid }[] = [];
	for (const at of formsInOrder(doc)) {
		out.push({ parentUuid: at.formUuid, formUuid: at.formUuid });
	}
	for (const at of fieldsInOrder(doc)) {
		if (isContainer(at.field)) {
			out.push({ parentUuid: at.field.uuid, formUuid: at.formUuid });
		}
	}
	return out;
}
