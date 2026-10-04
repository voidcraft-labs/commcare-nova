// proof/ci/runtime.mjs is what .github/actions/proof-runtime runs: the only
// way the job's artifact-service credentials reach the `run` steps that claim
// blocks. Its output is read by the runner's GITHUB_ENV parser, so these
// tests read the file the way the runner documents it (NAME<<DELIMITER, the
// value's lines, DELIMITER) rather than checking text the script wrote.

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { Scripts } from "./scripts";

let scratch: string;
let scripts: Scripts;

beforeEach(async () => {
	scratch = await mkdtemp(join(tmpdir(), "proof-ci-runtime-"));
	scripts = new Scripts(undefined, scratch);
});

afterEach(async () => {
	await scripts.join();
	await rm(scratch, { recursive: true, force: true });
});

/** The variables a GITHUB_ENV file sets, read as the runner reads it (single-line NAME=VALUE, or the delimited form). */
function readGithubEnv(text: string): Map<string, string> {
	const lines = text.split("\n");
	const values = new Map<string, string>();
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index];
		if (line === "") continue;
		const delimited = /^([^=<]+)<<(.+)$/.exec(line);
		if (delimited) {
			const [, name, delimiter] = delimited;
			const end = lines.indexOf(delimiter, index + 1);
			if (end < 0)
				throw new Error(`${name}'s delimiter ${delimiter} never closes`);
			values.set(name, lines.slice(index + 1, end).join("\n"));
			index = end;
		} else {
			const at = line.indexOf("=");
			values.set(line.slice(0, at), line.slice(at + 1));
		}
	}
	return values;
}

it("exports the runtime token and results URL to later steps, after what is there, with the token masked", async () => {
	const githubEnv = join(scratch, "github-env");
	await writeFile(githubEnv, "EARLIER=kept\n");
	const credentials = {
		ACTIONS_RUNTIME_TOKEN: "header.payload.signature",
		ACTIONS_RESULTS_URL:
			"https://results-receiver.actions.githubusercontent.com/",
	};
	const result = await scripts.run("runtime.mjs", [], {
		env: { ...credentials, GITHUB_ENV: githubEnv },
	});
	expect(result.code).toBe(0);
	expect(
		Object.fromEntries(readGithubEnv(await readFile(githubEnv, "utf8"))),
	).toEqual({ EARLIER: "kept", ...credentials });
	// The runner masks a value from the moment it reads the mask command, so the command comes first.
	expect(result.stdout.split("\n")[0]).toBe(
		"::add-mask::header.payload.signature",
	);
	expect(result.stderr).toBe("");
});

it("fails, writing nothing, when the runner gave it no token", async () => {
	const githubEnv = join(scratch, "github-env");
	await writeFile(githubEnv, "EARLIER=kept\n");
	const result = await scripts.run("runtime.mjs", [], {
		env: {
			ACTIONS_RESULTS_URL: "https://results.example/",
			GITHUB_ENV: githubEnv,
		},
	});
	expect(result.code).toBe(1);
	expect(result.stderr).toContain("ACTIONS_RUNTIME_TOKEN is not set");
	expect(await readFile(githubEnv, "utf8")).toBe("EARLIER=kept\n");
});
