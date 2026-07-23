import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const cloudBuild = readFileSync("cloudbuild.yaml", "utf8");
const dockerfile = readFileSync("Dockerfile", "utf8");
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
		expect(stepOffset("push")).toBeLessThan(stepOffset("migrate"));
		expect(stepOffset("migrate")).toBeLessThan(stepOffset("deploy"));
		expect(stepOffset("deploy")).toBeLessThan(stepOffset("verify"));
		expect(cloudBuild).not.toContain("--no-traffic");
		expect(cloudBuild).not.toContain("nova-rollout");
		expect(cloudBuild).not.toContain("update-traffic");
		expect(dockerfile).not.toContain("rollout.cjs");
		expect(cloudBuild).toContain("https://commcare.app/");
		expect(cloudBuild).toContain("https://docs.commcare.app/");
		expect(cloudBuild).toContain("https://mcp.commcare.app/mcp");
	});

	test("pins one unique image and the runtime platform limits", () => {
		expect(cloudBuild).not.toContain("app:$COMMIT_SHA");
		expect(cloudBuild.match(/app:\$BUILD_ID/g)).toHaveLength(4);
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
		expect(provisioning).not.toContain("nova-rollout");
		expect(provisioning).toContain("roles/iam.serviceAccountTokenCreator");
		expect(provisioning).toContain('bind_act_as "$MIGRATION_ACCOUNT"');
		expect(provisioning).toContain('bind_act_as "$RUNTIME_ACCOUNT"');
		expect(provisioning).not.toContain('bind_act_as "$BUILD_ACCOUNT"');
		expect(provisioning).not.toContain("nova-openai-api-key");
		expect(provisioning).toContain("gcloud sql users assign-roles");
		expect(provisioning).toContain('--database-roles="$RUNTIME_DB_USER"');
		expect(provisioning).toContain("--revoke-existing-roles");
		expect(cloudSqlProvisioning).toContain('MIGRATION_SA_EMAIL="nova-migrate@');
		expect(cloudSqlProvisioning).toContain('RUNTIME_SA_EMAIL="commcare-nova@');
		expect(cloudSqlProvisioning).not.toContain("compute@developer");
	});
});
