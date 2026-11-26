import { Storage } from "@google-cloud/storage";
import jobContracts from "@/config/deployment-jobs.json";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import { completionPlanSchema } from "./hqRoundTripCompletion";

export const completionJobName = "commcare-nova-historical-repair";
const job = jobContracts[completionJobName];
const evidenceBucket = "commcare-nova-cutover-evidence";
const planPrefix = "hq-round-trip-completion/plans";

export function requireCompletionJobEnvironment(
	env: Readonly<Record<string, string | undefined>>,
) {
	if (
		env.CLOUD_RUN_JOB !== completionJobName ||
		env.NOVA_DB_LOCAL_URL ||
		(env.NOVA_DB_IP_TYPE && env.NOVA_DB_IP_TYPE !== "PRIVATE") ||
		Object.entries(job.env).some(([key, value]) => env[key] !== value)
	)
		throw new Error(
			"The cutover requires the dedicated migration Job environment.",
		);
	return { role: job.env.NOVA_DB_USER, database: job.env.NOVA_DB_NAME };
}

function completionPlanLocation(digest: string, generation: string) {
	// The Storage SDK converts numeric generations to JS numbers.
	const exactGeneration = Number(generation);
	if (
		!/^[a-f0-9]{64}$/.test(digest) ||
		!/^[1-9][0-9]{0,15}$/.test(generation) ||
		!Number.isSafeInteger(exactGeneration)
	)
		throw new Error(
			"The cutover requires an exact plan digest and object generation.",
		);
	return {
		bucket: evidenceBucket,
		name: `${planPrefix}/${digest}.json`,
		generation: exactGeneration,
	};
}

type PlanDownload = (
	location: ReturnType<typeof completionPlanLocation>,
) => Promise<Buffer>;

async function downloadPlan({
	bucket,
	name,
	generation,
}: Parameters<PlanDownload>[0]) {
	const storage = new Storage({ timeout: 30_000 });
	const [bytes] = await storage
		.bucket(bucket)
		.file(name, { generation })
		.download();
	return bytes;
}

export async function readCompletionJobPlan(
	digest: string,
	generation: string,
	download: PlanDownload = downloadPlan,
) {
	const bytes = await download(completionPlanLocation(digest, generation));
	const plan = completionPlanSchema.parse(JSON.parse(bytes.toString("utf8")));
	if (canonicalJsonDigest(plan) !== digest)
		throw new Error(
			"The selected private plan differs from the reviewed scan.",
		);
	return plan;
}
