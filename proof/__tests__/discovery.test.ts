// No test runner discovers tests in the proof lane's data.
//
// Contract: a file a container wrote under the run's output (`.proof/`) or
// one under a retained tree (`proof/hq-apps/`, `proof/hq-reads/`) is never
// run by Vitest, whatever it is named, while the harness's own tests are.
// The plausible failure: a run's output or an adopted tree holding
// `x.test.ts`, which the next `npm test` on a reviewer's machine would run as
// code. pytest's side is `proof/test_collection.py`, in the lane.
//
// Vitest's files are matched here as Vitest matches them: its glob library,
// with `dot: true`, the config's include and exclude, from the root
// (vitest/dist globProjectFiles).

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { glob } from "tinyglobby";
import { afterEach, beforeEach, expect, it } from "vitest";
import { configDefaults } from "vitest/config";
import config from "../../vitest.config.mts";

let scratch: string;

beforeEach(async () => {
	scratch = await mkdtemp(join(tmpdir(), "proof-discovery-"));
});

afterEach(async () => {
	await rm(scratch, { recursive: true, force: true });
});

async function plant(paths: readonly string[]) {
	for (const path of paths) {
		await mkdir(join(scratch, path, ".."), { recursive: true });
		await writeFile(join(scratch, path), "planted\n");
	}
}

it("never runs a test file in a run's output or a retained tree, and runs the harness's own", async () => {
	const planted = [
		".proof/runs/r/blocks/b/a.test.ts",
		".proof/out/x.spec.mjs",
		"proof/hq-apps/hq-plain/a.test.ts",
		"proof/hq-reads/reading/__tests__/a.spec.js",
	];
	const own = ["proof/ci/__tests__/claim.test.ts", "lib/x.test.tsx"];
	await plant([...planted, ...own]);
	const exclude = config.test?.exclude ?? [];
	const found = await glob(configDefaults.include, {
		dot: true,
		cwd: scratch,
		ignore: exclude,
		expandDirectories: false,
	});
	expect(found.sort()).toEqual([...own].sort());
});
