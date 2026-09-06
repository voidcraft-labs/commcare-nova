import AdmZip from "adm-zip";
import { describe, expect, it } from "vitest";
import { compileCcz } from "@/lib/commcare/compiler";
import { expandDoc } from "@/lib/commcare/expander";
import { runValidation } from "@/lib/commcare/validator/runner";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import {
	type BlueprintDoc,
	blueprintDocSchema,
	uuidSchema,
} from "@/lib/domain";
import {
	compilerNavigationFixture,
	temporalSearchFixture,
	temporalSearchScenarios,
} from "./compilerNavigationFixture";
import { onlyXml, readXmlEvidence, xmlChildren } from "./xmlEvidence";

function exported(doc: BlueprintDoc, compiledAtSeq?: number) {
	blueprintDocSchema.parse(toPersistableDoc(doc));
	expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
	const hq = expandDoc(doc);
	const zip = new AdmZip(compileCcz(hq, doc.appName, doc, { compiledAtSeq }));
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
	it("packages resolvable profile resources and fresh installation identities at each document sequence", () => {
		const doc = compilerNavigationFixture("base");
		const identities = new Set<string>();
		for (const sequence of [undefined, 0, 42]) {
			const { zip } = exported(doc, sequence);
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
			expect(profile.uri).toBe("http://cihi.commcarehq.org/jad");
			expect(profile.attributes.name).toBe(doc.appName);
			uuidSchema.parse(profile.attributes.uniqueid);
			identities.add(profile.attributes.uniqueid);
			expect(
				xmlChildren(profile, "property").map((property) => property.attributes),
			).toEqual([
				{ key: "CommCare App Name", value: doc.appName },
				{ key: "cc-content-version", value: String(sequence ?? 1) },
				{ key: "cc-app-version", value: "1" },
			]);
			const locations = xmlChildren(profile, "suite").map((suite) =>
				onlyXml(
					xmlChildren(onlyXml(xmlChildren(suite, "resource")), "location"),
				),
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
		expect(identities.size).toBe(3);
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
		expect(() => compileCcz(hq, doc.appName, doc)).toThrow(
			/XForm validation failed[\s\S]*\/data\/meta\/location/,
		);
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
		expect(onlyXml(xmlChildren(menu, "command")).attributes).toEqual({
			id: "m0-f0",
			relevant:
				"instance('casedb')/casedb/case[@case_id=instance('commcaresession')/session/data/case_id]/@status = 'open'",
		});
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
		expect(selection.attributes.nodeset).toBe(
			`instance('casedb')/casedb/case[@case_type='patient'][@status='open'][${rule}]`,
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
		expect(frames.map((frame) => frame.attributes.if)).toEqual([
			condition,
			`not(${condition})`,
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
		expect(hq.modules[0].forms[1].actions.open_case.external_id).toBe(
			"/data/external",
		);
		expect(hq.modules[0].forms[1].actions.update_case.update).toEqual({});
		const followup = model(zip.readAsText("modules-0/forms-0.xml"));
		expect(
			xmlChildren(followup, "setvalue")
				.filter((node) => node.attributes.ref === "/data/answer")
				.map((node) => node.attributes),
		).toEqual([
			{ ref: "/data/answer", event: "xforms-ready", value: "'manual-default'" },
			{
				ref: "/data/answer",
				event: "xforms-ready",
				value:
					"instance('casedb')/casedb/case[@case_id=instance('commcaresession')/session/data/case_id]/notes",
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
