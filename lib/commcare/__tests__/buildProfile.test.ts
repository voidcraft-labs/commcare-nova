import { describe, expect, it } from "vitest";
import { profileReferencesBuildSuite } from "../buildProfile";

const target = {
	server: "india" as const,
	domain: "demo",
	buildId: "released",
};
const profile = (url: string) =>
	`<profile><suite><resource id="suite" version="5"><location authority="remote">${url}</location></resource></suite></profile>`;
const url =
	"https://india.commcarehq.org/a/demo/apps/download/released/suite.xml";
describe("released profile suite identity", () => {
	it("accepts the exact selected-server build resource with optional local location absent", () => {
		expect(profileReferencesBuildSuite(profile(url), target)).toBe(true);
	});
	it("accepts HQ's separate media suite and local fallback without confusing them with the main remote suite", () => {
		const xml = `<profile><suite><resource id="media-suite"><location authority="remote">https://india.commcarehq.org/a/demo/apps/download/released/media_suite.xml</location></resource></suite><suite><resource id="suite"><location authority="local">./suite.xml</location><location authority="remote">${url}</location></resource></suite></profile>`;
		expect(profileReferencesBuildSuite(xml, target)).toBe(true);
	});
	it("refuses ambiguous main-suite resources and remote locations", () => {
		const resource = `<resource id="suite"><location authority="remote">${url}</location></resource>`;
		expect(
			profileReferencesBuildSuite(
				`<profile><suite>${resource}${resource}</suite></profile>`,
				target,
			),
		).toBe(false);
		expect(
			profileReferencesBuildSuite(
				`<profile><suite><resource id="suite"><location authority="remote">${url}</location><location authority="remote">${url}</location></resource></suite></profile>`,
				target,
			),
		).toBe(false);
	});
	it.each([
		url.replace("india.", "www."),
		url.replace("/released/", "/working/"),
		`${url}?latest=true`,
		url.replace("/demo/", "/other/"),
	])("refuses another resource %s", (other) => {
		expect(profileReferencesBuildSuite(profile(other), target)).toBe(false);
	});
	it.each(["<profile/>", "<html/>", "<profile>", "<profile/><profile/>"])(
		"refuses incomplete or unrelated profiles %s",
		(xml) => {
			expect(profileReferencesBuildSuite(xml, target)).toBe(false);
		},
	);
});
