import { promises as fs } from "node:fs";
import path from "node:path";

const CCZ_DIR = path.join(process.cwd(), ".data", "ccz");

/** Matches a standard v4 UUID (hex-and-dashes, 36 chars). */
const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Owner segment guard. The owner is the authenticated user id from the
 * caller's session (Better Auth's `generateId` — alphanumeric), never
 * client-supplied text. It's still validated here because it becomes a
 * filesystem path segment: an alphanumeric-only owner can't carry `..` or
 * a separator that would escape the ccz directory.
 */
const OWNER_RE = /^[a-zA-Z0-9]+$/;

/**
 * Resolve the on-disk path for a compiled archive, owner-scoped as
 * `<dir>/<owner>/<id>.ccz`.
 *
 * Archives are keyed by a random UUID AND the owner id so the download
 * route can bind access to the caller: it resolves `owner` from the
 * session, so a user who learns another user's compile id still reads
 * only their OWN namespace — the foreign archive is simply absent (404),
 * never served. Without the owner segment any authenticated user could
 * download any archive by id (the archives now bundle media bytes, so the
 * exposure is the victim's app structure AND their media).
 *
 * Both segments are validated so a malformed id/owner can't traverse out
 * of the ccz directory regardless of origin.
 */
function cczPath(id: string, owner: string): string {
	if (!UUID_RE.test(id)) {
		throw new Error(
			`Invalid CCZ id: expected a UUID, got "${id.slice(0, 40)}".`,
		);
	}
	if (!OWNER_RE.test(owner)) {
		throw new Error(
			`Invalid CCZ owner: expected an alphanumeric user id, got "${owner.slice(0, 40)}".`,
		);
	}
	return path.join(CCZ_DIR, owner, `${id}.ccz`);
}

/** Persist a compiled archive under its owner's namespace. */
export async function saveCcz(
	id: string,
	buffer: Buffer,
	owner: string,
): Promise<void> {
	const file = cczPath(id, owner);
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(file, buffer);
}

/**
 * Read a compiled archive for `owner`, or `null` when there's no archive
 * at that (owner, id) — including the cross-user case (a foreign id resolves
 * under the caller's namespace and isn't found). A malformed id/owner is a
 * miss, not a throw, so the download route returns a clean 404.
 */
export async function getCcz(
	id: string,
	owner: string,
): Promise<Buffer | null> {
	let file: string;
	try {
		file = cczPath(id, owner);
	} catch {
		return null;
	}
	try {
		return await fs.readFile(file);
	} catch {
		return null;
	}
}
