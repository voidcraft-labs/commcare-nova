// Exports the job's artifact-service credentials to the workflow steps after
// the one that runs this: `node proof/ci/runtime.mjs`, run by the local action
// .github/actions/proof-runtime.
//
// The runner gives ACTIONS_RUNTIME_TOKEN and ACTIONS_RESULTS_URL to the
// processes of actions, never to `run` steps, and the proof lane's claim and
// wait commands (proof/ci/claim.mjs, proof/ci/wait.mjs) run
// from a `run` step, inside the lane's container. So this appends both to the
// file GITHUB_ENV names, each in the runner's delimited form, which makes them
// part of every later step's environment, and asks the runner to mask the
// token in logs. The lane's server passes them on to its claim and wait
// commands alone (--command-env), never to the processes that run HQ.

import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";

const EXPORTED = ["ACTIONS_RUNTIME_TOKEN", "ACTIONS_RESULTS_URL"];

const target = process.env.GITHUB_ENV;
const missing = EXPORTED.filter((name) => !process.env[name]);
if (!target || missing.length > 0) {
	process.stderr.write(
		`${[...(target ? [] : ["GITHUB_ENV"]), ...missing].join(" and ")} ${missing.length + (target ? 0 : 1) === 1 ? "is" : "are"} not set, so the artifact-service credentials cannot reach the steps after this one.\n` +
			"This runs as the action .github/actions/proof-runtime, whose process the runner gives ACTIONS_RUNTIME_TOKEN, ACTIONS_RESULTS_URL and GITHUB_ENV; a `run` step has none of the first two.\n",
	);
	process.exit(1);
}

process.stdout.write(`::add-mask::${process.env.ACTIONS_RUNTIME_TOKEN}\n`);
let lines = "";
for (const name of EXPORTED) {
	const value = process.env[name];
	const delimiter = `proof_runtime_${randomUUID()}`;
	lines += `${name}<<${delimiter}\n${value}\n${delimiter}\n`;
}
appendFileSync(target, lines);
process.stdout.write(
	`Exported ${EXPORTED.join(" and ")} to the steps after this one.\n`,
);
