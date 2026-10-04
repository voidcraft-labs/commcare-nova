// Records a candidate proof image in this checkout's proof/image.lock, as the
// pin pull request will record it, for a lane run of an image the checkout's
// lock does not name yet (proof-lane.yml's `image`):
//
//   node proof/ci/candidate.mjs --image ghcr.io/<owner>/<name>@sha256:<64 hex> [--root DIR]
//
// The lock it writes is the one proof/upstream/pins.mjs::report commits for a
// candidate built from this checkout's pins: the image, and the commit of
// each upstream proof/pins.json names, as Biome formats the repository's JSON.
// Everything that reads which image a lane run observes reads the lock (the
// queue builder's and the lane's keys, proof/ci/store-keys.mjs's cache names,
// proof/run.mjs's pull), so after this one step they all name the image the
// run pulls, and the records a prewarm saves are keyed as the pin pull
// request's own run will look them up.
//
// --root is the checkout (the working directory by default). It prints the
// lock it wrote.

import { readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

// What scripts/ci/check-proof-image-lock.mjs accepts as the lock's image.
const DIGEST_REFERENCE = /^ghcr\.io\/[\w./-]+@sha256:[0-9a-f]{64}$/;

function fail(message) {
	process.stderr.write(`${message}\n`);
	process.exit(2);
}

const { values, positionals } = parseArgs({
	allowPositionals: true,
	options: {
		image: { type: "string" },
		root: { type: "string", default: "." },
	},
});
if (positionals.length > 0) {
	fail(
		`candidate.mjs takes no arguments beside --image and --root; got ${positionals.join(" ")}.`,
	);
}
if (!DIGEST_REFERENCE.test(values.image ?? "")) {
	fail(
		`--image names the candidate image as ghcr.io/<owner>/<name>@sha256:<64 hex>, pinned by its digest as the lock records it; got ${JSON.stringify(values.image)}.`,
	);
}
const root = resolve(values.root);
const pinsFile = join(root, "proof", "pins.json");
let pins;
try {
	pins = JSON.parse(await readFile(pinsFile, "utf8"));
} catch (error) {
	fail(
		`${pinsFile} could not be read as JSON (${error.message}), and the lock records the pins the candidate was built from.`,
	);
}
const commits = Object.entries(pins ?? {}).map(([name, pin]) => {
	if (typeof pin?.commit !== "string" || !/^[0-9a-f]{40}$/.test(pin.commit)) {
		fail(
			`${pinsFile} pins ${name} to ${JSON.stringify(pin?.commit)}, which is not a 40-digit commit, so the lock cannot record what the candidate was built from.`,
		);
	}
	return [name, pin.commit];
});
if (commits.length === 0) {
	fail(
		`${pinsFile} names no upstream, so there is nothing the candidate was built from.`,
	);
}
const lock = `${JSON.stringify({ image: values.image, pins: Object.fromEntries(commits) }, null, "\t")}\n`;
const lockFile = join(root, "proof", "image.lock");
const staged = `${lockFile}.${process.pid}`;
await writeFile(staged, lock);
await rename(staged, lockFile);
process.stdout.write(lock);
