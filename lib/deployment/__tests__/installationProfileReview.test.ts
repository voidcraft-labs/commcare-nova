import { expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { localizationWireFixture } from "@/lib/commcare/__tests__/localizationWireFixture";
import { snapshotTranslationUnits, storedTranslationValue } from "@/lib/domain";
import {
	type InstallationProfileRequest,
	profileAgreement,
	profileLanguageTransition,
} from "../installationProfileReview";
import { intermediateInstallationDoc } from "../installationProfileSuperset";

const old: InstallationProfileRequest = {
	uuid: testUuid("old"),
	definition: {
		id: "local-old",
		name: "Outreach",
		langs: ["fra", "en"],
		practiceWorkerId: "worker-a",
	},
	knownKey: true,
	needsWorker: true,
};
const added: InstallationProfileRequest = {
	uuid: testUuid("new"),
	definition: { id: "local-new", name: "Supervisors", langs: ["spa"] },
	knownKey: false,
	needsWorker: false,
};

it("retains an existing key through a rename and correlates a newly allocated key only after review", () => {
	const requests = {
		requested: [old, added],
		previousKeys: ["local-old", "deleted"],
	};
	const correct = [old.definition, { ...added.definition, id: "assigned" }];
	expect(profileAgreement(requests, correct)).toEqual({
		agreed: true,
		bindings: [
			{ uuid: old.uuid, key: "local-old", practiceWorkerId: "worker-a" },
			{ uuid: added.uuid, key: "assigned" },
		],
	});
	for (const changed of [
		{ name: "Former name" },
		{ langs: ["en", "fra"] },
		{ practiceWorkerId: "worker-b" },
	]) {
		expect(
			profileAgreement(requests, [
				{ ...old.definition, ...changed },
				correct[1],
			]),
		).toEqual({ agreed: false });
	}
	expect(
		profileAgreement(requests, [
			old.definition,
			{ ...added.definition, id: "deleted" },
		]),
	).toEqual({ agreed: false });
	expect(
		profileAgreement(requests, [
			...correct,
			{ ...added.definition, id: "extra" },
		]),
	).toEqual({ agreed: false });
});

it("keeps a same-content rename at its own key and refuses indistinguishable new bindings", () => {
	const twins = [
		{ ...added, uuid: testUuid("A") },
		{ ...added, uuid: testUuid("B") },
	];
	expect(
		profileAgreement({ requested: twins, previousKeys: [] }, [
			{ ...added.definition, id: "hq-a" },
			{ ...added.definition, id: "hq-b" },
		]),
	).toEqual({ agreed: false });
	const swapped = [
		old,
		{
			...old,
			uuid: testUuid("another"),
			definition: { ...old.definition, id: "old-b", name: "Second" },
		},
	];
	expect(
		profileAgreement(
			{ requested: swapped, previousKeys: ["local-old", "old-b"] },
			[
				{ ...old.definition, name: "Second" },
				{ ...old.definition, id: "old-b" },
			],
		),
	).toEqual({ agreed: false });
});

it("keeps a removed language until CommCare HQ can save the new one in its place", () => {
	expect(
		profileLanguageTransition(
			["en", "spa"],
			{ langs: ["en", "fra"], buildProfiles: [old.definition] },
			[added],
		),
	).toEqual({
		addFirst: ["spa"],
		keepUntilEdit: ["fra"],
		needsContentFirst: true,
		intermediateLanguages: ["en", "spa", "fra"],
	});
});

it("retains the previous effective language text by durable unit identity during the temporary superset", () => {
	const prior = localizationWireFixture("mandarin");
	const local = prior.localization;
	if (!local) throw new Error("Expected localization fixture");
	const dropped = "cmn-Hant";
	const { [dropped]: originalText, ...translations } = local.translations;
	const { [dropped]: code, ...wireCodes } = local.wireCodes;
	const desired = {
		...prior,
		localization: {
			...local,
			languageOrder: local.languageOrder.filter((tag) => tag !== dropped),
			translations,
			wireCodes,
		},
	};
	const interim = intermediateInstallationDoc(desired, prior, [code]);
	if ("issue" in interim) throw new Error(interim.issue);
	expect(originalText).toBeDefined();
	expect(interim.localization?.languageOrder.at(-1)).toBe(dropped);
	for (const [id, unit] of snapshotTranslationUnits(prior)) {
		const current = snapshotTranslationUnits(interim).get(id);
		if (!current)
			throw new Error("The intermediate installation lost a translation unit");
		expect(storedTranslationValue(interim, dropped, current)).toEqual(
			storedTranslationValue(prior, dropped, unit),
		);
	}
	expect(desired.localization.languageOrder).not.toContain(dropped);
	expect(
		intermediateInstallationDoc(desired, prior, ["unknown"]),
	).toHaveProperty("issue");
});
