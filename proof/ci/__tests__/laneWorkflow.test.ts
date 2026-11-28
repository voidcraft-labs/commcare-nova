// What the lane's workflow and the lane's own code must say alike.
//
// The planner rounds a lane's shard count up to a multiple of the shards
// that run at once (proof/lane/plan.py, PARALLEL_SHARDS), so a last round is
// as full as the others; the workflow's matrix is what runs that many at
// once (proof-lane.yml, max-parallel). The two are written apart, and a
// change to one alone gives rounds the plan did not count: more shards at
// once than the six runners left to pull requests allow, or a last round
// planned full and run half empty.
//
// This is held here and not in the lane's own tests because a proof shard's
// checkout holds proof/, the surface and its actions, and no workflow: read
// from inside the lane, the workflow is there on a machine that copied the
// whole tree and absent on every shard.

import { execFile } from "node:child_process";
import {
	chmod,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { parse } from "yaml";

const run = promisify(execFile);
const WORKTREE = resolve(import.meta.dirname, "..", "..", "..");

it("executes one checkout at the replay dispatch's own commit", async () => {
	const workflow = parse(
		await readFile(
			join(WORKTREE, ".github/workflows/proof-replay.yml"),
			"utf8",
		),
	);
	const { steps } = workflow.jobs.replay;
	const checkouts = steps.filter((step: { uses?: string }) =>
		step.uses?.startsWith("actions/checkout@"),
	);
	expect(checkouts).toEqual([steps[0]]);
	expect(checkouts[0].with).toEqual({
		// biome-ignore lint/suspicious/noTemplateCurlyInString: This is a literal GitHub expression.
		ref: "${{ github.sha }}",
		"persist-credentials": false,
	});
	expect(workflow.permissions).toEqual({ contents: "read", actions: "read" });
	expect(workflow["cache-mode"]).toBe("read");
});

it("queues full reader workflows together without blocking a pin update on its child image build", async () => {
	const workflows = await Promise.all(
		["proof-audit", "upstream-pins", "proof-image"].map(async (name) =>
			parse(
				await readFile(join(WORKTREE, `.github/workflows/${name}.yml`), "utf8"),
			),
		),
	);
	for (const workflow of workflows) {
		expect(workflow.concurrency.group).toContain("proof-scheduled-readers");
		expect(workflow.concurrency.queue).toBe("max");
		expect(workflow.concurrency["cancel-in-progress"]).toBe(false);
	}
	const [audit, pins, image] = workflows;
	// Full dispatches join schedules; a bounded mechanics/slice dispatch stays independent.
	expect(audit.concurrency.group).toContain(
		"github.event_name == 'schedule' || inputs.nightly || inputs.weekly",
	);
	expect(audit.concurrency.group).toContain("github.run_id");
	// The pin workflow waits on this image job while holding the common group. Its ref must take the
	// image-only group even though reusable workflows inherit the caller's scheduled event context.
	expect(pins.jobs.image.with.ref).toBeTruthy();
	expect(image.concurrency.group).toContain(
		"inputs.ref && format('proof-image-{0}', inputs.ref)",
	);
});

it.each([
	["ci.yml", "proofs-gate", "proof"],
	["proof-lane.yml", "gate", "shard"],
])(
	"records the hosted shard result in the %s verdict even when a shard could not upload",
	async (file, job, dependency) => {
		const workflow = parse(
			await readFile(join(WORKTREE, ".github/workflows", file), "utf8"),
		);
		const gate = (
			workflow.jobs[job].steps as {
				run?: string;
				env?: Record<string, string>;
			}[]
		).find((step) => step.run?.includes("python3 -m proof.lane.gate"));
		expect(gate?.env?.SHARDS_RESULT).toBe(`\${{ needs.${dependency}.result }}`);
		expect(gate?.run).toContain('--shards-result "$SHARDS_RESULT"');
	},
);

it("builds the corpus with the same native architecture as its proof shards", async () => {
	const workflow = parse(
		await readFile(join(WORKTREE, ".github/workflows/proof-lane.yml"), "utf8"),
	);
	expect(workflow.jobs.emit["runs-on"]).toBe(
		// biome-ignore lint/suspicious/noTemplateCurlyInString: This is a literal GitHub expression.
		"${{ inputs.runner }}",
	);
	expect(
		workflow.jobs.emit.steps.find(
			(step: { name?: string }) => step.name === "Emit the proof corpus",
		)?.run,
	).toContain("python3 -m proof.native.produce");
});

it("runs as many of a lane's shards at once as the planner fills its rounds with", async () => {
	const workflow = parse(
		await readFile(join(WORKTREE, ".github/workflows/proof-lane.yml"), "utf8"),
	);
	// The planner's own value, asked of the planner as the workflow's jobs run it: on the machine's Python,
	// with nothing but the standard library.
	const { stdout } = await run(
		"python3",
		["-c", "from proof.lane import plan; print(plan.PARALLEL_SHARDS)"],
		{ cwd: WORKTREE },
	);
	const planned = Number(stdout.trim());
	expect(Number.isInteger(planned) && planned > 0).toBe(true);
	expect(workflow.jobs.shard.strategy["max-parallel"]).toBe(planned);
	// No other job of the workflow is a matrix, so no other bound could stand in for this one.
	const bounded = Object.entries(workflow.jobs).filter(
		([, job]) =>
			(job as { strategy?: Record<string, unknown> }).strategy?.[
				"max-parallel"
			] !== undefined,
	);
	expect(bounded.map(([name]) => name)).toEqual(["shard"]);
});

// A pattern download of one artifact extracts it loose into its path, with no directory named for it
// (actions/download-artifact, src/download-artifact.ts, lines 185-194), and every step that reads the
// shards' outputs globs proof-shards/proof-out-*. So each download of the outputs into proof-shards is
// followed at once by proof/ci/shard-outputs.mjs, run whenever the download runs, or a lane of one
// shard reads no output and its gate refuses.
it("gives a lone shard's output its directory after every download of the shards' outputs", async () => {
	const expression = (name: string) => `\${{ ${name} }}`;
	const downloads: string[] = [];
	for (const file of ["proof-lane.yml", "ci.yml"]) {
		const workflow = parse(
			await readFile(join(WORKTREE, ".github/workflows", file), "utf8"),
		);
		for (const [name, job] of Object.entries(workflow.jobs)) {
			const steps = ((job as { steps?: unknown[] }).steps ?? []) as Record<
				string,
				// biome-ignore lint/suspicious/noExplicitAny: a workflow step's fields are YAML of any shape.
				any
			>[];
			steps.forEach((step, index) => {
				if (
					!`${step.uses ?? ""}`.startsWith("actions/download-artifact@") ||
					step.with?.path !== `${expression("runner.temp")}/proof-shards`
				) {
					return;
				}
				downloads.push(`${file}:${name}`);
				const next = steps[index + 1];
				expect(next?.run ?? "").toContain("node proof/ci/shard-outputs.mjs");
				expect(next?.if).toBe(step.if);
				// The lone output's name is the pattern's with the first shard in place of its wildcard.
				const pattern = `${step.with.pattern}`
					.replaceAll(expression("inputs.label"), "$LABEL")
					.replaceAll(expression("github.run_attempt"), "$GITHUB_RUN_ATTEMPT");
				expect(pattern.endsWith("-*")).toBe(true);
				expect(next.run).toContain(`--name "${pattern.slice(0, -1)}1"`);
			});
		}
	}
	expect(downloads.sort()).toEqual([
		"ci.yml:proof-store",
		"ci.yml:proofs-gate",
		"proof-lane.yml:gate",
	]);
});

// A prewarm checks the tree the pin pull request will carry, so every job that takes the candidate's surface takes
// its retained trees too: one that took only the surface would emit the bases from main's answers, or hold main's
// trees to the new pins. Each artifact is data another job wrote, so it is downloaded outside the checkout and
// placed by the code that reads it as data: the surface's one file through proof/ci/untrusted.mjs, the trees
// through the retained layout (python3 -m proof.matrix.place unpack). The step that places the trees runs as
// written, over a checkout's proof/: the trees are replaced whole (a download alone would keep a file the new tree
// lacks) and nothing else of proof/ moves, and an artifact holding a test-named file, a hidden file, a deeper
// directory or a link is refused with the checkout left as it was.
const PLACE_FILES = [
	"proof/__init__.py",
	"proof/matrix/__init__.py",
	"proof/matrix/adopt.py",
	"proof/matrix/bases.json",
	"proof/matrix/lane_input.py",
	"proof/matrix/layout.py",
	"proof/matrix/place.py",
	"proof/matrix/retained-layout.json",
	"proof/matrix/stand-ins.json",
];

async function placingStep() {
	const expression = (name: string) => `\${{ ${name} }}`;
	const workflow = parse(
		await readFile(join(WORKTREE, ".github/workflows/proof-lane.yml"), "utf8"),
	);
	expect(workflow.on.workflow_call.inputs.retained.default).toBe("");
	const placing: string[] = [];
	const surfaced: string[] = [];
	const runs = new Set<string>();
	for (const [name, job] of Object.entries(workflow.jobs)) {
		const steps = ((job as { steps?: unknown[] }).steps ?? []) as Record<
			string,
			// biome-ignore lint/suspicious/noExplicitAny: a workflow step's fields are YAML of any shape.
			any
		>[];
		const surface = steps.findIndex(
			(step) => step.with?.name === expression("inputs.surface"),
		);
		if (surface !== -1) {
			surfaced.push(name);
			expect(steps[surface].with.path).toBe(
				`${expression("runner.temp")}/surface`,
			);
			expect(steps[surface + 1].if).toBe(steps[surface].if);
			expect(steps[surface + 1].run).toBe(
				'node proof/ci/untrusted.mjs surface "$RUNNER_TEMP/surface" lib/commcare/surface/surface.json',
			);
		}
		const download = steps.findIndex(
			(step) => step.with?.name === expression("inputs.retained"),
		);
		if (download === -1) continue;
		placing.push(name);
		expect(steps[download].uses).toMatch(/^actions\/download-artifact@/);
		expect(steps[download].if).toBe(expression("inputs.retained != ''"));
		expect(steps[download].with.path).toBe(
			`${expression("runner.temp")}/retained`,
		);
		const place = steps[download + 1];
		expect(place.if).toBe(steps[download].if);
		runs.add(place.run);
	}
	expect(placing).toEqual(surfaced);
	expect(placing.sort()).toEqual(["emit", "gate", "shard"]);
	expect([...runs]).toHaveLength(1);
	return [...runs][0];
}

const tabbed = (value: unknown) => `${JSON.stringify(value, null, "\t")}\n`;

/** A checkout holding the harness's placing code and its own trees, and a downloaded artifact beside it. */
async function placingScratch(artifact: Record<string, string>) {
	const scratch = await mkdtemp(join(tmpdir(), "proof-lane-retained-"));
	const files: Record<string, string> = {
		// The checkout: a base the new tree changes, an answer it drops, and the harness's own files.
		"checkout/proof/hq-apps/hq-plain/app.json": tabbed({ old: true }),
		"checkout/proof/hq-apps/hq-plain/seed.json": tabbed({ dropped: true }),
		"checkout/proof/hq-reads/publish/source-live.json": tabbed({ kept: true }),
		"checkout/proof/pins.json": tabbed({ pins: true }),
		...Object.fromEntries(
			Object.entries(artifact).map(([path, text]) => [
				`temp/retained/${path}`,
				text,
			]),
		),
	};
	for (const path of PLACE_FILES) {
		files[`checkout/${path}`] = await readFile(join(WORKTREE, path), "utf8");
	}
	for (const [path, text] of Object.entries(files)) {
		await mkdir(join(scratch, path, ".."), { recursive: true });
		await writeFile(join(scratch, path), text);
	}
	return scratch;
}

async function checkoutFiles(scratch: string) {
	const { stdout } = await run("find", ["proof", "-type", "f"], {
		cwd: join(scratch, "checkout"),
	});
	const found: Record<string, string> = {};
	for (const path of stdout.trim().split("\n").sort()) {
		if (path.includes("__pycache__") || PLACE_FILES.includes(path)) continue;
		found[path] = await readFile(join(scratch, "checkout", path), "utf8");
	}
	return found;
}

const ARTIFACT = {
	"hq-apps/hq-plain/app.json": tabbed({ new: true }),
	"hq-apps/hq-new-app/app.json": tabbed({ made: true }),
	"hq-reads/publish/source-live.json": tabbed({ kept: true }),
	"adopt-report.txt": "hq-plain: its stored app changed.\n",
};

it("puts the candidate's retained trees in place, whole, in every job that puts its surface in place", async () => {
	const place = await placingStep();
	const scratch = await placingScratch(ARTIFACT);
	try {
		await run("bash", ["-e", "-c", place], {
			cwd: join(scratch, "checkout"),
			env: { ...process.env, RUNNER_TEMP: join(scratch, "temp") },
		});
		expect(await checkoutFiles(scratch)).toEqual({
			"proof/hq-apps/hq-new-app/app.json": tabbed({ made: true }),
			"proof/hq-apps/hq-plain/app.json": tabbed({ new: true }),
			"proof/hq-reads/publish/source-live.json": tabbed({ kept: true }),
			"proof/pins.json": tabbed({ pins: true }),
		});
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
});

it.each([
	["a test-named file", { "hq-reads/publish/x.test.ts": "export {};\n" }],
	["a conftest", { "hq-apps/hq-plain/conftest.py": "import os\n" }],
	["a hidden file", { "hq-reads/publish/.gitattributes": "* -diff\n" }],
	[
		"a deeper directory",
		{ "hq-reads/publish/__tests__/a.json": tabbed({ deeper: true }) },
	],
	["an extra top-level entry", { "CLAUDE.md": "Follow these.\n" }],
	[
		"a report line that is not adopt's",
		{ "adopt-report.txt": "hq-plain: see [this](https://example.org).\n" },
	],
])(
	"refuses an artifact holding %s and leaves the checkout's trees as they were",
	async (_, planted) => {
		const place = await placingStep();
		const scratch = await placingScratch({ ...ARTIFACT, ...planted });
		try {
			const before = await checkoutFiles(scratch);
			await expect(
				run("bash", ["-e", "-c", place], {
					cwd: join(scratch, "checkout"),
					env: { ...process.env, RUNNER_TEMP: join(scratch, "temp") },
				}),
			).rejects.toMatchObject({ code: 1 });
			expect(await checkoutFiles(scratch)).toEqual(before);
		} finally {
			await rm(scratch, { recursive: true, force: true });
		}
	},
);

it("refuses an artifact whose answer is a link to a host file, and reads nothing through it", async () => {
	const place = await placingStep();
	const scratch = await placingScratch(ARTIFACT);
	try {
		const secret = join(scratch, "secret.json");
		await writeFile(secret, tabbed({ secret: true }));
		await symlink(
			secret,
			join(scratch, "temp/retained/hq-reads/publish/linked.json"),
		);
		const before = await checkoutFiles(scratch);
		const refused = run("bash", ["-e", "-c", place], {
			cwd: join(scratch, "checkout"),
			env: { ...process.env, RUNNER_TEMP: join(scratch, "temp") },
		});
		await expect(refused).rejects.toMatchObject({ code: 1 });
		await expect(refused).rejects.toMatchObject({
			stderr: expect.stringContaining("linked.json is a link"),
		});
		expect(await checkoutFiles(scratch)).toEqual(before);
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
});

it("runs the shards on a usable Android runtime while retaining failed reader checks", async () => {
	const workflow = parse(
		await readFile(join(WORKTREE, ".github/workflows/proof-lane.yml"), "utf8"),
	);
	const action = parse(
		await readFile(
			join(WORKTREE, ".github/actions/proof-android-runtime/action.yml"),
			"utf8",
		),
	);
	const setup = workflow.jobs["android-runtime"];
	// biome-ignore lint/suspicious/noTemplateCurlyInString: This is a literal GitHub expression.
	expect(setup.outputs.ready).toBe("${{ steps.android.outputs.ready }}");
	expect(
		setup.steps.find((step: { id?: string }) => step.id === "android").uses,
	).toBe("./.github/actions/proof-android-runtime");
	expect(workflow.jobs.shard.if).toContain(
		"needs.android-runtime.outputs.ready == 'true'",
	);
	const steps = action.runs.steps;
	const ready = steps.findIndex((step: { id?: string }) => step.id === "ready");
	const checks = steps.findIndex(
		(step: { id?: string }) => step.id === "checks",
	);
	expect(
		steps
			.slice(0, ready)
			.some(
				(step: { run?: string }) =>
					step.run === "python3 -m proof.android.ready",
			),
	).toBe(true);
	expect(
		steps
			.slice(0, ready)
			.some((step: { uses?: string }) =>
				step.uses?.startsWith("actions/cache/save@"),
			),
	).toBe(true);
	expect(ready).toBeLessThan(checks);
	expect(steps[checks]["continue-on-error"]).toBe(true);
	expect(steps[checks].run).toContain("set -o pipefail");
	expect(steps[checks].run).toContain(
		"proof.android.selfcheck proof.android.predicates",
	);
	expect(steps.at(-1).uses).toMatch(/^actions\/upload-artifact@/);
	expect(steps.at(-1).if).toContain("always()");
	const verdict = setup.steps.at(-1);
	// biome-ignore lint/suspicious/noTemplateCurlyInString: This is a literal GitHub expression.
	expect(verdict.if).toBe("${{ steps.android.outputs.checks == 'failure' }}");
	expect(verdict.run).toContain("exit 1");
});

it("executes slice validation against a named test and refuses broader paths and pytest overrides", async () => {
	const workflow = parse(
		await readFile(join(WORKTREE, ".github/workflows/proof-slice.yml"), "utf8"),
	);
	const validation = workflow.jobs.slice.steps.find(
		(step: { id?: string }) => step.id === "selection",
	).run;
	const scratch = await mkdtemp(join(tmpdir(), "proof-slice-selection-"));
	try {
		const env = {
			...process.env,
			GITHUB_OUTPUT: join(scratch, "output"),
			RUNNER_TEMP: scratch,
			PROOF_READERS: "android",
		};
		await run("bash", ["-e", "-c", validation], {
			cwd: WORKTREE,
			env: {
				...env,
				SELECTORS: "proof/android/test_navigation.py -k entry_point",
			},
		});
		expect(await readFile(join(scratch, "output"), "utf8")).toContain(
			"android=true",
		);
		expect(
			JSON.parse(await readFile(join(scratch, "proof-selectors.json"), "utf8")),
		).toEqual(["proof/android/test_navigation.py", "-k", "entry_point"]);
		const piece =
			"proof/checks/pieces.py::test_a_configuration_is_observed_into_the_runs_store[targeted-search-hq-compile@minimum]";
		await run("bash", ["-e", "-c", validation], {
			cwd: WORKTREE,
			env: { ...env, SELECTORS: piece, AUDIT_MODE: "unseeded" },
		});
		expect(
			JSON.parse(await readFile(join(scratch, "proof-selectors.json"), "utf8")),
		).toEqual([piece]);
		for (const selectors of [
			"proof/checks/pieces.py",
			"proof/checks/pieces.py::test_a_configuration_is_observed_into_the_runs_store",
			"proof/lane/test_plan.py .",
			"proof/lane/test_plan.py -o addopts=--maxfail=1",
			"proof/lane/test_plan.py -x",
			"proof/checks",
			"proof/../package.json",
			"-k only",
		]) {
			const code = await run("bash", ["-e", "-c", validation], {
				cwd: WORKTREE,
				env: { ...env, SELECTORS: selectors },
			}).then(
				() => 0,
				(error: { code: number }) => error.code,
			);
			expect(code, selectors).toBe(1);
		}
		await expect(
			run("bash", ["-e", "-c", validation], {
				cwd: WORKTREE,
				env: {
					...env,
					SELECTORS: "proof/hq/test_branches.py -k targeted-hq-side-state",
					AUDIT_MODE: "unknown",
				},
			}),
		).rejects.toMatchObject({ code: 1 });
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
});

it("keeps Android result artifacts separate for each reusable lane and attempt", async () => {
	const workflow = parse(
		await readFile(join(WORKTREE, ".github/workflows/proof-lane.yml"), "utf8"),
	);
	const action = parse(
		await readFile(
			join(WORKTREE, ".github/actions/proof-android-runtime/action.yml"),
			"utf8",
		),
	);
	const runtime = workflow.jobs["android-runtime"].steps.find(
		(step: { id?: string }) => step.id === "android",
	);
	expect(runtime.with.label).toContain("inputs.label");
	const uploads = action.runs.steps.filter((step: { uses?: string }) =>
		step.uses?.startsWith("actions/upload-artifact@"),
	);
	expect(uploads).toHaveLength(2);
	for (const upload of uploads) {
		expect(upload.with.name).toContain("inputs.label");
		expect(upload.with.name).toContain("github.run_attempt");
	}
});

// GitHub's cache evicts the least recently used entries once the repository
// is over its limit, so a snapshot the prune listed can be gone when it is
// deleted. The plausible failures are a night failed by that eviction, and a
// prune that hides a delete that truly failed. The step runs as written
// against a controlled `gh` that holds the listed caches.
it("prunes main's older snapshots past one already gone, and fails on one still held", async () => {
	const workflow = parse(
		await readFile(join(WORKTREE, ".github/workflows/proof-audit.yml"), "utf8"),
	);
	const prune = workflow.jobs.prune.steps.find(
		(step: { name?: string }) => step.name === "Delete all but the newest two",
	).run;
	const scratch = await mkdtemp(join(tmpdir(), "proof-audit-prune-"));
	const PREFIX = "proof-store-amd64-abc-main-";
	// `cache list --key K` prints the held keys K begins (skipping the newest two when the step's --jq asks it
	// to); `cache delete K` fails for a key in `gone` (dropping it, as an eviction just before would) or in
	// `broken` (keeping it), and otherwise drops it.
	const gh = `#!/bin/sh
if [ "$2" = list ]; then
  key=""; skip=0
  while [ $# -gt 0 ]; do
    [ "$1" = --key ] && key="$2"
    [ "$1" = ".[2:][].key" ] && skip=2
    shift
  done
  grep -F -- "$key" "$FAKE/held" | awk -v k="$key" -v s="$skip" 'index($0, k) == 1 && ++n > s'
  exit 0
fi
key=$5
echo "delete $key" >> "$FAKE/calls"
if grep -qxF -- "$key" "$FAKE/gone"; then
  grep -vxF -- "$key" "$FAKE/held" > "$FAKE/next" || true; mv "$FAKE/next" "$FAKE/held"
  echo "X Could not find a cache matching $key" >&2; exit 1
fi
if grep -qxF -- "$key" "$FAKE/broken"; then echo "HTTP 502" >&2; exit 1; fi
grep -vxF -- "$key" "$FAKE/held" > "$FAKE/next" || true; mv "$FAKE/next" "$FAKE/held"
`;
	const pruned = async (gone: string[], broken: string[]) => {
		await writeFile(
			join(scratch, "held"),
			`${[1, 2, 3, 4, 5].map((n) => `${PREFIX}${6 - n}`).join("\n")}\n${PREFIX}10\n`,
		);
		await writeFile(join(scratch, "gone"), `${gone.join("\n")}\n`);
		await writeFile(join(scratch, "broken"), `${broken.join("\n")}\n`);
		await writeFile(join(scratch, "calls"), "");
		const code = await run("bash", ["-e", "-c", prune], {
			env: {
				NODE_ENV: "test",
				PATH: `${join(scratch, "bin")}:${process.env.PATH ?? ""}`,
				FAKE: scratch,
				PREFIX,
				GITHUB_REPOSITORY: "voidcraft-labs/commcare-nova",
			},
		}).then(
			() => 0,
			(error: { code: number }) => error.code,
		);
		return {
			code,
			held: (await readFile(join(scratch, "held"), "utf8"))
				.split("\n")
				.filter(Boolean),
		};
	};
	try {
		await mkdir(join(scratch, "bin"));
		await writeFile(join(scratch, "bin", "gh"), gh);
		await chmod(join(scratch, "bin", "gh"), 0o755);
		// Newest first: 5, 4, then 3, 2, 1 and 10 to delete. 10 shares 1's prefix, so a re-list by prefix alone
		// would find 1 still held after it was evicted.
		const gone = await pruned([`${PREFIX}1`], []);
		expect(gone.code).toBe(0);
		expect(gone.held).toEqual([`${PREFIX}5`, `${PREFIX}4`]);
		const broken = await pruned([], [`${PREFIX}2`]);
		expect(broken.code).toBe(1);
		expect(broken.held).toContain(`${PREFIX}2`);
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
});

// The cache's storage refuses some of a lane's concurrent runtime downloads
// though it holds the entry, and a refused restore reads as a miss. The
// plausible failures are a shard failed by one refusal, and a missing runtime
// that a shard (which cannot build one) goes on without. The summarizing step
// runs as written for each outcome of the two restores.
it("restores the Android runtime a second time before a shard concludes it is missing", async () => {
	const action = parse(
		await readFile(
			join(WORKTREE, ".github/actions/proof-android-runtime/action.yml"),
			"utf8",
		),
	);
	const steps = action.runs.steps;
	const restores = steps.filter((step: { uses?: string }) =>
		step.uses?.startsWith("actions/cache/restore@"),
	);
	expect(restores.map((step: { id?: string }) => step.id)).toEqual([
		"first",
		"again",
	]);
	for (const restore of restores) {
		expect(restore.with["fail-on-cache-miss"]).toBeUndefined();
	}
	expect(restores[1].if).toContain("steps.first.outputs.cache-hit != 'true'");
	const held = steps.findIndex((step: { id?: string }) => step.id === "held");
	expect(held).toBeGreaterThan(steps.indexOf(restores[1]));
	expect(steps[held].env.HIT).toContain("steps.first.outputs.cache-hit");
	expect(steps[held].env.HIT).toContain("steps.again.outputs.cache-hit");
	const scratch = await mkdtemp(join(tmpdir(), "proof-android-held-"));
	try {
		for (const [hit, build, code, output] of [
			["true", "false", 0, "cache-hit=true"],
			["false", "true", 0, "cache-hit=false"],
			["false", "false", 1, "cache-hit=false"],
		] as const) {
			const out = join(scratch, `${hit}-${build}`);
			const result = await run("bash", ["-e", "-c", steps[held].run], {
				env: {
					...process.env,
					GITHUB_OUTPUT: out,
					HIT: hit,
					BUILD: build,
					KEY: "proof-android-runtime-x",
				},
			}).then(
				() => ({ code: 0, stdout: "" }),
				(error: { code: number; stdout: string }) => error,
			);
			expect(result.code, `${hit} ${build}`).toBe(code);
			expect(await readFile(out, "utf8")).toBe(`${output}\n`);
			expect(result.stdout.includes("Egress is over the account limit")).toBe(
				code === 1,
			);
		}
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
});

it("pulls a shard's image and Postgres through the retrying script, on the lane's own Node", async () => {
	const workflow = parse(
		await readFile(join(WORKTREE, ".github/workflows/proof-lane.yml"), "utf8"),
	);
	const steps = workflow.jobs.shard.steps;
	const pull = steps.findIndex(
		(step: { name?: string }) => step.name === "Pull the image and Postgres",
	);
	const node = steps.findIndex((step: { uses?: string }) =>
		step.uses?.startsWith("actions/setup-node@"),
	);
	expect(steps[pull].run).toBe("node proof/ci/pull.mjs");
	expect(node).toBeGreaterThanOrEqual(0);
	expect(node).toBeLessThan(pull);
});

it("restores the checksum-pinned JDK with the runtime and permits only its builder to download it", async () => {
	const expression = (name: string) => `\${{ ${name} }}`;
	const action = parse(
		await readFile(
			join(WORKTREE, ".github/actions/proof-android-runtime/action.yml"),
			"utf8",
		),
	);
	const steps = action.runs.steps;
	const setup = steps.findIndex(
		(step: { name?: string }) => step.name === "Prepare the pinned JDK",
	);
	const ready = steps.findIndex((step: { id?: string }) => step.id === "ready");
	expect(setup).toBeGreaterThan(
		steps.findIndex((step: { id?: string }) => step.id === "held"),
	);
	expect(setup).toBeLessThan(ready);
	expect(steps[setup]["continue-on-error"]).toBeUndefined();
	expect(
		steps.some((step: { uses?: string }) =>
			step.uses?.startsWith("actions/setup-java@"),
		),
	).toBe(false);
	const caches = steps.filter((step: { uses?: string }) =>
		step.uses?.startsWith("actions/cache/"),
	);
	expect(caches).toHaveLength(3);
	for (const cache of caches) {
		expect(cache.with.path.trim().split("\n")).toEqual([
			expression("steps.name.outputs.runtime"),
			expression("steps.name.outputs.jdk-archive"),
		]);
	}
	const scratch = await mkdtemp(join(tmpdir(), "proof-jdk-action-"));
	try {
		const bin = join(scratch, "bin");
		await mkdir(bin);
		const python = join(bin, "python3");
		await writeFile(
			python,
			'#!/bin/sh\nprintf "%s\\n" "$@" > "$ARGUMENTS"\nexit "$RESULT"\n',
		);
		await chmod(python, 0o755);
		for (const build of ["true", "false"]) {
			for (const result of ["0", "1"]) {
				const args = join(scratch, `${build}-${result}`);
				const outcome = await run("bash", ["-e", "-c", steps[setup].run], {
					env: {
						...process.env,
						PATH: `${bin}:${process.env.PATH}`,
						BUILD: build,
						JDK_ARCHIVE: "/cache/jdk.tar.gz",
						JDK_HOME: "/install/jdk",
						ARGUMENTS: args,
						RESULT: result,
					},
				}).then(
					() => 0,
					(error: { code: number }) => error.code,
				);
				expect(outcome).toBe(Number(result));
				expect((await readFile(args, "utf8")).trim().split("\n")).toEqual([
					"-m",
					"proof.android.jdk",
					"/cache/jdk.tar.gz",
					"/install/jdk",
					...(build === "true" ? ["--download"] : []),
				]);
			}
		}
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
});

// A shard's output is uploaded by upload-artifact, which follows a link to its target, so every upload of a run's
// output comes after the step that seals it (proof/ci/untrusted.mjs). run.mjs seals as the run ends; the step
// seals an output a run that ended first left unsealed.
it("uploads shard and slice outputs only when their seal succeeds", async () => {
	let uploads = 0;
	for (const file of ["proof-lane.yml", "ci.yml", "proof-slice.yml"]) {
		const workflow = parse(
			await readFile(join(WORKTREE, ".github/workflows", file), "utf8"),
		);
		for (const job of Object.values(workflow.jobs)) {
			const steps = ((job as { steps?: unknown[] }).steps ?? []) as {
				id?: string;
				if?: string;
				uses?: string;
				run?: string;
				with?: { path?: string };
			}[];
			steps.forEach((step, index) => {
				if (
					!step.uses?.startsWith("actions/upload-artifact@") ||
					!(
						step.with?.path?.endsWith("/proof-out/") ||
						step.with?.path === ".proof/slice"
					)
				)
					return;
				uploads += 1;
				const output =
					file === "proof-slice.yml"
						? "$PROOF_OUT_DIR"
						: "$RUNNER_TEMP/proof-out";
				const command = file === "proof-slice.yml" ? "--seal" : "--seal-hosted";
				if (file !== "proof-slice.yml") {
					expect(
						(job as { env?: Record<string, string> }).env
							?.PROOF_HOSTED_CHECKPOINTS,
					).toBe("1");
					expect(
						steps
							.slice(0, index)
							.some((step) => step.uses === "./.github/actions/proof-runtime"),
					).toBe(true);
					expect(steps[0]?.run).toContain("PROOF_SHARD_STARTED_AT=$(date +%s)");
					expect(
						steps
							.slice(0, index)
							.some((earlier) =>
								earlier.run?.includes("node proof/run.mjs --hosted-lane"),
							),
					).toBe(true);
					expect((job as Record<string, unknown>)["timeout-minutes"]).toBe(
						`\${{ matrix.jobDeadline }}`,
					);
				}
				const seal = steps
					.slice(0, index)
					.find(
						(earlier) =>
							earlier.run === `node proof/run.mjs ${command} "${output}"`,
					);
				expect(seal?.id, file).toBeTruthy();
				expect(step.if, file).toContain(
					`steps.${seal?.id}.outcome == 'success'`,
				);
			});
		}
	}
	expect(uploads).toBe(3);
});

// Adopting takes every output of one run and merges by file (proof/matrix/adopt.py): two blocks of one run, on two
// outputs, can write files of one retained directory, and an output left out is a block whose files go unwritten
// and whose held records go unread. So every workflow step that adopts names, as its outputs, exactly the outputs its
// job's run of the lane wrote (each `node proof/run.mjs` step's PROOF_OUT_DIR), reports with the reader of the corpus
// that run was given, made on the host and inside no output, and hands its report to the layout's packer. Each such
// step's shell runs as written, over a `python3` that records what it was asked, so what is held is what the runner
// executes, whatever the step's quoting.
it("adopts every output of its job's run, through the layout, wherever a workflow adopts", async () => {
	const directory = join(WORKTREE, ".github/workflows");
	const adopting: string[] = [];
	const scratch = await mkdtemp(join(tmpdir(), "proof-lane-adopt-"));
	try {
		const bin = join(scratch, "bin");
		await mkdir(bin);
		await writeFile(
			join(bin, "python3"),
			'#!/bin/sh\nfor arg in "$@"; do printf \'%s\\n\' "$arg"; done >> "$PYTHON_CALLS"\nprintf \'%s\\n\' "--end--" >> "$PYTHON_CALLS"\n',
		);
		await chmod(join(bin, "python3"), 0o755);
		const expression = (name: string) => `\${{ ${name} }}`;
		for (const file of (await readdir(directory)).filter((name) =>
			name.endsWith(".yml"),
		)) {
			const workflow = parse(await readFile(join(directory, file), "utf8"));
			for (const [name, job] of Object.entries(workflow.jobs ?? {})) {
				const steps = ((job as { steps?: unknown[] }).steps ?? []) as Record<
					string,
					// biome-ignore lint/suspicious/noExplicitAny: a workflow step's fields are YAML of any shape.
					any
				>[];
				const step = steps.find((each) =>
					`${each.run ?? ""}`.includes("proof.matrix.adopt"),
				);
				if (step === undefined) continue;
				adopting.push(`${file}:${name}`);
				const temp = join(scratch, `${file}-${name}`);
				await mkdir(temp, { recursive: true });
				const expand = (value: string) =>
					value.replaceAll(expression("runner.temp"), temp);
				const runs = steps.filter(
					(each) =>
						/(^|\s)node proof\/run\.mjs\s/.test(`${each.run ?? ""}`) &&
						!`${each.run}`.includes("--seal") &&
						!`${each.run}`.includes("--surface"),
				);
				expect(runs.length, `${file}:${name} runs the lane`).toBeGreaterThan(0);
				const outputs = runs.map((each) => expand(each.env.PROOF_OUT_DIR));
				const corpora = new Set(
					runs.map((each) => expand(each.env.PROOF_CORPUS)),
				);
				expect(corpora.size).toBe(1);
				const calls = join(temp, "python-calls");
				await run("bash", ["-e", "-c", step.run], {
					cwd: WORKTREE,
					env: {
						...process.env,
						PATH: `${bin}:${process.env.PATH}`,
						RUNNER_TEMP: temp,
						PYTHON_CALLS: calls,
					},
				});
				const asked = (await readFile(calls, "utf8"))
					.split("--end--\n")
					.filter((call) => call !== "")
					.map((call) => call.trimEnd().split("\n"));
				const adopt = asked.find(
					(call) => call[0] === "-m" && call[1] === "proof.matrix.adopt",
				);
				const pack = asked.find(
					(call) => call[0] === "-m" && call[1] === "proof.matrix.place",
				);
				expect(adopt, `${file}:${name} adopts`).toBeDefined();
				const flag = adopt?.findIndex((arg) => arg.startsWith("--")) ?? -1;
				const named = adopt?.slice(2, flag === -1 ? undefined : flag) ?? [];
				expect([...named].sort()).toEqual([...outputs].sort());
				expect(adopt).toContain("--report");
				const corpus = adopt?.[(adopt?.indexOf("--corpus") ?? -2) + 1];
				expect(corpora.has(`${corpus}`)).toBe(true);
				for (const output of outputs) {
					expect(`${corpus}/`.startsWith(`${output}/`)).toBe(false);
				}
				// The report goes to the layout's packer, which holds each line to adopt's own sentences.
				expect(pack?.slice(2, 4)).toEqual(["pack", "proof"]);
				const report = pack?.[(pack?.indexOf("--report") ?? -2) + 1];
				expect(report).toBeDefined();
				expect(step.run).toContain(
					`> "${`${report}`.replace(temp, "$RUNNER_TEMP")}"`,
				);
			}
		}
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
	expect(adopting).toEqual(["upstream-pins.yml:retained"]);
});

// proof/run.mjs shows a container a view of the checkout without .git (checkoutView), but a job that runs the image
// itself over $GITHUB_WORKSPACE shows it the checkout whole, and actions/checkout leaves the job's token in
// .git/config unless told not to (persist-credentials). So every job that mounts the workspace into a container
// checks out with no credential kept.
it("keeps no credential in a workspace a job mounts into a container", async () => {
	const directory = join(WORKTREE, ".github/workflows");
	const mounting: string[] = [];
	for (const file of (await readdir(directory)).filter((name) =>
		name.endsWith(".yml"),
	)) {
		const workflow = parse(await readFile(join(directory, file), "utf8"));
		for (const [name, job] of Object.entries(workflow.jobs ?? {})) {
			const steps = ((job as { steps?: unknown[] }).steps ?? []) as {
				uses?: string;
				run?: string;
				with?: Record<string, unknown>;
			}[];
			if (
				!steps.some((step) =>
					/docker run[^\n]*-v "?\$GITHUB_WORKSPACE:/.test(step.run ?? ""),
				)
			)
				continue;
			mounting.push(`${file}:${name}`);
			const checkouts = steps.filter((step) =>
				step.uses?.startsWith("actions/checkout@"),
			);
			expect(checkouts.length, `${file}:${name}`).toBeGreaterThan(0);
			for (const checkout of checkouts) {
				expect(checkout.with?.["persist-credentials"], `${file}:${name}`).toBe(
					false,
				);
			}
		}
	}
	// The image workflow's emission job runs the emission and the producers in the image over the workspace.
	expect(mounting).toContain("proof-image.yml:emission");
});

it("includes the domain data consumed by both sparse proof shard checkouts", async () => {
	for (const [file, job] of [
		["ci.yml", "proof"],
		["proof-lane.yml", "shard"],
	] as const) {
		const workflow = parse(
			await readFile(join(WORKTREE, ".github", "workflows", file), "utf8"),
		);
		const checkout = workflow.jobs[job].steps.find((step: { uses?: string }) =>
			step.uses?.startsWith("actions/checkout@"),
		);
		expect(checkout.with["sparse-checkout"].trim().split(/\s+/)).toContain(
			"lib/domain",
		);
	}
});
