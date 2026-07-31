/**
 * Lossless JSONB carrier for the canonical-identity cutover.
 *
 * `pg` normally applies JSON.parse to JSONB results. That can round a numeric
 * token before the migration has inspected it. Frozen callers therefore
 * select `jsonb::text`; this module parses number tokens into opaque holders
 * and retains the direct PostgreSQL text as the byte/digest authority.
 *
 * Exact capture and JavaScript materialization are intentionally separate.
 * Audit-only payloads remain opaque even when they contain numbers that the
 * final Blueprint runtime cannot represent. Only a semantic decoder calls
 * `materializeFrozenJson` and supplies its explicit numeric admission policy.
 */

import { createHash } from "node:crypto";
import { type Kysely, sql } from "kysely";

declare const verifiedFrozenJson: unique symbol;
declare const frozenExactNumber: unique symbol;
const PROOF_BATCH_BYTES = 4 * 1024 * 1024;

export interface FrozenJsonCarrierInput {
	/** Content-free structural identifier used only in failures. */
	readonly id: string;
	/** The direct result of `jsonb::text`; SQL NULL remains null. */
	readonly sourceText: string | null;
}

export interface FrozenJsonNumberToken {
	readonly raw: string;
	/** RFC 6901 JSON pointer; contains object keys, never object values. */
	readonly pointer: string;
}

interface FrozenExactNumber {
	readonly raw: string;
	readonly [frozenExactNumber]: true;
}

class FrozenExactNumberValue implements FrozenExactNumber {
	declare readonly [frozenExactNumber]: true;

	constructor(readonly raw: string) {}
}

interface FrozenExactJsonArray extends ReadonlyArray<FrozenExactJson> {}

interface FrozenExactJsonObject {
	readonly [key: string]: FrozenExactJson;
}

type FrozenExactJson =
	| null
	| boolean
	| string
	| FrozenExactNumber
	| FrozenExactJsonArray
	| FrozenExactJsonObject;

export interface FrozenVerifiedJson {
	readonly sourceText: string | null;
	readonly sourceDigest: string;
	readonly [verifiedFrozenJson]: true;
}

class VerifiedFrozenJson implements FrozenVerifiedJson {
	declare readonly [verifiedFrozenJson]: true;

	constructor(
		readonly sourceText: string | null,
		readonly sourceDigest: string,
		readonly exact: FrozenExactJson | undefined,
	) {}
}

interface PreparedCarrier {
	readonly id: string;
	readonly sourceText: string | null;
	readonly sourceDigest: string;
	readonly exact: FrozenExactJson | undefined;
	readonly bytes: number;
}

export type FrozenJsonMaterialization<T> =
	| { readonly kind: "sql-null" }
	| { readonly kind: "json"; readonly value: T };

function digestSource(sourceText: string | null): string {
	return createHash("sha256")
		.update(sourceText === null ? Buffer.from([0]) : Buffer.from(sourceText))
		.digest("hex");
}

function parseExactJson(source: string): FrozenExactJson {
	let offset = 0;
	const fail = (message: string): never => {
		const byteOffset = Buffer.byteLength(source.slice(0, offset), "utf8");
		throw new Error(
			`Frozen canonical storage JSON is invalid at byte ${byteOffset}: ${message}`,
		);
	};
	const whitespace = () => {
		while (
			source[offset] === " " ||
			source[offset] === "\n" ||
			source[offset] === "\r" ||
			source[offset] === "\t"
		) {
			offset++;
		}
	};
	const stringValue = (): string => {
		if (source[offset] !== '"') fail("expected string");
		const start = offset;
		offset++;
		let escaped = false;
		while (offset < source.length) {
			const character = source[offset];
			offset++;
			if (escaped) {
				escaped = false;
				continue;
			}
			if (character === "\\") {
				escaped = true;
				continue;
			}
			if (character === '"') {
				return JSON.parse(source.slice(start, offset)) as string;
			}
		}
		return fail("unterminated string");
	};
	const value = (): FrozenExactJson => {
		whitespace();
		const character = source[offset];
		if (character === '"') return stringValue();
		if (character === "[") {
			offset++;
			const entries: FrozenExactJson[] = [];
			whitespace();
			if (source[offset] === "]") {
				offset++;
				return entries;
			}
			while (true) {
				entries.push(value());
				whitespace();
				if (source[offset] === "]") {
					offset++;
					return entries;
				}
				if (source[offset] !== ",") fail("expected array comma");
				offset++;
			}
		}
		if (character === "{") {
			offset++;
			const result = Object.create(null) as Record<string, FrozenExactJson>;
			whitespace();
			if (source[offset] === "}") {
				offset++;
				return result;
			}
			while (true) {
				whitespace();
				const key = stringValue();
				whitespace();
				if (source[offset] !== ":") fail("expected object colon");
				offset++;
				result[key] = value();
				whitespace();
				if (source[offset] === "}") {
					offset++;
					return result;
				}
				if (source[offset] !== ",") fail("expected object comma");
				offset++;
			}
		}
		for (const [literal, parsed] of [
			["true", true],
			["false", false],
			["null", null],
		] as const) {
			if (source.startsWith(literal, offset)) {
				offset += literal.length;
				return parsed;
			}
		}
		const numeric = source
			.slice(offset)
			.match(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/)?.[0];
		if (numeric !== undefined) {
			offset += numeric.length;
			return new FrozenExactNumberValue(numeric);
		}
		return fail("expected JSON value");
	};
	const parsed = value();
	whitespace();
	if (offset !== source.length) fail("trailing content");
	return parsed;
}

function prepareCarrier(entry: FrozenJsonCarrierInput): PreparedCarrier {
	const sourceDigest = digestSource(entry.sourceText);
	if (entry.sourceText === null) {
		return {
			id: entry.id,
			sourceText: null,
			sourceDigest,
			exact: undefined,
			bytes: 0,
		};
	}
	let exact: FrozenExactJson;
	try {
		exact = parseExactJson(entry.sourceText);
	} catch {
		throw new Error(
			`Frozen JSON carrier ${entry.id} is not valid JSON (${sourceDigest}).`,
		);
	}
	return {
		id: entry.id,
		sourceText: entry.sourceText,
		sourceDigest,
		exact,
		bytes: Buffer.byteLength(entry.sourceText, "utf8"),
	};
}

function proofBatches(
	entries: readonly PreparedCarrier[],
): readonly (readonly PreparedCarrier[])[] {
	const batches: PreparedCarrier[][] = [];
	let batch: PreparedCarrier[] = [];
	let batchBytes = 0;
	for (const entry of entries) {
		if (batch.length > 0 && batchBytes + entry.bytes > PROOF_BATCH_BYTES) {
			batches.push(batch);
			batch = [];
			batchBytes = 0;
		}
		batch.push(entry);
		batchBytes += entry.bytes;
	}
	if (batch.length > 0) batches.push(batch);
	return batches;
}

/**
 * Pure exact capture used by timestamp-owned decoder tests. Production DB
 * callers additionally use `verifyFrozenJsonCarriers`, which proves that the
 * supplied source is PostgreSQL's canonical JSONB text.
 */
export function decodeFrozenCanonicalJsonText(
	entry: FrozenJsonCarrierInput,
): FrozenVerifiedJson {
	const prepared = prepareCarrier(entry);
	return new VerifiedFrozenJson(
		prepared.sourceText,
		prepared.sourceDigest,
		prepared.exact,
	);
}

/**
 * Establish exact PostgreSQL JSONB carriers without materializing numeric
 * tokens into JavaScript numbers.
 */
export async function verifyFrozenJsonCarriers<DB>(
	db: Kysely<DB>,
	entries: readonly FrozenJsonCarrierInput[],
): Promise<ReadonlyMap<string, FrozenVerifiedJson>> {
	const ids = new Set<string>();
	for (const entry of entries) {
		if (entry.id.length === 0 || ids.has(entry.id)) {
			throw new Error("Frozen JSON carrier identifiers must be unique.");
		}
		ids.add(entry.id);
	}
	const prepared = entries.map(prepareCarrier);
	for (const batch of proofBatches(prepared)) {
		const proof = await sql<{
			id: string;
			source_digest: string;
		}>`
			WITH candidate AS (
				SELECT *
				FROM jsonb_to_recordset(${JSON.stringify(
					batch.map((entry) => ({
						id: entry.id,
						source_text: entry.sourceText,
						source_digest: entry.sourceDigest,
					})),
				)}::jsonb)
					AS value(id text, source_text text, source_digest text)
			)
			SELECT id, source_digest
			FROM candidate
			WHERE
				source_text IS NOT NULL
				AND source_text::jsonb::text IS DISTINCT FROM source_text
			ORDER BY id
		`.execute(db);
		const mismatch = proof.rows[0];
		if (mismatch !== undefined) {
			throw new Error(
				`Frozen JSON carrier ${mismatch.id} is not canonical PostgreSQL JSONB (${mismatch.source_digest}).`,
			);
		}
	}
	return new Map(
		prepared.map((entry) => [
			entry.id,
			new VerifiedFrozenJson(entry.sourceText, entry.sourceDigest, entry.exact),
		]),
	);
}

function pointerSegment(value: string): string {
	return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

/**
 * Materialize an exact carrier only at a semantic boundary. The caller owns
 * numeric admission and receives every raw token plus its structural pointer.
 * SQL NULL is distinct from a JSON `null` value.
 */
export function materializeFrozenJson<T>(
	carrier: FrozenVerifiedJson,
	materializeNumber: (token: FrozenJsonNumberToken) => number,
): FrozenJsonMaterialization<T> {
	if (!(carrier instanceof VerifiedFrozenJson)) {
		throw new Error(
			"Frozen JSON carrier was not created by the frozen decoder.",
		);
	}
	if (carrier.sourceText === null) return { kind: "sql-null" };
	const walk = (value: FrozenExactJson, pointer: string): unknown => {
		if (
			value === null ||
			typeof value === "string" ||
			typeof value === "boolean"
		) {
			return value;
		}
		if (value instanceof FrozenExactNumberValue) {
			return materializeNumber({ raw: value.raw, pointer });
		}
		if (Array.isArray(value)) {
			return value.map((entry, index) => walk(entry, `${pointer}/${index}`));
		}
		const output = Object.create(null) as Record<string, unknown>;
		for (const [key, entry] of Object.entries(value)) {
			output[key] = walk(entry, `${pointer}/${pointerSegment(key)}`);
		}
		return output;
	};
	if (carrier.exact === undefined) {
		throw new Error("Frozen JSON carrier lost its exact tree.");
	}
	return { kind: "json", value: walk(carrier.exact, "") as T };
}

export function frozenJsonSourceBytes(value: FrozenVerifiedJson): number {
	return value.sourceText === null
		? 0
		: Buffer.byteLength(value.sourceText, "utf8");
}
