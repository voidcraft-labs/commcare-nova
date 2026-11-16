/**
 * An HQ app's language codes read into Nova's language identities.
 *
 * It would catch `en` beside `eng` held as two languages; a macrolanguage's
 * code read to no identity; a code HQ's grammar refuses, an empty one or a
 * repeated one held; `pt-br`, `zh-hans` and `cmn-hanttw` read without their
 * region or script, since the suffix is lower case; and a code Nova itself
 * wrote for an identity read back to another identity, which would make an
 * app Nova published read back as a different app; a re-read of an app Nova
 * holds that names a stored code's language anew where the minter has since
 * changed its spelling (`swc` stored as `sw`); and a reading whose source
 * stands third in the app's order throwing at its construction batch.
 */

import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import { recordDialectRoundTrip } from "@/lib/agent/authoring/recordRoundTrip";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { applyMutations } from "@/lib/doc/mutations";
import { emptyBlueprintDoc } from "@/lib/doc/scaffolds";
import type { Mutation } from "@/lib/doc/types";
import {
	type AppLanguageIdentity,
	type BlueprintDoc,
	collectTranslationUnits,
	languageTag,
	proseText,
} from "@/lib/domain";
import { resolvedLanguageDisplayLabel } from "@/lib/domain/languageRegistry/names";
import { mintLanguageWireCode } from "../../languageWire";
import { DERIVED_WIRE_IDENTITY } from "../../wireIdentity";
import { matchingResolver } from "../identity";
import { externalIdentityMap } from "../identityMap";
import { knownLanguageCodesOf, readHqApp } from "../index";
import { languageIdentityForHqCode, readLanguages } from "../languages";
import type { ReaderInput, ReadOutcome } from "../types";
import { exportedBody, inputFor } from "./novaExport";
import {
	readContext,
	readerInput,
	retainedSourceBody,
	sourceFromBody,
} from "./readerInput";

const A = "application-and-settings";

async function read(
	langs: readonly string[],
	names: Readonly<Record<string, string>> = {},
) {
	const body = retainedSourceBody("shell/app-source");
	const first = langs[0] ?? "en";
	const ctx = readContext(
		readerInput(
			await sourceFromBody({
				...body,
				langs,
				translations: { [first]: names },
			}),
		),
	);
	const languages = readLanguages(ctx);
	/* Only the languages stage runs, so the app's other keys stay unclaimed; its findings are
	 * the ones at the languages place. */
	const findings = ctx
		.close()
		.findings.filter((finding) => finding.place.kind === "languages");
	return { ctx, languages, findings };
}

describe("languageIdentityForHqCode", () => {
	it.each<[string, AppLanguageIdentity | undefined]>([
		["en", { language: "eng" }],
		["eng", { language: "eng" }],
		["hin", { language: "hin" }],
		["pt-br", { language: "por", region: "BR" }],
		["zh-hans", { language: "cmn", script: "Hans" }],
		["cmn-hanttw", { language: "cmn", script: "Hant", region: "TW" }],
		/* CN is no region of Traditional Chinese, so the suffix adds nothing, and Chinese with
		 * no script is no identity. */
		["cmn-hantcn", undefined],
		["ar", { language: "arb" }],
		["en-zz", { language: "eng" }],
		["xx", undefined],
		["zh", undefined],
		["lat", undefined],
	])("reads %s", (code, identity) => {
		expect(languageIdentityForHqCode(code)).toEqual(identity);
	});

	it("reads a bare code as the identity whose name the app holds for it", () => {
		const simplified = { language: "cmn", script: "Hans" };
		expect(
			languageIdentityForHqCode("zh", resolvedLanguageDisplayLabel(simplified)),
		).toEqual(simplified);
		const mexican = { language: "spa", region: "MX" };
		expect(
			languageIdentityForHqCode("es", resolvedLanguageDisplayLabel(mexican)),
		).toEqual(mexican);
		expect(languageIdentityForHqCode("es", "Castellano")).toEqual({
			language: "spa",
		});
	});

	it("reads Swahili's bare code as its predominant member, with or without the name both members share", () => {
		/* `swh` and `swc` both widen to Classic's `sw` and are both named
		 * Kiswahili, so the minter leaves `sw` to Swahili and writes Congo
		 * Swahili's own code. */
		expect(mintLanguageWireCode(new Set(), { language: "swc" })).toBe("swc-");
		expect(languageIdentityForHqCode("sw")).toEqual({ language: "swh" });
		expect(
			languageIdentityForHqCode(
				"sw",
				resolvedLanguageDisplayLabel({ language: "swh" }),
			),
		).toEqual({ language: "swh" });
	});

	it.each<AppLanguageIdentity>([
		{ language: "eng" },
		{ language: "eng", region: "GB" },
		{ language: "spa", region: "MX" },
		{ language: "cmn", script: "Hans" },
		{ language: "cmn", script: "Hant", region: "TW" },
		{ language: "hin" },
		{ language: "fra", region: "CA" },
		{ language: "swh" },
		/* Each shares its preferred spelling and its name with an identity above it in the
		 * registry: Swahili, Iranian Persian, Papiamentu. */
		{ language: "swc" },
		{ language: "prs" },
		{ language: "pap", region: "AW" },
		{ language: "pes" },
		{ language: "pap" },
	])(
		"reads the code Nova writes for %o back to it, alone and beside a language that holds its spelling",
		(identity) => {
			const name = resolvedLanguageDisplayLabel(identity);
			const alone = mintLanguageWireCode(new Set(), identity);
			expect(languageIdentityForHqCode(alone, name)).toEqual(identity);
			/* An identity that leaves its spelling to another of its name is suffixed already. */
			const suffixed = alone.includes("-")
				? alone
				: mintLanguageWireCode(new Set([alone]), identity);
			expect(languageIdentityForHqCode(suffixed, name)).toEqual(identity);
		},
	);
});

describe("readLanguages", () => {
	it("holds each code verbatim as its language's wire code, the first the source and default", async () => {
		const { ctx, findings } = await read(["hin", "en", "pt-br"]);
		expect(findings).toEqual([]);
		expect(ctx.draft.localization).toEqual({
			sourceLanguage: "hin",
			defaultLanguage: "hin",
			languageOrder: ["hin", "eng", "por-BR"],
			translations: { eng: {}, "por-BR": {} },
			wireCodes: { hin: "hin", eng: "en", "por-BR": "pt-br" },
		});
	});

	it("refuses a second code that names a language an earlier one named", async () => {
		const { ctx, findings } = await read(["en", "eng"]);
		expect(findings).toMatchObject([
			{
				code: `${A}/langs-code-nova-s-language-registry-cannot-name`,
				place: { kind: "languages" },
				detail: { name: "eng" },
			},
		]);
		expect(ctx.draft.localization).toBeUndefined();
	});

	it.each<[readonly string[], string, string | undefined]>([
		[
			["en", "EN-us"],
			"a-non-empty-langs-code-outside-that-grammar-or-repeated",
			"EN-us",
		],
		[
			["en", "fr", "en"],
			"a-non-empty-langs-code-outside-that-grammar-or-repeated",
			"en",
		],
		[["en", ""], "langs-containing-an-empty-code", undefined],
		[["en", "xx"], "langs-code-nova-s-language-registry-cannot-name", "xx"],
		[["en", "zh"], "langs-code-nova-s-language-registry-cannot-name", "zh"],
	])(
		"refuses %o under its entry, at the languages place",
		async (codes, entry, name) => {
			const { findings } = await read(codes);
			expect(findings).toEqual([
				expect.objectContaining({
					code: `${A}/${entry}`,
					place: { kind: "languages" },
					detail: name === undefined ? {} : { name },
				}),
			]);
		},
	);

	it("reads a bare macrolanguage code to the script its name in the app says", async () => {
		const simplified = { language: "cmn", script: "Hans" };
		const label = resolvedLanguageDisplayLabel(simplified) ?? "";
		const { ctx, findings } = await read(["en", "zh"], { zh: label });
		expect(findings).toEqual([]);
		expect(ctx.draft.localization?.wireCodes).toEqual({
			eng: "en",
			[languageTag(simplified)]: "zh",
		});
	});

	it("guesses no language into an app that holds none", async () => {
		const { ctx, findings } = await read([]);
		expect(findings).toMatchObject([
			{
				code: "unrecognized",
				place: { kind: "languages" },
				detail: { name: "schema:Application.langs" },
			},
		]);
		expect(ctx.draft.localization).toBeUndefined();
	});
});

/** A one-form survey app, which every language test below changes. */
function survey(appName = "Clinic"): BlueprintDoc {
	return buildDoc({
		appId: "app-1",
		appName,
		modules: [
			{
				name: "Survey",
				forms: [
					{
						name: "Intake",
						type: "survey",
						fields: [{ kind: "text", id: "notes", label: proseText("Notes") }],
					},
				],
			},
		],
	});
}

/** A reading of `doc`'s export, as a re-read of an app Nova holds is told it. */
async function readExport(
	doc: BlueprintDoc,
	overrides: Partial<ReaderInput> = {},
): Promise<Extract<ReadOutcome, { kind: "read" }>> {
	const outcome = readHqApp(
		await inputFor(exportedBody(doc), {
			resolver: matchingResolver(
				"app-1",
				externalIdentityMap(doc, DERIVED_WIRE_IDENTITY),
			),
			recordDialect: recordDialectRoundTrip,
			...overrides,
		}),
	);
	expect(outcome.defects).toEqual([]);
	if (outcome.kind !== "read")
		throw new Error(
			`The export read to an account: ${outcome.findings.map((one) => `${one.code} (${one.detail.name ?? ""})`).join(", ")}`,
		);
	return outcome;
}

describe("a re-read of an app Nova holds", () => {
	it.each<[AppLanguageIdentity, string, AppLanguageIdentity]>([
		[{ language: "swc" }, "sw", { language: "swh" }],
		[{ language: "prs" }, "fas", { language: "pes" }],
		[{ language: "pap", region: "AW" }, "pap", { language: "pap" }],
	])(
		"reads %o, stored under the code %s before its spelling changed, back to it",
		async (identity, code, holder) => {
			const tag = languageTag(identity);
			const doc = produce(survey(), (draft) => {
				applyMutations(draft, [
					{ kind: "addLanguage", language: identity, wireCode: code },
				]);
			});
			expect(doc.localization?.wireCodes[tag]).toBe(code);
			const told = await readExport(doc, {
				knownLanguageCodes: knownLanguageCodesOf(doc),
			});
			expect(told.draft.doc.localization?.wireCodes).toEqual({
				eng: "en",
				[tag]: code,
			});
			/* Told nothing, a reading names the code as the language that holds its spelling now. */
			const untold = await readExport(doc);
			expect(untold.draft.doc.localization?.wireCodes).toEqual({
				eng: "en",
				[languageTag(holder)]: code,
			});
		},
	);
});

describe("a reading whose source is not among its first two languages", () => {
	it("returns a draft whose batch replays to its document", async () => {
		const languages = produce(survey("Clínica"), (draft) => {
			applyMutations(draft, [
				{
					kind: "relabelSourceLanguage",
					language: { language: "spa" },
					wireCode: "es",
				},
				{ kind: "addLanguage", language: { language: "eng" }, wireCode: "en" },
				{ kind: "addLanguage", language: { language: "fra" }, wireCode: "fr" },
				{ kind: "setDefaultLanguage", code: "fra" },
				{ kind: "setDefaultLanguage", code: "eng" },
			]);
		});
		const unit = collectTranslationUnits(languages).find(
			(one) => one.owner.kind === "app",
		);
		if (unit === undefined) throw new Error("The app has a name to translate.");
		/* English and French each name the app their own way, so neither is the source. */
		const doc = produce(languages, (draft) => {
			applyMutations(
				draft,
				(["eng", "fra"] as const).map(
					(language): Mutation => ({
						kind: "setTranslation",
						language,
						unitId: unit.id,
						entry: {
							value: language === "eng" ? "Clinic" : "Clinique",
							sourceFingerprint: unit.sourceFingerprint,
							origin: "human",
							review: "reviewed",
							translatedFrom: "spa",
						},
					}),
				),
			);
		});
		const read = await readExport(doc);
		expect(read.draft.doc.localization).toMatchObject({
			sourceLanguage: "spa",
			defaultLanguage: "eng",
			languageOrder: ["eng", "fra", "spa"],
		});
		const replayed = produce(emptyBlueprintDoc("app-1"), (draft) => {
			applyMutations(draft, [...read.draft.batch]);
		});
		expect(toPersistableDoc(replayed).localization).toEqual(
			toPersistableDoc(read.draft.doc).localization,
		);
	});
});
