/**
 * yazl 3.3.1 uses the central directory offset to widen a member's data
 * descriptor. Android's ZipInputStream chooses descriptor width from the
 * inflated/compressed member's actual lengths; the descriptor has no offset.
 * Keep the central directory ZIP64 where needed. See streamZip.test.ts.
 * Reject any changed upstream input so an upgrade requires a fresh witness.
 */
import { createHash, randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const original =
	"73c9e5b6c10dea1892f13f4180be0c11b061b5d60f9937dd4f5cae6a47ec36c2";
const corrected =
	"8b6fb46af73bee795bc3c1b761f64637b0b73f333179c4f26c8baaafdee55e93";
const root = resolve(
	process.argv[2] ?? fileURLToPath(new URL("..", import.meta.url)),
);
const entry = join(root, "node_modules", "yazl", "index.js");
const source = await readFile(entry, "utf8");
const digest = (s) => createHash("sha256").update(s).digest("hex");
if (digest(source) !== corrected) {
	if (digest(source) !== original)
		throw new Error(
			"The installed yazl differs from the reviewed ZIP64 writer.",
		);
	const fixed = source
		.replace(
			"Entry.prototype.useZip64Format = function() {",
			`Entry.prototype.useZip64Descriptor = function() {
  return this.forceZip64Format || this.uncompressedSize > 0xffffffff || this.compressedSize > 0xffffffff;
};
Entry.prototype.useZip64Format = function() {`,
		)
		.replace(
			"if (!this.useZip64Format()) {",
			"if (!this.useZip64Descriptor()) {",
		)
		.replace(
			"// use a data descriptor\n      if (useZip64Format)",
			"// use a data descriptor\n      if (entry.useZip64Descriptor())",
		);
	if (digest(fixed) !== corrected)
		throw new Error("The ZIP64 correction differs from the verified writer.");
	// A proof checkout may hardlink its dependencies to the shared cache.
	// Replace the directory entry, never rewrite the shared inode.
	const temporary = `${entry}.${randomUUID()}`;
	try {
		await writeFile(temporary, fixed, { flag: "wx" });
		await rename(temporary, entry);
	} finally {
		await rm(temporary, { force: true });
	}
}
