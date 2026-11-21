// The corpus's Vitest writers (proof/corpus/emit.ts) and the native Vitest
// producers (proof/native/families.py) run inside the lane's container, where
// the checkout and node_modules are mounted read-only, so what they hand
// Vitest must leave it nothing to write there: the config loaded by Node's own
// import (Vite's default loader first bundles it into node_modules/.vite-temp,
// and on a read-only mount Vitest stops before its first test), and neither
// the results cache nor the module cache. The plausible failures: a writer
// that drops one of the options (the lane's emission then fails before its
// first document, as a hosted run once did), a spelling Vitest reads as
// something else, the two languages' lists drifting apart, and a config the
// native loader cannot load. Each list is read by Vitest's own CLI parser,
// and the config is loaded by Vitest's own resolution of those options.

import { execFile } from "node:child_process";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { parseCLI, resolveConfig } from "vitest/node";
import { VITEST_WRITERS } from "../emissionProcess";

const run = promisify(execFile);
const WORKTREE = resolve(import.meta.dirname, "..", "..", "..");

/** Every Vitest producer's arguments after the binary, asked of families.py on the machine's Python. */
async function nativeWriters(): Promise<string[][]> {
	const { stdout } = await run(
		"python3",
		[
			"-B",
			"-c",
			"import json; from proof.native.families import FAMILIES; print(json.dumps([list(f.command[1:]) for f in FAMILIES.values() if f.uses_vitest]))",
		],
		{ cwd: WORKTREE },
	);
	return JSON.parse(stdout) as string[][];
}

it("hands every writer's Vitest the native config loader and neither cache, as Vitest's own CLI reads them", async () => {
	const native = await nativeWriters();
	// The expander corpus and the HQ-JSON oracle probes: a family list without them proves nothing here.
	expect(native.length).toBeGreaterThanOrEqual(2);
	for (const args of [VITEST_WRITERS, ...native]) {
		const { options } = parseCLI(["vitest", ...args]);
		expect(options).toMatchObject({
			run: true,
			configLoader: "native",
			cache: false,
			fsModuleCache: false,
		});
	}
});

it("reads a list without the options as Vite's default loader and both caches on", () => {
	// The counterpart of the check above, on the list the native producers passed before the config loader was
	// named: Vitest leaves the loader to Vite's default (the bundle under node_modules/.vite-temp).
	const { options } = parseCLI([
		"vitest",
		"run",
		"lib/commcare/__tests__/expander.test.ts",
		"--project",
		"unit",
		"--no-cache",
		"--fsModuleCache=false",
	]);
	expect(options.configLoader).toBeUndefined();
	const bare = parseCLI(["vitest", "run"]).options;
	expect(bare.cache).not.toBe(false);
	expect(bare.fsModuleCache).not.toBe(false);
});

it("loads this repository's config through the native loader the writers name", async () => {
	const { options } = parseCLI(["vitest", ...VITEST_WRITERS]);
	const resolved = await resolveConfig({
		...options,
		root: WORKTREE,
		config: join(WORKTREE, "vitest.config.mts"),
	});
	expect(resolved.configFile).toBe(join(WORKTREE, "vitest.config.mts"));
	expect(resolved.test).toMatchObject({
		cache: false,
		fsModuleCache: false,
		// The config's own setting arrived, so the file was read, not skipped.
		taskTitleValueFormatTruncate: 0,
	});
});
