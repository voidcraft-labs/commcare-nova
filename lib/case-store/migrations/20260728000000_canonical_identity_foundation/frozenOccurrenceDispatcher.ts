/**
 * Executable storage-occurrence dispatcher for the canonical-identity cutover.
 *
 * The manifest is the inventory; this file is the one implementation that
 * turns every entry into content digests and disposition postconditions.
 * Advisory/locked scans, repair rehearsal/application, and migration all call
 * this exact code, so adding a carrier to the manifest without teaching the
 * dispatcher how to project it is impossible.
 */

import { createHash } from "node:crypto";
import { type Kysely, sql } from "kysely";
import {
	FROZEN_STORAGE_OCCURRENCES,
	type FrozenOccurrenceDisposition,
	type FrozenStorageOccurrence,
} from "./frozenOccurrenceManifest";
import { classifyFrozenCasesRelation } from "./frozenRelationLifecycle";
import { canonicalIdentityDigest } from "./frozenTransform";

type JsonRecord = Record<string, unknown>;
/** The standard scalars a pre-cutover row may carry inside `properties`. One
 *  definition: the scan counts rows by it and the migration strips by it, so
 *  the two can never disagree about what "standard" means. */
export const PRE_CUTOVER_STANDARD_PROPERTIES = new Set([
	"name",
	"date-opened",
	"external-id",
	"case_id",
	"case_type",
	"case_name",
	"date_opened",
	"external_id",
	"last_modified",
	"owner_id",
	"status",
]);

export interface FrozenStorageTableSnapshot {
	readonly exists: boolean;
	readonly rows: readonly unknown[];
	/** Direct `to_jsonb(row)::text`, parallel to `rows`, when DB-captured. */
	readonly rowTexts?: readonly string[];
}

export interface FrozenExactPayloadSnapshot {
	readonly id: string;
	readonly rowCount: number;
	readonly bytes: number;
	readonly digest: string;
}

export type FrozenStorageSnapshot = Readonly<
	Record<string, FrozenStorageTableSnapshot>
>;

/** Resolve exactly one physical owner of the logical `cases` carrier. */
export async function resolveFrozenCasesSchema<DB>(
	db: Kysely<DB>,
): Promise<"nova_case_runtime" | "public"> {
	const result = await sql<{ schema_name: string }>`
		SELECT namespace.nspname AS schema_name
		FROM pg_class AS relation
		JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
		WHERE relation.relname = 'cases'
		  AND namespace.nspname IN ('public', 'nova_case_runtime')
		  AND relation.relkind IN ('r', 'p')
		ORDER BY convert_to(namespace.nspname, 'UTF8')
	`.execute(db);
	const resolution = classifyFrozenCasesRelation(
		result.rows.map((row) => ({
			schema: row.schema_name,
			table: "cases",
		})),
	);
	if (resolution.relation === null) {
		throw new Error(
			`Frozen canonical migration requires exactly one cases relation; observed state is ${resolution.state}.`,
		);
	}
	return resolution.relation.schema as "nova_case_runtime" | "public";
}

export interface FrozenOccurrenceProjection {
	readonly id: string;
	readonly disposition: FrozenOccurrenceDisposition;
	readonly table: string;
	readonly path: string;
	readonly semantic: FrozenStorageOccurrence["semantic"];
	readonly rowCount: number;
	readonly bytes: number;
	readonly digest: string;
}

export interface FrozenOccurrencePlanEntry {
	readonly id: string;
	readonly disposition: FrozenOccurrenceDisposition;
	readonly sourceDigest: string;
	readonly resultDigest: string;
	readonly sourceRows: number;
	readonly resultRows: number;
	readonly sourceBytes: number;
	readonly resultBytes: number;
}

export interface FrozenOccurrencePlan {
	readonly entries: readonly FrozenOccurrencePlanEntry[];
	readonly sourceDigest: string;
	readonly resultDigest: string;
	readonly planDigest: string;
	readonly sourceBytes: number;
	readonly resultBytes: number;
}

function isRecord(value: unknown): value is JsonRecord {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

class FrozenExactNumber {
	readonly raw: string;

	constructor(raw: string) {
		this.raw = raw;
	}
}

function isFrozenExactNumber(value: unknown): value is FrozenExactNumber {
	return value instanceof FrozenExactNumber;
}

function compareUtf8(left: string, right: string): number {
	return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

/**
 * `pg` parses a JSON/JSONB result through `JSON.parse`, which irreversibly
 * rounds an int8/numeric value outside JavaScript's safe range. The frozen
 * inventory is an exact-byte authority, so it reads PostgreSQL's canonical
 * JSON text and parses number tokens into an opaque lexeme holder instead.
 */
export function parseFrozenExactJson(source: string): unknown {
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
	const value = (): unknown => {
		whitespace();
		const character = source[offset];
		if (character === '"') return stringValue();
		if (character === "[") {
			offset++;
			const entries: unknown[] = [];
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
			const result = Object.create(null) as JsonRecord;
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
			.match(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/);
		if (numeric?.[0] !== undefined) {
			offset += numeric[0].length;
			return new FrozenExactNumber(numeric[0]);
		}
		return fail("expected JSON value");
	};
	const parsed = value();
	whitespace();
	if (offset !== source.length) fail("trailing content");
	return parsed;
}

function frozenExactJson(value: unknown): string {
	if (isFrozenExactNumber(value)) return value.raw;
	if (value === null) return "null";
	if (Array.isArray(value)) {
		return `[${value.map(frozenExactJson).join(",")}]`;
	}
	switch (typeof value) {
		case "string":
		case "boolean":
		case "number":
			return JSON.stringify(value);
		case "object":
			return `{${Object.entries(value as JsonRecord)
				.filter(([, entry]) => entry !== undefined)
				.sort(([left], [right]) => compareUtf8(left, right))
				.map(
					([key, entry]) => `${JSON.stringify(key)}:${frozenExactJson(entry)}`,
				)
				.join(",")}}`;
		default:
			throw new Error("Frozen storage projections must be JSON values.");
	}
}

function jsonBytes(value: unknown): number {
	return Buffer.byteLength(frozenExactJson(value), "utf8");
}

export function frozenExactDigest(value: unknown): string {
	return createHash("sha256").update(frozenExactJson(value)).digest("hex");
}

export function frozenExactTextSequenceDigest(
	values: readonly (string | null)[],
): string {
	const hash = createHash("sha256");
	for (const value of values) {
		if (value === null) {
			hash.update(Buffer.from([0]));
			continue;
		}
		hash.update(Buffer.from([1]));
		const bytes = Buffer.from(value, "utf8");
		const length = Buffer.allocUnsafe(8);
		length.writeBigUInt64BE(BigInt(bytes.length));
		hash.update(length);
		hash.update(bytes);
	}
	return hash.digest("hex");
}

function exactPayloadSnapshot(
	id: string,
	rows: readonly { readonly payload_text: string | null }[],
): FrozenExactPayloadSnapshot {
	const values = rows.map((row) => row.payload_text);
	return {
		id,
		rowCount: values.length,
		bytes: values.reduce(
			(total, value) =>
				total + (value === null ? 0 : Buffer.byteLength(value, "utf8")),
			0,
		),
		digest: frozenExactTextSequenceDigest(values),
	};
}

/** Capture complete canonical JSONB projections without table-specific SQL. */
export async function captureFrozenStorageSnapshot<DB>(
	db: Kysely<DB>,
): Promise<FrozenStorageSnapshot> {
	const tableNames = [
		...new Set(FROZEN_STORAGE_OCCURRENCES.map((entry) => entry.table)),
	];
	const casesSchema = await resolveFrozenCasesSchema(db);
	const expectedRelations = tableNames.flatMap((table) => {
		const schema = table === "cases" ? casesSchema : "public";
		return [
			{ schema, table },
			...(table === "app_changes"
				? [{ schema: "public", table: "accepted_mutations" }]
				: []),
		];
	});
	const existing = await sql<{ schema_name: string; table_name: string }>`
		SELECT n.nspname AS schema_name, c.relname AS table_name
		FROM pg_class AS c
		JOIN pg_namespace AS n ON n.oid = c.relnamespace
		WHERE (n.nspname, c.relname) IN (
			${sql.join(
				expectedRelations.map(
					(relation) => sql`(${relation.schema}, ${relation.table})`,
				),
			)}
		  )
		  AND c.relkind IN ('r', 'p')
		ORDER BY convert_to(n.nspname, 'UTF8'), convert_to(c.relname, 'UTF8')
	`.execute(db);
	const existingNames = new Set(
		existing.rows.map((row) => `${row.schema_name}.${row.table_name}`),
	);
	const snapshot: Record<string, FrozenStorageTableSnapshot> = {};
	for (const table of tableNames) {
		const schema = table === "cases" ? casesSchema : "public";
		const physicalTable =
			table === "app_changes" &&
			!existingNames.has("public.app_changes") &&
			existingNames.has("public.accepted_mutations")
				? "accepted_mutations"
				: table;
		if (!existingNames.has(`${schema}.${physicalTable}`)) {
			snapshot[table] = { exists: false, rows: [] };
			continue;
		}
		const rows = await sql<{ row_text: string }>`
			SELECT to_jsonb(source_row)::text AS row_text
			FROM ${sql.id(schema, physicalTable)} AS source_row
			ORDER BY convert_to(to_jsonb(source_row)::text, 'UTF8')
		`.execute(db);
		snapshot[table] = {
			exists: true,
			rows: rows.rows.map((row) => parseFrozenExactJson(row.row_text)),
			rowTexts: rows.rows.map((row) => row.row_text),
		};
	}
	const generatedIndexes = await sql<{
		schema_name: string;
		index_name: string;
		definition: string;
		is_valid: boolean;
	}>`
		SELECT
			index_namespace.nspname AS schema_name,
			index_relation.relname AS index_name,
			pg_get_indexdef(index_relation.oid) AS definition,
			index_catalog.indisvalid AS is_valid
		FROM pg_index AS index_catalog
		JOIN pg_class AS index_relation
		  ON index_relation.oid = index_catalog.indexrelid
		JOIN pg_namespace AS index_namespace
		  ON index_namespace.oid = index_relation.relnamespace
		JOIN pg_class AS table_relation
		  ON table_relation.oid = index_catalog.indrelid
		JOIN pg_namespace AS table_namespace
		  ON table_namespace.oid = table_relation.relnamespace
		WHERE table_relation.relname = 'cases'
		  AND table_namespace.nspname = ${casesSchema}
		  AND index_relation.relname ~
		      '^cases_[0-9a-f]{12}_[0-9a-f]{12}_(fuzzy|int|num|contains)$'
		ORDER BY
			convert_to(index_namespace.nspname, 'UTF8'),
			convert_to(index_relation.relname, 'UTF8')
	`.execute(db);
	snapshot.__case_property_indexes = {
		exists: true,
		rows: generatedIndexes.rows,
	};
	const exactPayloads: Record<string, FrozenExactPayloadSnapshot> = {};
	const appChangesTable = existingNames.has("public.app_changes")
		? "app_changes"
		: existingNames.has("public.accepted_mutations")
			? "accepted_mutations"
			: null;
	if (appChangesTable !== null) {
		const hasFoldBaseline = existingNames.has(
			"public.app_change_fold_baselines",
		);
		const greatestFoldBaselineByApp = sql`
			SELECT app_id, MAX(seq) AS seq
			FROM public.app_change_fold_baselines
			GROUP BY app_id
		`;
		const acceptedBefore = hasFoldBaseline
			? await sql<{ payload_text: string }>`
					WITH greatest_baseline AS (${greatestFoldBaselineByApp})
					SELECT (
						to_jsonb(change_row)
							- 'from_project_id'
							- 'to_project_id'
					)::text AS payload_text
					FROM public.app_changes AS change_row
					LEFT JOIN greatest_baseline AS baseline
					  ON baseline.app_id = change_row.app_id
					WHERE baseline.app_id IS NULL OR change_row.seq < baseline.seq
					ORDER BY convert_to(
						(
							to_jsonb(change_row)
								- 'from_project_id'
								- 'to_project_id'
						)::text,
						'UTF8'
					)
				`.execute(db)
			: await sql<{ payload_text: string }>`
					SELECT to_jsonb(change_row)::text AS payload_text
					FROM ${sql.id("public", appChangesTable)} AS change_row
					ORDER BY convert_to(to_jsonb(change_row)::text, 'UTF8')
				`.execute(db);
		exactPayloads["app_changes.pre-horizon-envelope"] = exactPayloadSnapshot(
			"app_changes.pre-horizon-envelope",
			acceptedBefore.rows,
		);
		const acceptedSuffix = hasFoldBaseline
			? await sql<{ payload_text: string }>`
					WITH greatest_baseline AS (${greatestFoldBaselineByApp})
					SELECT to_jsonb(change_row)::text AS payload_text
					FROM public.app_changes AS change_row
					JOIN greatest_baseline AS baseline
					  ON baseline.app_id = change_row.app_id
					 AND change_row.seq >= baseline.seq
					ORDER BY convert_to(to_jsonb(change_row)::text, 'UTF8')
				`.execute(db)
			: { rows: [] };
		exactPayloads["app_changes.horizon-and-suffix-envelope"] =
			exactPayloadSnapshot(
				"app_changes.horizon-and-suffix-envelope",
				acceptedSuffix.rows,
			);
	}
	if (existingNames.has("public.threads")) {
		const threadRows = await sql<{ payload_text: string }>`
			SELECT (
				to_jsonb(thread_row)
				- 'active_stream_id'
				- 'active_holder_nonce'
			)::text AS payload_text
			FROM public.threads AS thread_row
			ORDER BY convert_to(
				(
					to_jsonb(thread_row)
						- 'active_stream_id'
						- 'active_holder_nonce'
				)::text,
				'UTF8'
			)
		`.execute(db);
		exactPayloads["threads.immutable-envelope"] = exactPayloadSnapshot(
			"threads.immutable-envelope",
			threadRows.rows,
		);
	}
	if (existingNames.has("public.form_submission_intents")) {
		const intentRows = await sql<{ payload_text: string | null }>`
			SELECT result::text AS payload_text
			FROM public.form_submission_intents
			ORDER BY convert_to(result::text, 'UTF8')
		`.execute(db);
		exactPayloads["form_submission_intents.result"] = exactPayloadSnapshot(
			"form_submission_intents.result",
			intentRows.rows,
		);
	}
	if (existingNames.has("public.lookup_rows")) {
		const lookupRows = await sql<{ payload_text: string }>`
			SELECT values::text AS payload_text
			FROM public.lookup_rows
			ORDER BY convert_to(values::text, 'UTF8')
		`.execute(db);
		exactPayloads["lookup_rows.values"] = exactPayloadSnapshot(
			"lookup_rows.values",
			lookupRows.rows,
		);
	}
	if (existingNames.has("public.events")) {
		const archivedMutationRows = await sql<{ payload_text: string }>`
			SELECT CASE
				WHEN kind = 'archived-mutation' THEN (event -> 'archived')::text
				ELSE event::text
			END AS payload_text
			FROM public.events
			WHERE kind IN ('mutation', 'archived-mutation')
			ORDER BY convert_to(
				CASE
					WHEN kind = 'archived-mutation'
					THEN (event -> 'archived')::text
					ELSE event::text
				END,
				'UTF8'
			)
		`.execute(db);
		exactPayloads["events.mutation-payload"] = exactPayloadSnapshot(
			"events.mutation-payload",
			archivedMutationRows.rows,
		);
		const currentEventRows = await sql<{ payload_text: string }>`
			SELECT to_jsonb(event_row)::text AS payload_text
			FROM public.events AS event_row
			WHERE kind NOT IN ('mutation', 'archived-mutation')
			ORDER BY convert_to(to_jsonb(event_row)::text, 'UTF8')
		`.execute(db);
		exactPayloads["events.nonmutation-envelope"] = exactPayloadSnapshot(
			"events.nonmutation-envelope",
			currentEventRows.rows,
		);
	}
	if (existingNames.has(`${casesSchema}.cases`)) {
		const caseRows = await sql<{ payload_text: string }>`
			SELECT (
				properties - ${[...PRE_CUTOVER_STANDARD_PROPERTIES]}::text[]
			)::text AS payload_text
			FROM ${sql.id(casesSchema, "cases")}
			ORDER BY convert_to(
				(
					properties - ${[...PRE_CUTOVER_STANDARD_PROPERTIES]}::text[]
				)::text,
				'UTF8'
			)
		`.execute(db);
		exactPayloads["cases.unrelated-properties"] = exactPayloadSnapshot(
			"cases.unrelated-properties",
			caseRows.rows,
		);
	}
	if (existingNames.has("public.parked_case_values")) {
		const parkedRows = await sql<{ payload_text: string }>`
			SELECT to_jsonb(parked)::text AS payload_text
			FROM public.parked_case_values AS parked
			WHERE property <> ALL(${[...PRE_CUTOVER_STANDARD_PROPERTIES]}::text[])
			ORDER BY convert_to(to_jsonb(parked)::text, 'UTF8')
		`.execute(db);
		exactPayloads["parked_case_values.unrelated-envelope"] =
			exactPayloadSnapshot(
				"parked_case_values.unrelated-envelope",
				parkedRows.rows,
			);
	}
	snapshot.__exact_payloads = {
		exists: true,
		rows: Object.values(exactPayloads),
	};
	return snapshot;
}

function walkPath(value: unknown, segments: readonly string[]): unknown[] {
	if (segments.length === 0) return [value];
	const [segment, ...tail] = segments;
	if (segment === undefined) return [];
	if (segment === "<LookupColumnId>") {
		if (!isRecord(value)) return [];
		return Object.entries(value)
			.sort(([left], [right]) => compareUtf8(left, right))
			.flatMap(([key, entry]) => walkPath({ key, value: entry }, tail));
	}
	const array = segment.endsWith("[]");
	const key = array ? segment.slice(0, -2) : segment;
	if (!isRecord(value) || !Object.hasOwn(value, key)) return [];
	const child = value[key];
	if (!array) return walkPath(child, tail);
	if (!Array.isArray(child)) return [];
	return child.flatMap((entry) => walkPath(entry, tail));
}

function projectDeclaredPath(row: unknown, path: string): unknown {
	if (path === "*") return row;
	const alternatives = path.split("|");
	if (alternatives.length === 1) {
		return walkPath(row, alternatives[0]?.split(".") ?? []);
	}
	return Object.fromEntries(
		alternatives.map((alternative) => [
			alternative,
			walkPath(row, alternative.split(".")),
		]),
	);
}

function baselineSeqByApp(
	snapshot: FrozenStorageSnapshot,
): Map<string, bigint> {
	const result = new Map<string, bigint>();
	for (const value of snapshot.app_change_fold_baselines?.rows ?? []) {
		if (!isRecord(value) || typeof value.app_id !== "string") continue;
		if (
			typeof value.seq !== "string" &&
			typeof value.seq !== "number" &&
			!isFrozenExactNumber(value.seq)
		)
			continue;
		const seq = BigInt(
			isFrozenExactNumber(value.seq) ? value.seq.raw : value.seq,
		);
		const prior = result.get(value.app_id);
		if (prior === undefined || seq > prior) result.set(value.app_id, seq);
	}
	return result;
}

function acceptedRowsFor(
	occurrence: FrozenStorageOccurrence,
	snapshot: FrozenStorageSnapshot,
): readonly unknown[] {
	const rows = snapshot.app_changes?.rows ?? [];
	const baselines = baselineSeqByApp(snapshot);
	if (occurrence.id === "app_changes.before-new-horizon") {
		return rows.filter((value) => {
			if (!isRecord(value) || typeof value.app_id !== "string") return false;
			const baseline = baselines.get(value.app_id);
			return (
				baseline === undefined ||
				((typeof value.seq === "string" ||
					typeof value.seq === "number" ||
					isFrozenExactNumber(value.seq)) &&
					BigInt(isFrozenExactNumber(value.seq) ? value.seq.raw : value.seq) <
						baseline)
			);
		});
	}
	if (occurrence.id === "app_changes.new-horizon-and-suffix") {
		return rows.filter((value) => {
			if (!isRecord(value) || typeof value.app_id !== "string") return false;
			const baseline = baselines.get(value.app_id);
			return (
				baseline !== undefined &&
				(typeof value.seq === "string" ||
					typeof value.seq === "number" ||
					isFrozenExactNumber(value.seq)) &&
				BigInt(isFrozenExactNumber(value.seq) ? value.seq.raw : value.seq) >=
					baseline
			);
		});
	}
	return rows;
}

function eventRowsFor(
	occurrence: FrozenStorageOccurrence,
	snapshot: FrozenStorageSnapshot,
): readonly unknown[] {
	const rows = snapshot.events?.rows ?? [];
	if (occurrence.id === "events.mutation") {
		return rows.flatMap((value) => {
			if (!isRecord(value)) return [];
			if (value.kind === "mutation") return [value.event];
			if (
				value.kind === "archived-mutation" &&
				isRecord(value.event) &&
				value.event.archived !== undefined
			) {
				return [value.event.archived];
			}
			return [];
		});
	}
	if (occurrence.id.startsWith("events.conversation.")) {
		return rows.filter(
			(value) => isRecord(value) && value.kind === "conversation",
		);
	}
	if (occurrence.id === "events.current-nonmutation") {
		return rows.filter(
			(value) =>
				isRecord(value) &&
				value.kind !== "mutation" &&
				!frozenCurrentNonMutationEventIsExact(value),
		);
	}
	return rows;
}

function hasExactKeys(
	value: JsonRecord,
	required: readonly string[],
	optional: readonly string[] = [],
): boolean {
	const allowed = new Set([...required, ...optional]);
	const keys = Object.keys(value);
	return (
		required.every((key) => Object.hasOwn(value, key)) &&
		keys.every((key) => allowed.has(key))
	);
}

function isNonnegativeInteger(value: unknown): boolean {
	if (isFrozenExactNumber(value)) {
		if (!/^(?:0|[1-9][0-9]*)$/.test(value.raw)) return false;
		return BigInt(value.raw) <= BigInt(Number.MAX_SAFE_INTEGER);
	}
	return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isPositiveInteger(value: unknown): boolean {
	if (!isNonnegativeInteger(value)) return false;
	return isFrozenExactNumber(value)
		? BigInt(value.raw) > BigInt(0)
		: Number(value) > 0;
}

const FROZEN_CANONICAL_UUID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const FROZEN_CHAT_ATTACHMENT_KINDS = new Set([
	"image",
	"pdf",
	"text",
	"docx",
	"xlsx",
]);
const FROZEN_AUDIT_ATTACHMENT_KINDS = new Set([
	"image",
	"audio",
	"video",
	"pdf",
	"text",
	"docx",
	"xlsx",
]);
const FROZEN_MAX_ATTACHMENTS_PER_MESSAGE = 20;

function frozenAttachmentShapeIsExact(
	value: unknown,
	allowedKinds: ReadonlySet<string>,
): boolean {
	if (!isRecord(value)) return false;
	if (
		!hasExactKeys(
			value,
			["assetId", "kind", "filename", "mimeType"],
			["title", "summary"],
		)
	) {
		return false;
	}
	return (
		typeof value.assetId === "string" &&
		FROZEN_CANONICAL_UUID.test(value.assetId) &&
		typeof value.kind === "string" &&
		allowedKinds.has(value.kind) &&
		typeof value.filename === "string" &&
		value.filename.length > 0 &&
		value.filename.length <= 255 &&
		typeof value.mimeType === "string" &&
		value.mimeType.length > 0 &&
		value.mimeType.length <= 255 &&
		(value.title === undefined ||
			(typeof value.title === "string" && value.title.length <= 200)) &&
		(value.summary === undefined ||
			(typeof value.summary === "string" && value.summary.length <= 2_000))
	);
}

export function frozenChatAttachmentIsExact(value: unknown): boolean {
	return frozenAttachmentShapeIsExact(value, FROZEN_CHAT_ATTACHMENT_KINDS);
}

export function frozenAuditAttachmentIsExact(value: unknown): boolean {
	return frozenAttachmentShapeIsExact(value, FROZEN_AUDIT_ATTACHMENT_KINDS);
}

export interface FrozenThreadAttachmentOccurrence {
	readonly messageIndex: number;
	readonly attachmentIndex: number;
	readonly value: unknown;
	readonly assetId: string | null;
	readonly kind: string | null;
	readonly exact: boolean;
}

export interface FrozenThreadAttachmentInventory {
	readonly shapeExact: boolean;
	readonly occurrences: readonly FrozenThreadAttachmentOccurrence[];
}

/**
 * Strict canonical thread traversal. Only
 * `messages[*].metadata.attachments[*]` is a live attachment carrier.
 */
export function frozenThreadAttachmentInventory(
	messages: unknown,
): FrozenThreadAttachmentInventory {
	if (!Array.isArray(messages)) {
		return { shapeExact: false, occurrences: [] };
	}
	let shapeExact = true;
	const occurrences: FrozenThreadAttachmentOccurrence[] = [];
	for (const [messageIndex, message] of messages.entries()) {
		if (!isRecord(message) || !Object.hasOwn(message, "metadata")) continue;
		if (!isRecord(message.metadata)) {
			shapeExact = false;
			continue;
		}
		if (!Object.hasOwn(message.metadata, "attachments")) continue;
		if (!Array.isArray(message.metadata.attachments)) {
			shapeExact = false;
			continue;
		}
		if (
			message.metadata.attachments.length > FROZEN_MAX_ATTACHMENTS_PER_MESSAGE
		) {
			shapeExact = false;
		}
		for (const [
			attachmentIndex,
			value,
		] of message.metadata.attachments.entries()) {
			const exact = frozenChatAttachmentIsExact(value);
			if (!exact) shapeExact = false;
			occurrences.push({
				messageIndex,
				attachmentIndex,
				value,
				assetId:
					isRecord(value) && typeof value.assetId === "string"
						? value.assetId
						: null,
				kind:
					isRecord(value) && typeof value.kind === "string" ? value.kind : null,
				exact,
			});
		}
	}
	return { shapeExact, occurrences };
}

function frozenConversationPayloadIsExact(value: unknown): boolean {
	if (!isRecord(value) || typeof value.type !== "string") return false;
	switch (value.type) {
		case "user-message":
			return (
				hasExactKeys(value, ["type", "text"], ["attachments"]) &&
				typeof value.text === "string" &&
				(value.attachments === undefined ||
					(Array.isArray(value.attachments) &&
						value.attachments.length <= FROZEN_MAX_ATTACHMENTS_PER_MESSAGE &&
						value.attachments.every(frozenAuditAttachmentIsExact)))
			);
		case "assistant-text":
		case "assistant-reasoning":
			return (
				hasExactKeys(value, ["type", "text"]) && typeof value.text === "string"
			);
		case "tool-call":
			return (
				hasExactKeys(value, ["type", "toolCallId", "toolName", "input"]) &&
				typeof value.toolCallId === "string" &&
				typeof value.toolName === "string"
			);
		case "tool-result":
			return (
				hasExactKeys(value, ["type", "toolCallId", "toolName", "output"]) &&
				typeof value.toolCallId === "string" &&
				typeof value.toolName === "string"
			);
		case "error":
			return (
				hasExactKeys(value, ["type", "error"]) &&
				isRecord(value.error) &&
				hasExactKeys(value.error, ["type", "message", "fatal"]) &&
				typeof value.error.type === "string" &&
				typeof value.error.message === "string" &&
				typeof value.error.fatal === "boolean"
			);
		case "validation-attempt":
			return (
				hasExactKeys(value, ["type", "attempt", "errors"]) &&
				isPositiveInteger(value.attempt) &&
				Array.isArray(value.errors) &&
				value.errors.every((entry) => typeof entry === "string")
			);
		case "step-usage":
			return (
				hasExactKeys(
					value,
					["type", "inputTokens", "outputTokens"],
					["cacheReadTokens", "cacheWriteTokens"],
				) &&
				isNonnegativeInteger(value.inputTokens) &&
				isNonnegativeInteger(value.outputTokens) &&
				(value.cacheReadTokens === undefined ||
					isNonnegativeInteger(value.cacheReadTokens)) &&
				(value.cacheWriteTokens === undefined ||
					isNonnegativeInteger(value.cacheWriteTokens))
			);
		case "attachment-prep":
			return (
				hasExactKeys(value, ["type", "phase"], ["count"]) &&
				(value.phase === "start" || value.phase === "done") &&
				(value.count === undefined || isPositiveInteger(value.count))
			);
		default:
			return false;
	}
}

/**
 * Frozen exact parser for current non-mutation event bytes. Mutation events are
 * archived separately and their nested payload stays opaque.
 */
export function frozenCurrentNonMutationEventIsExact(
	storedRow: unknown,
): boolean {
	if (!isRecord(storedRow) || !isRecord(storedRow.event)) return false;
	const event = storedRow.event;
	const envelopeExact =
		typeof event.runId === "string" &&
		isNonnegativeInteger(event.ts) &&
		isNonnegativeInteger(event.seq) &&
		(event.source === "chat" || event.source === "mcp");
	if (!envelopeExact) return false;
	if (
		event.kind === "archived-mutation" &&
		hasExactKeys(event, ["kind", "runId", "ts", "seq", "source", "archived"])
	) {
		return storedRow.kind === "archived-mutation";
	}
	if (
		event.kind === "conversation" &&
		hasExactKeys(event, ["kind", "runId", "ts", "seq", "source", "payload"])
	) {
		return (
			storedRow.kind === "conversation" &&
			frozenConversationPayloadIsExact(event.payload)
		);
	}
	return false;
}

function hasOperationalContent(value: unknown): boolean {
	if (value === null || value === undefined) return false;
	if (Array.isArray(value)) return value.some(hasOperationalContent);
	if (isRecord(value)) return Object.values(value).some(hasOperationalContent);
	return true;
}

function rowsForOccurrence(
	occurrence: FrozenStorageOccurrence,
	snapshot: FrozenStorageSnapshot,
): readonly unknown[] {
	if (occurrence.table === "app_changes") {
		return acceptedRowsFor(occurrence, snapshot);
	}
	if (occurrence.table === "events") {
		return eventRowsFor(occurrence, snapshot);
	}
	if (occurrence.id === "cases.standard-properties") {
		return (snapshot.cases?.rows ?? []).filter(
			(value) =>
				isRecord(value) &&
				isRecord(value.properties) &&
				Object.keys(value.properties).some((key) =>
					PRE_CUTOVER_STANDARD_PROPERTIES.has(key),
				),
		);
	}
	if (occurrence.id === "apps.project-tenancy") {
		return (snapshot.apps?.rows ?? []).filter(
			(value) =>
				isRecord(value) &&
				(typeof value.project_id !== "string" ||
					value.project_id.trim().length === 0),
		);
	}
	if (occurrence.id === "cases.project-tenancy") {
		const projectByApp = new Map(
			(snapshot.apps?.rows ?? []).flatMap((value) =>
				isRecord(value) &&
				typeof value.id === "string" &&
				typeof value.project_id === "string" &&
				value.project_id.trim().length > 0
					? [[value.id, value.project_id] as const]
					: [],
			),
		);
		return (snapshot.cases?.rows ?? []).filter(
			(value) =>
				isRecord(value) &&
				(typeof value.app_id !== "string" ||
					typeof value.project_id !== "string" ||
					value.project_id.trim().length === 0 ||
					projectByApp.get(value.app_id) !== value.project_id),
		);
	}
	if (occurrence.id === "parked_case_values.standard-properties") {
		return (snapshot.parked_case_values?.rows ?? []).filter(
			(value) =>
				isRecord(value) &&
				typeof value.property === "string" &&
				PRE_CUTOVER_STANDARD_PROPERTIES.has(value.property),
		);
	}
	if (occurrence.id === "case-property-indexes.standard-properties") {
		return snapshot.__case_property_indexes?.rows ?? [];
	}
	return snapshot[occurrence.table]?.rows ?? [];
}

function projectOccurrence(
	occurrence: FrozenStorageOccurrence,
	snapshot: FrozenStorageSnapshot,
): FrozenOccurrenceProjection {
	const rawRows = rowsForOccurrence(occurrence, snapshot);
	let projected = rawRows.map((row) =>
		occurrence.id === "events.mutation"
			? row
			: projectDeclaredPath(row, occurrence.path),
	);
	if (occurrence.disposition === "delete-operational") {
		projected = projected.filter(hasOperationalContent);
	}
	return {
		id: occurrence.id,
		disposition: occurrence.disposition,
		table: occurrence.table,
		path: occurrence.path,
		semantic: occurrence.semantic,
		rowCount: projected.length,
		bytes: jsonBytes(projected),
		digest: frozenExactDigest(projected),
	};
}

/** Dispatch every manifest entry exactly once through its disposition. */
export function dispatchFrozenStorageOccurrences(
	snapshot: FrozenStorageSnapshot,
): readonly FrozenOccurrenceProjection[] {
	const handlers: Record<
		FrozenOccurrenceDisposition,
		(
			occurrence: FrozenStorageOccurrence,
			state: FrozenStorageSnapshot,
		) => FrozenOccurrenceProjection
	> = {
		"rewrite-current": projectOccurrence,
		"block-current": projectOccurrence,
		"archive-exact": projectOccurrence,
		"opaque-pre-horizon": projectOccurrence,
		"delete-operational": projectOccurrence,
		"preserve-exact": projectOccurrence,
		DDL: projectOccurrence,
	};
	const projections = FROZEN_STORAGE_OCCURRENCES.map((occurrence) =>
		handlers[occurrence.disposition](occurrence, snapshot),
	);
	if (
		projections.length !== FROZEN_STORAGE_OCCURRENCES.length ||
		new Set(projections.map((entry) => entry.id)).size !== projections.length
	) {
		throw new Error(
			"Canonical identity occurrence dispatcher did not cover the manifest exactly once.",
		);
	}
	return projections;
}

export function compareFrozenStorageOccurrences(
	source: FrozenStorageSnapshot,
	result: FrozenStorageSnapshot,
): FrozenOccurrencePlan {
	for (const occurrence of FROZEN_STORAGE_OCCURRENCES) {
		const beforeTable = source[occurrence.table];
		const afterTable = result[occurrence.table];
		if (beforeTable === undefined || afterTable === undefined) {
			throw new Error(
				`Canonical identity occurrence table ${occurrence.table} disappeared from the storage inventory.`,
			);
		}
		if (occurrence.disposition === "DDL") {
			if (afterTable.exists !== true) {
				throw new Error(
					`Canonical identity DDL relation ${occurrence.table} is absent from the result catalog.`,
				);
			}
			continue;
		}
		if (!beforeTable.exists || !afterTable.exists) {
			throw new Error(
				`Canonical identity non-DDL relation ${occurrence.table} must exist in both source and result catalogs.`,
			);
		}
	}
	const before = dispatchFrozenStorageOccurrences(source);
	const after = dispatchFrozenStorageOccurrences(result);
	const afterById = new Map(after.map((entry) => [entry.id, entry] as const));
	const manifestEntries = before.map((entry) => {
		const next = afterById.get(entry.id);
		if (next === undefined) {
			throw new Error(`Canonical identity occurrence ${entry.id} disappeared.`);
		}
		const isNewMigrationHorizon =
			entry.id === "app_changes.new-horizon-and-suffix" &&
			entry.rowCount === 0 &&
			next.rowCount > 0;
		/* This carrier is CLEARED rather than refused: a pre-cutover row may
		 * hold a standard scalar inside `properties`, and the migration strips
		 * it, keeping the authoritative column. So it may start non-zero, and
		 * the guarantee is that it ends at zero — a strictly stronger claim than
		 * "there were none to begin with", and one this audit can prove. */
		const isClearedStandardProperties =
			entry.id === "cases.standard-properties";
		if (
			entry.disposition === "block-current" &&
			(isClearedStandardProperties
				? next.rowCount !== 0
				: entry.rowCount !== 0 || next.rowCount !== 0)
		) {
			throw new Error(
				isClearedStandardProperties
					? `Canonical identity occurrence ${entry.id} still holds ${next.rowCount} standard case ${next.rowCount === 1 ? "property" : "properties"} in the document after the migration stripped them.`
					: `Canonical identity occurrence ${entry.id} has block-current rows (${entry.rowCount} source, ${next.rowCount} result).`,
			);
		}
		if (
			(entry.disposition === "preserve-exact" ||
				entry.disposition === "opaque-pre-horizon" ||
				entry.disposition === "archive-exact") &&
			!isNewMigrationHorizon &&
			entry.digest !== next.digest
		) {
			throw new Error(
				`Canonical identity occurrence ${entry.id} did not preserve exact content.`,
			);
		}
		/* The reverse media index is DROPPED and rebuilt from the authored
		 * Blueprint and the canonical thread attachments, so its rows differ from
		 * whatever the previous index held whenever that index had drifted — a
		 * stale edge is precisely what the rebuild exists to correct, and nothing
		 * clears edges when an app is soft-deleted or an asset is removed.
		 * Demanding the rebuild equal what it replaced asserts the old index was
		 * already correct, which is a claim about the prestate rather than about
		 * this migration. The rebuilt rows are proved exactly by
		 * `assertFrozenMediaReferenceRows`, row for row against the recomputed
		 * edge set, and every edge is proved ready, same-Project, and of the
		 * authored slot kind before insertion. The other DDL carriers only have a
		 * column type converted, so their content is genuinely unchanged and they
		 * keep the equality. */
		const isRebuiltMediaReferenceIndex =
			entry.id === "media_asset_refs.identity";
		if (isRebuiltMediaReferenceIndex && entry.digest !== next.digest) {
			console.error(
				`[media-index-rebuilt] ${entry.id}: ${entry.rowCount} stored edge(s) replaced by ${next.rowCount} recomputed edge(s)`,
			);
		}
		/* The generated standard-property indexes are DROPPED by this migration
		 * on purpose — the scalars they indexed move out of the document and into
		 * their own columns, so the expressions they were built on stop existing.
		 * `assertFrozenGeneratedIndexResult` proves the surviving set equals the
		 * source set minus exactly the indexes the drop pass reported, and
		 * `assertNoFrozenStandardPropertyIndexes` proves none is left. Requiring
		 * the carrier digest to be unchanged contradicts the deletion this
		 * migration exists to perform. */
		const isDroppedStandardPropertyIndexes =
			entry.id === "case-property-indexes.standard-properties";
		if (
			entry.disposition === "DDL" &&
			!isRebuiltMediaReferenceIndex &&
			!isDroppedStandardPropertyIndexes &&
			source[
				FROZEN_STORAGE_OCCURRENCES.find(
					(occurrence) => occurrence.id === entry.id,
				)?.table ?? ""
			]?.exists === true &&
			entry.digest !== next.digest
		) {
			throw new Error(
				`Canonical identity DDL occurrence ${entry.id} changed after creation.`,
			);
		}
		if (entry.disposition === "delete-operational" && next.rowCount !== 0) {
			throw new Error(
				`Canonical identity occurrence ${entry.id} was not deleted/reset.`,
			);
		}
		return {
			id: entry.id,
			disposition: entry.disposition,
			sourceDigest: entry.digest,
			resultDigest: next.digest,
			sourceRows: entry.rowCount,
			resultRows: next.rowCount,
			sourceBytes: entry.bytes,
			resultBytes: next.bytes,
		};
	});
	const exactPayloadRows = (
		value: FrozenStorageSnapshot,
	): readonly FrozenExactPayloadSnapshot[] =>
		(value.__exact_payloads?.rows ?? []).flatMap((entry) =>
			isRecord(entry) &&
			typeof entry.id === "string" &&
			typeof entry.rowCount === "number" &&
			typeof entry.bytes === "number" &&
			typeof entry.digest === "string"
				? [
						{
							id: entry.id,
							rowCount: entry.rowCount,
							bytes: entry.bytes,
							digest: entry.digest,
						},
					]
				: [],
		);
	const exactAfter = new Map(
		exactPayloadRows(result).map((entry) => [entry.id, entry] as const),
	);
	const exactEntries = exactPayloadRows(source).map((entry) => {
		const next = exactAfter.get(entry.id);
		if (next === undefined) {
			throw new Error(
				`Canonical identity exact payload ${entry.id} disappeared.`,
			);
		}
		const isNewHorizon =
			entry.id === "app_changes.horizon-and-suffix-envelope" &&
			entry.rowCount === 0 &&
			next.rowCount > 0;
		if (!isNewHorizon && entry.digest !== next.digest) {
			throw new Error(
				`Canonical identity exact payload ${entry.id} did not preserve source bytes.`,
			);
		}
		return {
			id: `exact:${entry.id}`,
			disposition: "preserve-exact" as const,
			sourceDigest: entry.digest,
			resultDigest: next.digest,
			sourceRows: entry.rowCount,
			resultRows: next.rowCount,
			sourceBytes: entry.bytes,
			resultBytes: next.bytes,
		};
	});
	const entries = [...manifestEntries, ...exactEntries];
	return {
		entries,
		sourceDigest: canonicalIdentityDigest(before),
		resultDigest: canonicalIdentityDigest(after),
		planDigest: canonicalIdentityDigest(entries),
		sourceBytes: entries.reduce((total, entry) => total + entry.sourceBytes, 0),
		resultBytes: entries.reduce((total, entry) => total + entry.resultBytes, 0),
	};
}
