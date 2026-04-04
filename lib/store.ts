import { promises as fs } from "fs";
import path from "path";

const CCZ_DIR = path.join(process.cwd(), ".data", "ccz");

/** Matches a standard v4 UUID (hex-and-dashes, 36 chars). */
const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validate that an ID is a well-formed UUID.
 * Prevents path traversal — IDs like `../../etc/passwd` are rejected
 * before they can reach any filesystem operation.
 */
function assertValidId(id: string): void {
	if (!UUID_RE.test(id)) {
		throw new Error(`Invalid CCZ ID: expected UUID, got "${id.slice(0, 40)}"`);
	}
}

export async function saveCcz(id: string, buffer: Buffer): Promise<void> {
	assertValidId(id);
	await fs.mkdir(CCZ_DIR, { recursive: true });
	await fs.writeFile(path.join(CCZ_DIR, `${id}.ccz`), buffer);
}

export async function getCcz(id: string): Promise<Buffer | null> {
	if (!UUID_RE.test(id)) return null;
	try {
		return await fs.readFile(path.join(CCZ_DIR, `${id}.ccz`));
	} catch {
		return null;
	}
}
