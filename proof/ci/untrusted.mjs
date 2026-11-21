// What a container or another job wrote is data, never the host's own files.
// The proof lane's container runs upstream code at its pins with a writable
// output directory, and an artifact is whatever the job that uploaded it
// wrote, so nothing in either is trusted to be what its name says. This
// module is the host's door for both:
//
// - sealOutput(directory) walks a run's output once its container has
//   exited, without following a link, and refuses an output that holds
//   anything but directories and plain files: it is moved aside to
//   `<directory>.refused`, outside every path a workflow uploads or a later
//   step reads, so no host step (an artifact upload, the gate, the store's
//   pack and audit, adoption) can follow a link a container left. A plain
//   file's link count is not read: link(2) never crosses a mount, so a
//   container cannot give a host file a second name under its output.
// - readSurface(file) reads a surface the extraction wrote, or an artifact
//   carried, opened without following a link and without blocking, within
//   SURFACE_BOUND bytes, as strict UTF-8 JSON holding an `items` object.
//
//   node proof/ci/untrusted.mjs seal DIRECTORY
//   node proof/ci/untrusted.mjs surface FROM_DIRECTORY TO_FILE
//
// `seal` exits SEAL_REFUSED where it moved the output aside. `surface`
// places the one surface.json an artifact's directory holds (and nothing
// else may be there) at TO_FILE, and exits 1 where it refuses.

import { constants } from "node:fs";
import { lstat, open, opendir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The most bytes a surface may hold: the committed surface is about 2.4 MiB. */
export const SURFACE_BOUND = 16 * 1024 * 1024;

/** The exit status of a run whose output was moved aside. */
export const SEAL_REFUSED = 6;

/** Why a non-directory, non-file entry is no part of an output, in a person's words. */
function kindOf(entry) {
	if (entry.isSymbolicLink()) return "a link and not a file";
	if (entry.isFIFO()) return "a pipe";
	if (entry.isSocket()) return "a socket";
	if (entry.isCharacterDevice() || entry.isBlockDevice()) return "a device";
	return "neither a file nor a directory";
}

/** Every entry under `directory` that is not a directory or a plain file, each with what it is; links are never followed. */
async function foreignEntries(directory) {
	let root;
	try {
		root = await lstat(directory);
	} catch (error) {
		// A run that never wrote its output, or whose output was already moved aside, has nothing to seal.
		if (error.code === "ENOENT") return [];
		throw error;
	}
	if (!root.isDirectory()) {
		return [
			{
				path: directory,
				kind: root.isFile()
					? "a plain file where a directory is required"
					: kindOf(root),
			},
		];
	}
	const found = [];
	const pending = [directory];
	while (pending.length > 0) {
		const current = pending.pop();
		const handle = await opendir(current);
		for await (const entry of handle) {
			const path = join(current, entry.name);
			if (entry.isDirectory()) pending.push(path);
			else if (!entry.isFile()) found.push({ path, kind: kindOf(entry) });
		}
	}
	return found.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * Holds a run's output to plain files and directories once its container has
 * exited. Where it holds anything else, the directory is moved to
 * `<directory>.refused` and each entry is named on stderr; returns the
 * entries refused (none where the output is sealed in place).
 *
 * @param {string} directory
 * @param {{ say?: (line: string) => unknown }} [options]
 */
export async function sealOutput(
	directory,
	{ say = (line) => process.stderr.write(`${line}\n`) } = {},
) {
	const foreign = await foreignEntries(directory);
	if (foreign.length === 0) return [];
	const aside = `${directory}.refused`;
	await rename(directory, aside);
	for (const { path, kind } of foreign.slice(0, 20)) {
		say(
			`The run's output holds ${path}, which is ${kind}. A run writes plain files only, so nothing of it is uploaded or adopted, and the output was moved to ${aside}. The run's log says what wrote it.`,
		);
	}
	if (foreign.length > 20) {
		say(`It holds ${foreign.length - 20} more entries like these.`);
	}
	return foreign;
}

/** A refusal of a surface, its message the sentence a person reads. */
export class SurfaceRefused extends Error {}

/**
 * The surface at `file`: its bytes and its parsed value. Refused where it is
 * a link, not a plain file, over SURFACE_BOUND bytes, not strict UTF-8 JSON,
 * or holds no `items` object.
 */
export async function readSurface(file, { bound = SURFACE_BOUND } = {}) {
	let handle;
	try {
		handle = await open(
			file,
			constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
		);
	} catch (error) {
		const what =
			error.code === "ELOOP"
				? "a link"
				: error.code === "ENOENT"
					? "missing"
					: `unreadable (${error.code ?? error.message})`;
		throw new SurfaceRefused(`The surface at ${file} is ${what}.`);
	}
	let bytes;
	try {
		const held = await handle.stat();
		if (!held.isFile()) {
			throw new SurfaceRefused(`The surface at ${file} is not a plain file.`);
		}
		if (held.size > bound) {
			throw new SurfaceRefused(
				`The surface at ${file} is larger than ${bound} bytes.`,
			);
		}
		const buffer = Buffer.alloc(bound + 1);
		let filled = 0;
		for (;;) {
			const { bytesRead } = await handle.read(
				buffer,
				filled,
				buffer.length - filled,
				null,
			);
			if (bytesRead === 0) break;
			filled += bytesRead;
			if (filled > bound) {
				throw new SurfaceRefused(
					`The surface at ${file} is larger than ${bound} bytes.`,
				);
			}
		}
		bytes = buffer.subarray(0, filled);
	} finally {
		await handle.close();
	}
	let value;
	try {
		value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	} catch (error) {
		throw new SurfaceRefused(
			`The surface at ${file} is not JSON (${error.message}).`,
		);
	}
	const items = value?.items;
	if (
		typeof value !== "object" ||
		value === null ||
		Array.isArray(value) ||
		typeof items !== "object" ||
		items === null ||
		Array.isArray(items)
	) {
		throw new SurfaceRefused(
			`The surface at ${file} is JSON with no items object at its top.`,
		);
	}
	if (
		Object.values(items).some(
			(item) => !item || typeof item !== "object" || Array.isArray(item),
		)
	) {
		throw new SurfaceRefused(
			`Each item in the surface at ${file} must be an object of extracted facts.`,
		);
	}
	return { bytes, value };
}

/** The one surface.json an artifact's directory holds, placed at `destination`; refused where the directory holds anything else. */
export async function placeSurface(directory, destination) {
	if (!(await lstat(directory)).isDirectory()) {
		throw new SurfaceRefused(
			`The surface artifact at ${directory} must be a directory.`,
		);
	}
	const names = [];
	const handle = await opendir(directory);
	for await (const entry of handle) names.push(entry.name);
	const others = names.filter((name) => name !== "surface.json").sort();
	if (others.length > 0) {
		throw new SurfaceRefused(
			`The surface artifact in ${directory} holds ${others.join(", ")} beside surface.json, and it carries that one file only.`,
		);
	}
	const { bytes } = await readSurface(join(directory, "surface.json"));
	await writeFile(destination, bytes);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const [command, ...rest] = process.argv.slice(2);
	const fail = (error) => {
		process.stderr.write(`${error.message}\n`);
		process.exit(1);
	};
	if (command === "seal" && rest.length === 1) {
		sealOutput(rest[0]).then(
			(foreign) => process.exit(foreign.length === 0 ? 0 : SEAL_REFUSED),
			fail,
		);
	} else if (command === "surface" && rest.length === 2) {
		placeSurface(rest[0], rest[1]).then(() => process.exit(0), fail);
	} else {
		process.stderr.write(
			`untrusted.mjs takes \`seal DIRECTORY\` or \`surface FROM_DIRECTORY TO_FILE\`; got ${JSON.stringify(process.argv.slice(2))}.\n`,
		);
		process.exit(2);
	}
}
