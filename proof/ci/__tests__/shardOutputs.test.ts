// proof/ci/shard-outputs.mjs gives a lone shard's output the directory every
// shard's output lands in when a pattern download matches several artifacts,
// so the verdict's and the store's glob (proof-shards/proof-out-*) reads one
// shard as it reads many. The plausible failures are a lone output left loose
// (the gate is called with no outputs and refuses), outputs that already have
// their directories moved again, and a step that fails where no shard
// uploaded anything. These run the script as the workflow does over a real
// directory and read the tree it leaves.

import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { Scripts } from "./scripts";

let scratch: string;
let scripts: Scripts;
let shards: string;

beforeEach(async () => {
	scratch = await mkdtemp(join(tmpdir(), "proof-ci-shard-outputs-"));
	scripts = new Scripts(undefined, scratch);
	shards = join(scratch, "proof-shards");
});

afterEach(async () => {
	await scripts.join();
	await rm(scratch, { recursive: true, force: true });
});

async function tree(dir: string): Promise<string[]> {
	const entries = await readdir(dir, { recursive: true, withFileTypes: true });
	return entries
		.filter((entry) => entry.isFile())
		.map((entry) => relative(dir, join(entry.parentPath, entry.name)))
		.sort();
}

async function put(path: string) {
	await mkdir(join(shards, path, ".."), { recursive: true });
	await writeFile(join(shards, path), "{}\n");
}

const place = (name = "proof-out-nightly-1-1") =>
	scripts.run("shard-outputs.mjs", ["--dir", shards, "--name", name], {
		env: {},
	});

it("moves a lone shard's loose output into the directory named for its artifact", async () => {
	await put("blocks/b1/records.json");
	await put("collected.json");
	const result = await place();
	expect(result.code).toBe(0);
	expect(await tree(shards)).toEqual([
		"proof-out-nightly-1-1/blocks/b1/records.json",
		"proof-out-nightly-1-1/collected.json",
	]);
});

it("leaves the outputs of several shards where the download put them", async () => {
	await put("proof-out-nightly-1-1/collected.json");
	await put("proof-out-nightly-1-2/collected.json");
	const result = await place();
	expect(result.code).toBe(0);
	expect(await tree(shards)).toEqual([
		"proof-out-nightly-1-1/collected.json",
		"proof-out-nightly-1-2/collected.json",
	]);
});

it("changes nothing when no shard uploaded an output", async () => {
	expect((await place()).code).toBe(0);
	await mkdir(shards);
	expect((await place()).code).toBe(0);
	expect(await readdir(shards)).toEqual([]);
});

it("refuses a name the consumers' glob would not read", async () => {
	await put("collected.json");
	const result = await place("shard-1");
	expect(result.code).toBe(2);
	expect(await tree(shards)).toEqual(["collected.json"]);
});
