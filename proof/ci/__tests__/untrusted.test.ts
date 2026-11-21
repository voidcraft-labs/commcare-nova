// The host's door for what a container or another job wrote (proof/ci/untrusted.mjs).
//
// Contract: a run's output holding anything but directories and plain files
// is moved aside whole and each entry named, so no later host step (an
// upload, which follows links, the gate, adoption) meets it; an output of
// plain files stays where it is. A surface is taken only as a plain file
// within its bound holding strict UTF-8 JSON with an items object, and an
// artifact's directory only where surface.json is all it holds. The
// plausible failures: a link followed to a host file (a key, a cloud
// credential) that is then uploaded or committed; a pipe that holds the host
// reading it; a surface that is no surface written over the committed one.
// Each refusal is paired with an accepted case.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import {
	mkdir,
	mkdtemp,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
	placeSurface,
	readSurface,
	SurfaceRefused,
	sealOutput,
} from "../untrusted.mjs";

const run = promisify(execFile);
const WORKTREE = resolve(import.meta.dirname, "..", "..", "..");

let scratch: string;

beforeEach(async () => {
	scratch = await mkdtemp(join(tmpdir(), "proof-untrusted-"));
});

afterEach(async () => {
	await rm(scratch, { recursive: true, force: true });
});

async function output(files: Record<string, string>) {
	const directory = join(scratch, "out");
	for (const [path, text] of Object.entries(files)) {
		await mkdir(join(directory, path, ".."), { recursive: true });
		await writeFile(join(directory, path), text);
	}
	await mkdir(directory, { recursive: true });
	return directory;
}

const said = () => {
	const lines: string[] = [];
	return { lines, say: (line: string) => lines.push(line) };
};

it("leaves an output of plain files and directories where it is", async () => {
	const directory = await output({
		"blocks/a/block.json": "{}\n",
		"blocks/a/hq-reads/reading/application.json": "{}\n",
		"serve.json": "{}\n",
	});
	const { lines, say } = said();
	expect(await sealOutput(directory, { say })).toEqual([]);
	expect(lines).toEqual([]);
	expect(existsSync(join(directory, "serve.json"))).toBe(true);
	expect(existsSync(`${directory}.refused`)).toBe(false);
});

it.each([
	["a link to a host file", "file"],
	["a link to a host directory", "directory"],
])(
	"moves aside an output holding %s, naming it, and follows nothing",
	async (_, kind) => {
		const secret = join(scratch, "secret");
		if (kind === "file") await writeFile(secret, "a host key\n");
		else await mkdir(secret);
		const directory = await output({ "blocks/a/block.json": "{}\n" });
		await symlink(secret, join(directory, "blocks/a/leak"));
		const { lines, say } = said();
		const refused = await sealOutput(directory, { say });
		expect(refused).toEqual([
			{ path: join(directory, "blocks/a/leak"), kind: "a link and not a file" },
		]);
		expect(lines[0]).toContain(
			`${join(directory, "blocks/a/leak")}, which is a link and not a file`,
		);
		expect(lines[0]).toContain(`moved to ${directory}.refused`);
		expect(existsSync(directory)).toBe(false);
		expect(
			existsSync(join(`${directory}.refused`, "blocks/a/block.json")),
		).toBe(true);
	},
);

it("moves aside an output holding a pipe, which a reader would block on", async () => {
	const directory = await output({ "serve.json": "{}\n" });
	await run("mkfifo", [join(directory, "pipe")]);
	const refused = await sealOutput(directory, { say: () => {} });
	expect(refused.map((entry) => entry.kind)).toEqual(["a pipe"]);
	expect(existsSync(`${directory}.refused`)).toBe(true);
});

it("holds nothing to seal where the output was never made", async () => {
	expect(await sealOutput(join(scratch, "absent"), { say: () => {} })).toEqual(
		[],
	);
});

it("reads the committed surface byte for byte", async () => {
	const committed = join(WORKTREE, "lib/commcare/surface/surface.json");
	const { bytes, value } = await readSurface(committed);
	expect(Buffer.compare(bytes, await readFile(committed))).toBe(0);
	expect(typeof value.items).toBe("object");
});

it.each([
	["a link", "link", "is a link"],
	["over its bound", '{"items":{"x":{}}}', "larger than 8 bytes"],
	["not JSON", "not json", "is not JSON"],
	["not UTF-8", "ÿ", "is not JSON"],
	["JSON with no items object", '{"items":[]}', "no items object"],
	[
		"an item with missing facts",
		'{"items":{"toggle:active":null}}',
		"must be an object of extracted facts",
	],
])("refuses a surface that is %s", async (_, text, why) => {
	const file = join(scratch, "surface.json");
	if (text === "link") {
		await writeFile(join(scratch, "target.json"), '{"items":{}}\n');
		await symlink(join(scratch, "target.json"), file);
	} else if (text === "ÿ") {
		await writeFile(file, Buffer.from([0x7b, 0xff, 0x7d]));
	} else {
		await writeFile(file, text);
	}
	const bound = why.startsWith("larger") ? 8 : undefined;
	const reading = readSurface(file, bound === undefined ? {} : { bound });
	await expect(reading).rejects.toBeInstanceOf(SurfaceRefused);
	await expect(reading).rejects.toThrow(why);
});

it("places the one surface.json an artifact holds, and refuses one that holds more", async () => {
	const artifact = join(scratch, "artifact");
	await mkdir(artifact);
	await writeFile(join(artifact, "surface.json"), '{"items":{"a":{}}}\n');
	const destination = join(scratch, "placed.json");
	await placeSurface(artifact, destination);
	expect(await readFile(destination, "utf8")).toBe('{"items":{"a":{}}}\n');

	await writeFile(join(artifact, "x.test.ts"), "export {};\n");
	await writeFile(destination, "committed\n");
	await expect(placeSurface(artifact, destination)).rejects.toThrow(
		"holds x.test.ts beside surface.json",
	);
	expect(await readFile(destination, "utf8")).toBe("committed\n");
});
