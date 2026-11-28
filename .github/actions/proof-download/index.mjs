import { client } from "../../../proof/ci/artifacts.mjs";
import { downloadNamed } from "../../../proof/ci/download.mjs";

const words = (value = "") => value.trim().split(/\s+/).filter(Boolean);

try {
	const counts = words(process.env["INPUT_SHARD-COUNTS"]);
	const labels = words(process.env.INPUT_LABELS);
	const names = labels.map((label) => `${process.env.INPUT_PREFIX}${label}${process.env.INPUT_SUFFIX}`);
	for (const pair of counts) {
		const match = /^([a-z0-9-]+)=([1-9][0-9]{0,2})$/.exec(pair);
		if (!match) throw new Error(`Invalid proof shard count: ${pair}.`);
		const [, label, count] = match;
		for (let shard = 1; shard <= Number(count); shard++) {
			names.push(`proof-out-${label}-${process.env.GITHUB_RUN_ATTEMPT}-${shard}`);
		}
	}
	await downloadNamed(await client(), {
		names,
		allowMissing: process.env["INPUT_ALLOW-MISSING"] === "true",
		directory: process.env.INPUT_PATH,
	});
} catch (error) {
	console.error(error);
	process.exitCode = 1;
}
