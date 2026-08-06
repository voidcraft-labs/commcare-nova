/**
 * The setup artifact.
 *
 * Three properties are the reason it exists, and each is asserted here:
 * it is target-aware (real URLs on the real project space), it never
 * claims Nova installed a prerequisite, and it says nothing about content
 * the app does not have.
 */

import { describe, expect, it } from "vitest";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import { proseText } from "@/lib/domain/prose";
import { resolvePreviewDeploymentTarget } from "../previewTarget";
import { buildSetupArtifact, renderSetupArtifact } from "../setupArtifact";
import type { DeploymentRecord } from "../types";

function baseDoc() {
	const { fieldParent: _fieldParent, ...doc } = buildDoc({
		appName: "Vaccine Tracker",
		caseTypes: [
			{
				name: "patient",
				properties: [{ name: "case_name", label: proseText("Name") }],
			},
		],
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				forms: [
					{
						name: "Reg",
						type: "registration",
						fields: [
							{
								kind: "text",
								id: "case_name",
								label: proseText("Name"),
								caseWrite: { caseType: "patient", property: "case_name" },
							},
						],
					},
				],
			},
		],
	});
	return doc as never;
}

function artifact(overrides: Record<string, unknown> = {}) {
	return buildSetupArtifact({
		doc: baseDoc(),
		server: "production",
		domain: "rhi-bihar",
		hqAppId: "hq-abc",
		locations: [],
		...overrides,
	});
}

describe("target awareness", () => {
	it("names the real project space in every URL", () => {
		const result = artifact();
		for (const section of result.sections) {
			if (section.url === null) continue;
			expect(section.url).toContain("/a/rhi-bihar/");
		}
	});

	it("points at the server the deployment is actually on", () => {
		const india = artifact({ server: "india" });
		const release = india.sections.find((s) => s.id === "build-and-release");
		expect(release?.url).toContain("https://india.commcarehq.org/");
	});

	it("links the app's own releases screen once there is an app id", () => {
		expect(
			artifact().sections.find((s) => s.id === "build-and-release")?.url,
		).toBe("https://www.commcarehq.org/a/rhi-bihar/apps/view/hq-abc/releases/");
		expect(
			artifact({ hqAppId: null }).sections.find(
				(s) => s.id === "build-and-release",
			)?.url,
		).toBeNull();
	});
});

describe("only what the app actually has", () => {
	it("omits worker information when the app declares none", () => {
		expect(artifact().sections.some((s) => s.id === "worker-data")).toBe(false);
	});

	it("omits organization when the app has no levels", () => {
		expect(artifact().sections.some((s) => s.id === "organization")).toBe(
			false,
		);
	});

	it("always carries the two that are true of every published app", () => {
		const ids = artifact().sections.map((s) => s.id);
		expect(ids).toContain("build-and-release");
		expect(ids).toContain("web-apps");
	});
});

describe("never claims a prerequisite was installed", () => {
	it("says who has to make the version and release it", () => {
		const release = artifact().sections.find(
			(s) => s.id === "build-and-release",
		);
		expect(release?.caveats.join(" ")).toMatch(/signed-in person/i);
		expect(release?.caveats.join(" ")).toMatch(/not an API key/i);
	});

	it("warns that Web Apps availability is decided at import, not later", () => {
		const webApps = artifact().sections.find((s) => s.id === "web-apps");
		expect(webApps?.caveats.join(" ")).toMatch(/when the app is created/i);
		expect(webApps?.caveats.join(" ")).toMatch(/publish again/i);
	});
});

describe("rendering", () => {
	it("produces plain text carrying the project space and its steps", () => {
		const text = renderSetupArtifact(artifact());
		expect(text).toContain("rhi-bihar");
		expect(text).toContain("Make a version and release it");
	});
});

describe("preview target resolution", () => {
	function deployment(state: string, domain: string) {
		return { state, domain } as Pick<DeploymentRecord, "state" | "domain">;
	}

	it("names a project space once one deployment reached uploaded", () => {
		expect(
			resolvePreviewDeploymentTarget([deployment("uploaded", "acme")]),
		).toEqual({ kind: "known", domain: "acme" });
	});

	it("says nothing while the app is on no project space", () => {
		expect(
			resolvePreviewDeploymentTarget([deployment("preflight", "acme")]),
		).toEqual({ kind: "none" });
	});

	it("never counts a refused deployment", () => {
		expect(
			resolvePreviewDeploymentTarget([deployment("incomplete", "acme")]),
		).toEqual({ kind: "none" });
	});

	it("refuses to choose between two real answers", () => {
		expect(
			resolvePreviewDeploymentTarget([
				deployment("runnable", "acme"),
				deployment("uploaded", "beta"),
			]).kind,
		).toBe("ambiguous");
	});
});
