// Names the GitHub cache entries that hold the proof lane's evidence store,
// for the workflows that restore and save them:
//
//   node proof/ci/store-keys.mjs --arch arm64 [--lock proof/image.lock] [--save NAME]
//
// An entry is one store snapshot:
// `proof-store-<arch>-<image>-<scope>-<run id>-<attempt>[-<save>]`, where
// <image> is the first 16 hex digits of the digest of the image the lock
// records (a store is only ever read by runs of the image that wrote it, on
// the same architecture; a run of a candidate image first records it in the
// lock, proof/ci/candidate.mjs) and <scope> is `main` or `pr<number>`. A
// cache entry is never written over: a save under a key that exists is
// dropped, and the action only warns. So the key names the run's attempt (a
// run tried again saves what the new attempt observed) and, where one run
// saves more than once (the nightly's two profiles, and a dispatch that also
// runs the weekly audit), which save it is (`--save`). GitHub keeps a
// cache written by a pull_request run in that pull request's scope, and one
// written by a schedule, push or workflow_dispatch run on the default branch
// in the default branch's scope, which every pull request can read; so the
// audit on main writes `main` snapshots and each pull request's gate writes
// its own. A restore names a key no entry has and the scope's prefix as its
// restore key, which finds the newest snapshot of that scope.
//
// It appends to GITHUB_OUTPUT (or prints, without it): `main` (the main
// snapshots' prefix), `scope` (this run's snapshots' prefix, empty when the
// run writes none: a dispatch on a branch other than main) and `key` (the key
// this save is kept under, empty likewise). It reads GITHUB_EVENT_NAME,
// GITHUB_REF, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT and PROOF_PULL_REQUEST (the
// pull request's number, which the workflow passes from
// github.event.pull_request.number).

import { appendFileSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";

const { values } = parseArgs({
	options: {
		arch: { type: "string" },
		lock: { type: "string", default: "proof/image.lock" },
		save: { type: "string" },
	},
});

function fail(message) {
	process.stderr.write(`${message}\n`);
	process.exit(2);
}

if (values.arch !== "arm64" && values.arch !== "amd64") {
	fail(
		`--arch names the architecture the store's records were observed on, arm64 or amd64; got ${JSON.stringify(values.arch)}.`,
	);
}
let image;
try {
	image = JSON.parse(readFileSync(values.lock, "utf8")).image;
} catch (error) {
	fail(
		`The image lock ${values.lock} could not be read as JSON (${error.message}), and the store's keys name the image it records.`,
	);
}
const digest = /@sha256:([0-9a-f]{64})$/.exec(image ?? "")?.[1];
if (!digest) {
	fail(
		`${values.lock} records the image ${JSON.stringify(image)}, which is not pinned by a sha256 digest; the store's keys name that digest.`,
	);
}
const base = `proof-store-${values.arch}-${digest.slice(0, 16)}`;
const event = process.env.GITHUB_EVENT_NAME ?? "";
const pullRequest = process.env.PROOF_PULL_REQUEST ?? "";
const run = process.env.GITHUB_RUN_ID ?? "";
let scope = "";
if (event === "pull_request" && /^\d+$/.test(pullRequest)) {
	scope = `${base}-pr${pullRequest}-`;
} else if (
	["schedule", "push", "workflow_dispatch"].includes(event) &&
	process.env.GITHUB_REF === "refs/heads/main"
) {
	scope = `${base}-main-`;
}
if (values.save !== undefined && !/^[A-Za-z0-9+._-]+$/.test(values.save)) {
	fail(
		`--save names which of a run's saves this is, in letters, digits and + . _ - (it becomes part of a cache key); got ${JSON.stringify(values.save)}.`,
	);
}
const attempt = process.env.GITHUB_RUN_ATTEMPT || "1";
const save = values.save ? `-${values.save}` : "";
const lines = [
	`main=${base}-main-`,
	`scope=${scope}`,
	`key=${scope && run ? `${scope}${run}-${attempt}${save}` : ""}`,
];
if (process.env.GITHUB_OUTPUT) {
	appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`);
} else {
	process.stdout.write(`${lines.join("\n")}\n`);
}
