import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const cloudBuild = readFileSync("cloudbuild.yaml", "utf8");
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
		expect(cloudBuild).toContain("https://commcare.app/");
		expect(cloudBuild).toContain("https://docs.commcare.app/");
		expect(cloudBuild).toContain("https://mcp.commcare.app/mcp");
	});

	test("pins one unique image and the runtime platform limits", () => {
		expect(cloudBuild).not.toContain("app:$COMMIT_SHA");
		expect(cloudBuild.match(/app:\$BUILD_ID/g)).toHaveLength(6);
		expect(cloudBuild).toContain('--build-arg NOVA_BUILD_ID="$$NOVA_BUILD_ID"');
		expect(cloudBuild).toContain(
			'--timeout="$${NOVA_CLOUD_RUN_REQUEST_SECONDS}s"',
		);
		expect(cloudBuild).toContain(
			"--no-default-url --ingress=internal-and-cloud-load-balancing",
		);
		expect(cloudBuild).toContain("--min-instances=1 --max-instances=5");
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
			'gcloud run jobs execute "$${cleanup_job}" --region=us-central1 --wait',
		);
		expect(cloudBuild).toContain('--schedule="*/5 * * * *"');
		expect(cloudBuild).toContain(
			'--oauth-service-account-email="$${scheduler_account}"',
		);
		expect(cloudBuild).toContain("NOVA_MEDIA_BUCKET=nova-multimedia-prod");
		expect(cloudBuild).toContain(
			"NOVA_UPLOAD_CORS_ORIGINS=https://commcare.app",
		);
		expect(provisioning).toContain("roles/cloudscheduler.admin");
		expect(provisioning).toContain("roles/storage.admin");
		expect(provisioning).toContain("roles/storage.objectUser");
	});
});
