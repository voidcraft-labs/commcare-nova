import AdmZip from "adm-zip";
import { findAll, textContent } from "domutils";
import { parseDocument } from "htmlparser2";
import { expect, it } from "vitest";
import {
	retainedBodyJson,
	retainedPublishRead,
} from "@/__tests__/helpers/retainedHqReads";
import { testUuid } from "@/__tests__/helpers/uuid";
import { localizationWireFixture } from "@/lib/commcare/__tests__/localizationWireFixture";
import { TEST_RUNTIME_TARGET } from "@/lib/commcare/__tests__/runtimeTargetFixture";
import { compileCcz } from "@/lib/commcare/compiler";
import { expandDoc } from "@/lib/commcare/expander";
import { parseHqAppSource } from "@/lib/commcare/hq/appSource";
import {
	filledProse,
	makeTranslationUnitId,
	snapshotTranslationUnits,
	storedTranslationValue,
	TRANSLATION_FILL_ROLES,
} from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import { whereHqKeepsLines } from "@/lib/publish/hqChangesCopy";
import { installationDisclosure } from "../installationDisclosure";
import {
	installationChoicePage,
	sameInstallationAfterMedia,
} from "../installationProfilePublish";
import {
	definitionKey,
	groupedDefinitions,
	type InstallationProfileRequest,
	installationEditorSteps,
	profileAgreement,
	profileLanguageTransition,
} from "../installationProfileReview";
import { intermediateInstallationDoc } from "../installationProfileSuperset";
import {
	EMPTY_TARGET_IDENTITY,
	targetIdentityChanges,
} from "../targetIdentity";

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
			TRANSLATION_FILL_ROLES.has(unit.role)
				? filledProse(prior, unit, dropped)
				: storedTranslationValue(prior, dropped, unit),
		);
	}
	expect(desired.localization.languageOrder).not.toContain(dropped);
	expect(
		intermediateInstallationDoc(desired, prior, ["unknown"]),
	).toHaveProperty("issue");
});

it("browses many identically named installations by Nova installation and one page of matching destinations", () => {
	const requests = Array.from({ length: 1000 }, (_, n) => ({
		...old,
		uuid: testUuid(String(n)),
		definition: { ...old.definition, id: `local-${n}` },
		needsWorker: false,
	}));
	const physical = requests.map((r, index) => ({
		...r.definition,
		id: `remote-${index}`,
	}));
	const groups = groupedDefinitions(physical, (p) => definitionKey(p, false));
	const choose = installationChoicePage(requests, groups, undefined, "offer");
	expect(choose?.options).toHaveLength(13);
	const more = choose?.options.at(-1)?.action;
	if (!more || !("page" in more)) throw new Error("Missing next page");
	const second = installationChoicePage(requests, groups, more.page, "offer");
	const select = second?.options[0]?.action;
	if (!select || !("page" in select))
		throw new Error("Missing installation choice");
	const destinations = installationChoicePage(
		requests,
		groups,
		select.page,
		"offer",
	);
	expect(destinations?.options).toHaveLength(14);
	const first = destinations?.options[0]?.action;
	expect(first).toMatchObject({
		request: { uuid: requests[12].uuid },
		profile: { id: "remote-0" },
	});
	expect(
		profileAgreement({ requested: requests, previousKeys: [] }, physical),
	).toEqual({ agreed: false });
});
it("names the saved defaults that realize a secondary-language order in the releases editor", () => {
	const request = {
		...old,
		definition: { ...old.definition, langs: ["en", "es", "fra"] },
	};
	for (const langs of [
		["en", "fra"],
		["en", "fra", "es"],
	]) {
		expect(
			installationEditorSteps(request, langs, ["en", "fra", "es"]),
		).toContain("es → en");
	}
	expect(
		installationEditorSteps(request, request.definition.langs, [
			"en",
			"fra",
			"es",
		]),
	).not.toContain("between saves");
});

it("allows only the file IDs reported for the uploaded content before recording its ready installation", () => {
	const raw = retainedBodyJson(retainedPublishRead("source-live"));
	const path = "jr://file/commcare/artwork.png";
	const read = (id: string, label?: string) => {
		const parsed = parseHqAppSource({
			...raw,
			multimedia_map: {
				[path]: { multimedia_id: id, media_type: "CommCareImage" },
			},
			...(label && { name: label }),
		});
		if (parsed.kind !== "source")
			throw new Error("Expected retained working app source");
		return parsed.source;
	};
	expect(
		sameInstallationAfterMedia(read("old"), read("new"), {
			"commcare/artwork.png": "new",
		}),
	).toBe(true);
	expect(
		sameInstallationAfterMedia(read("old"), read("other"), {
			"commcare/artwork.png": "new",
		}),
	).toBe(false);
	expect(
		sameInstallationAfterMedia(read("old"), read("new", "Another edit"), {
			"commcare/artwork.png": "new",
		}),
	).toBe(false);
});

it("pins the old visible XForm label when an old installation used fallback and the source label changes", () => {
	const prior = localizationWireFixture("mandarin");
	const field = Object.values(prior.fields).find((f) => f.id === "case_name");
	const local = prior.localization;
	if (!field || !local) throw new Error("Expected a multilingual field.");
	const dropped = "cmn-Hant";
	const id = makeTranslationUnitId("field", field.uuid, "label");
	local.translations[dropped][id].value = proseText("");
	const { [dropped]: _text, ...translations } = local.translations;
	const { [dropped]: code, ...wireCodes } = local.wireCodes;
	const desired = structuredClone(prior);
	const edited = desired.fields[field.uuid];
	if (!("label" in edited)) throw new Error("Expected a labelled field.");
	edited.label = proseText("Updated home visit");
	desired.localization = {
		...local,
		translations,
		wireCodes,
		languageOrder: local.languageOrder.filter((tag) => tag !== dropped),
	};
	const intermediate = intermediateInstallationDoc(desired, prior, [code]);
	if ("issue" in intermediate) throw new Error(intermediate.issue);
	const xml = new AdmZip(
		compileCcz(expandDoc(intermediate), intermediate.appName, intermediate, {
			runtimeTarget: TEST_RUNTIME_TARGET,
		}),
	).readAsText("modules-0/forms-0.xml");
	const tables = findAll(
		(e) => e.name === "translation",
		parseDocument(xml, { xmlMode: true }).children,
	);
	const label = (lang: string) =>
		textContent(
			findAll(
				(e) => e.attribs.id === "case_name-label",
				tables.find((e) => e.attribs.lang === lang)?.children ?? [],
			),
		);
	expect(label(code)).toBe("Name");
	expect(label("en")).toBe("Updated home visit");
});

it("details each added, removed and renamed installation and the before/after languages and practice worker", () => {
	const before = localizationWireFixture("bilingual");
	const keep = testUuid("retained installation"),
		remove = testUuid("removed installation"),
		add = testUuid("new installation");
	const profile = (
		uuid: typeof keep,
		name: string,
		languages: string[],
		requiresPracticeWorker = false,
	) => ({ uuid, name, languages, requiresPracticeWorker });
	before.appSettings.installationProfiles = {
		[keep]: profile(keep, "Old visits", ["eng", "spa"], true),
		[remove]: profile(remove, "Training", ["eng"]),
	};
	const after = structuredClone(before);
	after.appSettings.installationProfiles = {
		[keep]: profile(keep, "New visits", ["spa", "eng"], true),
		[add]: profile(add, "Outreach", ["spa"], true),
	};
	const changed = targetIdentityChanges(
		{
			...EMPTY_TARGET_IDENTITY,
			installationProfiles: [
				{ uuid: keep, key: "original", practiceWorkerId: "old-worker" },
				{ uuid: remove, key: "retired" },
			],
		},
		{
			...EMPTY_TARGET_IDENTITY,
			installationProfiles: [
				{ uuid: keep, key: "original", practiceWorkerId: "new-worker" },
				{ uuid: add, key: "hq-made", practiceWorkerId: "training-worker" },
			],
		},
		after,
		before,
	);
	const lines = whereHqKeepsLines(changed);
	expect(lines).toHaveLength(3);
	expect(lines).toEqual(
		expect.arrayContaining([
			expect.stringMatching(
				/Change.*Old visits.*English → Spanish.*old-worker.*New visits.*Spanish → English.*new-worker/,
			),
			expect.stringMatching(/Remove.*Training.*retired/),
			expect.stringMatching(/Bring in.*Outreach.*hq-made.*training-worker/),
		]),
	);
});

it("discloses every byte of a long binding choice before giving its action, and invalidates a page on a changed decision", () => {
	const key = "Home visits ".repeat(12000) + "last-character";
	const label = `Use the installation ${key}`;
	const action = "a".repeat(64);
	const review = {
		kind: "review" as const,
		message: "Choose the matching installation",
		details: [],
		choices: [{ label, confirmation: action }],
	};
	let result = installationDisclosure(review, "original");
	let parts = "";
	let firstCursor: string | undefined;
	for (;;) {
		parts += result.details.join("");
		if (result.choices?.[0]?.confirmation === action) break;
		const cursor = result.choices?.[0]?.confirmation;
		if (!cursor) throw new Error("Missing next part");
		firstCursor ??= cursor;
		expect(JSON.stringify(result)).not.toContain(action);
		expect(JSON.stringify(result).length).toBeLessThan(12_000);
		result = installationDisclosure(review, "original", cursor);
	}
	expect(parts).toContain(label);
	const reset = installationDisclosure(
		review,
		"replacement-claim",
		firstCursor,
	);
	expect(reset.details).toEqual(
		installationDisclosure(review, "replacement-claim").details,
	);
	expect(reset.choices).not.toContainEqual({ label, confirmation: action });
});
