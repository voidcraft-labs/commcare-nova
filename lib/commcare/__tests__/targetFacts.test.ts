/**
 * `targetFactsFromSource` over a source CommCare HQ really answered: the
 * retained read `proof/hq-reads/case-list-inline/app-source.json`, taken
 * from its HTTP envelope and normalized as a stored baseline is, then edited
 * one key at a time. Each test plants one value of one row of the projection
 * and reads it back, so a key read from the wrong place, a value printed
 * differently from HQ's profile template, or a key kept that a publish drops
 * fails by name.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeHqAppSource } from "@/lib/deployment/hqSourceBaseline";
import { isRuntimeUiStringKey } from "../appStringKeys";
import {
	hqProfileValueText,
	KEPT_PROFILE_PROPERTY_KEYS,
	type TargetFacts,
	targetFactsFromSource,
} from "../targetFacts";

type Json = Record<string, unknown>;

/** The retained read's body, normalized as `normalizeHqAppSource` stores it. */
function retainedSource(): Json {
	const envelope = JSON.parse(
		readFileSync(
			path.join(
				process.cwd(),
				"proof/hq-reads/case-list-inline/app-source.json",
			),
			"utf8",
		),
	) as { body: string };
	const read = normalizeHqAppSource(JSON.parse(envelope.body));
	if ("malformed" in read) throw new Error(read.malformed);
	return read.normalized as Json;
}

const OBSERVED_AT = "2026-11-10T09:00:00.000Z";

function factsOf(
	edit: (source: Json) => void = () => {},
	input: { novaOwnsAutoGpsCapture?: boolean; adopted?: boolean } = {},
): TargetFacts {
	const source = retainedSource();
	edit(source);
	const facts = targetFactsFromSource(source, {
		observedAt: OBSERVED_AT,
		novaOwnsAutoGpsCapture: input.novaOwnsAutoGpsCapture ?? false,
		adopted: input.adopted ?? false,
	});
	if (facts === null) throw new Error("A source that is an object gives facts");
	return facts;
}

function properties(source: Json): Json {
	return (source.profile as { properties: Json }).properties;
}

function translations(source: Json): Record<string, Json> {
	return source.translations as Record<string, Json>;
}

describe("targetFactsFromSource over the retained read", () => {
	it("reads a new app's settings as HQ's build writes them", () => {
		const facts = factsOf();
		expect(facts.observedAt).toBe(OBSERVED_AT);
		/* The new app holds the fifteen seeded settings; the detail-view log
		 * setting it holds no value for is left out. */
		expect(facts.profileProperties).toEqual({
			"cc-fuzzy-search-enabled": "no",
			"cc-gps-auto-capture-accuracy": "10",
			"cc-content-valid": "no",
			"cc-autoup-freq": "freq-never",
			"cc-enable-tts": "no",
			"cc-autosync-freq": "freq-never",
			"cc-days-form-retain": "-1",
			"cc-inflation-target-density": "none",
			"cc-label-required-questions-with-asterisk": "no",
			"cc-login-duration-seconds": "86400",
			"cc-maps-default-layer": "normal",
			"cc-resize-images": "none",
			logenabled: "Enabled",
			"unsent-number-limit": "5",
			"unsent-time-limit": "5",
		});
		expect(facts).toMatchObject({
			uiText: {},
			uiTextKeys: [],
			secureSubmissions: false,
			customBaseUrl: null,
			autoGpsCapture: false,
			androidLogos: [],
			practiceWorker: false,
			persistentMenu: false,
			breadcrumbs: true,
			mobileReportVersion: "2.0",
			credentialLevel: null,
			languageNames: null,
			seeds: "nova",
		});
	});

	it("reads a setting at another choice, a numeric value, and booleans as HQ's template prints them", () => {
		const facts = factsOf((source) => {
			properties(source)["cc-fuzzy-search-enabled"] = "yes";
			/* HQ's own Settings save stores this one as a number. */
			properties(source)["cc-gps-auto-capture-accuracy"] = 10;
			properties(source)["cc-log-entity-detail-enabled"] = true;
			properties(source)["cc-enable-tts"] = false;
			properties(source).logenabled = "";
			properties(source)["cc-show-saved"] = "yes";
		});
		expect(facts.profileProperties["cc-fuzzy-search-enabled"]).toBe("yes");
		expect(facts.profileProperties["cc-gps-auto-capture-accuracy"]).toBe("10");
		expect(facts.profileProperties["cc-log-entity-detail-enabled"]).toBe(
			"True",
		);
		expect(facts.profileProperties).not.toHaveProperty("cc-enable-tts");
		expect(facts.profileProperties).not.toHaveProperty("logenabled");
		/* Nova's own two settings are no kept fact. */
		expect(facts.profileProperties).not.toHaveProperty("cc-show-saved");
	});

	it("keeps the project space's own text, lists the keys a runtime reads, and drops a generated key", () => {
		const facts = factsOf((source) => {
			source.langs = ["en", "hin"];
			translations(source).en = {
				en: "English",
				hin: "Hindi",
				"home.start": "Begin",
				"home.sync": "",
				"android.package.name.org.example": "Example",
				"my.own.note": "A note",
				"forms.m0f0": "Visit",
			};
			translations(source).hin = { "home.start": "शुरू" };
		});
		expect(facts.uiText).toEqual({
			en: {
				"home.start": "Begin",
				"android.package.name.org.example": "Example",
				"my.own.note": "A note",
			},
			hin: { "home.start": "शुरू" },
		});
		/* A blank runtime key is listed; a key no runtime reads is not; a
		 * language's own code and a generated key are no target key. */
		expect(facts.uiTextKeys).toEqual([
			"android.package.name.org.example",
			"home.start",
			"home.sync",
		]);
	});

	it("reads each Android logo slot that holds a path", () => {
		const facts = factsOf((source) => {
			source.logo_refs = {
				hq_logo_android_home: { path: "jr://file/commcare/logo/home.png" },
				hq_logo_android_login: {
					path: "jr://file/commcare/logo/login.png",
					m_id: "abc",
				},
				hq_logo_android_demo: {},
				hq_logo_web_apps: { path: "jr://file/commcare/logo/web.png" },
			};
		});
		expect(facts.androidLogos).toEqual(["home", "login"]);
		const demo = factsOf((source) => {
			source.logo_refs = {
				hq_logo_android_demo: { path: "jr://file/commcare/logo/demo.png" },
			};
		});
		expect(demo.androidLogos).toEqual(["demo"]);
	});

	it("reads location capture as kept only where Nova's body did not set it", () => {
		const capture = (source: Json) => {
			source.auto_gps_capture = true;
		};
		expect(factsOf(capture).autoGpsCapture).toBe(true);
		expect(
			factsOf(capture, { novaOwnsAutoGpsCapture: true }).autoGpsCapture,
		).toBe(false);
	});

	/* Each expectation is what Python's `urljoin(base, "/a/…")` keeps of the
	 * base before `/a/…`, the join `absolute_url_property` makes. */
	it("keeps the scheme and the netloc of a custom base URL as HQ's urljoin does", () => {
		const base = (value: unknown) =>
			factsOf((source) => {
				source.custom_base_url = value;
			}).customBaseUrl;
		expect(base("https://example.org/hq/path")).toBe("https://example.org");
		expect(base("https://example.org/")).toBe("https://example.org");
		expect(base("https://example.org")).toBe("https://example.org");
		expect(base("https://example.org?x=1#f")).toBe("https://example.org");
		expect(base("https://example.org:8443/x")).toBe("https://example.org:8443");
		expect(base("https://relay:s3cret@proxy.example.org/hq/")).toBe(
			"https://relay:s3cret@proxy.example.org",
		);
		expect(base("https://Proxy.Example.org:443/")).toBe(
			"https://Proxy.Example.org:443",
		);
		expect(base("HTTPS://example.org")).toBe("https://example.org");
		expect(base("  https://ex\tample.org/x")).toBe("https://example.org");
		expect(base("https://[::1]:8443/x")).toBe("https://[::1]:8443");
		expect(base("https://[fe80::1%eth0]/")).toBe("https://[fe80::1%eth0]");
		expect(base("https://[v1.x]/")).toBe("https://[v1.x]");
		expect(base("https://ex℀mple/")).toBeNull();
		expect(base("example.org")).toBeNull();
		expect(base("https:example.org")).toBeNull();
		expect(base("https://")).toBeNull();
		expect(base("https://[::1/")).toBeNull();
		expect(base("https://[1.2.3.4]/")).toBeNull();
		expect(base("ftp://example.org/")).toBeNull();
		expect(base("")).toBeNull();
		expect(base(7)).toBeNull();
	});

	it("reads the submission, practice worker, Web Apps and report settings", () => {
		const facts = factsOf((source) => {
			source.secure_submissions = true;
			source.practice_mobile_worker_id = "a1b2c3";
			source.persistent_menu = true;
			source.show_breadcrumbs = false;
			source.mobile_ucr_restore_version = "1.5";
		});
		expect(facts).toMatchObject({
			secureSubmissions: true,
			practiceWorker: true,
			persistentMenu: true,
			breadcrumbs: false,
			mobileReportVersion: "1.5",
		});
		const absent = factsOf((source) => {
			source.practice_mobile_worker_id = "";
			delete source.show_breadcrumbs;
			delete source.mobile_ucr_restore_version;
		});
		expect(absent).toMatchObject({
			practiceWorker: false,
			breadcrumbs: true,
			mobileReportVersion: "2.0",
		});
	});

	it("reads the worker activity credential's level", () => {
		const facts = factsOf((source) => {
			(source.profile as Json).features = { credentials: "3MON_ACTIVE" };
		});
		expect(facts.credentialLevel).toBe("3MON_ACTIVE");
	});

	it("carries language names and leaves seeding to CommCare HQ only on an app Nova brought in", () => {
		const named = (source: Json) => {
			source.langs = ["en", "fra"];
			translations(source).en = { en: "English", fra: "" };
			translations(source).fra = { en: "Anglais", fra: "Français" };
		};
		const created = factsOf(named);
		expect(created.languageNames).toBeNull();
		expect(created.seeds).toBe("nova");
		const adopted = factsOf(named, { adopted: true });
		expect(adopted.languageNames).toEqual({
			en: { en: "English" },
			fra: { en: "Anglais", fra: "Français" },
		});
		expect(adopted.seeds).toBe("target");
	});

	it("gives null for a source that is no object", () => {
		for (const source of [null, "app", 3, ["app"]]) {
			expect(
				targetFactsFromSource(source, {
					observedAt: OBSERVED_AT,
					novaOwnsAutoGpsCapture: false,
					adopted: false,
				}),
			).toBeNull();
		}
	});
});

describe("hqProfileValueText", () => {
	it("prints what HQ's profile template prints, and nothing for a value HQ drops", () => {
		expect(hqProfileValueText("yes")).toBe("yes");
		expect(hqProfileValueText(true)).toBe("True");
		expect(hqProfileValueText(10)).toBe("10");
		expect(hqProfileValueText(-1)).toBe("-1");
		expect(hqProfileValueText(2.5)).toBe("2.5");
		for (const dropped of [null, undefined, "", false, 0, [], {}]) {
			expect(hqProfileValueText(dropped)).toBeNull();
		}
	});

	it("holds sixteen kept keys, the detail-view log last", () => {
		expect(KEPT_PROFILE_PROPERTY_KEYS).toHaveLength(16);
		expect(KEPT_PROFILE_PROPERTY_KEYS.at(-1)).toBe(
			"cc-log-entity-detail-enabled",
		);
	});
});

describe("isRuntimeUiStringKey", () => {
	it("holds for a key a runtime reads and for a key under a prefix a runtime reads", () => {
		expect(isRuntimeUiStringKey("home.start")).toBe(true);
		expect(isRuntimeUiStringKey("android.package.name.org.example")).toBe(true);
	});

	it("does not hold for a key of HQ's catalog no runtime reads, or a key the surface does not know", () => {
		expect(isRuntimeUiStringKey("Back")).toBe(false);
		expect(isRuntimeUiStringKey("my.own.note")).toBe(false);
		/* The prefix item names its dot; the bare prefix is no key under it. */
		expect(isRuntimeUiStringKey("android.package.name")).toBe(false);
	});
});
