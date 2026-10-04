// Fails when the proof image the harness pulls was built from other pins than
// the ones the repository names.
//
// proof/pins.json names the upstream commits the harness proves Nova against;
// proof/image.lock records the image digest the proof lane pulls and the pins
// that image was built from (proof/README.md). A pull request that moves a pin
// without rebuilding the image, or records a new image without its pins, would
// otherwise run every native proof against upstream code the pins do not name.
//
// Usage: node scripts/ci/check-proof-image-lock.mjs [repo root]

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot =
	process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const DIGEST_REFERENCE = /^ghcr\.io\/[\w./-]+@sha256:[0-9a-f]{64}$/;

async function readJson(relativePath) {
	const path = join(repoRoot, relativePath);
	try {
		return JSON.parse(await readFile(path, "utf8"));
	} catch (error) {
		throw new Error(
			`Could not read ${relativePath} as JSON (${error.message}).\n` +
				"The proof lane pulls the image proof/image.lock names, built from the pins in proof/pins.json.\n" +
				`Look at ${relativePath}.`,
		);
	}
}

const pins = await readJson("proof/pins.json");
const lock = await readJson("proof/image.lock");

const problems = [];
if (typeof lock.image !== "string" || !DIGEST_REFERENCE.test(lock.image)) {
	problems.push(
		`proof/image.lock names the image ${JSON.stringify(lock.image)}, which is not a digest-pinned ghcr.io reference ` +
			"(`ghcr.io/<owner>/<name>@sha256:<64 hex>`).",
	);
}
const lockedPins = lock.pins ?? {};
const upstreams = new Set([...Object.keys(pins), ...Object.keys(lockedPins)]);
for (const upstream of [...upstreams].sort()) {
	const pinned = pins[upstream]?.commit;
	const built = lockedPins[upstream];
	if (pinned !== built) {
		problems.push(
			`${upstream}: proof/pins.json pins ${pinned ?? "nothing"}, but the image in proof/image.lock was built from ${built ?? "nothing"}.`,
		);
	}
}

if (problems.length > 0) {
	console.error(
		"The proof image and the pins disagree:\n" +
			problems.map((problem) => `  - ${problem}`).join("\n") +
			"\n\nRebuild the image from proof/pins.json with the Proof image workflow and record its digest and pins in proof/image.lock " +
			'(proof/README.md, "Changing a pin").',
	);
	process.exit(1);
}
console.log(
	`proof/image.lock matches proof/pins.json (${upstreams.size} upstreams).`,
);
