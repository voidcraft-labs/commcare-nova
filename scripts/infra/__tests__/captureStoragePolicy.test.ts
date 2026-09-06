import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
	assertCaptureBucketPolicy,
	convergeCaptureBucketPolicy,
	parseStorageIamPolicy,
} from "../capture-bucket-policy.mjs";

const policyArgs = {
	bucket: "nova-multimedia-prod",
	cleanupAccount: "nova-capture-cleanup@commcare-nova.iam.gserviceaccount.com",
	mediaPolicyAccount: "nova-media-policy@commcare-nova.iam.gserviceaccount.com",
	captureRole: "projects/commcare-nova/roles/novaCaptureObjectMaintenance",
	mediaPolicyRole: "projects/commcare-nova/roles/novaMediaBucketPolicy",
};

describe("capture cleanup storage IAM policy", () => {
	it("atomically removes stale conditions and broad grants before adding one exact binding", () => {
		const cleanupMember = `serviceAccount:${policyArgs.cleanupAccount}`;
		const mediaMember = `serviceAccount:${policyArgs.mediaPolicyAccount}`;
		const otherMember =
			"serviceAccount:unrelated@example.iam.gserviceaccount.com";
		const converged = convergeCaptureBucketPolicy(
			{
				version: 3,
				etag: "BwY=",
				bindings: [
					{
						role: policyArgs.captureRole,
						members: [cleanupMember],
						condition: {
							title: "old-v1",
							expression: "resource.name.startsWith('wrong')",
						},
					},
					{
						role: policyArgs.captureRole,
						members: [cleanupMember, otherMember],
						condition: {
							title: "old-v2",
							expression: "resource.name.startsWith('also-wrong')",
						},
					},
					{
						role: "roles/storage.objectUser",
						members: [cleanupMember, otherMember],
						condition: { title: "stale", expression: "true" },
					},
					{
						role: "roles/storage.admin",
						members: [mediaMember],
					},
					{
						role: "roles/storage.legacyBucketOwner",
						members: [mediaMember, otherMember],
					},
					{
						role: "roles/storage.objectViewer",
						members: [cleanupMember, otherMember],
					},
					{
						role: "roles/storage.objectViewer",
						members: [otherMember],
					},
				],
			},
			policyArgs,
		);

		expect(converged.etag).toBe("BwY=");
		expect(() =>
			assertCaptureBucketPolicy(converged, policyArgs),
		).not.toThrow();
		expect(
			converged.bindings.filter(
				(binding: { role?: string; members?: string[] }) =>
					binding.role === policyArgs.captureRole &&
					binding.members?.includes(cleanupMember),
			),
		).toHaveLength(1);
		expect(converged.bindings).toContainEqual({
			role: policyArgs.captureRole,
			members: [otherMember],
			condition: {
				title: "old-v2",
				expression: "resource.name.startsWith('also-wrong')",
			},
		});
		expect(converged.bindings).toContainEqual({
			role: "roles/storage.objectUser",
			members: [otherMember],
			condition: { title: "stale", expression: "true" },
		});
		expect(converged.bindings).toContainEqual({
			role: "roles/storage.objectViewer",
			members: [otherMember],
		});
		expect(converged.bindings).toContainEqual({
			role: "roles/storage.legacyBucketOwner",
			members: [otherMember],
		});
		expect(converged.bindings).toContainEqual({
			role: policyArgs.mediaPolicyRole,
			members: [mediaMember],
		});
		expect(() =>
			assertCaptureBucketPolicy(
				{
					...converged,
					bindings: [
						...converged.bindings,
						{
							role: "roles/storage.objectViewer",
							members: [cleanupMember],
						},
					],
				},
				policyArgs,
			),
		).toThrow("outside its sole intended");
		expect(() =>
			assertCaptureBucketPolicy(
				{
					...converged,
					bindings: [
						...converged.bindings,
						{
							role: "roles/storage.legacyBucketReader",
							members: [mediaMember],
						},
					],
				},
				policyArgs,
			),
		).toThrow("does not have exactly");
	});

	it("handles absent historical grants and makes malformed reads fatal", () => {
		const converged = convergeCaptureBucketPolicy(
			parseStorageIamPolicy(
				JSON.stringify({ version: 1, etag: "BwZ=", bindings: [] }),
			),
			policyArgs,
		);
		expect(() =>
			assertCaptureBucketPolicy(converged, policyArgs),
		).not.toThrow();
		expect(() => parseStorageIamPolicy("{not-json")).toThrow(
			"was not valid JSON",
		);
		expect(() =>
			parseStorageIamPolicy(JSON.stringify({ version: 3, bindings: [] })),
		).toThrow("missing its etag");
		expect(() =>
			convergeCaptureBucketPolicy(
				{
					version: 3,
					etag: "BwX=",
					bindings: [{ role: policyArgs.captureRole, members: "wrong" }],
				},
				policyArgs,
			),
		).toThrow("malformed binding");
	});
});

it("convergence preserves the input and is idempotent over the complete policy", () => {
	const input = {
		version: 1,
		etag: "original-etag",
		auditConfigs: [{ service: "storage.googleapis.com" }],
		bindings: [
			{
				role: "roles/storage.objectViewer",
				members: ["user:other@example.com"],
			},
		],
	};
	const before = structuredClone(input);
	const output = convergeCaptureBucketPolicy(input, policyArgs);
	expect(input).toEqual(before);
	expect(output.version).toBe(3);
	expect(output.etag).toBe("original-etag");
	expect(output.auditConfigs).toEqual(input.auditConfigs);
	expect(output.bindings).toHaveLength(3);
	expect(output.bindings).toContainEqual(input.bindings[0]);
	expect(convergeCaptureBucketPolicy(output, policyArgs)).toEqual(output);
});

it("the real CLI emits a fenced policy and refuses a broadened condition on verification", () => {
	const directory = mkdtempSync(join(tmpdir(), "nova-capture-policy-"));
	try {
		const input = join(directory, "input.json");
		const output = join(directory, "output.json");
		writeFileSync(
			input,
			JSON.stringify({ version: 1, etag: "generation-7", bindings: [] }),
		);
		const args = [
			resolve("scripts/infra/capture-bucket-policy.mjs"),
			"render",
			policyArgs.bucket,
			policyArgs.cleanupAccount,
			policyArgs.mediaPolicyAccount,
			policyArgs.captureRole,
			policyArgs.mediaPolicyRole,
			input,
			output,
		];
		execFileSync(process.execPath, args, {
			cwd: directory,
			encoding: "utf8",
			timeout: 5000,
		});
		const policy = parseStorageIamPolicy(readFileSync(output, "utf8"));
		expect(policy).toMatchObject({ version: 3, etag: "generation-7" });
		expect(policy.bindings).toHaveLength(2);
		expect(policy.bindings).toContainEqual({
			role: policyArgs.mediaPolicyRole,
			members: [`serviceAccount:${policyArgs.mediaPolicyAccount}`],
		});
		const capture = policy.bindings.find(
			(binding: { role: string }) => binding.role === policyArgs.captureRole,
		);
		expect(capture.members).toEqual([
			`serviceAccount:${policyArgs.cleanupAccount}`,
		]);
		const verify = [args[0], "verify", ...args.slice(2, 7), output];
		execFileSync(process.execPath, verify, {
			cwd: directory,
			encoding: "utf8",
			timeout: 5000,
		});
		capture.condition.expression = "true";
		writeFileSync(output, JSON.stringify(policy));
		const refused = spawnSync(process.execPath, verify, {
			cwd: directory,
			encoding: "utf8",
			timeout: 5000,
		});
		expect(refused.status).toBe(1);
		expect(refused.stderr).toContain("condition does not match policy");
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
