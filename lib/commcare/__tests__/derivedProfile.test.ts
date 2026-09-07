import AdmZip from "adm-zip";
import { isTag } from "domhandler";
import { findAll } from "domutils";
import { parseDocument } from "htmlparser2";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig } from "@/lib/__tests__/docHelpers";
import { compileCcz } from "@/lib/commcare/compiler";
import { derivedProfileProperties } from "@/lib/commcare/derivedProfile";
import { expandDoc } from "@/lib/commcare/expander";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { blueprintDocSchema, simpleSearchInputDef } from "@/lib/domain";
import { literal, term } from "@/lib/domain/predicate";
import { proseText } from "@/lib/domain/prose";
import { runValidation } from "../validator/runner";

function appWithSearch(search: "none" | "explicit" | "input" | "owner-only") {
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
				caseListOnly: true,
				caseListConfig: list,
				...(search === "explicit" && { caseSearchConfig: {} }),
				...(search === "owner-only" && {
					caseSearchConfig: {
						searchActionEnabled: false as const,
						excludedOwnerIds: term(literal("owner-a")),
					},
				}),
				forms: [],
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

function profileProperties(search: Parameters<typeof appWithSearch>[0]) {
	const doc = appWithSearch(search);
	const xml = new AdmZip(
		compileCcz(expandDoc(doc), doc.appName, doc),
	).readAsText("profile.ccpr");
	const parsed = parseDocument(xml, { xmlMode: true });
	return findAll((n) => isTag(n) && n.name === "property", parsed.children).map(
		(n) => n.attribs,
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
			expect(expandDoc(doc).profile).toEqual({
				custom_properties: {
					"cc-index-case-search-results": "yes",
				},
			});
			expect(
				profileProperties(search).filter(
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
			expect(Object.hasOwn(hq, "profile")).toBe(false);
			expect(profileProperties(search).map((p) => p.key)).not.toContain(
				"cc-index-case-search-results",
			);
		},
	);

	it("does not emit a post-form sync property", () => {
		const doc = appWithSearch("explicit");
		expect(JSON.stringify(expandDoc(doc))).not.toContain("sync-after-form");
		expect(profileProperties("explicit").map((p) => p.key)).not.toContain(
			"sync-after-form",
		);
	});
});
