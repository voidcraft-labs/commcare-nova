import { isTag } from "domhandler";
import { textContent } from "domutils";
import { XMLValidator } from "fast-xml-parser";
import { parseDocument } from "htmlparser2";
import { COMMCARE_SERVERS, type CommCareServer } from "./servers";

/** HQ profile.xml always carries a remote resource named suite; local is optional. */
export function profileReferencesBuildSuite(
	xml: string,
	target: { server: CommCareServer; domain: string; buildId: string },
): boolean {
	if (XMLValidator.validate(xml) !== true) return false;
	const roots = parseDocument(xml, {
		xmlMode: true,
		decodeEntities: true,
	}).children.filter(isTag);
	if (roots.length !== 1 || roots[0].name !== "profile") return false;
	const resources = roots[0].children
		.filter(isTag)
		.filter((e) => e.name === "suite")
		.flatMap((e) => e.children.filter(isTag))
		.filter((e) => e.name === "resource" && e.attribs.id === "suite");
	if (resources.length !== 1) return false;
	const remotes = resources[0].children
		.filter(isTag)
		.filter((e) => e.name === "location" && e.attribs.authority === "remote");
	if (remotes.length !== 1) return false;
	const expected = `${COMMCARE_SERVERS[target.server].baseUrl}/a/${encodeURIComponent(target.domain)}/apps/download/${encodeURIComponent(target.buildId)}/suite.xml`;
	// No resource fetch follows this untrusted location. It must name our fixed read.
	return textContent(remotes[0]).trim() === expected;
}
