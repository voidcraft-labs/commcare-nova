import { describe, expect, it } from "vitest";
// This plain ESM module is also executed directly by the provisioning shell,
// so the tested expression is the exact value sent to GCP.
import {
	captureCleanupIamCondition,
	captureCleanupObjectKeyAllowed,
} from "../capture-storage-policy.mjs";

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
				"resource.name.extract('projects/_/buckets/nova-multimedia-prod/objects/projects/{project}/captures/') != '' ) )",
		);
		expect(condition).toContain("resource.name.startsWith");
		expect(condition).toContain("resource.name.extract");
		expect(condition).not.toMatch(/matches|regex|pending\//i);
	});
});
