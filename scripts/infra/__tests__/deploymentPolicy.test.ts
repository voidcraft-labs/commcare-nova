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

function stepOffset(id: string): number {
	const offset = cloudBuild.indexOf(`- id: ${id}`);
	expect(offset, `missing Cloud Build step ${id}`).toBeGreaterThanOrEqual(0);
	return offset;
}

describe("durable deployment policy", () => {
	test("uses the standard blocking migration then Cloud Run deploy path", () => {
		expect(stepOffset("runtime-capabilities")).toBeLessThan(
			stepOffset("build"),
		);
		expect(stepOffset("build")).toBeLessThan(stepOffset("push"));
		expect(stepOffset("push")).toBeLessThan(stepOffset("media-policy"));
		expect(stepOffset("media-policy")).toBeLessThan(
			stepOffset("capacity-precap"),
		);
		expect(stepOffset("capacity-precap")).toBeLessThan(
			stepOffset("capacity-audit"),
		);
		expect(stepOffset("capacity-audit")).toBeLessThan(stepOffset("migrate"));
		expect(stepOffset("media-policy")).toBeLessThan(stepOffset("migrate"));
		expect(stepOffset("push")).toBeLessThan(stepOffset("migrate"));
		expect(stepOffset("migrate")).toBeLessThan(stepOffset("capture-cleanup"));
		expect(stepOffset("capture-cleanup")).toBeLessThan(stepOffset("deploy"));
		expect(stepOffset("deploy")).toBeLessThan(stepOffset("verify"));
		expect(cloudBuild).not.toContain("--no-traffic");
		expect(cloudBuild).not.toContain("nova-rollout");
		expect(cloudBuild).not.toContain("update-traffic");
		expect(dockerfile).not.toContain("rollout.cjs");
		expect(dockerignore).toContain("!scripts/infra/databaseOwnerBootstrap.ts");
		expect(dockerignore).toContain("!scripts/infra/check-database-capacity.ts");
		expect(dockerignore).toContain(
			"!scripts/infra/databaseCapacityPreflight.ts",
		);
		expect(cloudBuild).toContain("https://commcare.app/");
		expect(cloudBuild).toContain("https://docs.commcare.app/");
		expect(cloudBuild).toContain("https://mcp.commcare.app/mcp");
	});

	test("pins one unique image and the runtime platform limits", () => {
		expect(cloudBuild).not.toContain("app:$COMMIT_SHA");
		expect(cloudBuild.match(/app:\$BUILD_ID/g)).toHaveLength(7);
		expect(cloudBuild).toContain('--build-arg NOVA_BUILD_ID="$$NOVA_BUILD_ID"');
		expect(cloudBuild).toContain(
			'--timeout="$${NOVA_CLOUD_RUN_REQUEST_SECONDS}s"',
		);
		expect(cloudBuild).toContain(
			"--no-default-url --ingress=internal-and-cloud-load-balancing",
		);
		expect(cloudBuild).toContain("--min-instances=1 --max=4 --max-instances=4");
		expect(cloudSqlProvisioning).toContain(
			"readonly CLOUD_RUN_MAX_INSTANCES=4",
		);
		expect(cloudSqlProvisioning).toContain("readonly MAX_CONNECTIONS=25");
		expect(cloudSqlProvisioning).toContain(
			`readonly DATABASE_FLAGS="cloudsql.enable_pgaudit=on,cloudsql.iam_authentication=on,max_connections=\${MAX_CONNECTIONS},pgaudit.log=all"`,
		);
		expect(cloudSqlProvisioning).toContain(
			'expected_database_flags="$DATABASE_FLAGS"',
		);
		expect(cloudSqlProvisioning).toContain(
			'CAPTURE_CLEANUP_SA_EMAIL="nova-capture-cleanup@',
		);
		expect(cloudSqlProvisioning).toContain(
			'assign-roles "$CAPTURE_CLEANUP_SA_DBUSER"',
		);
		const cloudRunCap = cloudSqlProvisioning.indexOf(
			"=== Phase 5: Cap Cloud Run before database bootstrap ===",
		);
		const ownerBootstrap = cloudSqlProvisioning.indexOf(
			"=== Phase 6: SKIPPED (manual — run the checked-in local CLI) ===",
		);
		expect(cloudRunCap).toBeGreaterThanOrEqual(0);
		expect(ownerBootstrap).toBeGreaterThan(cloudRunCap);
		expect(cloudSqlProvisioning).toContain("gcloud run services list");
		expect(cloudSqlProvisioning).toContain(
			"refusing to infer that the service is absent",
		);
		expect(cloudSqlProvisioning).toContain('--max="$CLOUD_RUN_MAX_INSTANCES"');
		expect(cloudSqlProvisioning).toContain("NOVA_DB_WORKLOAD=service");
		expect(cloudSqlProvisioning).toContain(
			"yaml(metadata.annotations,spec.template.metadata.annotations",
		);
		expect(cloudSqlProvisioning).toContain(
			"Cloud SQL Studio can optionally inspect",
		);
		expect(cloudSqlProvisioning).toContain(
			"cannot run this repository's Node/TypeScript",
		);
	});

	test("preserves the live four-flag Cloud SQL audit/IAM/capacity shape exactly", () => {
		// `read_database_flags` sorts the live API response before comparison.
		// Pin the production-shaped four-flag response here so adding exact
		// convergence can never regress into replacement of the pgaudit flags.
		const liveDatabaseFlags = [
			{ name: "pgaudit.log", value: "all" },
			{ name: "max_connections", value: "25" },
			{ name: "cloudsql.iam_authentication", value: "on" },
			{ name: "cloudsql.enable_pgaudit", value: "on" },
		];
		const canonicalLiveFlags = liveDatabaseFlags
			.map((flag) => `${flag.name}=${flag.value}`)
			.sort()
			.join(",");
		expect(canonicalLiveFlags).toBe(
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
		expect(
			canonicalLiveFlags.replace(
				"max_connections=25",
				`max_connections=\${MAX_CONNECTIONS}`,
			),
		).toBe(
			`cloudsql.enable_pgaudit=on,cloudsql.iam_authentication=on,max_connections=\${MAX_CONNECTIONS},pgaudit.log=all`,
		);
	});

	test("ships every bundled Job entrypoint in the clean Docker context", () => {
		const esbuildEntrypoints = [
			...dockerfile.matchAll(/npx esbuild (scripts\/[^\s\\]+)/g),
		].map((match) => match[1]);
		expect(esbuildEntrypoints).toEqual([
			"scripts/migrate.ts",
			"scripts/cleanup-form-attachments.ts",
			"scripts/infra/apply-media-bucket-policy.ts",
			"scripts/infra/check-database-capacity.ts",
		]);
		for (const entrypoint of esbuildEntrypoints) {
			expect(dockerignore).toContain(`!${entrypoint}`);
		}
	});

	test("caps the old service globally and per revision before migration", () => {
		const capacityPrecap = cloudBuild.slice(
			stepOffset("capacity-precap"),
			stepOffset("capacity-audit"),
		);
		expect(capacityPrecap).toContain(
			"gcloud run services update commcare-nova",
		);
		expect(capacityPrecap).toContain("--max=4");
		expect(capacityPrecap).toContain("--max-instances=4");
		expect(capacityPrecap).toContain("run.googleapis.com/maxScale");
		expect(capacityPrecap).toContain("autoscaling.knative.dev/maxScale");
		expect(capacityPrecap).toContain('if [[ "$${reported_maxima}" != "4,4" ]]');
	});

	test("audits hard database caps and drains old runtime sessions before migration", () => {
		const capacityAudit = cloudBuild.slice(
			stepOffset("capacity-audit"),
			stepOffset("migrate"),
		);
		const migration = cloudBuild.slice(
			stepOffset("migrate"),
			stepOffset("capture-cleanup"),
		);
		const cleanup = cloudBuild.slice(
			stepOffset("capture-cleanup"),
			stepOffset("deploy"),
		);
		const roleEnvironment = [
			"NOVA_RUNTIME_DB_USER=commcare-nova@commcare-nova.iam",
			"NOVA_MIGRATION_DB_USER=nova-migrate@commcare-nova.iam",
			"NOVA_CAPTURE_CLEANUP_DB_USER=nova-capture-cleanup@commcare-nova.iam",
		];
		expect(dockerfile).toContain("scripts/infra/check-database-capacity.ts");
		expect(dockerfile).toContain("capacity-preflight.cjs");
		expect(capacityAudit).toContain("commcare-nova-capacity-preflight");
		for (const role of roleEnvironment) {
			expect(capacityAudit).toContain(role);
			expect(migration).toContain(role);
			expect(cleanup).toContain(role);
		}
		expect(capacityAudit).toContain("--args=capacity-preflight.cjs");
		expect(capacityAudit).toContain("--max-retries=0");
		expect(capacityAudit).toContain("--task-timeout=420");
		expect(migration).toContain("--task-timeout=1020");
		expect(cleanup).toContain("--task-timeout=1260");
		expect(cleanup).toContain("--max-retries=0");
		expect(cleanup).not.toContain("--max-retries=1");
		expect(cleanup).not.toContain("--max-retries=2");
		expect(capacityAudit).toContain(
			'gcloud run jobs execute "$${capacity_job}" --region=us-central1 --wait',
		);
		expect(migrateEntrypoint).toContain("await runDatabaseCapacityPreflight(");
		expect(
			migrateEntrypoint.indexOf("await runDatabaseCapacityPreflight("),
		).toBeLessThan(migrateEntrypoint.indexOf("await runCaseStoreMigrations("));
		expect(cleanupEntrypoint).toContain("await runDatabaseCapacityPreflight(");
		expect(
			cleanupEntrypoint.indexOf("await runDatabaseCapacityPreflight("),
		).toBeLessThan(
			cleanupEntrypoint.indexOf(
				"const result = await withExclusiveCaptureCleanupWorker(",
			),
		);
	});

	test("keeps build, migration, and runtime authority distinct", () => {
		expect(cloudBuild).toContain(
			"--service-account=nova-migrate@commcare-nova.iam.gserviceaccount.com",
		);
		expect(cloudBuild).toContain(
			"--service-account=commcare-nova@commcare-nova.iam.gserviceaccount.com",
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
		expect(provisioning).not.toContain("nova-openai-api-key");
		expect(provisioning).toContain("gcloud sql users assign-roles");
		expect(provisioning).toContain('assign-roles "$RUNTIME_DB_USER"');
		expect(provisioning).toContain('--database-roles="$RUNTIME_DB_USER"');
		expect(provisioning).toContain("--revoke-existing-roles");
		expect(cloudSqlProvisioning).toContain('MIGRATION_SA_EMAIL="nova-migrate@');
		expect(cloudSqlProvisioning).toContain('RUNTIME_SA_EMAIL="commcare-nova@');
		expect(cloudSqlProvisioning).toContain(
			'CAPTURE_CLEANUP_SA_EMAIL="nova-capture-cleanup@',
		);
		expect(cloudSqlProvisioning).toContain('assign-roles "$RUNTIME_SA_DBUSER"');
		expect(cloudSqlProvisioning).not.toContain("compute@developer");
	});

	test("deploys the capture storage policy and a scheduled retry worker before traffic", () => {
		expect(dockerfile).toContain("scripts/infra/apply-media-bucket-policy.ts");
		expect(dockerfile).toContain("scripts/cleanup-form-attachments.ts");
		expect(dockerfile).toContain("media-bucket-policy.cjs");
		expect(dockerfile).toContain("capture-cleanup.cjs");

		expect(cloudBuild).toContain(
			"--service-account=nova-media-policy@commcare-nova.iam.gserviceaccount.com",
		);
		expect(cloudBuild).toContain(
			"--service-account=nova-capture-cleanup@commcare-nova.iam.gserviceaccount.com",
		);
		expect(cloudBuild).toContain(
			"gcloud run jobs execute commcare-nova-media-policy --region=us-central1 --wait",
		);
		expect(cloudBuild).toContain(
			"--update-env-vars=NOVA_CAPTURE_CLEANUP_MODE=strict",
		);
		expect(cloudBuild).toContain('--schedule="*/5 * * * *"');
		expect(cloudBuild).toContain("NOVA_DB_WORKLOAD=capture-cleanup");
		expect(cloudBuild).toContain("NOVA_DB_WORKLOAD=migration");
		expect(cloudBuild).toContain("NOVA_DB_WORKLOAD=service");
		expect(prodDb).toContain('process.env.NOVA_DB_WORKLOAD = "operator"');
		expect(packageJson).toContain(
			'"db:migrate": "NOVA_DB_WORKLOAD=migration tsx scripts/migrate.ts"',
		);
		expect(cloudBuild.match(/--tasks=1 --parallelism=1/g)).toHaveLength(3);
		expect(cloudBuild).toContain(
			'--oauth-service-account-email="$${scheduler_account}"',
		);
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
		expect(provisioning).not.toContain("--flatten=bindings");
		expect(provisioning).not.toContain('--filter="bindings.role=');
		expect(provisioning).toContain("gcloud storage buckets get-iam-policy");
		expect(provisioning).toContain("gcloud storage buckets set-iam-policy");
		expect(provisioning).not.toContain(
			'gcloud storage buckets add-iam-policy-binding "gs://$' +
				'{MEDIA_BUCKET}"',
		);
		expect(provisioning).toContain("capture-bucket-policy.mjs");
		expect(provisioning).toContain(
			"Failed to read the media bucket IAM policy",
		);
		expect(provisioning).toContain(
			"Failed to verify the media bucket IAM policy",
		);
		expect(captureBucketPolicy).toContain(
			'from "./capture-storage-policy.mjs"',
		);
		expect(cloudBuild).toContain("NOVA_CAPTURE_CLEANUP_MODE=scheduler");
		expect(cleanupEntrypoint).toContain("probeCaptureStorageAuthority");
		expect(cleanupEntrypoint).toContain("assertStrictCaptureMaintenance");
		const schedulerEnablement = provisioning.indexOf(
			"gcloud services enable cloudscheduler.googleapis.com",
		);
		const schedulerAgentBinding = provisioning.indexOf(
			'--member="serviceAccount:' + "$" + '{SCHEDULER_SERVICE_AGENT}"',
		);
		const buildTriggerUpdate = provisioning.indexOf(
			"gcloud beta builds triggers update developer-connect",
		);
		expect(schedulerEnablement).toBeGreaterThanOrEqual(0);
		expect(schedulerAgentBinding).toBeGreaterThan(schedulerEnablement);
		expect(buildTriggerUpdate).toBeGreaterThan(schedulerEnablement);
	});
});
