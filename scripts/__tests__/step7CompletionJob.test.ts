import { expect, it, vi } from "vitest";
import jobContracts from "@/config/deployment-jobs.json";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import {
	completionJobName,
	readCompletionJobPlan,
	requireCompletionJobEnvironment,
} from "../lib/step7CompletionJob";

const plan = {
	version: 3,
	conversionSettings: {},
	workspaces: [],
	provenance: "f".repeat(64),
	apps: [],
};
const digest = canonicalJsonDigest(plan);
const generation = "1795676400000000";

it("only admits the configured Cloud Run migration authority", () => {
	const configured = jobContracts[completionJobName].env;
	const env = { ...configured, CLOUD_RUN_JOB: completionJobName };
	expect(requireCompletionJobEnvironment(env)).toEqual({
		role: configured.NOVA_DB_USER,
		database: configured.NOVA_DB_NAME,
	});
	for (const overrides of [
		{ CLOUD_RUN_JOB: undefined },
		{ NOVA_DB_USER: configured.NOVA_RUNTIME_DB_USER },
		{ NOVA_MIGRATION_DB_USER: undefined },
		{ NOVA_DB_WORKLOAD: "operator" },
		{ NOVA_DB_IP_TYPE: "PUBLIC" },
		{ NOVA_DB_LOCAL_URL: "postgres://localhost/postgres" },
	]) {
		expect(() =>
			requireCompletionJobEnvironment({ ...env, ...overrides }),
		).toThrow("dedicated migration Job environment");
	}
});

it("reads only the approved plan generation and verifies the complete document", async () => {
	const download = vi.fn(async () => Buffer.from(JSON.stringify(plan)));
	await expect(
		readCompletionJobPlan(digest, generation, download),
	).resolves.toEqual(plan);
	expect(download).toHaveBeenCalledExactlyOnceWith({
		bucket: "commcare-nova-cutover-evidence",
		name: `hq-round-trip-completion/plans/${digest}.json`,
		generation: Number(generation),
	});
});

it("refuses missing or unsafe object generations before attempting a download", async () => {
	const download = vi.fn(async () => Buffer.from("{}"));
	for (const bad of ["", "0", "01", "latest", "9007199254740992"]) {
		await expect(readCompletionJobPlan(digest, bad, download)).rejects.toThrow(
			"exact plan digest and object generation",
		);
	}
	expect(download).not.toHaveBeenCalled();
});

it("refuses unavailable generations and changed private plan bytes", async () => {
	const unavailable = vi.fn(async () => {
		throw new Error("generation unavailable");
	});
	await expect(
		readCompletionJobPlan(digest, generation, unavailable),
	).rejects.toThrow("generation unavailable");
	const changed = vi.fn(async () =>
		Buffer.from(
			JSON.stringify({
				...plan,
				conversionSettings: { changed: true },
			}),
		),
	);
	await expect(
		readCompletionJobPlan(digest, generation, changed),
	).rejects.toThrow("differs from the reviewed scan");
});
