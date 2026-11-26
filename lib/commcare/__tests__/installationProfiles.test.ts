import {resolvedLanguageEnglishName} from "@/lib/domain/languageRegistry/names";
import { expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { installationArchiveIssue } from "@/lib/domain/installationProfiles";
import { compileCczParts } from "../compiler";
import {installationDownloadIssue} from "../installationProfiles";
import {DERIVED_WIRE_IDENTITY} from "../wireIdentity";
import { expandDoc } from "../expander";
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
	expect(installationArchiveIssue(doc, uuid,resolvedLanguageEnglishName)).toContain("Mandarin Chinese");
 expect(installationArchiveIssue(doc,uuid,resolvedLanguageEnglishName)).toContain("Releases page");
	expect(installationArchiveIssue(doc)).toBeUndefined();
	const held = {...DERIVED_WIRE_IDENTITY, installationProfileKey: () => "team/subteam"};
	expect(installationDownloadIssue(doc,uuid,held)).toContain("Releases page");
	expect(installationDownloadIssue(doc,undefined,held)).toBeUndefined();
	expect(installationDownloadIssue(doc,uuid,DERIVED_WIRE_IDENTITY)).toBeUndefined();
});
