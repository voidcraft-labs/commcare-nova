import { COMMCARE_SERVERS, type CommCareServer } from "./servers";

/** The selected HQ deployment. Missing domain/app identity remains portable. */
export interface RuntimeTarget {
	readonly server: CommCareServer;
	readonly domain?: string;
	readonly appId?: string;
}

/** Unbound compiler calls are structural validation, never an implicit US target. */
export function runtimeUrls(target?: RuntimeTarget) {
	const base = target
		? COMMCARE_SERVERS[target.server].baseUrl
		: "https://__COMMCARE_HOST__";
	const domain = target?.domain
		? encodeURIComponent(target.domain)
		: "__DOMAIN__";
	const appId = target?.appId ? encodeURIComponent(target.appId) : "__APP_ID__";
	return {
		claim: `${base}/a/${domain}/phone/claim-case/`,
		search: `${base}/a/${domain}/phone/search/${appId}/`,
		caseFixture: `${base}/a/${domain}/phone/case_fixture/${appId}/`,
	};
}
