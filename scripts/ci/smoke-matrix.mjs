import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** Assign hardware by measured workload. Discovery still selects every test. */
export function smokeMatrix(jobs, workers, timings) {
	if (![4, 6].includes(jobs) || ![1, 2].includes(workers))
		throw new Error(
			"Smoke execution supports four/six jobs and one/two workers",
		);
	let browser = 0,
		app = 0;
	for (const [name, duration] of Object.entries(timings)) {
		if (!Number.isFinite(duration) || duration <= 0)
			throw new Error(`Invalid smoke duration: ${name}`);
		if (name.startsWith("[browser]")) browser += duration;
		else if (name.startsWith("[authed]") || name.startsWith("[public]"))
			app += duration;
	}
	if (!browser || !app)
		throw new Error("Both smoke lanes need measured workload");
	const browserJobs = Math.max(
		1,
		Math.min(jobs - 1, Math.round((jobs * browser) / (browser + app))),
	);
	return {
		include: [
			...Array.from({ length: browserJobs }, (_, i) => ({
				lane: "browser",
				shard: i + 1,
				total: browserJobs,
				workers,
			})),
			...Array.from({ length: jobs - browserJobs }, (_, i) => ({
				lane: "app",
				shard: i + 1,
				total: jobs - browserJobs,
				workers,
			})),
		],
	};
}
if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	const defaults = JSON.parse(
		readFileSync(
			new URL("../../config/smoke-execution.json", import.meta.url),
			"utf8",
		),
	);
	const { durationsMs } = JSON.parse(
		readFileSync(
			new URL("../../e2e/smoke-timings.json", import.meta.url),
			"utf8",
		),
	);
	const [jobs, workers] = process.argv
		.slice(2)
		.map((value) =>
			value === "default" || !value ? undefined : Number(value),
		);
	console.log(
		JSON.stringify(
			smokeMatrix(
				jobs ?? defaults.jobs,
				workers ?? defaults.workers,
				durationsMs,
			),
		),
	);
}
