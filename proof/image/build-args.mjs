// Prints the build arguments of the proof image (proof/README.md) from the
// files that decide them, so the image workflow and a local build use the same
// inputs: each upstream commit from proof/pins.json, Node from .nvmrc and npm
// from package.json's devEngines.
//
// Usage:
//   node proof/image/build-args.mjs          `--build-arg` and `KEY=VALUE`, one argument per line
//   node proof/image/build-args.mjs --env    one `KEY=VALUE` per line

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The pins whose commits the image recipe fetches, by build argument. */
const PINNED_SOURCES = {
	HQ_COMMIT: "commcare-hq",
	CORE_COMMIT: "commcare-core",
	ANDROID_COMMIT: "commcare-android",
	FORMPLAYER_COMMIT: "formplayer",
	CONNECT_COMMIT: "commcare-connect",
};

const FULL_COMMIT = /^[0-9a-f]{40}$/;

async function readJson(relativePath) {
	return JSON.parse(await readFile(join(repoRoot, relativePath), "utf8"));
}

const pins = await readJson("proof/pins.json");
const packageJson = await readJson("package.json");
const nodeVersion = (await readFile(join(repoRoot, ".nvmrc"), "utf8")).trim();

const args = {};
for (const [argument, upstream] of Object.entries(PINNED_SOURCES)) {
	const commit = pins[upstream]?.commit;
	if (typeof commit !== "string" || !FULL_COMMIT.test(commit)) {
		throw new Error(
			`proof/pins.json names no full commit for ${upstream} (found ${JSON.stringify(commit)}).\n` +
				"The image fetches each upstream at exactly its pinned commit, so the pin must be the full 40-character id.\n" +
				`Look at the "${upstream}" entry in proof/pins.json.`,
		);
	}
	args[argument] = commit;
}
args.NODE_VERSION = nodeVersion;
args.NPM_VERSION = packageJson.devEngines?.packageManager?.version;
if (!args.NPM_VERSION) {
	throw new Error(
		"package.json declares no devEngines.packageManager.version, so the image cannot install the npm Nova pins.\n" +
			"Look at package.json's devEngines.",
	);
}

const asEnv = process.argv.includes("--env");
for (const [key, value] of Object.entries(args)) {
	// One argument per line, so a caller that reads lines into an array (mapfile) passes each as its own word.
	console.log(asEnv ? `${key}=${value}` : `--build-arg\n${key}=${value}`);
}
