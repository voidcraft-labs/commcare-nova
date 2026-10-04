// proof/ci/store-keys.mjs decides which evidence-store snapshot a run reads
// and which scope it writes. A wrong scope either reuses records observed
// under another image or architecture, or writes a pull request's store where
// main's should be; so each case pairs what is named with what is not.

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, it } from "vitest";
import { CI } from "./scripts";

const run = promisify(execFile);
const DIGEST = "0123456789abcdef".repeat(4);

let scratch: string;

beforeEach(async () => {
	scratch = await mkdtemp(join(tmpdir(), "proof-ci-store-keys-"));
});

afterEach(async () => {
	await rm(scratch, { recursive: true, force: true });
});

async function keys(
	env: Record<string, string>,
	{ arch = "arm64", image = `ghcr.io/org/proof@sha256:${DIGEST}` } = {},
) {
	const lock = join(scratch, "image.lock");
	await writeFile(lock, JSON.stringify({ image }));
	const output = join(scratch, "github-output");
	await writeFile(output, "");
	await run(
		process.execPath,
		[join(CI, "store-keys.mjs"), "--arch", arch, "--lock", lock],
		{
			env: {
				NODE_ENV: "test",
				PATH: process.env.PATH ?? "",
				GITHUB_OUTPUT: output,
				GITHUB_RUN_ID: "777",
				...env,
			},
		},
	);
	return Object.fromEntries(
		(await readFile(output, "utf8"))
			.split("\n")
			.filter(Boolean)
			.map((line) => line.split(/=(.*)/s).slice(0, 2)),
	);
}

it("gives a pull request's run its own scope, reading main's snapshots beside it", async () => {
	expect(
		await keys({ GITHUB_EVENT_NAME: "pull_request", PROOF_PULL_REQUEST: "42" }),
	).toEqual({
		main: "proof-store-arm64-0123456789abcdef-main-",
		scope: "proof-store-arm64-0123456789abcdef-pr42-",
		key: "proof-store-arm64-0123456789abcdef-pr42-777",
	});
});

it("writes main's scope only from a run on main", async () => {
	expect(
		(
			await keys({
				GITHUB_EVENT_NAME: "schedule",
				GITHUB_REF: "refs/heads/main",
			})
		).key,
	).toBe("proof-store-arm64-0123456789abcdef-main-777");
	expect(
		await keys({
			GITHUB_EVENT_NAME: "workflow_dispatch",
			GITHUB_REF: "refs/heads/upstream/pins",
		}),
	).toEqual({
		main: "proof-store-arm64-0123456789abcdef-main-",
		scope: "",
		key: "",
	});
});

it("names the image and the architecture, so a store is read only where it was observed", async () => {
	const other = await keys(
		{ GITHUB_EVENT_NAME: "pull_request", PROOF_PULL_REQUEST: "42" },
		{ arch: "amd64", image: `ghcr.io/org/proof@sha256:${"f".repeat(64)}` },
	);
	expect(other.main).toBe("proof-store-amd64-ffffffffffffffff-main-");
});

it("refuses an image the lock does not pin by digest", async () => {
	await expect(
		keys(
			{ GITHUB_EVENT_NAME: "pull_request", PROOF_PULL_REQUEST: "42" },
			{ image: "ghcr.io/org/proof:latest" },
		),
	).rejects.toThrow(/not pinned by a sha256 digest/);
});
