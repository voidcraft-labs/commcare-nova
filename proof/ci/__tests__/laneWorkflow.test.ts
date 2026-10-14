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
import { readFile } from "node:fs/promises";
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
