/** Sort orders supported by `listApps`. `searchApps` takes none — Fuse ranks
 *  by relevance, the only sensible ordering for a search. */
export type AppsSortOrder =
	| "updated_desc"
	| "updated_asc"
	| "name_asc"
	| "name_desc";

/**
 * Structured cursor used to resume enumeration in `listApps`. Discriminated
 * by `kind`, which MUST equal the `sort` the caller is running with; the
 * server enforces the match and throws rather than silently coerce. The `id`
 * component makes `(sort_field, id)` a stable composite sort key. Wire form:
 * base64url JSON via `encodeAppsCursor`/`decodeAppsCursor`.
 */
export type ListAppsCursor =
	| { kind: "updated_desc"; updated_at: string; id: string }
	| { kind: "updated_asc"; updated_at: string; id: string }
	| { kind: "name_asc"; name_lower: string; id: string }
	| { kind: "name_desc"; name_lower: string; id: string };

/** A caller can recover by restarting the listing without a cursor. */
export class AppPaginationError extends Error {
	constructor(
		message = "This pagination cursor is invalid. Try again without a cursor.",
	) {
		super(message);
		this.name = "AppPaginationError";
	}
}

export function encodeAppsCursor(cursor: ListAppsCursor): string {
	return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

/** Admit only values the cursor writer can emit, before constructing SQL. */
export function decodeAppsCursor(
	encoded: string,
	sort: AppsSortOrder,
): ListAppsCursor {
	let parsed: unknown;
	try {
		const bytes = Buffer.from(encoded, "base64url");
		if (bytes.toString("base64url") !== encoded) throw new AppPaginationError();
		parsed = JSON.parse(bytes.toString("utf8"));
	} catch {
		throw new AppPaginationError();
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new AppPaginationError();
	}
	const obj = parsed as Record<string, unknown>;
	const { kind, id } = obj;
	if (
		typeof id !== "string" ||
		id.length === 0 ||
		id.includes("\0") ||
		Object.keys(obj).length !== 3
	) {
		throw new AppPaginationError();
	}
	let cursor: ListAppsCursor;
	if (kind === "updated_desc" || kind === "updated_asc") {
		const updatedAt = obj.updated_at;
		if (typeof updatedAt !== "string") throw new AppPaginationError();
		const date = new Date(updatedAt);
		if (!Number.isFinite(date.getTime()) || date.toISOString() !== updatedAt) {
			throw new AppPaginationError();
		}
		cursor = { kind, updated_at: updatedAt, id };
	} else if (kind === "name_asc" || kind === "name_desc") {
		const nameLower = obj.name_lower;
		if (typeof nameLower !== "string" || nameLower.includes("\0"))
			throw new AppPaginationError();
		cursor = { kind, name_lower: nameLower, id };
	} else {
		throw new AppPaginationError();
	}
	if (cursor.kind !== sort) {
		throw new AppPaginationError(
			`Cursor was minted for sort="${cursor.kind}" but this call uses sort="${sort}". Try again without a cursor.`,
		);
	}
	return cursor;
}
