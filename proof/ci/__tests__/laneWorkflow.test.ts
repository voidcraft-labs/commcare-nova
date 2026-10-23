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
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { parse } from "yaml";

const run = promisify(execFile);
const WORKTREE = resolve(import.meta.dirname, "..", "..", "..");

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
		for (const selectors of [
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
