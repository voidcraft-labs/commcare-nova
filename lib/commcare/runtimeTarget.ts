import { COMMCARE_SERVERS, type CommCareServer } from "./servers";

/**
 * The one HQ deployment an archive is made for: its server, its project
 * space, and the HQ working app the deployment maps to. Every member is
 * required, so an archive names a whole deployment or is not compiled.
 */
export interface RuntimeTarget {
	readonly server: CommCareServer;
	readonly domain: string;
	readonly appId: string;
}

/**
 * The runtime request URLs a suite names.
 *
 * With a target, the deployment's own addresses. With none, the neutral
 * template: structural validation and the HQ JSON path, whose import body
 * holds no runtime URL because HQ writes its own when it builds the app.
 */
export function runtimeUrls(target?: RuntimeTarget) {
	const { base, domain, appId } = target
		? {
				base: COMMCARE_SERVERS[target.server].baseUrl,
				domain: encodeURIComponent(target.domain),
				appId: encodeURIComponent(target.appId),
			}
		: {
				base: "https://__COMMCARE_HOST__",
				domain: "__DOMAIN__",
				appId: "__APP_ID__",
			};
	return {
		claim: `${base}/a/${domain}/phone/claim-case/`,
		search: `${base}/a/${domain}/phone/search/${appId}/`,
		caseFixture: `${base}/a/${domain}/phone/case_fixture/${appId}/`,
	};
}

/** One `<property>` of the profile that names where a worker's app talks to. */
export interface ProfileServerProperty {
	readonly key: "ota-restore-url" | "PostURL" | "key_server" | "cc_user_domain";
	readonly value: string;
}

/**
 * The four server properties a `.ccz`'s profile writes, in profile order:
 * where the worker syncs, where forms are sent, where the key server is, and
 * the domain Android appends to a worker's name when it signs in.
 *
 * They are the strings HQ's own profile holds for the same app
 * (`templates/app_manager/profile.xml`, `ApplicationBase.ota_restore_url`,
 * `::post_url`, `::key_server_url`, `corehq/apps/users/util.py::cc_user_domain`),
 * with the receiver URL in its plain form because every app Nova imports has
 * `secure_submissions` off. `cc_user_domain` joins the domain to HQ's
 * `HQ_ACCOUNT_ROOT`, which is `commcarehq.org` on every server Nova publishes
 * to, and lower-cases the whole, as HQ's own does.
 */
export function profileServerProperties(
	target: RuntimeTarget,
): readonly ProfileServerProperty[] {
	const base = COMMCARE_SERVERS[target.server].baseUrl;
	const domain = encodeURIComponent(target.domain);
	const appId = encodeURIComponent(target.appId);
	return [
		{
			key: "ota-restore-url",
			value: `${base}/a/${domain}/phone/restore/${appId}/`,
		},
		{ key: "PostURL", value: `${base}/a/${domain}/receiver/${appId}/` },
		{ key: "key_server", value: `${base}/a/${domain}/phone/keys/` },
		{
			key: "cc_user_domain",
			value: `${target.domain}.commcarehq.org`.toLowerCase(),
		},
	];
}
