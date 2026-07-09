/**
 * Firestore REST access for the one-time Firestore→Postgres cutover scripts.
 *
 * The firebase / `@google-cloud/firestore` SDKs are gone from the runtime, so
 * these scripts read the OLD Firestore database over its REST API v1 using
 * `google-auth-library` (a devDependency) for Application Default Credentials.
 * Two things live here, shared by the scan + migrate scripts:
 *
 *   1. A decoder for Firestore REST `Value` wrappers → plain JS. Each wrapper
 *      is a one-key object (`{stringValue: "…"}`); `decodeValue` unwraps it:
 *        - `stringValue`     → string (verbatim)
 *        - `integerValue`    → number (REST sends int64 as a decimal STRING)
 *        - `doubleValue`     → number
 *        - `booleanValue`    → boolean
 *        - `timestampValue`  → ISO-8601 string (RFC-3339, left as text — the
 *                              callers `new Date(...)` the ones they store)
 *        - `nullValue`       → null
 *        - `bytesValue`      → the base64 string as-is (unused by our data)
 *        - `referenceValue`  → the document path string
 *        - `geoPointValue`   → `{latitude, longitude}`
 *        - `mapValue`        → object (recursively decoded `fields`)
 *        - `arrayValue`      → array (recursively decoded `values`)
 *      An unrecognized wrapper THROWS, so a caller can count the doc as
 *      "undecodable" instead of silently dropping a field.
 *
 *   2. A thin REST client: `runQuery` (structured queries), `getDocument`, and
 *      `__name__`-cursor-paginated scanners for a collection-group, a root
 *      collection, or one document's subcollection.
 *
 * This file is deleted in a follow-up commit once the production cutover has
 * run (see the two scripts' headers).
 */

import { GoogleAuth } from "google-auth-library";

/** The OAuth scope Firestore's REST surface authorizes against. */
const DATASTORE_SCOPE = "https://www.googleapis.com/auth/datastore";

/** Documents pulled per `runQuery` page. Firestore caps a page at 300 docs by
 *  default for a query with no explicit `limit`; we page explicitly by
 *  `__name__` cursor, so this is just the per-request batch size. */
const DEFAULT_PAGE_SIZE = 300;

const API_BASE = "https://firestore.googleapis.com/v1/";

// ── Firestore REST value decoding ───────────────────────────────────

/** A Firestore REST `Value` — a one-key wrapper. Loosely typed: the decoder
 *  branches on which key is present. */
export type FirestoreValue = Record<string, unknown>;

/** A Firestore REST `Document`: `name` is the full resource path; `fields` is
 *  the doc body as `{ key: Value }` (absent for an empty document). */
export interface FirestoreDocument {
	name: string;
	fields?: Record<string, FirestoreValue>;
	createTime?: string;
	updateTime?: string;
}

/** One `runQuery` response element. Only `document` matters; an empty result
 *  set yields a single element carrying just `readTime`. */
interface RunQueryRow {
	document?: FirestoreDocument;
	readTime?: string;
	skippedResults?: number;
	done?: boolean;
}

/** Unwrap one Firestore REST `Value`. Throws on an unrecognized wrapper so the
 *  caller can classify the document as undecodable rather than lose a field. */
export function decodeValue(value: FirestoreValue): unknown {
	if (value == null || typeof value !== "object") {
		throw new Error(`not a Firestore value wrapper: ${JSON.stringify(value)}`);
	}
	if ("nullValue" in value) return null;
	if ("booleanValue" in value) return Boolean(value.booleanValue);
	if ("integerValue" in value) return Number(value.integerValue);
	if ("doubleValue" in value) return Number(value.doubleValue);
	if ("timestampValue" in value) return String(value.timestampValue);
	if ("stringValue" in value) return String(value.stringValue);
	if ("bytesValue" in value) return String(value.bytesValue);
	if ("referenceValue" in value) return String(value.referenceValue);
	if ("geoPointValue" in value) {
		const gp = value.geoPointValue as { latitude?: number; longitude?: number };
		return { latitude: gp?.latitude ?? 0, longitude: gp?.longitude ?? 0 };
	}
	if ("arrayValue" in value) {
		const values = (value.arrayValue as { values?: FirestoreValue[] })?.values;
		return (values ?? []).map(decodeValue);
	}
	if ("mapValue" in value) {
		const fields = (
			value.mapValue as { fields?: Record<string, FirestoreValue> }
		)?.fields;
		return decodeFields(fields ?? {});
	}
	throw new Error(
		`unrecognized Firestore value type: {${Object.keys(value).join(", ")}}`,
	);
}

/** Decode a Firestore `fields` map (`{ key: Value }`) to a plain object. */
export function decodeFields(
	fields: Record<string, FirestoreValue>,
): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(fields)) {
		out[key] = decodeValue(value);
	}
	return out;
}

/** Decode a whole document's body (`{}` when it carries no fields). */
export function decodeDocument(
	doc: FirestoreDocument,
): Record<string, unknown> {
	return decodeFields(doc.fields ?? {});
}

// ── Path helpers ────────────────────────────────────────────────────

/** The path segments after `/documents/` — e.g. `apps/{id}/events/{eventId}` →
 *  `["apps", "{id}", "events", "{eventId}"]`. */
export function segmentsFromName(name: string): string[] {
	const marker = "/documents/";
	const at = name.indexOf(marker);
	const rel = at >= 0 ? name.slice(at + marker.length) : name;
	return rel.split("/");
}

/** The leaf document id (the last path segment). */
export function docIdFromName(name: string): string {
	const segments = segmentsFromName(name);
	return segments[segments.length - 1] ?? name;
}

/** The `apps/{appId}/…` owner id for a subcollection document (segment 1). */
export function appIdFromName(name: string): string {
	return segmentsFromName(name)[1] ?? "";
}

/** A compact `collection/id/...` rendering of a document path for log samples. */
export function shortPath(name: string): string {
	return segmentsFromName(name).join("/");
}

// ── Deterministic stringify (deep key sort) ─────────────────────────

/**
 * Canonical JSON with every object's keys sorted recursively, so two objects
 * that differ only in key order stringify identically. Arrays keep their
 * order. `undefined`-valued keys drop (JSON.stringify's behavior), so an
 * absent key and an `undefined` key compare equal on both sides.
 */
export function stableStringify(value: unknown): string {
	return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortDeep);
	if (value && typeof value === "object") {
		const source = value as Record<string, unknown>;
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(source).sort()) {
			out[key] = sortDeep(source[key]);
		}
		return out;
	}
	return value;
}

// ── REST client ─────────────────────────────────────────────────────

export interface FirestoreRest {
	readonly project: string;
	/** `projects/{project}/databases/(default)/documents`. */
	readonly documentsRoot: string;
	/** Fetch one document by relative path (`apps/{id}`); `null` on 404. */
	getDocument(relativePath: string): Promise<FirestoreDocument | null>;
	/** Every document of a collection id anywhere in the database. */
	scanCollectionGroup(collectionId: string): AsyncGenerator<FirestoreDocument>;
	/** Every direct child document of a ROOT collection. */
	scanRootCollection(collectionId: string): AsyncGenerator<FirestoreDocument>;
	/** Every document of a subcollection under one parent document. */
	scanSubcollection(
		parentRelativePath: string,
		collectionId: string,
	): AsyncGenerator<FirestoreDocument>;
}

/**
 * Build a REST client bound to `project`, authenticated with ADC. `getClient()`
 * resolves the ambient credentials (`gcloud auth application-default login`
 * locally, the metadata server on Cloud Run) once; every request rides the
 * auto-refreshed bearer.
 */
export async function createFirestoreRest(
	project: string,
	pageSize: number = DEFAULT_PAGE_SIZE,
): Promise<FirestoreRest> {
	const auth = new GoogleAuth({ scopes: DATASTORE_SCOPE });
	const client = await auth.getClient();
	const documentsRoot = `projects/${project}/databases/(default)/documents`;

	async function runQuery(
		parent: string,
		structuredQuery: Record<string, unknown>,
	): Promise<RunQueryRow[]> {
		const res = await client.request<RunQueryRow[]>({
			url: `${API_BASE}${parent}:runQuery`,
			method: "POST",
			data: { structuredQuery },
		});
		return res.data ?? [];
	}

	async function getDocument(
		relativePath: string,
	): Promise<FirestoreDocument | null> {
		const encoded = relativePath.split("/").map(encodeURIComponent).join("/");
		try {
			const res = await client.request<FirestoreDocument>({
				url: `${API_BASE}${documentsRoot}/${encoded}`,
				method: "GET",
			});
			return res.data ?? null;
		} catch (err) {
			if (statusOf(err) === 404) return null;
			throw err;
		}
	}

	/** `__name__`-cursor pagination over a structured query. Ordering by the
	 *  document key needs no composite index and groups a collection-group scan
	 *  by parent path (all of one app's events are contiguous). */
	async function* scan(
		parent: string,
		collectionId: string,
		allDescendants: boolean,
	): AsyncGenerator<FirestoreDocument> {
		let cursor: string | null = null;
		for (;;) {
			const structuredQuery: Record<string, unknown> = {
				from: [{ collectionId, allDescendants }],
				orderBy: [{ field: { fieldPath: "__name__" }, direction: "ASCENDING" }],
				limit: pageSize,
			};
			if (cursor) {
				// `before: false` ⇒ start STRICTLY AFTER the last document seen.
				structuredQuery.startAt = {
					values: [{ referenceValue: cursor }],
					before: false,
				};
			}
			const rows = await runQuery(parent, structuredQuery);
			const docs = rows
				.map((r) => r.document)
				.filter((d): d is FirestoreDocument => d != null);
			for (const doc of docs) yield doc;
			if (docs.length < pageSize) return;
			cursor = docs[docs.length - 1].name;
		}
	}

	return {
		project,
		documentsRoot,
		getDocument,
		scanCollectionGroup: (collectionId) =>
			scan(documentsRoot, collectionId, true),
		scanRootCollection: (collectionId) =>
			scan(documentsRoot, collectionId, false),
		scanSubcollection: (parentRelativePath, collectionId) =>
			scan(`${documentsRoot}/${parentRelativePath}`, collectionId, false),
	};
}

/** The HTTP status carried by a google-auth-library / gaxios request error. */
function statusOf(err: unknown): number | undefined {
	const e = err as {
		status?: number;
		code?: number | string;
		response?: { status?: number };
	};
	if (typeof e?.status === "number") return e.status;
	if (typeof e?.response?.status === "number") return e.response.status;
	if (typeof e?.code === "number") return e.code;
	return undefined;
}
