import AdmZip from "adm-zip";
import { isTag } from "domhandler";
import { findAll } from "domutils";
import { parseDocument } from "htmlparser2";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { compileCcz } from "@/lib/commcare/compiler";
import { derivedProfileProperties } from "@/lib/commcare/derivedProfile";
import { expandDoc } from "@/lib/commcare/expander";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { blueprintDocSchema, simpleSearchInputDef } from "@/lib/domain";
import { literal, term } from "@/lib/domain/expression";
import { proseText } from "@/lib/domain/prose";
import { runValidation } from "../validator/runner";
import { TEST_RUNTIME_TARGET } from "./runtimeTargetFixture";

type SearchKind = "none" | "explicit" | "input" | "owner-only";

/**
 * One menu of patients holding the search named. A menu that lists its cases
 * offers its case list as a menu entry; one that lists none holds a survey
 * alone, so it keeps its case type and its search but chooses no case.
 */
function appWithSearch(
	search: SearchKind,
	menu: "lists-cases" | "lists-no-cases" = "lists-cases",
) {
	const list = caseListConfig([{ field: "case_name", header: "Name" }]);
	if (search === "input") {
		list.searchInputs.push(
			simpleSearchInputDef(
				testUuid("derived-profile-search-input"),
				"case_name",
				"Name",
				"text",
				"case_name",
			),
		);
	}

	const doc = buildDoc({
		appName: "Search profile",
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				...(menu === "lists-cases" && { caseListMenuItem: {} }),
				caseListConfig: list,
				...(search === "explicit" && { caseSearchConfig: {} }),
				...(search === "owner-only" && {
					caseSearchConfig: {
						searchActionEnabled: false as const,
						excludedOwnerIds: term(literal("owner-a")),
					},
				}),
				forms:
					menu === "lists-cases"
						? []
						: [
								{
									name: "Satisfaction",
									type: "survey" as const,
									fields: [
										f({ kind: "text", id: "notes", label: proseText("Notes") }),
									],
								},
							],
			},
		],
		caseTypes: [
			{
				name: "patient",
				properties: [{ name: "case_name", label: proseText("Name") }],
			},
		],
	});
	blueprintDocSchema.parse(toPersistableDoc(doc));
	expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
	return doc;
}

function archiveOf(doc: ReturnType<typeof appWithSearch>) {
	return new AdmZip(
		compileCcz(expandDoc(doc), doc.appName, doc, {
			runtimeTarget: TEST_RUNTIME_TARGET,
		}),
	);
}

function profileProperties(doc: ReturnType<typeof appWithSearch>) {
	const parsed = parseDocument(archiveOf(doc).readAsText("profile.ccpr"), {
		xmlMode: true,
	});
	return findAll((n) => isTag(n) && n.name === "property", parsed.children).map(
		(n) => n.attribs,
	);
}

function remoteRequests(doc: ReturnType<typeof appWithSearch>) {
	const parsed = parseDocument(archiveOf(doc).readAsText("suite.xml"), {
		xmlMode: true,
	});
	return findAll(
		(n) => isTag(n) && n.name === "remote-request",
		parsed.children,
	);
}

describe("derived CommCare profile", () => {
	it.each(["explicit", "input"] as const)(
		"derives Search indexing for %s Search",
		(search) => {
			const doc = appWithSearch(search);
			expect(derivedProfileProperties(doc)).toEqual({
				"cc-index-case-search-results": "yes",
			});
			expect(expandDoc(doc).profile?.custom_properties).toEqual({
				"cc-index-case-search-results": "yes",
			});
			expect(
				profileProperties(doc).filter(
					(p) => p.key === "cc-index-case-search-results",
				),
			).toEqual([
				{ key: "cc-index-case-search-results", value: "yes", force: "true" },
			]);
		},
	);

	it.each(["none", "owner-only"] as const)(
		"omits every derived profile field when %s does not emit Search",
		(search) => {
			const doc = appWithSearch(search);
			const hq = expandDoc(doc);

			expect(derivedProfileProperties(doc)).toEqual({});
			expect(Object.hasOwn(hq.profile ?? {}, "custom_properties")).toBe(false);
			expect(profileProperties(doc).map((p) => p.key)).not.toContain(
				"cc-index-case-search-results",
			);
		},
	);

	// Formplayer reads the property only while it fetches a remote request's
	// results (`CaseSearchHelper.shouldParseIntoCaseSearchStorage`). A menu that
	// lists no cases writes no remote request whatever search it holds, so the
	// property would stand in an app nothing searches from.
	it.each(["explicit", "input"] as const)(
		"omits Search indexing where the only %s Search is on a menu that lists no cases",
		(search) => {
			const doc = appWithSearch(search, "lists-no-cases");
			const hq = expandDoc(doc);

			expect(remoteRequests(doc)).toEqual([]);
			expect(hq.modules[0]?.search_config).toEqual(
				expandDoc(appWithSearch("none", "lists-no-cases")).modules[0]
					?.search_config,
			);
			expect(derivedProfileProperties(doc)).toEqual({});
			expect(Object.hasOwn(hq.profile ?? {}, "custom_properties")).toBe(false);
			expect(profileProperties(doc).map((p) => p.key)).not.toContain(
				"cc-index-case-search-results",
			);
		},
	);

	it("does not emit a post-form sync property", () => {
		const doc = appWithSearch("explicit");
		expect(JSON.stringify(expandDoc(doc))).not.toContain("sync-after-form");
		expect(profileProperties(doc).map((p) => p.key)).not.toContain(
			"sync-after-form",
		);
	});
});
