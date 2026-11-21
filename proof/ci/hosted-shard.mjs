// GitHub gives a hosted job up to six hours. Work keeps its original deadline
// from the start of preparation. The extra job time belongs to finalization.
import { execFileSync } from "node:child_process";

const FINALIZE_MINUTES = 15;
const HOST_GRACE_SECONDS = 180;
const RUNNER_MAX_MINUTES = 360;
// Each hosted shard has its own VM. Its name also lets a fallback seal rule
// out a still-running Docker writer after the host wrapper had to be killed.
export const HOSTED_CONTAINER = "nova-proof-hosted-shard";

export function hostedBudget(minutes = 330) {
	const deadline = Number(minutes);
	if (
		!Number.isSafeInteger(deadline) ||
		deadline < 1 ||
		deadline + FINALIZE_MINUTES > RUNNER_MAX_MINUTES
	) {
		throw new Error(
			`The shard's work deadline must be 1–${RUNNER_MAX_MINUTES - FINALIZE_MINUTES} whole minutes; got ${minutes}.`,
		);
	}
	return { deadline, jobDeadline: deadline + FINALIZE_MINUTES };
}

export function hostedCutoffs(
	start,
	minutes,
	now = Math.floor(Date.now() / 1000),
) {
	if (minutes === undefined)
		throw new Error("The hosted shard has no planned work deadline.");
	const began = Number(start);
	if (!Number.isSafeInteger(began) || began <= 0 || began > now) {
		throw new Error(
			"The shard's preparation start must be a positive Unix timestamp no later than now.",
		);
	}
	const stopAt = began + hostedBudget(minutes).deadline * 60;
	return { stopAt, hostSeconds: stopAt + HOST_GRACE_SECONDS - now };
}

export function stopHostedWriter() {
	const docker = (...args) =>
		execFileSync("docker", args, {
			encoding: "utf8",
			timeout: 60_000,
			killSignal: "SIGKILL",
		});
	const exists = () =>
		docker(
			"ps",
			"--all",
			"--quiet",
			"--filter",
			`name=^/${HOSTED_CONTAINER}$`,
		).trim() !== "";
	if (!exists()) return;
	console.error(
		"The hosted harness is still present. Removing it before sealing its output.",
	);
	try {
		docker("rm", "--force", HOSTED_CONTAINER);
	} catch (error) {
		// A --rm container can finish between listing it and removing it.
		if (exists()) throw error;
	}
}
