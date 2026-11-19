// The trees the lane retains of CommCare HQ, moved whole between a checkout's
// proof/ and an artifact that carries them:
//
//   node proof/ci/retained.mjs FROM TO
//
// Each of proof/hq-apps/ (the apps HQ's own pages and models made) and
// proof/hq-reads/ (HQ's answers to the reads Nova's tests are served) is
// written under TO as FROM holds it: what TO held of the tree is removed
// first, so a file FROM lacks does not stay behind, and a tree FROM lacks is
// removed from TO. Nothing else under either directory is touched.
//
// The weekly pin pull request's `retained` job (upstream-pins.yml) stages the
// trees `python3 -m proof.matrix.adopt` wrote into its checkout's proof/ for
// the artifact `upstream-retained`, beside the adopt report (ADOPT_REPORT); each
// job of proof-lane.yml that puts the candidate's surface in place puts these
// trees in place from that artifact; and proof/upstream/pins.mjs::report
// commits them from it. A download extracts an artifact's files over a path
// and removes none, so the trees are moved here rather than downloaded over
// proof/: a file adopt removed would stay, and the report would land among
// the harness's files, every one of which the store's harness fingerprint
// names (proof/store/fingerprints.py), so the run would key its package
// groups apart from the pull request it checks.

import { cp, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The retained trees, by their directory under proof/. */
export const RETAINED_TREES = ["hq-apps", "hq-reads"];

/** The adopt report's file in the artifact, beside the trees. */
export const ADOPT_REPORT = "adopt-report.txt";

async function isDirectory(path) {
	try {
		return (await stat(path)).isDirectory();
	} catch (error) {
		if (error.code === "ENOENT") return false;
		throw error;
	}
}

/** Each retained tree written under `to` as `from` holds it; the trees `from` holds. */
export async function placeRetained(from, to) {
	if (!(await isDirectory(from))) {
		throw new Error(
			`${from} is not a directory, so it holds no retained trees to put in place. Name the directory the artifact was downloaded into, or the checkout's proof/.`,
		);
	}
	const placed = [];
	for (const tree of RETAINED_TREES) {
		const target = join(to, tree);
		await rm(target, { recursive: true, force: true });
		if (await isDirectory(join(from, tree))) {
			await cp(join(from, tree), target, { recursive: true });
			placed.push(tree);
		}
	}
	return placed;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const [from, to, ...rest] = process.argv.slice(2);
	if (!from || !to || rest.length > 0) {
		process.stderr.write(
			`retained.mjs takes two directories, FROM and TO (the downloaded artifact and the checkout's proof/, or the reverse); got ${JSON.stringify(process.argv.slice(2))}.\n`,
		);
		process.exit(2);
	}
	placeRetained(resolve(from), resolve(to)).then(
		(placed) => {
			process.stdout.write(
				`Put ${placed.length === 0 ? "no retained tree" : placed.join(" and ")} in place under ${to}.\n`,
			);
		},
		(error) => {
			process.stderr.write(`${error.message}\n`);
			process.exit(1);
		},
	);
}
