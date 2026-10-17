import AdmZip from "adm-zip";
import { expect, it } from "vitest";
import { makeCaseSearchFixture } from "@/lib/agent/tools/case-search-config/__tests__/fixtures";
import { setCaseSearchAdvancedTool } from "@/lib/agent/tools/case-search-config/setCaseSearchAdvanced";
import { setCaseSearchDisplayTool } from "@/lib/agent/tools/case-search-config/setCaseSearchDisplay";
import { TEST_RUNTIME_TARGET } from "@/lib/commcare/__tests__/runtimeTargetFixture";
import { searchEmissionFixture } from "@/lib/commcare/__tests__/searchEmissionFixture";
import {
	onlyXml,
	readXmlEvidence,
	xmlChildren,
} from "@/lib/commcare/__tests__/xmlEvidence";
import { compileCcz } from "@/lib/commcare/compiler";
import { expandDoc } from "@/lib/commcare/expander";
import { runValidation } from "@/lib/commcare/validator/runner";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { blueprintDocSchema } from "@/lib/domain";
import { eq, literal, sessionUser, term } from "@/lib/domain/predicate";

// Shared tools and the canonical workspace, followed by the real exporters.
// The workspace host holds committed state in memory; no DB persistence is exercised.
// Native suite/query execution belongs to the separate Search runtime proofs.
it.each(["display-first", "advanced-first"])(
	"preserves both tool clusters through %s edits and clears only the requested cluster",
	async (order) => {
		const doc = searchEmissionFixture("remote");
		const moduleUuid = doc.moduleOrder[0];
		const workspace = makeCaseSearchFixture(doc);
		const condition = eq(sessionUser("role"), literal("supervisor"));
		const excluded = term(literal("owner-x"));
		const display = {
			moduleUuid,
			searchScreenTitle: "Find patients",
			searchScreenSubtitle: "Search by name",
			searchButtonLabel: "Find",
			searchButtonDisplayCondition: condition,
		};
		const advanced = {
			moduleUuid,
			excludedOwnerIds: excluded,
			searchFirst: null,
		};
		const calls = [
			() => workspace.runTool(setCaseSearchDisplayTool, display),
			() => workspace.runTool(setCaseSearchAdvancedTool, advanced),
		];
		for (const call of order === "display-first" ? calls : calls.toReversed()) {
			const result = await call();
			expect(result.kind).toBe("mutate");
			expect(result.result).not.toHaveProperty("error");
			expect(result.mutations.length).toBeGreaterThan(0);
		}
		let current = workspace.currentDoc();
		blueprintDocSchema.parse(toPersistableDoc(current));
		expect(runValidation(current, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
		expect(current.modules[moduleUuid].caseSearchConfig).toEqual({
			searchScreenTitle: display.searchScreenTitle,
			searchScreenSubtitle: display.searchScreenSubtitle,
			searchButtonLabel: display.searchButtonLabel,
			searchButtonDisplayCondition: condition,
			excludedOwnerIds: excluded,
		});
		const hq = expandDoc(current);
		expect(hq.modules[0].search_config.title_label).toEqual({
			en: "Find patients",
		});
		expect(hq.modules[0].search_config.search_button_label).toEqual({
			en: "Find",
		});
		expect(hq.modules[0].search_config.search_button_display_condition).toBe(
			"instance('commcaresession')/session/user/data/role = 'supervisor'",
		);
		const zip = new AdmZip(
			compileCcz(hq, current.appName, current, {
				runtimeTarget: TEST_RUNTIME_TARGET,
			}),
		);
		const remote = onlyXml(
			xmlChildren(
				readXmlEvidence(zip.readAsText("suite.xml")),
				"remote-request",
			),
		);
		const query = onlyXml(
			xmlChildren(onlyXml(xmlChildren(remote, "session")), "query"),
		);
		expect(xmlChildren(query, "data").map((data) => data.attributes)).toEqual([
			{ key: "case_type", ref: "'patient'" },
			{
				key: "commcare_blacklisted_owner_ids",
				ref: hq.modules[0].search_config.blacklisted_owner_ids_expression,
			},
		]);
		const cleared = await workspace.runTool(setCaseSearchDisplayTool, {
			moduleUuid,
			searchScreenTitle: null,
			searchScreenSubtitle: null,
			searchButtonLabel: null,
			searchButtonDisplayCondition: null,
		});
		expect(cleared.result).not.toHaveProperty("error");
		current = workspace.currentDoc();
		expect(current.modules[moduleUuid].caseSearchConfig).toEqual({
			excludedOwnerIds: excluded,
		});
		expect(runValidation(current, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
	},
);

// A search with no subtitle still writes `<description>` after its title, with
// a blank locale value, as HQ's build writes after its Case List save.
it.each(["remote", "inline"] as const)(
	"writes a blank description on the %s search's query",
	(scenario) => {
		const doc = searchEmissionFixture(scenario);
		expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
		const zip = new AdmZip(
			compileCcz(expandDoc(doc), doc.appName, doc, {
				runtimeTarget: TEST_RUNTIME_TARGET,
			}),
		);
		const suite = readXmlEvidence(zip.readAsText("suite.xml"));
		const search =
			scenario === "remote"
				? onlyXml(xmlChildren(suite, "remote-request"))
				: onlyXml(
						xmlChildren(suite, "entry").filter(
							(entry) =>
								onlyXml(xmlChildren(entry, "command")).attributes.id ===
								"m0-f0",
						),
					);
		const query = onlyXml(
			xmlChildren(onlyXml(xmlChildren(search, "session")), "query"),
		);
		expect(query.children.slice(0, 2).map((child) => child.name)).toEqual([
			"title",
			"description",
		]);
		const locale = onlyXml(
			xmlChildren(
				onlyXml(
					xmlChildren(onlyXml(xmlChildren(query, "description")), "text"),
				),
				"locale",
			),
		);
		expect(locale.attributes).toEqual({ id: "case_search.m0.description" });
		for (const dir of ["default", "en"]) {
			const lines = zip.readAsText(`${dir}/app_strings.txt`).split("\n");
			expect(lines).toContain("case_search.m0.description= ");
		}
	},
);
