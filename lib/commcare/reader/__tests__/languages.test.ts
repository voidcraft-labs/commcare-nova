/**
 * An HQ app's language codes read into Nova's language identities.
 *
 * It would catch `en` beside `eng` held as two languages; a macrolanguage's
 * code read to no identity; a code HQ's grammar refuses, an empty one or a
 * repeated one held; `pt-br`, `zh-hans` and `cmn-hanttw` read without their
 * region or script, since the suffix is lower case; and a code Nova itself
 * wrote for an identity read back to another identity, which would make an
 * app Nova published read back as a different app.
 */

import { describe, expect, it } from "vitest";
import { type AppLanguageIdentity, languageTag } from "@/lib/domain";
import { resolvedLanguageDisplayLabel } from "@/lib/domain/languageRegistry/names";
import { mintLanguageWireCode } from "../../languageWire";
import { languageIdentityForHqCode, readLanguages } from "../languages";
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

	it.each<AppLanguageIdentity>([
		{ language: "eng" },
		{ language: "eng", region: "GB" },
		{ language: "spa", region: "MX" },
		{ language: "cmn", script: "Hans" },
		{ language: "cmn", script: "Hant", region: "TW" },
		{ language: "hin" },
		{ language: "fra", region: "CA" },
	])(
		"reads the code Nova writes for %o back to it, alone and beside a language that holds its spelling",
		(identity) => {
			const name = resolvedLanguageDisplayLabel(identity);
			const alone = mintLanguageWireCode(new Set(), identity);
			expect(languageIdentityForHqCode(alone, name)).toEqual(identity);
			const suffixed = mintLanguageWireCode(new Set([alone]), identity);
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
