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
