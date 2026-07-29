import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const cloudBuild = readFileSync("cloudbuild.yaml", "utf8");
const packageJson = readFileSync("package.json", "utf8");
const dockerfile = readFileSync("Dockerfile", "utf8");
const dockerignore = readFileSync(".dockerignore", "utf8");
const provisioning = readFileSync(
	"scripts/infra/provision-deployment-identities.sh",
	"utf8",
);
const cloudSqlProvisioning = readFileSync(
	"scripts/infra/provision-cloud-sql.sh",
	"utf8",
);
const prodDb = readFileSync("scripts/lib/prodDb.ts", "utf8");
const migrateEntrypoint = readFileSync("scripts/migrate.ts", "utf8");
const cleanupEntrypoint = readFileSync(
	"scripts/cleanup-form-attachments.ts",
	"utf8",
);
const captureBucketPolicy = readFileSync(
	"scripts/infra/capture-bucket-policy.mjs",
	"utf8",
);
const deployPolicy = readFileSync(
	"scripts/rollout/deploy-cloud-run.py",
	"utf8",
);

function stepOffset(id: string): number {
	const offset = cloudBuild.indexOf(`- id: ${id}`);
	expect(offset, `missing Cloud Build step ${id}`).toBeGreaterThanOrEqual(0);
	return offset;
}

describe("durable deployment policy", () => {
	test("uses one blocking migration and one direct service deployment", () => {
		expect(stepOffset("runtime-capabilities")).toBeLessThan(
			stepOffset("build"),
		);
		expect(stepOffset("build")).toBeLessThan(stepOffset("push"));
		expect(stepOffset("push")).toBeLessThan(stepOffset("media-policy"));
		expect(stepOffset("media-policy")).toBeLessThan(stepOffset("migrate"));
		expect(stepOffset("migrate")).toBeLessThan(stepOffset("capture-cleanup"));
		expect(stepOffset("capture-cleanup")).toBeLessThan(stepOffset("deploy"));
		expect(stepOffset("deploy")).toBeLessThan(stepOffset("verify"));

		for (const removedMechanism of [
			"capacity-precap",
			"capacity-audit",
			"capacity-preflight",
			"NOVA_CAPTURE_CLEANUP_MODE",
			"--no-traffic",
			"nova-rollout",
			"update-traffic",
		]) {
			expect(cloudBuild).not.toContain(removedMechanism);
		}
		expect(dockerfile).not.toContain("rollout.cjs");
		expect(dockerfile).not.toContain("capacity-preflight.cjs");
		expect(cloudBuild).toContain("python3 scripts/rollout/deploy-cloud-run.py");
		expect(dockerignore).toContain("!scripts/infra/databaseOwnerBootstrap.ts");
		expect(cloudBuild).toContain("https://commcare.app/");
		expect(cloudBuild).toContain("https://docs.commcare.app/");
		expect(cloudBuild).toContain("https://mcp.commcare.app/mcp");
	});

	test("pins one image and the final runtime platform limits", () => {
		expect(cloudBuild).not.toContain("app:$COMMIT_SHA");
		expect(cloudBuild.match(/app:\$BUILD_ID/g)).toHaveLength(6);
		expect(cloudBuild).toContain('--build-arg NOVA_BUILD_ID="$$NOVA_BUILD_ID"');
		expect(cloudBuild).toContain(
			'--timeout="$${NOVA_CLOUD_RUN_REQUEST_SECONDS}s"',
		);
		expect(cloudBuild).toContain(
			"--no-default-url --ingress=internal-and-cloud-load-balancing",
		);
		expect(cloudBuild).toContain(
			"--min=1 --max=4 --min-instances=1 --max-instances=4",
		);
		expect(cloudSqlProvisioning).toContain(
			"readonly CLOUD_RUN_MAX_INSTANCES=4",
		);
		expect(cloudSqlProvisioning).toContain("readonly MAX_CONNECTIONS=25");
		expect(cloudSqlProvisioning).toContain(
			`readonly DATABASE_FLAGS="cloudsql.enable_pgaudit=on,cloudsql.iam_authentication=on,max_connections=\${MAX_CONNECTIONS},pgaudit.log=all"`,
		);
		expect(cloudSqlProvisioning).toContain('--max="$CLOUD_RUN_MAX_INSTANCES"');
		expect(cloudSqlProvisioning).toContain(
			'--max-instances="$CLOUD_RUN_MAX_INSTANCES"',
		);
		expect(cloudSqlProvisioning).toContain("NOVA_DB_WORKLOAD=service");
	});

	test("preserves manual-zero until the exact candidate owns traffic", () => {
		expect(
			execFileSync(
				"python3",
				["scripts/rollout/deploy-cloud-run.py", "--policy-self-test"],
				{ encoding: "utf8" },
			),
		).toContain("policy self-test passed");
		expect(deployPolicy).toContain(
			'"Cloud Run deploy accepts only automatic scaling or manual scaling "',
		);
		expect(deployPolicy).toContain(
			'"The exact candidate must own 100% traffic and every old revision "',
		);
		expect(deployPolicy).toContain(
			'"Scaling-only update created or removed a revision."',
		);
		expect(deployPolicy).toContain('"--scaling=auto"');
		expect(deployPolicy).toContain("NOVA_DEPLOY_PRESTATE=");
		expect(deployPolicy).toContain("NOVA_DEPLOY_CANDIDATE=");
		expect(deployPolicy).toContain("NOVA_DEPLOY_RESULT=");
		const deployStep = cloudBuild.slice(
			stepOffset("deploy"),
			stepOffset("verify"),
		);
		expect(deployStep).not.toMatch(/^\s+--scaling=/m);
		expect(cloudBuild).not.toContain("--no-deploy-health-check");
		expect(cloudBuild).not.toMatch(/^\s*status=/m);
	});

	test("preserves the exact Cloud SQL flags and dedicated database identities", () => {
		const liveDatabaseFlags = [
			{ name: "pgaudit.log", value: "all" },
			{ name: "max_connections", value: "25" },
			{ name: "cloudsql.iam_authentication", value: "on" },
			{ name: "cloudsql.enable_pgaudit", value: "on" },
		];
		expect(
			liveDatabaseFlags
				.map((flag) => `${flag.name}=${flag.value}`)
				.sort()
				.join(","),
		).toBe(
			"cloudsql.enable_pgaudit=on,cloudsql.iam_authentication=on,max_connections=25,pgaudit.log=all",
		);
		expect(cloudSqlProvisioning).toContain(
			'--database-flags="$DATABASE_FLAGS"',
		);
		expect(
			cloudSqlProvisioning.match(/--database-flags="\\?\$DATABASE_FLAGS"/g),
		).toHaveLength(1);
		expect(cloudSqlProvisioning).toContain(
			'--database-flags="$expected_database_flags"',
		);
		expect(cloudSqlProvisioning).toContain('MIGRATION_SA_EMAIL="nova-migrate@');
		expect(cloudSqlProvisioning).toContain('RUNTIME_SA_EMAIL="commcare-nova@');
		expect(cloudSqlProvisioning).toContain(
			'CAPTURE_CLEANUP_SA_EMAIL="nova-capture-cleanup@',
		);
		expect(cloudSqlProvisioning).toContain('assign-roles "$RUNTIME_SA_DBUSER"');
		expect(cloudSqlProvisioning).toContain(
			'assign-roles "$CAPTURE_CLEANUP_SA_DBUSER"',
		);
		expect(cloudSqlProvisioning).not.toContain("compute@developer");
	});

	test("ships only the final migration, media-policy, and cleanup Job entrypoints", () => {
		const esbuildEntrypoints = [
			...dockerfile.matchAll(/npx esbuild (scripts\/[^\s\\]+)/g),
		].map((match) => match[1]);
		expect(esbuildEntrypoints).toEqual([
			"scripts/migrate.ts",
			"scripts/cleanup-form-attachments.ts",
			"scripts/infra/apply-media-bucket-policy.ts",
		]);
		for (const entrypoint of esbuildEntrypoints) {
			expect(dockerignore).toContain(`!${entrypoint}`);
		}
		expect(migrateEntrypoint).not.toContain("DatabaseCapacityPreflight");
		expect(migrateEntrypoint).toContain("runCanonicalRuntimeDatabaseProbe");
		expect(migrateEntrypoint).toContain(
			"terminateAndAssertNoRuntimeDatabaseSessions",
		);
		expect(cleanupEntrypoint).not.toContain("DatabaseCapacityPreflight");
		expect(cleanupEntrypoint).not.toContain("CaptureCleanupMode");
		expect(cleanupEntrypoint).not.toContain("probeCaptureStorageAuthority");
		expect(dockerfile).toContain(
			"npx esbuild scripts/migrate.ts \\\n      --bundle --platform=node --target=node24 --format=cjs \\\n      --conditions=react-server",
		);
	});

	test("keeps build, migration, runtime, and cleanup authority distinct", () => {
		expect(cloudBuild).toContain(
			"--service-account=nova-migrate@commcare-nova.iam.gserviceaccount.com",
		);
		expect(cloudBuild).toContain(
			"--service-account=commcare-nova@commcare-nova.iam.gserviceaccount.com",
		);
		expect(cloudBuild).toContain(
			"--service-account=nova-capture-cleanup@commcare-nova.iam.gserviceaccount.com",
		);
		expect(cloudBuild).toContain("NOVA_DB_USER=nova-migrate@commcare-nova.iam");
		expect(cloudBuild).toContain(
			"NOVA_DB_USER=commcare-nova@commcare-nova.iam",
		);
		expect(provisioning).toContain('BUILD_ACCOUNT="nova-build@');
		expect(provisioning).toContain('MIGRATION_ACCOUNT="nova-migrate@');
		expect(provisioning).toContain('MEDIA_POLICY_ACCOUNT="nova-media-policy@');
		expect(provisioning).toContain(
			'CAPTURE_CLEANUP_ACCOUNT="nova-capture-cleanup@',
		);
		expect(provisioning).toContain(
			'CAPTURE_SCHEDULER_ACCOUNT="nova-capture-scheduler@',
		);
		expect(provisioning).not.toContain("nova-rollout");
		expect(provisioning).toContain("roles/iam.serviceAccountTokenCreator");
		expect(provisioning).toContain("roles/developerconnect.readTokenAccessor");
		expect(provisioning).toContain('bind_act_as "$MIGRATION_ACCOUNT"');
		expect(provisioning).toContain('bind_act_as "$RUNTIME_ACCOUNT"');
		expect(provisioning).toContain('bind_act_as "$MEDIA_POLICY_ACCOUNT"');
		expect(provisioning).toContain('bind_act_as "$CAPTURE_CLEANUP_ACCOUNT"');
		expect(provisioning).toContain('bind_act_as "$CAPTURE_SCHEDULER_ACCOUNT"');
		expect(provisioning).not.toContain('bind_act_as "$BUILD_ACCOUNT"');
	});

	test("deploys the storage policy and one scheduled retry worker", () => {
		expect(dockerfile).toContain("scripts/infra/apply-media-bucket-policy.ts");
		expect(dockerfile).toContain("scripts/cleanup-form-attachments.ts");
		expect(dockerfile).toContain("media-bucket-policy.cjs");
		expect(dockerfile).toContain("capture-cleanup.cjs");
		expect(cloudBuild).toContain(
			"gcloud run jobs execute commcare-nova-media-policy --region=us-central1 --wait",
		);
		expect(cloudBuild).not.toContain(
			"gcloud run jobs execute commcare-nova-capture-cleanup",
		);
		expect(cloudBuild).toContain("--args=capture-cleanup.cjs,--probe-schema");
		expect(cloudBuild).toContain(
			'scheduler_state_after="$$(gcloud scheduler jobs describe',
		);
		expect(cloudBuild).toContain(
			'"$${scheduler_state_after}" != "$${scheduler_state_before}"',
		);
		expect(cleanupEntrypoint).toContain("runCaptureCleanupSchemaProbe");
		expect(cloudBuild).toContain('--schedule="*/5 * * * *"');
		expect(cloudBuild).toContain("NOVA_DB_WORKLOAD=capture-cleanup");
		expect(cloudBuild).toContain("NOVA_DB_WORKLOAD=migration");
		expect(cloudBuild).toContain("NOVA_DB_WORKLOAD=service");
		expect(prodDb).toContain('process.env.NOVA_DB_WORKLOAD = "operator"');
		expect(packageJson).toContain(
			'"db:migrate": "NOVA_DB_WORKLOAD=migration tsx scripts/migrate.ts"',
		);
		expect(cloudBuild.match(/--tasks=1 --parallelism=1/g)).toHaveLength(2);
		expect(cloudBuild).toContain(
			'--oauth-service-account-email="$${scheduler_account}"',
		);
		const schedulerUpdate = cloudBuild.match(
			/gcloud scheduler jobs update http[\s\S]*?--update-headers=Content-Type=application\/json/,
		);
		const schedulerCreate = cloudBuild.match(
			/gcloud scheduler jobs create http[\s\S]*?--headers=Content-Type=application\/json/,
		);
		expect(schedulerUpdate).not.toBeNull();
		expect(schedulerCreate).not.toBeNull();
		expect(schedulerUpdate?.[0]).not.toContain(" --headers=");
		expect(schedulerCreate?.[0]).not.toContain("--update-headers=");
		expect(cloudBuild).toContain("NOVA_MEDIA_BUCKET=nova-multimedia-prod");
		expect(cloudBuild).toContain(
			"NOVA_UPLOAD_CORS_ORIGINS=https://commcare.app",
		);
		expect(provisioning).toContain("roles/cloudscheduler.admin");
		expect(provisioning).toContain(
			"storage.buckets.get,storage.buckets.update",
		);
		expect(provisioning).toContain(
			"storage.objects.get,storage.objects.create,storage.objects.delete",
		);
		expect(provisioning).toContain("novaMediaBucketPolicy");
		expect(provisioning).toContain("novaCaptureObjectMaintenance");
		expect(captureBucketPolicy).toContain(
			'from "./capture-storage-policy.mjs"',
		);
	});
});
