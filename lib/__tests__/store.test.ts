/**
 * Tests for the compiled-archive store's owner-binding — the access
 * control that keeps a `.ccz` (which bundles app structure + media bytes)
 * from being downloaded by id alone.
 *
 * `node:fs` is mocked with an in-memory path→Buffer map so the test
 * exercises the real path derivation (owner segment + UUID validation)
 * without touching disk. `node:path` is left real, so `ownerA` and
 * `ownerB` genuinely resolve to different paths — proving the cross-user
 * read misses rather than asserting it against a hand-stubbed path.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const files = new Map<string, Buffer>();

vi.mock("node:fs", () => ({
	promises: {
		mkdir: vi.fn(async () => undefined),
		writeFile: vi.fn(async (p: string, data: Buffer) => {
			files.set(p, data);
		}),
		readFile: vi.fn(async (p: string) => {
			const buf = files.get(p);
			if (!buf) {
				const err = new Error("ENOENT") as NodeJS.ErrnoException;
				err.code = "ENOENT";
				throw err;
			}
			return buf;
		}),
	},
}));

import { getCcz, saveCcz } from "../store";

const UUID = "12345678-1234-1234-1234-123456789abc";

beforeEach(() => files.clear());

describe("ccz store owner-binding", () => {
	it("returns the archive to the owner who saved it", async () => {
		await saveCcz(UUID, Buffer.from("ccz-bytes"), "ownerA");
		const got = await getCcz(UUID, "ownerA");
		expect(got?.toString()).toBe("ccz-bytes");
	});

	it("returns null for a different caller — a known id can't cross users", async () => {
		await saveCcz(UUID, Buffer.from("ccz-bytes"), "ownerA");
		// Same id, different owner: the owner segment puts it on a different
		// path, so the read misses (404), not serves the foreign archive.
		expect(await getCcz(UUID, "ownerB")).toBeNull();
	});

	it("treats a malformed id or owner as a miss, not a throw", async () => {
		await saveCcz(UUID, Buffer.from("x"), "ownerA");
		expect(await getCcz("../../etc/passwd", "ownerA")).toBeNull();
		expect(await getCcz(UUID, "../evil")).toBeNull();
	});

	it("rejects a malformed id or owner on save (path-traversal guard)", async () => {
		await expect(
			saveCcz("not-a-uuid", Buffer.from("x"), "ownerA"),
		).rejects.toThrow(/UUID/);
		await expect(saveCcz(UUID, Buffer.from("x"), "../evil")).rejects.toThrow(
			/owner/,
		);
	});
});
