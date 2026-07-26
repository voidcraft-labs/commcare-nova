import { describe, expect, it } from "vitest";
import {
	assertCaptureBucketPolicy,
	convergeCaptureBucketPolicy,
	parseStorageIamPolicy,
} from "../capture-bucket-policy.mjs";
// This plain ESM module is also executed directly by the provisioning shell,
// so the tested expression is the exact value sent to GCP.
import {
	captureCleanupIamCondition,
	captureCleanupObjectKeyAllowed,
} from "../capture-storage-policy.mjs";

const policyArgs = {
	bucket: "nova-multimedia-prod",
	cleanupAccount: "nova-capture-cleanup@commcare-nova.iam.gserviceaccount.com",
	mediaPolicyAccount: "nova-media-policy@commcare-nova.iam.gserviceaccount.com",
	captureRole: "projects/commcare-nova/roles/novaCaptureObjectMaintenance",
	mediaPolicyRole: "projects/commcare-nova/roles/novaMediaBucketPolicy",
};

describe("capture cleanup storage IAM policy", () => {
	it.each([
		"captures-staged/project-a/attachment.png",
		"captures-staged/_health/probe-id.probe",
		"projects/project-a/captures/attachment.png",
		"projects/project-b/captures/attachment.wav",
	])("admits capture object key %s", (key) => {
		expect(captureCleanupObjectKeyAllowed(key)).toBe(true);
	});

	it.each([
		"pending/project-a/media-id.png",
		"projects/project-a/content-hash.png",
		"projects/project-a/content-hash.requirements.md",
		"projects/project-a/captures-not/attachment.png",
		"projects/project-a/captures/",
		"projects/project-a/nested/captures/attachment.png",
		"projects//captures/attachment.png",
		"captures/project-a/attachment.png",
	])("rejects authoring, pending, or malformed object key %s", (key) => {
		expect(captureCleanupObjectKeyAllowed(key)).toBe(false);
	});

	it("uses only supported IAM string functions and a Storage Object type guard", () => {
		const condition = captureCleanupIamCondition("nova-multimedia-prod");
		expect(condition).toBe(
			"resource.type == 'storage.googleapis.com/Object' && " +
				"( resource.name.startsWith('projects/_/buckets/nova-multimedia-prod/objects/captures-staged/') || " +
				"( resource.name.startsWith('projects/_/buckets/nova-multimedia-prod/objects/projects/') && " +
				"resource.name.extract('projects/_/buckets/nova-multimedia-prod/objects/projects/{project}/captures/') != '' && " +
				"resource.name.extract('projects/_/buckets/nova-multimedia-prod/objects/projects/{project}/captures/') == resource.name.extract('projects/_/buckets/nova-multimedia-prod/objects/projects/{project}/') && " +
				"resource.name != 'projects/_/buckets/nova-multimedia-prod/objects/projects/' + resource.name.extract('projects/_/buckets/nova-multimedia-prod/objects/projects/{project}/') + '/captures/' ) )",
		);
		expect(condition).toContain("resource.name.startsWith");
		expect(condition).toContain("resource.name.extract");
		expect(condition).toContain(
			"resource.name != 'projects/_/buckets/nova-multimedia-prod/objects/projects/' + resource.name.extract('projects/_/buckets/nova-multimedia-prod/objects/projects/{project}/') + '/captures/'",
		);
		expect(condition).not.toMatch(/matches|regex|pending\//i);
	});

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
