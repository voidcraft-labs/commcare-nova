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
const auditEntrypoint = readFileSync(
	"scripts/audit-canonical-identity-foundation.ts",
	"utf8",
);
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
const schemaDriftScanner = readFileSync("scripts/scan-schema-drift.ts", "utf8");
const caseParentScanner = readFileSync(
	"scripts/scan-case-parent-relationships.ts",
	"utf8",
);
const caseParentMigration = readFileSync(
	"scripts/migrate-case-parent-relationships.ts",
	"utf8",
);

function stepOffset(id: string): number {
	const offset = cloudBuild.indexOf(`  - id: ${id}\n`);
	expect(offset, `missing Cloud Build step ${id}`).toBeGreaterThanOrEqual(0);
	return offset;
}

describe("durable deployment policy", () => {
	test("uses one blocking migration and one direct service deployment", () => {
		expect(stepOffset("runtime-capabilities")).toBeLessThan(
			stepOffset("build"),
		);
		expect(stepOffset("build")).toBeLessThan(stepOffset("push"));
		expect(stepOffset("push")).toBeLessThan(stepOffset("resolve-image"));
		expect(stepOffset("resolve-image")).toBeLessThan(
			stepOffset("deployment-prestate"),
		);
		expect(stepOffset("deployment-prestate")).toBeLessThan(
			stepOffset("media-policy"),
		);
		expect(stepOffset("media-policy")).toBeLessThan(stepOffset("migrate"));
		expect(stepOffset("migrate")).toBeLessThan(stepOffset("capture-cleanup"));
		expect(stepOffset("capture-cleanup")).toBeLessThan(stepOffset("deploy"));
		expect(stepOffset("deploy")).toBeLessThan(
			stepOffset("legacy-preplan-repair-job"),
		);
		expect(stepOffset("legacy-preplan-repair-job")).toBeLessThan(
			stepOffset("verify"),
		);
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
		const migrateStep = cloudBuild.slice(
			stepOffset("migrate"),
			stepOffset("capture-cleanup"),
		);
		expect(migrateStep).toContain("--max-retries=0");
		expect(migrateStep).not.toContain("--max-retries=1");
		expect(dockerignore).toContain("!scripts/infra/databaseOwnerBootstrap.ts");
		expect(cloudBuild).toContain("https://commcare.app/");
		expect(cloudBuild).toContain("https://docs.commcare.app/");
		expect(cloudBuild).toContain("https://mcp.commcare.app/mcp");
	});

	test("pins one image and the final runtime platform limits", () => {
		expect(cloudBuild).not.toContain("app:$COMMIT_SHA");
		expect(cloudBuild.match(/app:\$BUILD_ID/g)).toHaveLength(3);
		expect(cloudBuild.match(/\$\${NOVA_IMMUTABLE_IMAGE}/g)).toHaveLength(10);
		expect(cloudBuild).toContain("--resolve-image");
		expect(cloudBuild).toContain("--output=/workspace/image.env");
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
			'"Cloud Run removed a tagged or traffic-owning revision: "',
		);
		expect(deployPolicy).toContain(
			'"Cloud Run revision inventory added an unexpected revision: "',
		);
		expect(deployPolicy).toContain("RECOVERABLE_PHASES");
		expect(deployPolicy).toContain("finally:");
		expect(deployPolicy).toContain('"etag": etag');
		expect(deployPolicy).toContain("_run_all_recovery_actions");
		expect(deployPolicy).toContain("attempted_recovery_actions =");
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
		expect(cloudSqlProvisioning).toContain('AUDIT_SA_EMAIL="nova-audit@');
		expect(cloudSqlProvisioning).toContain('assign-roles "$RUNTIME_SA_DBUSER"');
		expect(cloudSqlProvisioning).toContain(
			'assign-roles "$CAPTURE_CLEANUP_SA_DBUSER"',
		);
		expect(cloudSqlProvisioning).toContain('assign-roles "$AUDIT_SA_DBUSER"');
		expect(cloudSqlProvisioning).not.toContain("compute@developer");
	});

	test("ships only the final deployment and maintenance Job entrypoints", () => {
		const esbuildEntrypoints = [
			...dockerfile.matchAll(/npx esbuild (scripts\/[^\s\\]+)/g),
		].map((match) => match[1]);
		expect(esbuildEntrypoints).toEqual([
			"scripts/migrate.ts",
			"scripts/cleanup-form-attachments.ts",
			"scripts/audit-canonical-identity-foundation.ts",
			"scripts/infra/apply-media-bucket-policy.ts",
			"scripts/migrate-case-type-schema-retirement.ts",
			"scripts/migrate-case-parent-relationships.ts",
			"scripts/migrate-schema-drift.ts",
			"scripts/migrate-legacy-preplan-builds.ts",
		]);
		for (const entrypoint of esbuildEntrypoints) {
			expect(dockerignore).toContain(`!${entrypoint}`);
		}
		for (const helper of [
			"caseParentRelationshipRepair.ts",
			"caseTypeSchemaRetirement.ts",
			"loadPersistedBlueprint.ts",
			"main.ts",
			"schemaDrift.ts",
			"schemaDriftMigration.ts",
		]) {
			expect(dockerignore).toContain(`!scripts/lib/${helper}`);
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

	test("packages the legacy pre-plan convergence as a dormant immutable Job", () => {
		expect(dockerfile).toContain("scripts/migrate-legacy-preplan-builds.ts");
		expect(dockerfile).toContain("legacy-preplan-repair.cjs");
		expect(cloudBuild).toContain(
			"gcloud run jobs deploy commcare-nova-legacy-preplan-repair",
		);
		expect(cloudBuild).toContain("--args=legacy-preplan-repair.cjs");
		expect(cloudBuild).not.toContain(
			"--args=legacy-preplan-repair.cjs,--execute",
		);
		expect(cloudBuild).toContain("NOVA_LEGACY_PREPLAN_PRODUCTION_JOB=true");
		expect(cloudBuild).not.toContain(
			"gcloud run jobs execute commcare-nova-legacy-preplan-repair",
		);
	});

	test("packages the ordinary extension-edge repair as a dormant immutable Job", () => {
		expect(dockerfile).toContain(
			"scripts/migrate-case-parent-relationships.ts",
		);
		expect(dockerfile).toContain("case-parent-relationship-repair.cjs");
		expect(cloudBuild).toContain(
			"gcloud run jobs deploy commcare-nova-case-parent-relationship-repair",
		);
		expect(cloudBuild).toContain("--args=case-parent-relationship-repair.cjs");
		expect(cloudBuild).not.toContain(
			"--args=case-parent-relationship-repair.cjs,--execute",
		);
		expect(cloudBuild).toContain(
			"NOVA_CASE_PARENT_RELATIONSHIP_PRODUCTION_JOB=true",
		);
		expect(cloudBuild).not.toContain(
			"gcloud run jobs execute commcare-nova-case-parent-relationship-repair",
		);
		expect(
			cloudBuild.indexOf("- id: case-parent-relationship-repair-job"),
		).toBeGreaterThan(cloudBuild.indexOf("- id: deploy"));
		expect(caseParentScanner).toContain('.setAccessMode("read only")');
		expect(caseParentScanner).toContain(
			"classifyCaseParentRelationshipsInSnapshot(tx, app.id)",
		);
		expect(caseParentMigration).toContain(
			"classifyCaseParentRelationshipsInSnapshot(tx, app.id)",
		);
		expect(caseParentScanner).not.toContain("projectId: app.project_id");
		expect(caseParentMigration).not.toContain("projectId: app.project_id");
		expect(caseParentScanner).toContain(
			"--job=commcare-nova-case-parent-relationship-repair",
		);
		expect(caseParentScanner).toContain(
			"scripts/scan-case-parent-relationships.ts --prod",
		);
	});

	test("keeps build, migration, runtime, cleanup, and audit authority distinct", () => {
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
		expect(provisioning).toContain('AUDIT_ACCOUNT="nova-audit@');
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
		expect(provisioning).not.toContain('bind_act_as "$AUDIT_ACCOUNT"');
		expect(cloudBuild).not.toContain(
			"--service-account=nova-audit@commcare-nova.iam.gserviceaccount.com",
		);
		expect(dockerfile).toContain("canonical-identity-audit.cjs");
		expect(auditEntrypoint).toContain('readCaseStoreWorkload() !== "audit"');
		expect(auditEntrypoint).toContain("databaseUser !== auditUser");
		expect(auditEntrypoint).toContain("SET default_transaction_read_only = on");
	});

	test("deploys the storage policy and one scheduled retry worker", () => {
		expect(dockerfile).toContain("scripts/infra/apply-media-bucket-policy.ts");
		expect(dockerfile).toContain("scripts/cleanup-form-attachments.ts");
		expect(dockerfile).toContain("media-bucket-policy.cjs");
		expect(dockerfile).toContain("capture-cleanup.cjs");
		expect(cloudBuild.match(/--execute-job/g)).toHaveLength(3);
		expect(cloudBuild).not.toContain("gcloud run jobs execute");
		expect(cloudBuild).not.toContain(
			"gcloud run jobs execute commcare-nova-capture-cleanup",
		);
		expect(cloudBuild).toContain("--execution-arg=capture-cleanup.cjs");
		expect(cloudBuild).toContain("--execution-arg=--probe-schema");
		expect(cloudBuild).toContain("--read-scaling-prestate");
		expect(cloudBuild).toContain(
			"Maintenance requires a pre-existing PAUSED cleanup scheduler.",
		);
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
		expect(cloudBuild).not.toContain("NOVA_DB_WORKLOAD=audit");
		expect(prodDb).toContain('process.env.NOVA_DB_WORKLOAD = "operator"');
		expect(packageJson).toContain(
			'"db:migrate": "NOVA_DB_WORKLOAD=migration tsx --conditions=react-server scripts/migrate.ts"',
		);
		expect(cloudBuild.match(/--tasks=1 --parallelism=1/g)).toHaveLength(6);
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

	test("packages the post-cutover case-type retirement repair as a non-automatic immutable Job", () => {
		expect(dockerfile).toContain(
			"scripts/migrate-case-type-schema-retirement.ts",
		);
		expect(dockerfile).toContain("scripts/migrate-schema-drift.ts");
		expect(dockerfile).toContain("case-type-schema-retirement.cjs");
		expect(dockerfile).toContain("schema-drift.cjs");
		expect(cloudBuild).toContain(
			"gcloud run jobs deploy commcare-nova-case-type-schema-retirement",
		);
		expect(cloudBuild).toContain("--args=case-type-schema-retirement.cjs");
		expect(cloudBuild).not.toContain(
			"--args=case-type-schema-retirement.cjs,--execute",
		);
		expect(cloudBuild).toContain(
			"NOVA_CASE_TYPE_RETIREMENT_PRODUCTION_JOB=true",
		);
		expect(cloudBuild).not.toContain(
			"gcloud run jobs execute commcare-nova-case-type-schema-retirement",
		);
		expect(
			cloudBuild.indexOf("- id: case-type-schema-retirement-job"),
		).toBeGreaterThan(cloudBuild.indexOf("- id: deploy"));
		expect(deployPolicy).toContain('image_source.add_argument("--service")');
		expect(deployPolicy).toContain(
			"expected_image = _ready_service_image(api.service(), api.revisions())",
		);
		expect(deployPolicy).toContain("JOB_TEMPLATE_CONTRACTS");
		expect(deployPolicy).toContain('execution.get("template")');
		expect(schemaDriftScanner).toContain('.setAccessMode("read only")');
		expect(schemaDriftScanner).toContain(
			"loadPersistedBlueprintReadOnly(tx, app.id)",
		);
		expect(schemaDriftScanner).toContain(
			"--job=commcare-nova-case-type-schema-retirement",
		);
		expect(schemaDriftScanner).toContain("scripts/scan-schema-drift.ts --prod");
		expect(schemaDriftScanner).toContain("scopeArgs");
	});
});
