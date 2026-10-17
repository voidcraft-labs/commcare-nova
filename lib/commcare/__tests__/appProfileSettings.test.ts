/**
 * The seventeen settings, held to HQ's own setting definitions (the
 * generated surface's `setting:properties.<key>`), and written alike by both
 * export paths. Pure.
 */
import AdmZip from "adm-zip";
import { describe, expect, it } from "vitest";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import {
	appProfileProperties,
	OWNED_PROFILE_PROPERTY_KEYS,
	SEEDED_PROFILE_PROPERTIES,
} from "../appProfileSettings";
import { compileCcz } from "../compiler";
import { expandDoc } from "../expander";
import surface from "../surface/surface.json";
import { TEST_RUNTIME_TARGET } from "./runtimeTargetFixture";
import { readXmlEvidence, xmlChildren } from "./xmlEvidence";

const ITEMS = (surface as { readonly items: Record<string, unknown> }).items;

interface SettingItem {
	readonly values?: readonly string[];
	readonly force?: boolean;
}

const PAIRS = [
	{ showSavedForms: false, showIncompleteForms: false },
	{ showSavedForms: false, showIncompleteForms: true },
	{ showSavedForms: true, showIncompleteForms: false },
	{ showSavedForms: true, showIncompleteForms: true },
] as const;

describe("appProfileProperties", () => {
	it("writes each setting at one of HQ's own choices for it, with HQ's own force", () => {
		for (const appSettings of PAIRS) {
			for (const { key, value, force } of appProfileProperties({
				appSettings,
			})) {
				const item = ITEMS[`setting:properties.${key}`] as
					| SettingItem
					| undefined;
				expect(item, key).toBeDefined();
				expect(item?.values, key).toContain(value);
				expect(item?.force === true, key).toBe(force);
			}
		}
	});

	it("is the fifteen constants and the two settings Nova holds, once each", () => {
		const keys = appProfileProperties({ appSettings: PAIRS[0] }).map(
			({ key }) => key,
		);
		expect(keys).toHaveLength(17);
		expect(new Set(keys).size).toBe(17);
		expect(keys).toEqual([
			...SEEDED_PROFILE_PROPERTIES.map(({ key }) => key),
			...OWNED_PROFILE_PROPERTY_KEYS,
		]);
	});

	it("puts the same list in the HQ JSON's profile and the archive's properties, for each value pair", () => {
		for (const appSettings of PAIRS) {
			const doc = buildDoc({ appName: "Settings", appSettings });
			const hq = expandDoc(doc);
			const expected = appProfileProperties(doc);
			expect(Object.entries(hq.profile?.properties ?? {})).toEqual(
				expected.map(({ key, value }) => [key, value]),
			);
			const profile = readXmlEvidence(
				new AdmZip(
					compileCcz(hq, doc.appName, doc, {
						runtimeTarget: TEST_RUNTIME_TARGET,
					}),
				).readAsText("profile.ccpr"),
			);
			const keys = new Set(expected.map(({ key }) => key));
			expect(
				xmlChildren(profile, "property")
					.map((property) => property.attributes)
					.filter((attributes) => keys.has(attributes.key ?? "")),
			).toEqual(
				expected.map(({ key, value, force }) => ({
					key,
					value,
					...(force && { force: "true" }),
				})),
			);
			expect(hq.profile?.properties?.["cc-show-saved"]).toBe(
				appSettings.showSavedForms ? "yes" : "no",
			);
			expect(hq.profile?.properties?.["cc-show-incomplete"]).toBe(
				appSettings.showIncompleteForms ? "yes" : "no",
			);
		}
	});
});
