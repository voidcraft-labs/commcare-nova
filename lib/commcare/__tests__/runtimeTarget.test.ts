/** Pure: the two URL shapes, the profile's server properties and its uniqueid. */
import { describe, expect, expectTypeOf, it } from "vitest";
import {
	profileServerProperties,
	profileUniqueId,
	type RuntimeTarget,
	runtimeUrls,
} from "../runtimeTarget";
import { COMMCARE_SERVER_IDS, COMMCARE_SERVERS } from "../servers";

describe("runtime target", () => {
	it("takes a whole deployment or none", () => {
		expectTypeOf<{ server: "production" }>().not.toExtend<RuntimeTarget>();
		expectTypeOf<{
			server: "production";
			domain: string;
		}>().not.toExtend<RuntimeTarget>();
		expectTypeOf<{
			server: "production";
			appId: string;
		}>().not.toExtend<RuntimeTarget>();
		expectTypeOf<Parameters<typeof runtimeUrls>>().toEqualTypeOf<
			[target?: RuntimeTarget]
		>();
	});

	it("writes the neutral template with no target and real URLs with one", () => {
		expect(runtimeUrls()).toEqual({
			claim: "https://__COMMCARE_HOST__/a/__DOMAIN__/phone/claim-case/",
			search: "https://__COMMCARE_HOST__/a/__DOMAIN__/phone/search/__APP_ID__/",
			caseFixture:
				"https://__COMMCARE_HOST__/a/__DOMAIN__/phone/case_fixture/__APP_ID__/",
		});
		expect(
			runtimeUrls({ server: "india", domain: "field ops", appId: "a/b" }),
		).toEqual({
			claim: "https://india.commcarehq.org/a/field%20ops/phone/claim-case/",
			search: "https://india.commcarehq.org/a/field%20ops/phone/search/a%2Fb/",
			caseFixture:
				"https://india.commcarehq.org/a/field%20ops/phone/case_fixture/a%2Fb/",
		});
	});

	it.each(COMMCARE_SERVER_IDS)(
		"gives the four server properties in profile order on %s",
		(server) => {
			const base = COMMCARE_SERVERS[server].baseUrl;
			expect(
				profileServerProperties({
					server,
					domain: "field-ops",
					appId: "0123456789abcdef0123456789abcdef",
				}),
			).toEqual([
				{
					key: "ota-restore-url",
					value: `${base}/a/field-ops/phone/restore/0123456789abcdef0123456789abcdef/`,
				},
				{
					key: "PostURL",
					value: `${base}/a/field-ops/receiver/0123456789abcdef0123456789abcdef/`,
				},
				{ key: "key_server", value: `${base}/a/field-ops/phone/keys/` },
				{ key: "cc_user_domain", value: "field-ops.commcarehq.org" },
			]);
		},
	);

	it("encodes the domain and app id in its URLs as the suite's URLs do", () => {
		const target = { server: "eu", domain: "Field Ops", appId: "a/b" } as const;
		const properties = Object.fromEntries(
			profileServerProperties(target).map(({ key, value }) => [key, value]),
		);
		expect(runtimeUrls(target).search).toBe(
			"https://eu.commcarehq.org/a/Field%20Ops/phone/search/a%2Fb/",
		);
		expect(properties["ota-restore-url"]).toBe(
			"https://eu.commcarehq.org/a/Field%20Ops/phone/restore/a%2Fb/",
		);
		expect(properties.PostURL).toBe(
			"https://eu.commcarehq.org/a/Field%20Ops/receiver/a%2Fb/",
		);
		expect(properties.key_server).toBe(
			"https://eu.commcarehq.org/a/Field%20Ops/phone/keys/",
		);
		/* The account domain is a name, not a URL: HQ joins and lower-cases it. */
		expect(properties.cc_user_domain).toBe("field ops.commcarehq.org");
	});
});

describe("profileUniqueId", () => {
	const target: RuntimeTarget = {
		server: "production",
		domain: "field-ops",
		appId: "hq-app-1",
	};

	it("is one literal value for one app, server and domain", () => {
		// A change of the namespace or of the name's shape changes every
		// archive's identity on a phone, so it fails here.
		expect(profileUniqueId("app-1", target)).toBe(
			"907e064a-4242-5e3e-80b2-e7526998eec6",
		);
	});

	it("differs by app, server and domain, and not by the HQ app the target names", () => {
		const id = profileUniqueId("app-1", target);
		expect(profileUniqueId("app-2", target)).not.toBe(id);
		expect(profileUniqueId("app-1", { ...target, server: "india" })).not.toBe(
			id,
		);
		expect(profileUniqueId("app-1", { ...target, domain: "other" })).not.toBe(
			id,
		);
		expect(profileUniqueId("app-1", { ...target, appId: "hq-app-2" })).toBe(id);
		expect(["app-1", target.appId]).not.toContain(id);
	});
});
