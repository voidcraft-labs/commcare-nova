/**
 * An HQ app's languages: `langs`, in order, each code held verbatim as its
 * language's wire code and named by an identity of Nova's language registry.
 * HQ's first language is both the source language, whose text the document's
 * own slots hold, and the default every runtime starts in
 * (`models/applications.py::Application.default_language`).
 */

import {
	type AppLanguageIdentity,
	type AppLocalization,
	isEnglishOnlyLocalization,
	type LanguageTag,
	languageTag,
	languageWireCodeSchema,
} from "@/lib/domain";
import {
	identityIssues,
	regionChoices,
	scriptChoices,
} from "@/lib/domain/languageRegistry";
import { resolvedLanguageDisplayLabel } from "@/lib/domain/languageRegistry/names";
import {
	cutFindingName,
	type FindingDetail,
	type HqPlace,
	type ManifestFinding,
	type Subject,
} from "@/lib/publish/hqFindings";
import {
	languagesOfWireBase,
	lawfulLanguageIdentities,
	mintLanguageWireCode,
} from "../languageWire";
import { inventoryIndex } from "../surface/inventory";
import { type Claim, defineClaims, refuse, take } from "./claims";
import type { ReadContext } from "./context";
import { isJsonObject } from "./jsonCursor";
import { languagesPlace } from "./place";

const AREA = "application-and-settings";
const LANGS = "schema:Application.langs";

const CLAIMS = defineClaims("languages", {
	/** The list, claimed once: its order, and its first code the default. */
	langs: take(`${AREA}/langs-order-langs-0-default`, LANGS),
	emptyCode: refuse(`${AREA}/langs-containing-an-empty-code`, LANGS),
	outsideGrammarOrRepeated: refuse(
		`${AREA}/a-non-empty-langs-code-outside-that-grammar-or-repeated`,
		LANGS,
	),
	cannotName: refuse(
		`${AREA}/langs-code-nova-s-language-registry-cannot-name`,
		LANGS,
	),
});

/** What a reading made of `langs`. */
export interface HqLanguages {
	/** The codes in HQ's order. */
	readonly codes: readonly string[];
	/** Each code the reading named, to its language's tag. */
	readonly tagOf: ReadonlyMap<string, LanguageTag>;
	/** Each code the reading named, to its identity. */
	readonly identityOf: ReadonlyMap<string, AppLanguageIdentity>;
	/** Each code that got a finding, to that finding: what a key under the code stands under. */
	readonly refused: ReadonlyMap<string, ManifestFinding>;
	/** The first code, HQ's default language; undefined where `langs` is empty. */
	readonly first: string | undefined;
}

/** A two-letter suffix as the region it spells, where the language offers it. */
function regionOf(
	language: string,
	script: string | undefined,
	letters: string,
): string | undefined {
	if (letters.length !== 2) return undefined;
	const region = letters.toUpperCase();
	return regionChoices(language, script).some(
		(choice) => choice.region === region,
	)
		? region
		: undefined;
}

/** A four-letter suffix as the script it spells, where the language is written in it. */
function scriptOf(language: string, letters: string): string | undefined {
	if (letters.length !== 4) return undefined;
	const script = `${letters.slice(0, 1).toUpperCase()}${letters.slice(1)}`;
	return scriptChoices(language).some((choice) => choice.script === script)
		? script
		: undefined;
}

/**
 * The identity an HQ language code names, or undefined where Nova's registry
 * names none. The code splits at its first hyphen into a base and a suffix.
 * The base gives the language: the one Nova itself writes the code for
 * (`languageWire.ts::mintLanguageWireCode`, asked of every identity the
 * base names), else the base's own language, a Set 1 alias's, or a
 * macrolanguage's predominant member. The suffix is lower case, since HQ's grammar
 * admits nothing else, so it is read by its length and its letters: two
 * letters a region the language offers, four a script it is written in, six
 * a script then a region offered in that script, the spelling
 * `languageWire.ts::mintLanguageWireCode` writes for an identity holding
 * both; any other suffix adds nothing.
 *
 * A code with no suffix is the spelling `mintLanguageWireCode` writes for
 * any identity while no other language holds it, so it can stand for a
 * script, a region or a macrolanguage's member the code does not spell.
 * There `displayName`, the name the app holds for the code in its first
 * language's strings, chooses: the one identity Nova writes the code for (or,
 * where it writes it for none, the one the base names) whose name Nova gives
 * is that name. Nova writes every language's name there on each publish, and
 * writes a code with no suffix for at most one identity of each name, so an
 * app Nova published reads back to the identities it held. Where no
 * identity's name is that one, the code names the language alone.
 */
export function languageIdentityForHqCode(
	code: string,
	displayName?: string,
): AppLanguageIdentity | undefined {
	const hyphen = code.indexOf("-");
	const base = hyphen < 0 ? code : code.slice(0, hyphen);
	const suffix = hyphen < 0 ? "" : code.slice(hyphen + 1);
	const languages = languagesOfWireBase(base);
	const candidates = languages.flatMap(lawfulLanguageIdentities);
	/* The identities Nova itself writes this code for while no other language
	 * holds it: the production minter, asked of each. */
	const spelled = candidates.filter(
		(identity) => mintLanguageWireCode(new Set(), identity) === code,
	);
	if (hyphen < 0 && displayName !== undefined) {
		const named = (spelled.length > 0 ? spelled : candidates).filter(
			(identity) => resolvedLanguageDisplayLabel(identity) === displayName,
		);
		if (named.length === 1) return named[0];
	}
	const language = spelled[0]?.language ?? languages[0];
	if (language === undefined) return undefined;
	let script: string | undefined;
	let region: string | undefined;
	if (suffix.length === 2) region = regionOf(language, undefined, suffix);
	else if (suffix.length === 4) script = scriptOf(language, suffix);
	else if (suffix.length === 6) {
		const written = scriptOf(language, suffix.slice(0, 4));
		const writtenRegion =
			written === undefined
				? undefined
				: regionOf(language, written, suffix.slice(4));
		if (writtenRegion !== undefined) {
			script = written;
			region = writtenRegion;
		}
	}
	const identity: AppLanguageIdentity = {
		language,
		...(script === undefined ? {} : { script }),
		...(region === undefined ? {} : { region }),
	};
	return identityIssues(identity).length === 0 ? identity : undefined;
}

/**
 * The finding a refusing claim makes, as the accounting makes it, for a node
 * a stage covers by it (`Accounting.cover`): a key under a language code that
 * got a finding, a value whose finding stands at another place.
 */
export function manifestFindingOf(
	claim: Claim,
	place: HqPlace,
	detail: FindingDetail,
): ManifestFinding {
	const entry = inventoryIndex().entry(claim.entry);
	if (
		entry === undefined ||
		entry.subject === null ||
		(entry.standing !== "not-yet" &&
			entry.standing !== "never" &&
			entry.standing !== "fix-in-hq")
	)
		throw new Error(
			`The reader's claim on ${claim.entry} names no entry that makes a finding. Its claims are held to the manifest by claimsBindManifest.test.ts; run it to see which entry moved.`,
		);
	return {
		code: entry.id,
		standing: entry.standing,
		...(entry.standing === "fix-in-hq" && entry.cause !== null
			? { cause: entry.cause }
			: {}),
		place,
		subject: entry.subject as Subject,
		detail: {
			...(detail.name === undefined
				? {}
				: { name: cutFindingName(detail.name) }),
		},
	};
}

/** The name the app holds for `code` in its first language's strings, where it holds one. */
function displayNameOf(
	ctx: ReadContext,
	first: string,
	code: string,
): string | undefined {
	const translations = ctx.app.peek("translations");
	if (!isJsonObject(translations)) return undefined;
	const strings = translations[first];
	if (!isJsonObject(strings)) return undefined;
	const name = strings[code];
	return typeof name === "string" ? name : undefined;
}

/**
 * Reads `langs` in order. The list is one use, claimed once; each code's
 * finding is raised at the languages place with the code as its name: an
 * empty code, a code outside HQ's grammar or one the list holds twice, and a
 * code Nova's registry cannot name or that names a language an earlier code
 * already named. The draft's localization holds every code the reading
 * named, the first named the source and default language.
 */
export function readLanguages(ctx: ReadContext): HqLanguages {
	const place = languagesPlace();
	const raw = ctx.app.peek("langs");
	const tagOf = new Map<string, LanguageTag>();
	const identityOf = new Map<string, AppLanguageIdentity>();
	const refused = new Map<string, ManifestFinding>();
	if (!Array.isArray(raw) || !raw.every((code) => typeof code === "string")) {
		return { codes: [], tagOf, identityOf, refused, first: undefined };
	}
	if (raw.length === 0) {
		/* HQ's pages never leave an app with no language, and HQ falls back
		 * to `en` for one (`Application.default_language`). Nova does not
		 * guess a language into the document. */
		ctx.accounting.circumstance("unrecognized", place, { name: LANGS });
		return { codes: [], tagOf, identityOf, refused, first: undefined };
	}
	const codes = ctx.app.take("langs", CLAIMS.langs, (value) =>
		(value as string[]).slice(),
	).value;
	const first = codes[0];
	const seen = new Set<string>();
	const raise = (claim: Claim, code: string, name: string | undefined) => {
		const detail: FindingDetail = name === undefined ? {} : { name };
		ctx.accounting.finding(claim, place, detail);
		if (!refused.has(code))
			refused.set(code, manifestFindingOf(claim, place, detail));
	};
	for (const code of codes) {
		if (code === "") {
			raise(CLAIMS.emptyCode, code, undefined);
			continue;
		}
		if (!languageWireCodeSchema.safeParse(code).success || seen.has(code)) {
			seen.add(code);
			raise(CLAIMS.outsideGrammarOrRepeated, code, code);
			continue;
		}
		seen.add(code);
		const identity = languageIdentityForHqCode(
			code,
			first === undefined ? undefined : displayNameOf(ctx, first, code),
		);
		const tag = identity === undefined ? undefined : languageTag(identity);
		if (
			identity === undefined ||
			tag === undefined ||
			[...tagOf.values()].includes(tag)
		) {
			raise(CLAIMS.cannotName, code, code);
			continue;
		}
		tagOf.set(code, tag);
		identityOf.set(code, identity);
	}
	const held = codes.flatMap((code) => {
		const tag = tagOf.get(code);
		return tag === undefined || refused.has(code) ? [] : [[tag, code] as const];
	});
	const order = held.map(([tag]) => tag);
	const [source] = order;
	if (source !== undefined) {
		const localization: AppLocalization = {
			sourceLanguage: source,
			defaultLanguage: source,
			languageOrder: order,
			translations: Object.fromEntries(order.slice(1).map((tag) => [tag, {}])),
			wireCodes: Object.fromEntries(held),
		};
		/* English alone, coded `en`, is the absent root: the one spelling a
		 * document holds for it. */
		ctx.writeDraft(() => {
			ctx.draft.localization = isEnglishOnlyLocalization(localization)
				? undefined
				: localization;
		});
	}
	return { codes, tagOf, identityOf, refused, first };
}
