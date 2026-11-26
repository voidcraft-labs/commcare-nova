import { expect, it } from "vitest";
import { testMediaAssetId, testUuid } from "@/__tests__/helpers/uuid";
import { installationArchiveIssue } from "@/lib/domain/installationProfiles";
import { resolvedLanguageEnglishName } from "@/lib/domain/languageRegistry/names";
import { compileCczParts } from "../compiler";
import { expandDoc } from "../expander";
import { installationDownloadIssue } from "../installationProfiles";
import { DERIVED_WIRE_IDENTITY } from "../wireIdentity";
import { manifestFor } from "./fixtureMediaManifest";
import { localizationWireFixture } from "./localizationWireFixture";
import { TEST_RUNTIME_TARGET } from "./runtimeTargetFixture";

it("installs the chosen languages in order, including a default other than the source", () => {
	const doc = localizationWireFixture("mandarin");
	const uuid = testUuid("field-team");
	doc.appSettings.installationProfiles = {
		[uuid]: {
			uuid,
			name: "Field team",
			languages: ["cmn-Hant", "cmn-Hans"],
			requiresPracticeWorker: false,
		},
	};
	const options = {
		installationProfileUuid: uuid,
		runtimeTarget: TEST_RUNTIME_TARGET,
	};
	const application = expandDoc(doc, options);
	expect(application.langs).toEqual(["cmn-hant", "zho"]);
	const { files, tables } = compileCczParts(
		application,
		doc.appName,
		doc,
		options,
	);
	expect(Object.keys(tables).sort()).toEqual(["cmn-hant", "default", "zho"]);
	expect(tables.default).toEqual(tables["cmn-hant"]);
	const profileXml = Object.values(files).find((xml) =>
		xml.includes("<profile "),
	);
	expect(profileXml).toContain(`buildProfileID="${uuid.replaceAll("-", "")}"`);
	const formXml = Object.values(files).find((xml) => xml.includes("<itext>"));
	expect(formXml).toContain('lang="cmn-hant"');
	expect(formXml).toContain('lang="zho"');
	expect(formXml).not.toContain('lang="en"');
	expect(expandDoc(doc).langs).toEqual(["en", "zho", "cmn-hant"]);
	doc.appSettings.installationProfiles[uuid].requiresPracticeWorker = true;
	expect(
		installationArchiveIssue(doc, uuid, resolvedLanguageEnglishName),
	).toContain("Mandarin Chinese");
	expect(
		installationArchiveIssue(doc, uuid, resolvedLanguageEnglishName),
	).toContain("Releases page");
	expect(installationArchiveIssue(doc)).toBeUndefined();
	const held = {
		...DERIVED_WIRE_IDENTITY,
		installationProfileKey: () => "team/subteam",
	};
	expect(installationDownloadIssue(doc, uuid, held)).toContain("Releases page");
	expect(installationDownloadIssue(doc, undefined, held)).toBeUndefined();
	expect(
		installationDownloadIssue(doc, uuid, DERIVED_WIRE_IDENTITY),
	).toBeUndefined();
});

it("writes no navigation icon when a named CCZ excludes its only ordinary icon language", () => {
	const doc = localizationWireFixture("mandarin");
	const menu = doc.modules[doc.moduleOrder[0]];
	const ordinary = testMediaAssetId("ordinary-nav-icon");
	const override = testMediaAssetId("locale-nav-icon");
	menu.icon = ordinary;
	menu.mediaByLanguage = {
		eng: { iconOverride: override },
		"cmn-Hans": { icon: null },
		"cmn-Hant": { icon: "blank" },
	};
	doc.forms[doc.formOrder[menu.uuid][0]].icon = override;
	const uuid = testUuid("without-navigation-language");
	doc.appSettings.installationProfiles = {
		[uuid]: {
			uuid,
			name: "Mandarin team",
			languages: ["cmn-Hant", "cmn-Hans"],
			requiresPracticeWorker: false,
		},
	};
	const assets = manifestFor(doc);
	const compile = (installationProfileUuid?: typeof uuid) => {
		const options = {
			assets,
			runtimeTarget: TEST_RUNTIME_TARGET,
			installationProfileUuid,
		};
		return compileCczParts(expandDoc(doc, options), doc.appName, doc, options);
	};
	const suite = (files: ReturnType<typeof compile>["files"]) =>
		Object.values(files).find((xml) => xml.includes("<menu "));
	const full = compile();
	expect(full.tables.en.get("modules.m0.icon")).toBe(
		`jr://file/${assets.get(override)?.wirePath}`,
	);
	expect(suite(full.files)).toContain('id="modules.m0.icon"');
	const limited = compile(uuid);
	expect(limited.tables.default.get("modules.m0.icon")).toBeUndefined();
	expect(suite(limited.files)).not.toContain('id="modules.m0.icon"');
});
