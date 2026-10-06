// The weekly pin pull request (proof/README.md, "Changing a pin"), in two
// stages the workflow (.github/workflows/upstream-pins.yml) runs around the
// image build and the surface extraction:
//
//   node proof/upstream/pins.mjs plan
//     Reads each upstream's default-branch head. When none differs from
//     proof/pins.json, or the open pin pull request already carries exactly
//     these heads, it does nothing. Otherwise it commits the new pins to the
//     branch upstream/pins, one commit on top of main (replacing last week's),
//     and pushes it, so the image builds from that branch.
//
//   node proof/upstream/pins.mjs report --image-result <result> [--digest <d>]
//       --surface-result <result> [--surface <file>] --run-url <url>
//     Adds the image lock and the regenerated surface to that one commit when
//     both succeeded (the pins alone otherwise), opens the pull request or
//     updates the open one, and requests the reviewer's review. GitHub holds
//     CI on a pull request the workflow's own token opened until a person
//     approves its run or updates the branch, and a run dispatched on the
//     branch does not stand in for it (the held run hides its checks), so
//     the description says so. It states the run's date and outcome and
//     classifies every surface item the new pins add, remove or change.
//
// Every git and gh call goes through the executables on PATH, so a test runs
// both stages against local repositories and a controlled `gh`.

import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);

export const BRANCH = "upstream/pins";
const PINS = "proof/pins.json";
const LOCK = "proof/image.lock";
const SURFACE = "lib/commcare/surface/surface.json";
const ENTRIES = "lib/commcare/surface/entries";
const IMAGE = "ghcr.io/voidcraft-labs/commcare-nova-proof";
const TITLE = "Move the upstream pins";

async function run(command, args, cwd) {
	const { stdout } = await execute(command, args, {
		cwd,
		maxBuffer: 64 * 1024 * 1024,
	});
	return stdout;
}

const git = (cwd, ...args) => run("git", args, cwd);
const gh = (cwd, ...args) => run("gh", args, cwd);

/** JSON as Biome formats this repository's JSON files: tabs, one final newline. */
function formatted(value) {
	return `${JSON.stringify(value, null, "\t")}\n`;
}

/** The commit each upstream's default branch points at now. */
async function upstreamHeads(cwd, pins) {
	const heads = {};
	for (const [name, pin] of Object.entries(pins)) {
		const out = await git(
			cwd,
			"ls-remote",
			pin.repository,
			`refs/heads/${pin.defaultBranch}`,
		);
		const commit = out.split(/\s+/)[0];
		if (!/^[0-9a-f]{40}$/.test(commit ?? "")) {
			throw new Error(
				`Could not read the head of ${name}'s ${pin.defaultBranch} branch from ${pin.repository} (git ls-remote answered ${JSON.stringify(out.trim())}).\n` +
					`Check that the repository and default branch in ${PINS} still exist.`,
			);
		}
		heads[name] = commit;
	}
	return heads;
}

/** The pins the pin branch carries, or null without one. */
async function branchPins(cwd) {
	const remote = await git(cwd, "ls-remote", "origin", `refs/heads/${BRANCH}`);
	if (!remote.trim()) return null;
	await git(cwd, "fetch", "--quiet", "origin", BRANCH);
	return JSON.parse(await git(cwd, "show", `FETCH_HEAD:${PINS}`));
}

/** The open pin pull requests, each `{number}`: one at most. */
async function openPullRequests(cwd) {
	return JSON.parse(
		await gh(
			cwd,
			"pr",
			"list",
			"--head",
			BRANCH,
			"--state",
			"open",
			"--json",
			"number",
		),
	);
}

const sameCommits = (a, b) =>
	Object.keys(a).length === Object.keys(b).length &&
	Object.entries(a).every(([name, pin]) => b[name]?.commit === pin.commit);

export async function plan(cwd) {
	const pins = JSON.parse(await readFile(join(cwd, PINS), "utf8"));
	const heads = await upstreamHeads(cwd, pins);
	const candidate = Object.fromEntries(
		Object.entries(pins).map(([name, pin]) => [
			name,
			{ ...pin, commit: heads[name] },
		]),
	);
	if (sameCommits(candidate, pins)) {
		return { action: "none", reason: `no upstream moved past ${PINS}` };
	}
	// The branch alone is not enough: a report that failed, or a pull request closed unmerged, leaves the branch
	// with these heads and no open pull request, which planning them again repairs.
	const branched = await branchPins(cwd);
	if (
		branched &&
		sameCommits(candidate, branched) &&
		(await openPullRequests(cwd)).length > 0
	) {
		return {
			action: "none",
			reason: `the open pin pull request already carries these heads`,
		};
	}
	await git(cwd, "checkout", "--quiet", "-B", BRANCH, "origin/main");
	await writeFile(join(cwd, PINS), formatted(candidate));
	await git(cwd, "add", PINS);
	await git(cwd, "commit", "--quiet", "-m", TITLE);
	await git(cwd, "push", "--quiet", "--force", "origin", BRANCH);
	return { action: "update", pins: candidate };
}

/** Every entry, by the surface keys it names. */
async function entriesByKey(cwd) {
	const byKey = new Map();
	const listing = await git(cwd, "ls-files", ENTRIES);
	for (const file of listing.split("\n").filter((f) => f.endsWith(".json"))) {
		const entries = JSON.parse(await readFile(join(cwd, file), "utf8"));
		for (const entry of entries) {
			for (const key of entry.surfaceKeys ?? []) {
				if (!byKey.has(key)) byKey.set(key, []);
				byKey.get(key).push(entry);
			}
		}
	}
	return byKey;
}

/** JSON with each object's keys sorted at every depth, so two values compare by their content alone. */
const stable = (value) =>
	JSON.stringify(value, (_, inner) =>
		inner && typeof inner === "object" && !Array.isArray(inner)
			? Object.fromEntries(
					Object.entries(inner).sort(([a], [b]) =>
						a < b ? -1 : a > b ? 1 : 0,
					),
				)
			: inner,
	);

/**
 * The surface items the new pins add, remove or change, each change naming
 * the attributes that differ, with the entries that name each item.
 */
export async function classify(cwd, before, after) {
	const byKey = await entriesByKey(cwd);
	const naming = (key) =>
		(byKey.get(key) ?? []).map((entry) => ({
			id: entry.id,
			disposition: entry.disposition ?? entry.class?.label ?? entry.kind,
		}));
	const added = [];
	const removed = [];
	const changed = [];
	for (const key of Object.keys(after.items).sort()) {
		if (!(key in before.items)) added.push({ key });
	}
	for (const key of Object.keys(before.items).sort()) {
		if (!(key in after.items)) {
			removed.push({ key, entries: naming(key) });
			continue;
		}
		const was = before.items[key];
		const now = after.items[key];
		const attributes = [...new Set([...Object.keys(was), ...Object.keys(now)])]
			.filter((name) => stable(was[name]) !== stable(now[name]))
			.sort();
		if (attributes.length > 0) {
			changed.push({ key, attributes, entries: naming(key) });
		}
	}
	return { added, removed, changed };
}

function describeEntries(entries) {
	if (entries.length === 0) return "no entry names it";
	return entries.map((e) => `\`${e.id}\` (${e.disposition})`).join(", ");
}

function describe({ date, outcome, runUrl, before, after, classified }) {
	const lines = [
		`Latest run: ${date}, ${outcome} ([run](${runUrl})).`,
		"",
		"| Upstream | Pinned on main | Default-branch head |",
		"|---|---|---|",
		...Object.keys(after).map(
			(name) =>
				`| ${name} | \`${before[name]?.commit.slice(0, 12) ?? "none"}\` | \`${after[name].commit.slice(0, 12)}\` |`,
		),
		"",
	];
	if (!classified) {
		lines.push(
			"The surface was not regenerated in this run, so its difference is unknown until the failed step passes.",
		);
		return lines.join("\n");
	}
	const { added, removed, changed } = classified;
	lines.push(
		`## Surface: ${added.length} added, ${removed.length} removed, ${changed.length} changed`,
		"",
	);
	if (added.length > 0) {
		lines.push(
			"### Added",
			"",
			"Each is refused wherever an app uses it until an entry names it. The proof lane's manifest check fails when HQ reads a new toggle while building one of Nova's exports.",
			"",
			...added.map(({ key }) => `- \`${key}\``),
			"",
		);
	}
	if (removed.length > 0) {
		lines.push(
			"### Removed",
			"",
			...removed.map(
				({ key, entries }) => `- \`${key}\`: ${describeEntries(entries)}`,
			),
			"",
		);
	}
	if (changed.length > 0) {
		lines.push(
			"### Changed",
			"",
			...changed.map(
				({ key, attributes, entries }) =>
					`- \`${key}\` (${attributes.join(", ")}): ${describeEntries(entries)}`,
			),
			"",
		);
	}
	return lines.join("\n");
}

// GitHub holds CI on a pull request the workflow's token opened, so every outcome says how it starts.
const CI_STARTS =
	"starts when you approve its run on this pull request or update the branch";

function outcomeOf(options) {
	if (options.imageResult !== "success") {
		return `the image build did not succeed, so the branch carries the new pins alone and CI, which ${CI_STARTS}, is red until the harness builds at them`;
	}
	if (options.surfaceResult !== "success") {
		return `the surface extraction did not succeed, so the branch carries the new pins alone and CI, which ${CI_STARTS}, is red until the extractor runs at them`;
	}
	return `the image, the lock and the surface are updated, and CI ${CI_STARTS}`;
}

export async function report(cwd, options) {
	const date = options.date ?? new Date().toISOString().slice(0, 10);
	const before = JSON.parse(await git(cwd, "show", `origin/main:${PINS}`));
	await git(cwd, "fetch", "--quiet", "origin", BRANCH);
	await git(cwd, "checkout", "--quiet", "-B", BRANCH, "FETCH_HEAD");
	const after = JSON.parse(await readFile(join(cwd, PINS), "utf8"));
	let classified = null;
	if (
		options.imageResult === "success" &&
		options.surfaceResult === "success"
	) {
		const beforeSurface = JSON.parse(
			await git(cwd, "show", `origin/main:${SURFACE}`),
		);
		const afterSurface = JSON.parse(await readFile(options.surface, "utf8"));
		await writeFile(
			join(cwd, LOCK),
			formatted({
				image: `${IMAGE}@${options.digest}`,
				pins: Object.fromEntries(
					Object.entries(after).map(([name, pin]) => [name, pin.commit]),
				),
			}),
		);
		await writeFile(join(cwd, SURFACE), await readFile(options.surface));
		await git(cwd, "add", LOCK, SURFACE);
		await git(cwd, "commit", "--quiet", "--amend", "--no-edit");
		await git(cwd, "push", "--quiet", "--force", "origin", BRANCH);
		classified = await classify(cwd, beforeSurface, afterSurface);
	}
	const body = describe({
		date,
		outcome: outcomeOf(options),
		runUrl: options.runUrl,
		before,
		after,
		classified,
	});
	const bodyFile = join(cwd, ".git", "upstream-pins-body.md");
	await writeFile(bodyFile, body);
	const open = await openPullRequests(cwd);
	let number;
	if (open.length > 0) {
		number = String(open[0].number);
		await gh(cwd, "pr", "edit", number, "--body-file", bodyFile);
	} else {
		const url = await gh(
			cwd,
			"pr",
			"create",
			"--base",
			"main",
			"--head",
			BRANCH,
			"--title",
			TITLE,
			"--body-file",
			bodyFile,
		);
		number = url.trim().split("/").at(-1);
	}
	if (options.reviewer) {
		await gh(cwd, "pr", "edit", number, "--add-reviewer", options.reviewer);
	}
	return { number, classified };
}

function parseOptions(args) {
	const options = {};
	for (let i = 0; i < args.length; i += 2) {
		const name = args[i].replace(/^--/, "");
		options[name.replace(/-(.)/g, (_, c) => c.toUpperCase())] = args[i + 1];
	}
	return options;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const [stage, ...rest] = process.argv.slice(2);
	const cwd = process.cwd();
	const done =
		stage === "plan"
			? plan(cwd)
			: stage === "report"
				? report(cwd, parseOptions(rest))
				: Promise.reject(
						new Error(
							`Unknown stage ${JSON.stringify(stage)}: run "plan" or "report".`,
						),
					);
	done.then(
		(result) => console.log(JSON.stringify(result)),
		(error) => {
			console.error(error.message);
			process.exit(1);
		},
	);
}
