import AdmZip from "adm-zip";
import { expect, it } from "vitest";
import { makeCaseSearchFixture } from "@/lib/agent/tools/case-search-config/__tests__/fixtures";
import { setCaseSearchAdvancedTool } from "@/lib/agent/tools/case-search-config/setCaseSearchAdvanced";
import { setCaseSearchDisplayTool } from "@/lib/agent/tools/case-search-config/setCaseSearchDisplay";
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
		const zip = new AdmZip(compileCcz(hq, current.appName, current));
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
