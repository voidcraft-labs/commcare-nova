import { isTag } from "domhandler";
import { textContent } from "domutils";
import { nativeInstallationKey } from "./hq/installationKey";
import { COMMCARE_SERVERS, type CommCareServer } from "./servers";
import { tryParseXml } from "./xmlParse";

/** HQ profile.xml always carries a remote resource named suite; local is optional. */
export function profileReferencesBuildSuite(
	xml: string,
	target: {
		server: CommCareServer;
		domain: string;
		buildId: string;
		profileKey?: string;
	},
): boolean {
	if (
		target.profileKey !== undefined &&
		!nativeInstallationKey(target.profileKey)
	)
		return false;
	const parsed = tryParseXml(xml);
	if ("issue" in parsed) return false;
	const roots = parsed.doc.children.filter(isTag);
	if (roots.length !== 1 || roots[0].name !== "profile") return false;
	if ((roots[0].attribs.buildProfileID || undefined) !== target.profileKey)
		return false;
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
	return (
		textContent(remotes[0]).trim() ===
		expected + (target.profileKey ? `?profile=${target.profileKey}` : "")
	);
}

/** HQ's native suite generator reads the target worker by ID and refuses an
 * inactive, deleted, foreign or non-practice account before emitting its restore. */
export function selectedSuiteAgrees(
	xml: string,
	profile: {
		readonly id: string;
		readonly langs: readonly string[];
		readonly practiceWorkerId?: string;
	},
): boolean {
	if (!nativeInstallationKey(profile.id)) return false;
	const parsed = tryParseXml(xml);
	if ("issue" in parsed) return false;
	const roots = parsed.doc.children.filter(isTag);
	if (roots.length !== 1 || roots[0].name !== "suite") return false;
	const children = roots[0].children.filter(isTag);
	const locales = children.filter((element) => element.name === "locale");
	const languages = ["default", ...profile.langs];
	const namesResource = (
		element: (typeof roots)[number],
		expectedRemote: string,
		options?: { id: string; versionRequired: boolean },
	) => {
		const resources = element.children
			.filter(isTag)
			.filter((child) => child.name === "resource");
		if (resources.length !== 1) return false;
		const resource = resources[0];
		if (
			options &&
			(resource.attribs.id !== options.id ||
				(options.versionRequired && !resource.attribs.version))
		)
			return false;
		const remotes = resource.children
			.filter(isTag)
			.filter(
				(child) =>
					child.name === "location" && child.attribs.authority === "remote",
			);
		return (
			remotes.length === 1 && textContent(remotes[0]).trim() === expectedRemote
		);
	};
	if (
		locales.length !== languages.length ||
		!locales.every(
			(element, index) =>
				element.attribs.language === languages[index] &&
				namesResource(
					element,
					`./${languages[index]}/app_strings.txt?profile=${profile.id}`,
				),
		)
	)
		return false;
	const restores = children.filter(
		(element) => element.name === "user-restore",
	);
	return profile.practiceWorkerId
		? restores.length === 1 &&
				namesResource(
					restores[0],
					`./practice_user_restore.xml?profile=${profile.id}`,
					{ id: "practice-user-restore", versionRequired: true },
				)
		: restores.length === 0;
}

/** HQ's FormResourceContributor emits one of these two resources for each
 * enabled form; shadow forms and disabled release notes contribute neither. */
export function installationFormFiles(xml: string, moduleFormCounts: readonly number[]): ReadonlySet<string> | null {
	const parsed = tryParseXml(xml);
	if ("issue" in parsed) return null;
	const roots=parsed.doc.children.filter(isTag);
	if (roots.length!==1 || roots[0].name !== "suite") return null;
	const paths=new Set<string>();
	for (const node of roots[0].children.filter(isTag)) {
		if(node.name!=="xform" && node.name!=="xform-update-info") continue;
		const resources=node.children.filter(isTag).filter(child=>child.name==="resource");
		if(resources.length!==1) return null;
		const locations=resources[0].children.filter(isTag).filter(child=>child.name==="location");
		const local=locations.filter(child=>child.attribs.authority==="local");
		const remote=locations.filter(child=>child.attribs.authority==="remote");
		if(local.length!==1 || remote.length!==1) return null;
		const name=textContent(local[0]).trim();
		const match=/^\.\/(modules-(0|[1-9][0-9]*)\/forms-(0|[1-9][0-9]*)\.xml)$/.exec(name);
		if (!match || textContent(remote[0]).trim()!==name || paths.has(match[1])) return null;
		const count=moduleFormCounts[Number(match[2])];
		if(count===undefined || Number(match[3])>=count) return null;
		paths.add(match[1]);
	}
	return paths;
}
