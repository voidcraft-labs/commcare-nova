/**
 * The reader's own defects: what went wrong inside the reader, never a fact
 * of the app it read. Each is returned beside the `unrecognized` finding it
 * stands behind and logged by the request that called the reader, so its
 * line (`ReaderDefectWhy`) holds no word of an app: every constructor below
 * fills one fixed template from closed slots, and nothing else makes a line.
 * A place is written by position alone (`place.ts::placeKey`), a claim by its
 * registered name, an entry by its id, and every other slot from a closed
 * list; a value outside its slot's list is written as the slot's fallback.
 */

import type { core } from "zod";
import { blueprintDocSchema } from "@/lib/domain/blueprint";
import {
	type TranslationUnitRole,
	type TranslationValueIntegrityIssue,
	translationUnitRoles,
} from "@/lib/domain/translationUnits";
import type { HqPlace, ReadStanding } from "@/lib/publish/hqFindings";
import { READ_STANDINGS } from "@/lib/publish/hqFindings";
import { inventoryIndex } from "../surface/inventory";
import type { FormParseIssueCode } from "../xpath/formParseIssues";
import type { FormSyntax } from "../xpath/formSyntax";
import { claimRegistry } from "./claims";
import { EXTERNAL_ENTITY_KINDS, type ExternalEntityKind } from "./identity";
import { placeKey } from "./place";

export const READER_DEFECT_CODES = [
	"claimed-twice",
	"claim-not-permitted",
	"claimed-not-read",
	"identity-met-twice",
	"form-source",
	"xmlns-differs",
	"itemset-column",
	"assembly",
	"unregistered-expression-claim",
	"translation",
	"expression-not-written-back",
	"no-case-datum",
	"emission-threw",
] as const;
export type ReaderDefectCode = (typeof READER_DEFECT_CODES)[number];

/** A defect's line. Only the constructors below return one. */
export type ReaderDefectWhy = string & { readonly __readerDefectWhy: true };

function why(text: string): ReaderDefectWhy {
	return text as ReaderDefectWhy;
}

function claimSlot(claim: string): string {
	return claimRegistry().has(claim) ? claim : "unregistered-claim";
}

function entrySlot(entry: string): string {
	return inventoryIndex().entry(entry) === undefined ? "no-such-entry" : entry;
}

/** The entry a registered claim names, as `entrySlot` writes it. */
function entryOfClaim(claim: string): string {
	const registered = claimRegistry().get(claim);
	return registered === undefined
		? "no-such-entry"
		: entrySlot(registered.entry);
}

function oneOf<T extends string>(
	value: string,
	members: readonly T[],
	fallback: string,
): string {
	return (members as readonly string[]).includes(value) ? value : fallback;
}

function positionSlot(n: number): string {
	return Number.isSafeInteger(n) && n >= 0 ? String(n) : "unknown-position";
}

/** The emitters a reader stage runs over what it read, by name. */
export const EMITTERS = [
	"expandDoc",
	"planFormCaseWire",
	"projectCaseListForHq",
] as const;

const PARSE_ISSUE_CODES = Object.keys({
	syntax: true,
	"unknown-function": true,
	arity: true,
	union: true,
	"filter-root": true,
	axis: true,
	"parent-after-name": true,
	wildcard: true,
	variable: true,
	"instance-unknown": true,
	"instance-argument": true,
	"groups-held": true,
	"form-root": true,
	"unknown-field": true,
	"ambiguous-field": true,
	"relative-unknown": true,
	"relative-above-form": true,
	"relative-no-context": true,
	"case-alias-unbound": true,
	"case-query-untyped": true,
	"case-row-attribute": true,
	"row-step-after-value": true,
	"row-leaves-record": true,
	"unknown-hashtag": true,
	"unknown-search-input": true,
	"search-results-unexcluded": true,
	"search-results-remote": true,
	"unknown-table": true,
	"table-path-mismatch": true,
	"unknown-column": true,
	"lookup-unavailable": true,
	"unknown-level": true,
	"unknown-location-property": true,
	"unknown-datum": true,
	"placeholder-datum": true,
	"multi-select-datum-value": true,
	"unknown-itext": true,
	"choice-name-not-a-select": true,
	"capture-link-not-a-question": true,
} satisfies Record<FormParseIssueCode, true>);

/** The kinds of the one grammar's syntax tree (`xpath/formSyntax.ts`), the
 *  nodes a tree comparison can differ at. */
const GRAMMAR_NODE_KINDS = Object.keys({
	string: true,
	number: true,
	name: true,
	hashtag: true,
	self: true,
	parent: true,
	root: true,
	variable: true,
	group: true,
	negative: true,
	axis: true,
	child: true,
	filter: true,
	binary: true,
	call: true,
} satisfies Record<FormSyntax["kind"], true>);

/** Part of the expression reader's `detail.reason`, written only where it is
 *  one of the three codes of Nova's own. */
function reasonSlot(reason: string): string {
	if (reason === "no-case-datum") return reason;
	const colon = reason.indexOf(":");
	const head = reason.slice(0, colon);
	const tail = reason.slice(colon + 1);
	if (colon > 0 && head === "parse" && PARSE_ISSUE_CODES.includes(tail))
		return reason;
	if (colon > 0 && head === "differs" && GRAMMAR_NODE_KINDS.includes(tail))
		return reason;
	return "unknown-reason";
}

const DOCUMENT_KEYS: readonly string[] = Object.keys(blueprintDocSchema.shape);

/** Zod's issue codes, the only `<issue code>` a line writes. */
const ZOD_ISSUE_CODES = Object.keys({
	invalid_type: true,
	too_big: true,
	too_small: true,
	invalid_format: true,
	not_multiple_of: true,
	unrecognized_keys: true,
	invalid_union: true,
	invalid_key: true,
	invalid_element: true,
	invalid_value: true,
	custom: true,
} satisfies Record<core.$ZodIssueCode, true>);

/** The integrity issues of a written translation, the only `<issue>` a line writes. */
const TRANSLATION_ISSUES = Object.keys({
	"value-kind": true,
	"blank-content": true,
	"protected-content": true,
} satisfies Record<TranslationValueIntegrityIssue, true>);

export const readerDefect = {
	/** `first` and `second` are names `claims.ts::claimRegistry()` holds. */
	claimedTwice(place: HqPlace, first: string, second: string): ReaderDefectWhy {
		return why(
			`claimed twice at ${placeKey(place)}: first by ${claimSlot(first)}, then by ${claimSlot(second)}`,
		);
	},
	/** `standing` is null where the index holds no entry for the claim. */
	claimNotPermitted(
		place: HqPlace,
		claim: string,
		standing: ReadStanding | null,
	): ReaderDefectWhy {
		const written =
			standing === null
				? "no-standing"
				: oneOf(standing, READ_STANDINGS, "no-standing");
		return why(
			`claim ${claimSlot(claim)} at ${placeKey(place)} is not permitted by ${entryOfClaim(claim)}, which is now ${written}`,
		);
	},
	claimedNotRead(place: HqPlace, claim: string): ReaderDefectWhy {
		return why(
			`claimed and not read at ${placeKey(place)}: ${claimSlot(claim)}`,
		);
	},
	identityMetTwice(place: HqPlace, kind: ExternalEntityKind): ReaderDefectWhy {
		return why(
			`identity met twice at ${placeKey(place)}: a ${oneOf(kind, EXTERNAL_ENTITY_KINDS, "unknown-kind")} key`,
		);
	},
	formSource(
		place: HqPlace,
		kind: "xml-version" | "malformed",
	): ReaderDefectWhy {
		return why(
			`form source at ${placeKey(place)}: Nova's parser answered ${oneOf(kind, ["xml-version", "malformed"], "unknown-kind")}`,
		);
	},
	xmlnsDiffers(place: HqPlace): ReaderDefectWhy {
		return why(
			`xmlns differs between the form and its source at ${placeKey(place)}`,
		);
	},
	itemsetColumn(place: HqPlace, ref: "value" | "label"): ReaderDefectWhy {
		return why(
			`itemset column at ${placeKey(place)}: the ${oneOf(ref, ["value", "label"], "unknown-ref")} ref names a column the catalog lacks`,
		);
	},
	/** `issue` is the first issue of the document schema's parse. */
	assembly(
		place: HqPlace,
		issue: { readonly path: readonly PropertyKey[]; readonly code: string },
	): ReaderDefectWhy {
		const top = issue.path[0];
		const key =
			typeof top === "string" && DOCUMENT_KEYS.includes(top) ? top : "root";
		return why(
			`assembly at ${placeKey(place)}: ${key}: ${oneOf(issue.code, ZOD_ISSUE_CODES, "unknown-code")}`,
		);
	},
	unregisteredExpressionClaim(place: HqPlace, entry: string): ReaderDefectWhy {
		return why(
			`expression claim at ${placeKey(place)} names ${entrySlot(entry)}, which no registered claim holds`,
		);
	},
	/** `language` is the language's 0-based position among the app's languages. */
	translation(
		place: HqPlace,
		role: TranslationUnitRole,
		language: number,
		issue: TranslationValueIntegrityIssue,
	): ReaderDefectWhy {
		return why(
			`translation at ${placeKey(place)}: ${oneOf(role, translationUnitRoles, "unknown-role")}, language ${positionSlot(language)}: ${oneOf(issue, TRANSLATION_ISSUES, "unknown-issue")}`,
		);
	},
	/** `reason` is the row's `detail.reason`, one of the expression reader's codes. */
	expressionNotWrittenBack(place: HqPlace, reason: string): ReaderDefectWhy {
		return why(
			`Nova read an expression from CommCare HQ and could not write the same expression back, at ${placeKey(place)}: ${reasonSlot(reason)}. Nova treats the spellings in \`lib/commcare/reader/syntaxCompare.ts\` as one; this one needs a row there with a native vector, or a manifest entry that names it.`,
		);
	},
	/** Nova's own emitter, run over what the reader built, threw: the reader built a document the
	 *  emitter cannot write, which is the reader's to fix. */
	emissionThrew(place: HqPlace, emitter: string): ReaderDefectWhy {
		return why(
			`Nova read part of an app from CommCare HQ and its own writer could not write that part back, at ${placeKey(place)}: ${oneOf(emitter, EMITTERS, "another-emitter")} threw. The reader built something Nova's documents never hold; check what the stages before it made of this place.`,
		);
	},
	noCaseDatum(place: HqPlace): ReaderDefectWhy {
		return why(
			`Nova couldn't find the session value that holds the case this form opens with, at ${placeKey(place)}, so it can't read the form's display condition as CommCare HQ builds it. CommCare HQ treats the form as one that opens on a case and Nova's reading of its menu and case operations does not; check what the case management reader made of this form.`,
		);
	},
} as const;

/** The code each constructor of `readerDefect` makes, in `READER_DEFECT_CODES` order. */
export const READER_DEFECT_CONSTRUCTORS = {
	"claimed-twice": "claimedTwice",
	"claim-not-permitted": "claimNotPermitted",
	"claimed-not-read": "claimedNotRead",
	"identity-met-twice": "identityMetTwice",
	"form-source": "formSource",
	"xmlns-differs": "xmlnsDiffers",
	"itemset-column": "itemsetColumn",
	assembly: "assembly",
	"unregistered-expression-claim": "unregisteredExpressionClaim",
	translation: "translation",
	"expression-not-written-back": "expressionNotWrittenBack",
	"no-case-datum": "noCaseDatum",
	"emission-threw": "emissionThrew",
} as const satisfies Record<ReaderDefectCode, keyof typeof readerDefect>;
