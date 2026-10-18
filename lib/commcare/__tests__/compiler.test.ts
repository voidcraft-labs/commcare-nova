import AdmZip from "adm-zip";
import { describe, expect, it } from "vitest";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { appProfileProperties } from "@/lib/commcare/appProfileSettings";
import { compileCcz } from "@/lib/commcare/compiler";
import { expandDoc } from "@/lib/commcare/expander";
import { commCareLocalization } from "@/lib/commcare/localization";
import {
	profileUniqueId,
	type RuntimeTarget,
} from "@/lib/commcare/runtimeTarget";
import { runValidation } from "@/lib/commcare/validator/runner";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { type BlueprintDoc, blueprintDocSchema } from "@/lib/domain";
import {
	and,
	eq,
	literal,
	matchNone,
	sessionUser,
} from "@/lib/domain/predicate";
import {
	compilerNavigationFixture,
	temporalSearchFixture,
	temporalSearchScenarios,
} from "./compilerNavigationFixture";
import { localizationWireFixture } from "./localizationWireFixture";
import { TEST_RUNTIME_TARGET } from "./runtimeTargetFixture";
import { onlyXml, readXmlEvidence, xmlChildren } from "./xmlEvidence";
import { xpathEvidence } from "./xpathEvidence";

function exported(
	doc: BlueprintDoc,
	options: {
		readonly compiledAtSeq?: number;
		readonly earlierHqApps?: number;
		readonly emptyCaseListText?: boolean;
		readonly runtimeTarget?: RuntimeTarget;
	} = {},
) {
	blueprintDocSchema.parse(toPersistableDoc(doc));
	expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
	const hq = expandDoc(doc);
	const zip = new AdmZip(
		compileCcz(hq, doc.appName, doc, {
			runtimeTarget: TEST_RUNTIME_TARGET,
			...options,
		}),
	);
	return { hq, zip, suite: readXmlEvidence(zip.readAsText("suite.xml")) };
}
const model = (xml: string) =>
	onlyXml(
		onlyXml(xmlChildren(readXmlEvidence(xml), "head")).children.filter(
			(node) =>
				node.name === "model" && node.uri === "http://www.w3.org/2002/xforms",
		),
	);

// Resource/media joins run over 900 admissible documents in compilerEvidence.
// Native case operation/capture and tile proofs own those consumer contracts.
// This suite owns archive identity, compiler refusal and navigation integration.
describe("CCZ compiler integration", () => {
	it("packages resolvable profile resources under one identity for the app on its project space", () => {
		const doc = compilerNavigationFixture("base");
		for (const sequence of [undefined, 1, 42]) {
			const { zip } = exported(doc, { compiledAtSeq: sequence });
			expect(
				zip
					.getEntries()
					.map((entry) => entry.entryName)
					.sort(),
			).toEqual([
				"default/app_strings.txt",
				"en/app_strings.txt",
				"media_suite.xml",
				"modules-0/forms-0.xml",
				"modules-0/forms-1.xml",
				"profile.ccpr",
				"suite.xml",
			]);
			const profile = readXmlEvidence(zip.readAsText("profile.ccpr"));
			const version = String(sequence ?? 1);
			expect(profile.uri).toBe("http://cihi.commcarehq.org/jad");
			expect(profile.attributes).toEqual({
				xmlns: "http://cihi.commcarehq.org/jad",
				version,
				uniqueid: profileUniqueId(doc.appId, TEST_RUNTIME_TARGET),
				requiredMajor: "2",
				requiredMinor: "57",
				requiredMinimal: "0",
				name: doc.appName,
				update: "http://localhost/update",
			});
			expect(
				xmlChildren(profile, "property").map((property) => property.attributes),
			).toEqual([
				{ key: "CommCare App Name", value: doc.appName },
				{ key: "cc-content-version", value: version },
				{ key: "cc-app-version", value: version },
				{
					key: "ota-restore-url",
					value:
						"https://www.commcarehq.org/a/nova-test/phone/restore/nova-test-app/",
					force: "true",
				},
				{
					key: "PostURL",
					value:
						"https://www.commcarehq.org/a/nova-test/receiver/nova-test-app/",
					force: "true",
				},
				{
					key: "key_server",
					value: "https://www.commcarehq.org/a/nova-test/phone/keys/",
					force: "true",
				},
				{
					key: "cc_user_domain",
					value: "nova-test.commcarehq.org",
					force: "true",
				},
				{ key: "cur_locale", value: "en", force: "false" },
				...appProfileProperties(doc).map(({ key, value, force }) => ({
					key,
					value,
					...(force && { force: "true" }),
				})),
			]);
			expect(
				onlyXml(xmlChildren(profile, "features")).children.map((feature) => [
					feature.name,
					feature.attributes.active,
				]),
			).toEqual([
				["checkoff", "true"],
				["users", "true"],
			]);
			const resources = xmlChildren(profile, "suite").map((suite) =>
				onlyXml(xmlChildren(suite, "resource")),
			);
			expect(resources.map((resource) => resource.attributes.version)).toEqual([
				version,
				version,
			]);
			const locations = resources.map((resource) =>
				onlyXml(xmlChildren(resource, "location")),
			);
			expect(
				locations.map((location) => [
					location.attributes.authority,
					location.text,
				]),
			).toEqual([
				["local", "./suite.xml"],
				["local", "./media_suite.xml"],
			]);
			for (const location of locations)
				expect(zip.getEntry(location.text.slice(2))).not.toBeNull();
		}
	});

	it("derives one uniqueid per app and project space, whatever HQ app the space holds", () => {
		const doc = compilerNavigationFixture("base");
		const uniqueId = (runtimeTarget: RuntimeTarget) =>
			readXmlEvidence(
				exported(doc, { runtimeTarget }).zip.readAsText("profile.ccpr"),
			).attributes.uniqueid;
		const same = uniqueId(TEST_RUNTIME_TARGET);
		expect(uniqueId(TEST_RUNTIME_TARGET)).toBe(same);
		expect(same).toBe(profileUniqueId(doc.appId, TEST_RUNTIME_TARGET));
		expect(uniqueId({ ...TEST_RUNTIME_TARGET, appId: "remade-hq-app" })).toBe(
			same,
		);
		expect(
			uniqueId({ ...TEST_RUNTIME_TARGET, domain: "other-space" }),
		).not.toBe(same);
		expect(uniqueId({ ...TEST_RUNTIME_TARGET, server: "india" })).not.toBe(
			same,
		);
	});

	it("writes one archive for one document, sequence and target", () => {
		const doc = compilerNavigationFixture("base");
		const bytes = () =>
			new Map(
				exported(doc, { compiledAtSeq: 7 })
					.zip.getEntries()
					.map((entry) => [entry.entryName, entry.getData().toString("utf8")]),
			);
		expect(bytes()).toEqual(bytes());
	});

	it("versions every resource by the sequence, and the profile and suite by the archive's version", () => {
		const doc = compilerNavigationFixture("base");
		for (const [earlierHqApps, archive] of [
			[0, "7"],
			[2, "9"],
		] as const) {
			const { zip, suite } = exported(doc, { compiledAtSeq: 7, earlierHqApps });
			const profile = readXmlEvidence(zip.readAsText("profile.ccpr"));
			expect(profile.attributes.version).toBe(archive);
			expect(
				xmlChildren(profile, "suite").map(
					(block) => onlyXml(xmlChildren(block, "resource")).attributes.version,
				),
			).toEqual([archive, archive]);
			expect(suite.attributes.version).toBe(archive);
			const property = (key: string) =>
				xmlChildren(profile, "property").find(
					(candidate) => candidate.attributes.key === key,
				)?.attributes.value;
			expect(property("cc-content-version")).toBe("7");
			expect(property("cc-app-version")).toBe("7");
			const resources = [
				...xmlChildren(suite, "xform"),
				...xmlChildren(suite, "locale"),
			].map(
				(block) => onlyXml(xmlChildren(block, "resource")).attributes.version,
			);
			expect(resources.length).toBeGreaterThan(0);
			for (const version of resources) expect(version).toBe("7");
			for (const path of ["modules-0/forms-0.xml", "modules-0/forms-1.xml"]) {
				const instance = onlyXml(
					model(zip.readAsText(path)).children.filter(
						(node) => node.name === "instance" && !node.attributes.id,
					),
				);
				expect(onlyXml(instance.children).attributes.version).toBe("7");
			}
		}
	});

	it("starts a two-language app in its first language", () => {
		const doc = localizationWireFixture("bilingual");
		const { zip } = exported(doc);
		const locale = xmlChildren(
			readXmlEvidence(zip.readAsText("profile.ccpr")),
			"property",
		).find((property) => property.attributes.key === "cur_locale");
		expect(locale?.attributes).toEqual({
			key: "cur_locale",
			value: commCareLocalization(doc).languages[0],
			force: "false",
		});
		expect(commCareLocalization(doc).languages).toHaveLength(2);
	});

	it("names its one project space everywhere and writes none of HQ's build-only profile keys", () => {
		for (const scenario of temporalSearchScenarios) {
			const { zip } = exported(temporalSearchFixture(scenario));
			const profile = readXmlEvidence(zip.readAsText("profile.ccpr"));
			const keys = xmlChildren(profile, "property").map(
				(property) => property.attributes.key,
			);
			for (const key of [
				"heartbeat-url",
				"PostTestURL",
				"ota-restore-url-testing",
				"BackupMode",
				"backup-url",
				"restore-url",
				"jr_openrosa_api",
			])
				expect(keys).not.toContain(key);
			const search = xmlChildren(
				readXmlEvidence(zip.readAsText("suite.xml")),
				"remote-request",
			).flatMap((request) =>
				xmlChildren(onlyXml(xmlChildren(request, "session")), "query"),
			);
			expect(search.map((query) => query.attributes.url)).toContain(
				"https://www.commcarehq.org/a/nova-test/phone/search/nova-test-app/",
			);
			for (const entry of zip.getEntries()) {
				const text = entry.getData().toString("utf8");
				for (const placeholder of [
					"__COMMCARE_HOST__",
					"__DOMAIN__",
					"__APP_ID__",
				])
					expect(text).not.toContain(placeholder);
			}
		}
	});

	it("refuses a damaged source after case/meta injection, naming the orphaned bind", () => {
		const doc = compilerNavigationFixture("base");
		const { hq } = exported(doc);
		const path = `${hq.modules[0].forms[0].unique_id}.xml`;
		const xml = hq._attachments[path];
		if (typeof xml !== "string") throw new Error("Missing source form");
		hq._attachments[path] = xml.replace(
			"</model>",
			'<bind nodeset="/data/meta/location" type="xsd:geopoint"/></model>',
		);
		expect(() =>
			compileCcz(hq, doc.appName, doc, { runtimeTarget: TEST_RUNTIME_TARGET }),
		).toThrow(/XForm validation failed[\s\S]*\/data\/meta\/location/);
	});

	it("places module and selected-case form conditions in their usable scopes", () => {
		const { suite, hq } = exported(compilerNavigationFixture("conditions"));
		const menu = onlyXml(xmlChildren(suite, "menu"));
		expect(menu.attributes.relevant).toBe(
			"instance('commcaresession')/session/user/data/role = 'supervisor'",
		);
		expect(
			xmlChildren(menu, "instance").map((instance) => instance.attributes),
		).toEqual([{ id: "commcaresession", src: "jr://instance/session" }]);
		const { relevant, ...commandAttributes } = onlyXml(
			xmlChildren(menu, "command"),
		).attributes;
		expect(commandAttributes).toEqual({ id: "m0-f0" });
		expect(xpathEvidence(relevant)).toEqual(
			xpathEvidence(
				"instance('casedb')/casedb/case[@case_id=instance('commcaresession')/session/data/case_id]/@status = 'open'",
			),
		);
		const entry = onlyXml(xmlChildren(suite, "entry"));
		expect(
			xmlChildren(entry, "instance")
				.map((instance) => instance.attributes.id)
				.sort(),
		).toEqual(["casedb", "commcaresession"]);
		expect(hq.modules[0].forms[0].requires).toBe("case");
	});

	it("keeps owner availability on the ordinary list when Search is disabled", () => {
		const { suite, hq } = exported(compilerNavigationFixture("owner"));
		expect(xmlChildren(suite, "remote-request")).toEqual([]);
		expect(
			xmlChildren(suite, "detail").flatMap((detail) =>
				xmlChildren(detail, "action"),
			),
		).toEqual([]);
		const entry = xmlChildren(suite, "entry")[0];
		const selection = onlyXml(
			xmlChildren(onlyXml(xmlChildren(entry, "session")), "datum"),
		);
		const rule = hq.modules[0].case_details.short.filter;
		expect(rule).toBeTypeOf("string");
		expect(rule).not.toBe("");
		expect(xpathEvidence(selection.attributes.nodeset)).toEqual(
			xpathEvidence(
				`instance('casedb')/casedb/case[@case_type='patient'][@status='open'][${rule}]`,
			),
		);
		// Native Core execution checks blank and repeated-whitespace exclusions
		// against actual cases, independently of this cross-artifact join.
	});

	it("delivers a conditional link and its module fallback on the originating entry", () => {
		const { suite } = exported(compilerNavigationFixture("links"));
		const entries = xmlChildren(suite, "entry");
		const frames = xmlChildren(
			onlyXml(xmlChildren(entries[0], "stack")),
			"create",
		);
		const condition =
			"instance('casedb')/casedb/case[@case_type='commcare-user'][hq_user_id=instance('commcaresession')/session/context/userid]/role = 'supervisor'";
		expect(frames.map((frame) => xpathEvidence(frame.attributes.if))).toEqual([
			xpathEvidence(condition),
			xpathEvidence(`not(${condition})`),
		]);
		expect(
			frames.map((frame) =>
				xmlChildren(frame, "command").map(
					(command) => command.attributes.value,
				),
			),
		).toEqual([["'m0'", "'m0-f1'"], ["'m0'"]]);
		expect(
			xmlChildren(entries[0], "instance")
				.map((instance) => instance.attributes.id)
				.sort(),
		).toEqual(["casedb", "commcaresession"]);
		expect(onlyXml(xmlChildren(entries[1], "command")).attributes.id).toBe(
			"m0-f1",
		);
	});

	it("places an ordinary registration external ID in update and preloads saved followup values after starting values", () => {
		const { hq, zip } = exported(compilerNavigationFixture("base"));
		const registration = model(zip.readAsText("modules-0/forms-1.xml"));
		const data = onlyXml(
			onlyXml(
				xmlChildren(registration, "instance").filter(
					(instance) => !instance.attributes.src,
				),
			).children,
		);
		const transaction = onlyXml(
			data.children.filter(
				(node) =>
					node.name === "case" &&
					node.uri === "http://commcarehq.org/case/transaction/v2",
			),
		);
		expect(
			xmlChildren(onlyXml(xmlChildren(transaction, "create")), "external_id"),
		).toEqual([]);
		expect(
			onlyXml(xmlChildren(transaction, "update")).children.map(
				(node) => node.name,
			),
		).toEqual(["external_id"]);
		// The external id is an ordinary update row, read from the question's
		// trimmed sibling, as HQ's Case Management tab writes it.
		expect(hq.modules[0].forms[1].actions.open_case.external_id).toBeNull();
		expect(hq.modules[0].forms[1].actions.update_case.update).toEqual({
			external_id: {
				question_path: "/data/nova_trimmed_external",
				update_mode: "always",
			},
		});
		const followup = model(zip.readAsText("modules-0/forms-0.xml"));
		expect(
			xmlChildren(followup, "setvalue")
				.filter((node) => node.attributes.ref === "/data/answer")
				.map((node) => ({
					...node.attributes,
					value: xpathEvidence(node.attributes.value),
				})),
		).toEqual([
			{
				ref: "/data/answer",
				event: "xforms-ready",
				value: xpathEvidence("'manual-default'"),
			},
			{
				ref: "/data/answer",
				event: "xforms-ready",
				value: xpathEvidence(
					"instance('casedb')/casedb/case[@case_id=instance('commcaresession')/session/data/case_id]/notes",
				),
			},
		]);
	});

	it.each(temporalSearchScenarios)(
		"%s delivers matching query data and excluded prompts through both exports",
		(scenario) => {
			const { suite, hq } = exported(temporalSearchFixture(scenario));
			const remote = onlyXml(xmlChildren(suite, "remote-request"));
			const query = onlyXml(
				xmlChildren(onlyXml(xmlChildren(remote, "session")), "query"),
			);
			const config = hq.modules[0].search_config;
			expect(config.title_label).toEqual({ en: "Search" });
			const prompts = xmlChildren(query, "prompt");
			const names =
				scenario === "legacy"
					? ["case_name"]
					: scenario === "day-range"
						? ["visit_date", "last_seen", "date_opened"]
						: ["base_date"];
			expect(prompts.map((prompt) => prompt.attributes)).toEqual(
				names.map((key) =>
					scenario === "legacy"
						? { key }
						: { key, input: "date", exclude: "true()" },
				),
			);
			expect(
				config.properties.map((property) => ({
					name: property.name,
					exclude: property.exclude,
				})),
			).toEqual(
				names.map((name) => ({
					name,
					exclude: scenario === "legacy" ? undefined : true,
				})),
			);
			const data = xmlChildren(query, "data").filter(
				(node) => node.attributes.key === "_xpath_query",
			);
			expect(data).toHaveLength(scenario === "legacy" ? 0 : names.length);
			expect(data.map((node) => node.attributes.ref)).toEqual(
				config.default_properties
					.filter((property) => property.property === "_xpath_query")
					.map((property) => property.defaultValue),
			);
			// Core evaluates these exact payloads; HQ's native CSQL compiler then
			// verifies date arithmetic and inclusive/exclusive UTC query bounds.
		},
	);
});

/** One `app_strings.txt`, read as Core reads a locale file: one `key=value` per line. */
function appStrings(zip: AdmZip, dir: string): ReadonlyMap<string, string> {
	return new Map(
		zip
			.readAsText(`${dir}/app_strings.txt`)
			.split("\n")
			.map((line) => {
				const at = line.indexOf("=");
				return [line.slice(0, at), line.slice(at + 1)] as const;
			}),
	);
}

describe("the texts HQ's build writes for a list and a form", () => {
	const shortDetails = (suite: ReturnType<typeof readXmlEvidence>) =>
		xmlChildren(suite, "detail").filter((detail) =>
			detail.attributes.id?.endsWith("_short"),
		);
	const textLocale = (block: ReturnType<typeof readXmlEvidence>) =>
		onlyXml(xmlChildren(onlyXml(xmlChildren(block, "text")), "locale"))
			.attributes.id;

	it("gives every short detail its select text, and every language the text and each form's submit label", () => {
		const doc = temporalSearchFixture("legacy");
		const { zip, suite } = exported(doc);
		const details = shortDetails(suite);
		expect(details.map((detail) => detail.attributes.id)).toEqual([
			"m0_case_short",
			"m0_search_short",
		]);
		for (const detail of details) {
			const children = detail.children.map((child) => child.name);
			expect(children.at(-1)).toBe("select_text");
			expect(children).not.toContain("no_items_text");
			expect(textLocale(onlyXml(xmlChildren(detail, "select_text")))).toBe(
				"m0_select_text",
			);
		}
		const forms = xmlChildren(suite, "entry").length;
		expect(forms).toBeGreaterThan(0);
		for (const dir of ["default", ...commCareLocalization(doc).languages]) {
			const table = appStrings(zip, dir);
			expect(table.get("m0_select_text")).toBe("Continue");
			expect(table.has("m0_no_items_text")).toBe(false);
			for (
				let form = 0;
				form < doc.formOrder[doc.moduleOrder[0]].length;
				form++
			)
				expect(table.get(`forms.m0f${form}.submit_label`)).toBe("Submit");
		}
	});

	it("writes the empty-list text after the select text where the target holds the flag", () => {
		const doc = temporalSearchFixture("legacy");
		const { zip, suite } = exported(doc, { emptyCaseListText: true });
		for (const detail of shortDetails(suite)) {
			expect(detail.children.slice(-2).map((child) => child.name)).toEqual([
				"select_text",
				"no_items_text",
			]);
			expect(textLocale(onlyXml(xmlChildren(detail, "no_items_text")))).toBe(
				"m0_no_items_text",
			);
		}
		for (const dir of ["default", ...commCareLocalization(doc).languages])
			expect(appStrings(zip, dir).get("m0_no_items_text")).toBe(
				"List is empty.",
			);
	});
});

describe("a survey menu's case type on the local path", () => {
	it("builds no detail and no string for a survey-only menu with a case type, beside a case menu's", () => {
		const doc = buildDoc({
			appName: "Survey menus",
			caseTypes: [{ name: "patient", properties: [] }],
			modules: [
				{
					name: "Patient surveys",
					caseType: "patient",
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
					forms: [
						{
							name: "Satisfaction",
							type: "survey",
							fields: [f({ kind: "text", id: "notes" })],
						},
					],
				},
				{
					name: "Patients",
					caseType: "patient",
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
					forms: [
						{
							name: "Visit",
							type: "followup",
							fields: [f({ kind: "text", id: "notes" })],
						},
					],
				},
			],
		});
		const { hq, zip, suite } = exported(doc);
		expect(hq.modules[0].case_type).toBe("patient");
		const detailIds = xmlChildren(suite, "detail").map(
			(detail) => detail.attributes.id,
		);
		expect(detailIds).toContain("m1_case_short");
		expect(detailIds.filter((id) => id?.startsWith("m0_"))).toEqual([]);
		const keys = [...appStrings(zip, "en").keys()];
		expect(keys.filter((key) => key.startsWith("m1."))).not.toEqual([]);
		expect(keys.filter((key) => key.startsWith("m0."))).toEqual([]);
	});
});

describe("a module's display condition on the local path", () => {
	const supervisor = eq(sessionUser("role"), literal("supervisor"));
	const role =
		"instance('commcaresession')/session/user/data/role = 'supervisor'";
	function menuOf(change: (doc: BlueprintDoc) => void) {
		const doc = buildDoc({
			appName: "Conditions",
			modules: [
				{
					name: "Surveys",
					forms: [
						{
							name: "Survey",
							type: "survey",
							fields: [f({ kind: "text", id: "notes" })],
						},
					],
				},
			],
		});
		change(doc);
		const { suite } = exported(doc);
		return onlyXml(
			xmlChildren(suite, "menu").filter((menu) => menu.attributes.id === "m0"),
		);
	}
	const instanceIds = (menu: ReturnType<typeof menuOf>) =>
		xmlChildren(menu, "instance").map((node) => node.attributes.id);

	it("declares what a condition that ends in never reads, as it is printed", () => {
		const menu = menuOf((doc) => {
			doc.modules[doc.moduleOrder[0]].displayCondition = and(
				supervisor,
				matchNone(),
			);
		});
		expect(menu.attributes.relevant).toBe(`${role} and false()`);
		expect(instanceIds(menu)).toEqual(["commcaresession"]);
	});

	it("declares what the rest of a module off the menu reads", () => {
		const menu = menuOf((doc) => {
			const module = doc.modules[doc.moduleOrder[0]];
			module.hiddenFromMenu = true;
			module.displayCondition = supervisor;
		});
		expect(xpathEvidence(menu.attributes.relevant)).toEqual(
			xpathEvidence(`false() and (${role})`),
		);
		expect(instanceIds(menu)).toEqual(["commcaresession"]);
	});
});
