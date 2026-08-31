import AdmZip from "adm-zip";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig } from "@/lib/__tests__/docHelpers";
import { compileCcz } from "@/lib/commcare/compiler";
import {
	derivedProfileProperties,
	NOVA_OWNED_DERIVED_PROFILE_PROPERTY_KEYS,
} from "@/lib/commcare/derivedProfile";
import { expandDoc } from "@/lib/commcare/expander";
import { simpleSearchInputDef } from "@/lib/domain";
import { literal, term } from "@/lib/domain/predicate";
import { proseText } from "@/lib/domain/prose";

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

	return buildDoc({
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
}

function profileXml(search: Parameters<typeof appWithSearch>[0]): string {
	const doc = appWithSearch(search);
	return new AdmZip(compileCcz(expandDoc(doc), doc.appName, doc)).readAsText(
		"profile.ccpr",
	);
}

describe("derived CommCare profile", () => {
	it("owns exactly the Search indexing property", () => {
		expect(NOVA_OWNED_DERIVED_PROFILE_PROPERTY_KEYS).toEqual([
			"cc-index-case-search-results",
		]);
	});

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
			expect(profileXml(search)).toContain(
				'<property key="cc-index-case-search-results" value="yes" force="true"/>',
			);
		},
	);

	it.each(["none", "owner-only"] as const)(
		"omits every derived profile field when %s does not emit Search",
		(search) => {
			const doc = appWithSearch(search);
			const hq = expandDoc(doc);

			expect(derivedProfileProperties(doc)).toEqual({});
			expect(Object.hasOwn(hq, "profile")).toBe(false);
			expect(profileXml(search)).not.toContain("cc-index-case-search-results");
		},
	);

	it("does not emit a post-form sync property", () => {
		const doc = appWithSearch("explicit");
		expect(JSON.stringify(expandDoc(doc))).not.toContain("sync-after-form");
		expect(profileXml("explicit")).not.toContain("sync-after-form");
	});
});
