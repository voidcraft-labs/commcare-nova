/**
 * A form's text table: its itext, read by reference. A control's or a bind's
 * `jr:itext('id')` names an entry whatever the id's spelling, since Vellum's
 * ids are free text an author can rename and share and Nova writes its own
 * (`xform/itextIds.ts`). The table holds each text's `value` elements by app
 * language and form name; the owners are the slots that reference each id,
 * which the prose reader records as it reads the references. A text no slot
 * references is settled here once every reference is read.
 */

import type { Element } from "domhandler";
import { isTag } from "domhandler";
import type { LanguageTag } from "@/lib/domain";
import type { HqPlace } from "@/lib/publish/hqFindings";
import surface from "../../surface/surface.json";
import {
	attributeNamespace,
	elementNamespace,
	type NamespaceScope,
	splitName,
	VELLUM_NS,
	XFORMS_NS,
} from "../../xmlNamespaces";
import type { FormSyntax } from "../../xpath/formSyntax";
import type { Accounting } from "../accounting";
import type { HqLanguages } from "../languages";
import { readFormSyntax } from "../syntaxRead";
import type { ItextRecipient } from "../types";
import type { XmlCursor } from "../xmlCursor";
import { X } from "./claims";
import type { DraftField } from "./index";
import type { StandingRefusal } from "./refusals";

/** The seven pragma keys the manifest names: ids CommCare reads as settings of the form. */
export const PRAGMA_KEYS = [
	"Pragma-Form-Descriptor",
	"Pragma-Skip-Full-Form-Validation",
	"Pragma-Submit-Automatically",
	"Pragma-Suppress-Autosync",
	"Pragma-Volatility-Key",
	"Pragma-Volatility-Entity-Title",
	"Pragma-Volatility-Window",
] as const;

const PRAGMAS: ReadonlySet<string> = new Set(PRAGMA_KEYS);

/** A text's slot on the field that references it. */
export type TextSlot = Exclude<ItextRecipient["slot"], "option_label">;

/** One slot that references a text. */
export interface ItextOwner {
	readonly field: DraftField;
	readonly slot: TextSlot | "option_label";
	/** For a choice's label, the option's position in the field's inline options. */
	readonly option?: number;
}

export function itextRecipient(
	owner: ItextOwner,
	language: LanguageTag,
): ItextRecipient {
	const choices = owner.field.field.optionsSource as
		| { options?: readonly { value: string }[] }
		| undefined;
	const choiceValue = choices?.options?.[owner.option ?? -1]?.value ?? null;
	if (owner.slot === "option_label" && choiceValue === null) {
		throw new Error(
			"A choice's itext has no saved value in the options the form reader accepted.",
		);
	}
	return {
		fieldPath: owner.field.node.path,
		slot: owner.slot,
		language,
		choiceValue,
	};
}

export interface ItextTable {
	/** A text's `value` elements by app language and form name (`default` for none). */
	values(
		id: string,
	): ReadonlyMap<LanguageTag, ReadonlyMap<string, Element>> | undefined;
	/** The slots that reference a text id, in document order. */
	owners(id: string): readonly ItextOwner[];
	/** Every text id of the source, for the table of texts no slot references. */
	ids(): readonly string[];
}

/** The table while the form stage reads it: the owners are recorded as references are read. */
export interface ItextReading extends ItextTable {
	/** A text's `text` element in each app language that holds one. */
	texts(id: string): ReadonlyMap<LanguageTag, Element>;
	/** Records a slot that references `id`. */
	own(id: string, owner: ItextOwner): void;
	/** Each language's `value` elements of every form, in document order: what the form-name
	 *  table claims. */
	allValues(id: string): ReadonlyMap<LanguageTag, readonly Element[]>;
	/** The source language's tag (`HqLanguages.source`): the language whose text a slot holds. */
	readonly source: LanguageTag | undefined;
	/** The form's default language: the app's first where the form holds its translation, else
	 *  the first translation the form holds, in document order. That is the translation HQ's
	 *  build marks default (`xform.py::XForm.exclude_languages` keeps the build languages' in
	 *  their order, `set_default_language(langs[0])` marks `langs[0]`'s where there is one) or,
	 *  where none is marked, the one Core takes (`XFormParser.parseIText`, the first available
	 *  locale). A text id it lacks is fatal (`XFormParser.verifyTextMappings`); every other
	 *  language shows its text where its own holds none (`Localizer.getLocaleData`,
	 *  `FormDef.initLocale`), and the form builder fills a blank value from it. */
	readonly defaultLanguage: LanguageTag | undefined;
	/** The tags of the languages the reading named, in HQ's order. */
	readonly languages: readonly LanguageTag[];
	/** Whether HQ's build refuses a question's or choice's label that references `id`: its
	 *  `text` in the source's first `<translation>` holds no `value` without a `form`. HQ's build
	 *  reads every label of the stored source in that translation whatever its language
	 *  (`models/forms.py::FormBase.cached_get_questions` passes no languages, so
	 *  `xform.py::XForm._get_label_text` calls `localize(ref, None)`, which takes the first key of
	 *  `translations()`, an `OrderedDict` by `lang` whose value is the last translation of that
	 *  `lang`) and raises "has no <value>" for such a text (`XForm.localize`), which
	 *  `helpers/validators.py` makes a build error. A label that translation holds no `text` of
	 *  builds. */
	buildRefusesLabel(id: string): boolean;
	/** Whether a translation holds two texts of `id`, which are refused at the form: a reference
	 *  to it stands under that refusal. */
	duplicated(id: string): boolean;
	/** Each `text` of `id` a translation for a language the app does not hold carries: dropped,
	 *  and still parsed by Core, so each output's value makes the uses its syntax makes. */
	otherLanguageTexts(id: string): readonly Element[];
}

/** The table of a source that holds no text: no id, no value, no owner. */
export const EMPTY_ITEXT_TABLE: ItextTable = Object.freeze({
	values: () => undefined,
	owners: () => [],
	ids: () => [],
});

export interface ReadItextInput {
	readonly itext: Element | undefined;
	readonly scope: (element: Element) => NamespaceScope;
	readonly cursor: XmlCursor;
	readonly accounting: Accounting;
	readonly formPlace: HqPlace;
	readonly languages: HqLanguages;
}

function xformsChildren(
	element: Element,
	scope: (element: Element) => NamespaceScope,
	local: string,
): Element[] {
	return element.children
		.filter(isTag)
		.filter(
			(child) =>
				elementNamespace(child, scope(child)) === XFORMS_NS &&
				splitName(child.name).local === local,
		);
}

/** Every element and attribute of a subtree, the root first. */
function* subtreeNodes(
	element: Element,
): Generator<{ readonly element: Element; readonly attribute?: string }> {
	yield { element };
	for (const attribute of Object.keys(element.attribs))
		if (attribute !== "xmlns" && !attribute.startsWith("xmlns:"))
			yield { element, attribute };
	for (const child of element.children)
		if (isTag(child)) yield* subtreeNodes(child);
}

/**
 * Reads `itext` into a table. A translation of one of the app's languages is
 * read as that language's texts; one of a language the reading refused stands
 * under that language's finding; one of any other language is inert. Two
 * texts of one id in one translation are refused at the form, and neither is
 * read.
 */
const TEXT = "xform:model/itext/translation/text";
const VALUE = `${TEXT}/value`;

/** Each runtime's surface item for an itext form a value names, by the form: what Core, Android
 *  and HQ's own reader each read of it. */
const ITEXT_FORM_ITEMS: ReadonlyMap<string, readonly string[]> = (() => {
	const items = new Map<string, string[]>();
	for (const key of Object.keys(
		(surface as unknown as { readonly items: Record<string, unknown> }).items,
	)) {
		if (!key.startsWith("itext-form:")) continue;
		const form = key.slice(key.indexOf("/") + 1);
		items.set(form, [...(items.get(form) ?? []), key]);
	}
	return items;
})();

/**
 * Records, under the drop of a translation for a language the app does not hold, each node of it
 * Core reads where the lane names it: the translation, each text and its id, each value and the
 * form it names, each output, its namespace, its value and its form builder shadow. The drop
 * reads none of it; Core parses every translation as the form opens.
 */
function recordOtherLanguage(
	cursor: XmlCursor,
	translation: Element,
	scope: (element: Element) => NamespaceScope,
): void {
	const claim = X.translationOtherLanguage;
	cursor.within({ element: translation }, claim, [
		"xform:model/itext/translation",
	]);
	for (const text of xformsChildren(translation, scope, "text")) {
		cursor.within({ element: text }, claim, [TEXT]);
		cursor.within({ element: text, attribute: "id" }, claim, [`${TEXT}@id`]);
		for (const value of xformsChildren(text, scope, "value")) {
			cursor.within({ element: value }, claim, [VALUE]);
			const form = value.attribs.form;
			if (form !== undefined) {
				const at = { element: value, attribute: "form" };
				cursor.within(at, claim, [`${VALUE}@form`]);
				for (const item of ITEXT_FORM_ITEMS.get(form) ?? [])
					cursor.within(at, claim, [item]);
			}
			for (const output of xformsChildren(value, scope, "output")) {
				cursor.within({ element: output }, claim, [`${VALUE}/output`]);
				cursor.within({ element: output, attribute: "xmlns" }, claim, [
					`${VALUE}/*@xmlns`,
				]);
				for (const attribute of Object.keys(output.attribs)) {
					const shadow =
						attributeNamespace(attribute, scope(output)) === VELLUM_NS;
					const named = splitName(attribute).local;
					if (shadow && named === "value")
						cursor.within({ element: output, attribute }, claim, [
							"vellum-markup:output@vellum:value",
						]);
					else if (!shadow && (named === "value" || named === "ref"))
						cursor.within({ element: output, attribute }, claim, [
							`${VALUE}/output@${named}`,
						]);
				}
			}
		}
	}
}

export function readItext(input: ReadItextInput): ItextReading {
	const { cursor, accounting, formPlace, languages, scope } = input;
	const values = new Map<string, Map<LanguageTag, Map<string, Element>>>();
	const every = new Map<string, Map<LanguageTag, Element[]>>();
	const texts = new Map<string, Map<LanguageTag, Element>>();
	const owners = new Map<string, ItextOwner[]>();
	const ids: string[] = [];
	const duplicated = new Set<string>();
	const otherLanguage = new Map<string, Element[]>();
	const seenLanguages = new Set<string>();
	/** The tags of the translations read, in document order. */
	const held: LanguageTag[] = [];
	const tags = languages.codes
		.filter((code) => !languages.refused.has(code))
		.map((code) => languages.tagOf.get(code))
		.filter((tag): tag is LanguageTag => tag !== undefined);
	const source =
		languages.source === undefined
			? undefined
			: languages.tagOf.get(languages.source);

	const translations =
		input.itext === undefined
			? []
			: xformsChildren(input.itext, scope, "translation");
	for (const translation of translations) {
		const code = translation.attribs.lang;
		if (code === undefined || !languages.codes.includes(code)) {
			cursor.dropSubtree(translation, X.translationOtherLanguage);
			recordOtherLanguage(cursor, translation, scope);
			for (const text of xformsChildren(translation, scope, "text")) {
				const id = text.attribs.id;
				if (id === undefined) continue;
				otherLanguage.set(id, [...(otherLanguage.get(id) ?? []), text]);
			}
			continue;
		}
		const refused = languages.refused.get(code);
		if (refused !== undefined) {
			// The translation of a refused language, its texts' own text with it, stands under
			// that language's finding.
			for (const node of subtreeNodes(translation)) {
				accounting.cover(node, refused);
				if (node.attribute === undefined) accounting.claimText(node.element);
			}
			continue;
		}
		const tag = languages.tagOf.get(code);
		if (tag === undefined || seenLanguages.has(code)) continue;
		seenLanguages.add(code);
		held.push(tag);
		cursor.derived({ element: translation }, X.translationElement);
		cursor.take({ element: translation, attribute: "lang" }, X.translationLang)
			.value;
		cursor.drop(
			{ element: translation, attribute: "default" },
			X.itextIds.default,
		);
		const byId = new Map<string, Element[]>();
		for (const text of xformsChildren(translation, scope, "text")) {
			const id = text.attribs.id;
			if (id === undefined) continue;
			const known = byId.get(id);
			if (known === undefined) byId.set(id, [text]);
			else known.push(text);
		}
		for (const [id, held] of byId) {
			if (held.length > 1) {
				duplicated.add(id);
				for (const text of held)
					cursor.refuseSubtree(text, X.duplicateTextId, formPlace);
				continue;
			}
			const text = held[0] as Element;
			if (!ids.includes(id)) ids.push(id);
			const byLanguage = texts.get(id) ?? new Map<LanguageTag, Element>();
			texts.set(id, byLanguage);
			byLanguage.set(tag, text);
			const forms = new Map<string, Element>();
			const all: Element[] = [];
			for (const value of xformsChildren(text, scope, "value")) {
				all.push(value);
				const form = value.attribs.form ?? "default";
				if (!forms.has(form)) forms.set(form, value);
			}
			const valuesOf =
				values.get(id) ?? new Map<LanguageTag, Map<string, Element>>();
			values.set(id, valuesOf);
			valuesOf.set(tag, forms);
			const everyOf = every.get(id) ?? new Map<LanguageTag, Element[]>();
			every.set(id, everyOf);
			everyOf.set(tag, all);
		}
	}

	// The texts HQ's build reads a label in and finds no `value` without a `form` in: the last
	// translation of the first translation's `lang` (`translations()` keeps the key's first place
	// and the last element under it).
	const firstLang = translations[0]?.attribs.lang;
	const hqFirst =
		firstLang === undefined
			? undefined
			: translations.filter((t) => t.attribs.lang === firstLang).at(-1);
	const labelRefused = new Set<string>();
	if (hqFirst !== undefined)
		for (const text of xformsChildren(hqFirst, scope, "text")) {
			const id = text.attribs.id;
			if (
				id !== undefined &&
				!xformsChildren(text, scope, "value").some(
					(value) => value.attribs.form === undefined,
				)
			)
				labelRefused.add(id);
		}

	return {
		buildRefusesLabel: (id) => labelRefused.has(id),
		duplicated: (id) => duplicated.has(id),
		otherLanguageTexts: (id) => otherLanguage.get(id) ?? [],
		values: (id) => values.get(id),
		owners: (id) => owners.get(id) ?? [],
		ids: () => ids,
		texts: (id) => texts.get(id) ?? new Map(),
		allValues: (id) => every.get(id) ?? new Map(),
		own(id, owner) {
			const known = owners.get(id);
			if (known === undefined) owners.set(id, [owner]);
			else known.push(owner);
		},
		source,
		defaultLanguage:
			tags[0] !== undefined && held.includes(tags[0])
				? tags[0]
				: (held[0] ?? tags[0]),
		languages: tags,
	};
}

/** What a reference's text names: an id, or why it names none. */
export type ItextReference =
	| { readonly kind: "id"; readonly id: string }
	/** `jr:itext("…")`: the argument between double quotes, which HQ's build reads as another id. */
	| { readonly kind: "double-quoted"; readonly id: string }
	/** Any other text: no call of `jr:itext` with one string argument. */
	| { readonly kind: "other" };

/** The id a `ref` or a `jr:constraintMsg` names, read with the XPath grammar. */
export function itextReference(text: string): ItextReference {
	const read = readFormSyntax(text);
	const node = read.ok ? read.node : undefined;
	if (
		node?.kind !== "call" ||
		node.name !== "jr:itext" ||
		node.args.length !== 1 ||
		node.args[0]?.kind !== "string"
	)
		return { kind: "other" };
	const argument = node.args[0] as Extract<FormSyntax, { kind: "string" }>;
	return text.charAt(argument.from) === '"'
		? { kind: "double-quoted", id: argument.value }
		: { kind: "id", id: argument.value };
}

/** Every id an expression reads through `jr:itext` with one string argument. */
export function itextIdsRead(text: string, into: Set<string>): void {
	const read = readFormSyntax(text);
	if (!read.ok || read.node === undefined) return;
	const walk = (node: FormSyntax): void => {
		switch (node.kind) {
			case "call":
				if (
					node.name === "jr:itext" &&
					node.args.length === 1 &&
					node.args[0]?.kind === "string"
				)
					into.add(node.args[0].value);
				for (const arg of node.args) walk(arg);
				return;
			case "group":
			case "negative":
				walk(node.value);
				return;
			case "axis":
				walk(node.value);
				return;
			case "child":
				if (node.left !== undefined) walk(node.left);
				walk(node.step);
				return;
			case "filter":
				walk(node.base);
				walk(node.where);
				return;
			case "binary":
				walk(node.left);
				walk(node.right);
				return;
			default:
				return;
		}
	};
	walk(read.node);
}

/**
 * The text@id claim of a referenced text: its pragma row where the id is a pragma
 * key, else the inert id. `merged` says whether another text holds equal values in
 * every translation and form under an id that sorts before it.
 */
function claimReferencedId(
	reading: ItextReading,
	id: string,
	cursor: XmlCursor,
	place: HqPlace,
): void {
	const elements = [...reading.texts(id).values()];
	if (!PRAGMAS.has(id)) {
		for (const text of elements)
			cursor.drop({ element: text, attribute: "id" }, X.itextIds.id);
		return;
	}
	const claim = pragmaClaim(reading, id);
	for (const text of elements) {
		if (claim.use === "account")
			cursor.account({ element: text, attribute: "id" }, claim, place);
		else
			cursor.refuse(
				{ element: text, attribute: "id" },
				claim as typeof X.pragmaKey,
				place,
			);
	}
}

/** Two values alike node for node: the same text nodes and the same elements (an `<output>`
 *  among them) with the same attributes. */
export function sameValueNodes(a: Element, b: Element): boolean {
	if (a.children.length !== b.children.length) return false;
	return a.children.every((child, index) => {
		const other = b.children[index];
		if (other === undefined || other.type !== child.type) return false;
		if (child.type === "text")
			return other.type === "text" && child.data === other.data;
		if (!isTag(child) || !isTag(other)) return true;
		if (child.name !== other.name) return false;
		const left = Object.entries(child.attribs);
		return (
			left.length === Object.keys(other.attribs).length &&
			left.every(([name, value]) => other.attribs[name] === value) &&
			sameValueNodes(child, other)
		);
	});
}

function pragmaClaim(
	reading: ItextReading,
	id: string,
):
	| typeof X.pragmaMerged
	| typeof X.pragmaVolatilityWithoutKey
	| typeof X.pragmaFormDescriptor
	| typeof X.pragmaKey {
	const mine = reading.allValues(id);
	const merged = reading.ids().some((other) => {
		if (other === id || other >= id) return false;
		const theirs = reading.allValues(other);
		if (theirs.size !== mine.size) return false;
		for (const [language, values] of mine) {
			const held = theirs.get(language);
			if (held === undefined || held.length !== values.length) return false;
			for (const [index, value] of values.entries()) {
				const twin = held[index] as Element;
				if (
					(value.attribs.form ?? "") !== (twin.attribs.form ?? "") ||
					!sameValueNodes(value, twin)
				)
					return false;
			}
		}
		return true;
	});
	if (merged) return X.pragmaMerged;
	if (
		(id === "Pragma-Volatility-Entity-Title" ||
			id === "Pragma-Volatility-Window") &&
		!reading.ids().includes("Pragma-Volatility-Key")
	)
		return X.pragmaVolatilityWithoutKey;
	if (id === "Pragma-Form-Descriptor") return X.pragmaFormDescriptor;
	return X.pragmaKey;
}

/**
 * Settles every text once the references are read: a referenced text's `id` by
 * its pragma row or as inert; a text no slot references by whether an
 * expression reads it, whether its id is a pragma key, or as inert. `elsewhere`
 * holds the ids a control or a bind outside every field references: a text whose
 * every such reference stands under a refusal (a refused question's label, hint,
 * help or message, a refused choice's label) belongs to what was refused and
 * stands under that refusal; any other is a node Nova generates, whose reader
 * claims it.
 */
export function settleItext(
	reading: ItextReading,
	input: {
		readonly cursor: XmlCursor;
		readonly formPlace: HqPlace;
		/** The place of the first slot that references each id. */
		readonly placeOf: (owner: ItextOwner) => HqPlace;
		readonly readByExpressions: ReadonlySet<string>;
		readonly elsewhere: ReadonlySet<string>;
		/** The refusal every reference of an id stands under, where each stands under one. */
		readonly refusedReferences: (id: string) => StandingRefusal | undefined;
	},
): void {
	const { cursor, formPlace } = input;
	for (const id of reading.ids()) {
		const owners = reading.owners(id);
		const first = owners[0];
		if (first !== undefined) {
			claimReferencedId(reading, id, cursor, input.placeOf(first));
			continue;
		}
		if (input.elsewhere.has(id)) {
			const refusal = input.refusedReferences(id);
			if (refusal !== undefined)
				for (const text of reading.texts(id).values())
					cursor.refuseSubtree(
						text,
						refusal.claim,
						refusal.place,
						refusal.detail,
					);
			continue;
		}
		for (const text of reading.texts(id).values()) {
			if (input.readByExpressions.has(id))
				cursor.refuseSubtree(text, X.expressionOnlyText, formPlace);
			else if (PRAGMAS.has(id))
				cursor.refuseSubtree(text, X.unreferencedPragma, formPlace);
			else cursor.dropSubtree(text, X.unreferencedText);
		}
	}
}
