/**
 * Agreement with CommCare HQ's own question summary: HQ reads each form of
 * the source itself (`corehq/apps/api/resources/v0_4.py::ApplicationResource
 * .dehydrate_module`, calling `xform.py::XForm.get_questions`), a second
 * parse of the same bytes by other code, and the reading's document must say
 * what it says. It is compared with the document, never with Nova's
 * emission: no CommCare HQ has summarized the emission.
 *
 * It compares paths, the repeat and group around a control, choice values,
 * label and choice text per language where HQ summarized one, ids, whether a
 * question is always required, and whether a display condition, a validation
 * and a Hidden Value's calculation are there. It compares no type: identity
 * agreement holds every input of HQ's type lookup.
 *
 * Pure.
 */

import type { ChildNode } from "domhandler";
import type { HqQuestionSummary } from "@/lib/commcare/hq/application";
import type { HqAlignedModule } from "@/lib/commcare/hq/appReading";
import type { HqAppSource } from "@/lib/commcare/hq/appSource";
import type {
	ControlAsWritten,
	SourceIdentity,
} from "@/lib/commcare/hq/sourceIdentity";
import { commCareLocalization } from "@/lib/commcare/localization";
import type { ReadDraft } from "@/lib/commcare/reader/types";
import { literalOutputText } from "@/lib/commcare/reader/xform/prose";
import { buildLabelNodes } from "@/lib/commcare/xform/builder";
import { collectFieldLocations } from "@/lib/commcare/xform/caseOps";
import { isConsumerWhitespace } from "@/lib/commcare/xform/consumerWhitespace";
import type { FormPath } from "@/lib/commcare/xform/formPath";
import { InstanceSink } from "@/lib/commcare/xpath/wire/instances";
import { orderedFieldUuids } from "@/lib/doc/fieldWalk";
import type {
	BlueprintDoc,
	Field,
	FieldKind,
	ProseTemplate,
	Uuid,
} from "@/lib/domain";
import {
	caseCreateNameFields,
	caseScalarTextGuardIsChecked,
	caseScalarTextGuards,
} from "@/lib/domain/caseScalarTextGuard";
import { formConnectIds } from "@/lib/domain/connectIds";
import { formStructure } from "@/lib/domain/expression/formStructure";
import type { Expression } from "@/lib/domain/expression/types";
import { makeTranslationUnitId } from "@/lib/domain/localization";
import { effectiveQueryRepeatPlacement } from "@/lib/domain/queryRepeatPlacement";
import { snapshotTranslationUnits } from "@/lib/domain/translationUnits";
import type { HqPlace } from "@/lib/publish/hqFindings";
import { canonicalJsonText } from "@/lib/utils/canonicalJsonText";
import { adoptedIdentityRows } from "../adoption";
import type { AcceptanceDifference } from "./acceptance";
import { differenceSignature } from "./signature";
import { sourcePlaces } from "./sourcePlaces";

export interface DocumentSummaryRow {
	readonly path: string;
	/** For a field with a control. Null for a Hidden Value, which the comparison does not compare. */
	readonly repeat: string | null;
	/** For a field with a control. Null for a Hidden Value, which the comparison does not compare. */
	readonly group: string | null;
	/** The field's kind, for a signature. */
	readonly kind: FieldKind;
	readonly alwaysRequired: boolean;
	readonly hasRelevant: boolean;
	readonly hasConstraint: boolean;
	/** For a Hidden Value. */
	readonly hasCalculate: boolean;
	/** The label per language, in the summary's pieces; a language with no text is absent. */
	readonly label: Readonly<Record<string, SummaryText>>;
	/** Inline choices in order, or null. */
	readonly options:
		| readonly {
				readonly value: string;
				readonly label: Readonly<Record<string, SummaryText>>;
		  }[]
		| null;
	readonly fieldUuid: Uuid;
}

/** HQ's row of a node with no control. */
const DATA_BIND_ONLY = "DataBindOnly";

/** What `XForm._get_label_translations` prints for an `<output>` (`ItextValue._render`). */
const OUTPUT_HOLE = "____";

const XFORM_MODE = { target: "xform", constraint: false } as const;

const UNICODE_WHITE_SPACE = /\p{White_Space}/u;

/**
 * A text with every character a consumer reads as whitespace removed
 * (`consumerWhitespace.ts::isConsumerWhitespace`, and every other Unicode
 * white space character). Core drops a whitespace-only text node before it
 * reads a text and lxml keeps it, so whitespace is where the two parses
 * differ without the reading being wrong.
 */
export function normalizedText(text: string): string {
	let out = "";
	for (const character of text)
		if (
			!isConsumerWhitespace(character) &&
			!UNICODE_WHITE_SPACE.test(character)
		)
			out += character;
	return out;
}

/**
 * A piece of a document's text as CommCare HQ's summary may render it:
 * `text` is rendered as it stands, a reference or a calculated value as the
 * hole `____`; `literal` is a run Nova writes as a literal output (a protected
 * whitespace run, a bracket after `instance`), which a source Nova wrote holds
 * as an output, rendered `____`, and a source made in CommCare HQ holds as
 * the plain text it spells. Each piece's text is normalized.
 */
export type SummaryPiece =
	| { readonly kind: "text"; readonly text: string }
	| { readonly kind: "literal"; readonly text: string };

/** A document's text in one language, as pieces; a text with no piece shows nothing. */
export type SummaryText = readonly SummaryPiece[];

/**
 * A run of literal prose as the emitter writes it (`builder.ts::buildLabelNodes`),
 * in pieces: each text node as text, each output as the literal it spells
 * (`reader/xform/prose.ts::literalOutputText`).
 */
function literalPieces(nodes: readonly ChildNode[]): SummaryPiece[] {
	const pieces: SummaryPiece[] = [];
	for (const node of nodes) {
		if (node.type === "text") pieces.push({ kind: "text", text: node.data });
		else if (node.type === "tag" && node.name === "output") {
			const spelled = literalOutputText(node.attribs.value ?? "");
			pieces.push(
				spelled === undefined
					? { kind: "text", text: OUTPUT_HOLE }
					: { kind: "literal", text: spelled },
			);
		}
	}
	return pieces;
}

/** Pieces normalized, empty text dropped and neighbouring text joined. */
function normalizedPieces(pieces: readonly SummaryPiece[]): SummaryText {
	const out: SummaryPiece[] = [];
	for (const piece of pieces) {
		const text = normalizedText(piece.text);
		const last = out.at(-1);
		if (piece.kind === "literal") out.push({ kind: "literal", text });
		else if (text === "") continue;
		else if (last?.kind === "text")
			out[out.length - 1] = { kind: "text", text: last.text + text };
		else out.push({ kind: "text", text });
	}
	return out;
}

/**
 * A prose value in the summary's pieces: each text part printed through the
 * emitter's own node builder, so every literal output Nova writes is a
 * `literal` piece, and each reference or calculated value the hole `____`.
 */
function summaryTextOf(template: ProseTemplate): SummaryText {
	const pieces: SummaryPiece[] = [];
	for (const part of template.parts) {
		if (part.kind !== "text") {
			pieces.push({ kind: "text", text: OUTPUT_HOLE });
			continue;
		}
		pieces.push(
			...literalPieces(
				buildLabelNodes(
					{ parts: [part] },
					() => {
						throw new Error("A literal text has no reference to lower.");
					},
					{ mode: XFORM_MODE, instances: new InstanceSink() },
				),
			),
		);
	}
	return normalizedPieces(pieces);
}

/**
 * Whether HQ's normalized text is one rendering of `held`: each text piece as
 * it stands, each literal piece as its text or as `____`.
 */
export function rendersAs(held: SummaryText, hq: string): boolean {
	let reached = new Set([0]);
	for (const piece of held) {
		const next = new Set<number>();
		for (const at of reached) {
			if (hq.startsWith(piece.text, at)) next.add(at + piece.text.length);
			if (piece.kind === "literal" && hq.startsWith(OUTPUT_HOLE, at))
				next.add(at + OUTPUT_HOLE.length);
		}
		if (next.size === 0) return false;
		reached = next;
	}
	return reached.has(hq.length);
}

/**
 * The text of a prose unit per language, in the summary's pieces (`summaryTextOf`);
 * a language whose text has no piece is absent.
 */
function proseByLanguage(
	doc: BlueprintDoc,
	unitId: ReturnType<typeof makeTranslationUnitId>,
): Readonly<Record<string, SummaryText>> {
	if (!snapshotTranslationUnits(doc).has(unitId)) return {};
	const localization = commCareLocalization(doc);
	const out: Record<string, SummaryText> = {};
	for (const language of localization.languages) {
		const text = summaryTextOf(localization.prose(language, unitId));
		if (text.length > 0) out[language] = text;
	}
	return out;
}

/** Whether an expression slot holds the constant true. */
function isConstantTrue(expression: Expression | undefined): boolean {
	if (expression === undefined) return false;
	return (
		expression.kind === "match-all" ||
		(expression.kind === "term" &&
			expression.term.kind === "literal" &&
			expression.term.value === true)
	);
}

function slot(field: Field, key: string): Expression | undefined {
	const value = (field as unknown as Record<string, unknown>)[key];
	return value === undefined || value === null
		? undefined
		: (value as Expression);
}

/**
 * The document's form in the summary's words: one row per field, at the
 * path the emitter prints it at (`collectFieldLocations`), with the repeat
 * and group HQ's summary gives a control there. A repeat is a row at its row
 * path, since HQ gives the `<group>` around a `<repeat>` no row; a query
 * repeat in the count placement is a row at its wrapper and a row at its row
 * path, which is what HQ makes of the wrapper `<group ref>`.
 */
export function documentSummary(
	doc: BlueprintDoc,
	formUuid: Uuid,
): readonly DocumentSummaryRow[] {
	const locations = collectFieldLocations(doc, formUuid);
	const structure = formStructure(doc, formUuid);
	const createNames = caseCreateNameFields(doc, formUuid);
	const rows: DocumentSummaryRow[] = [];
	const rowOf = (
		field: Field,
		path: string,
		repeat: string | null,
		group: string | null,
	): DocumentSummaryRow => {
		const hidden = field.kind === "hidden";
		const options =
			"optionsSource" in field && field.optionsSource.kind === "inline"
				? field.optionsSource.options.map((option) => ({
						value: option.value,
						label: proseByLanguage(
							doc,
							makeTranslationUnitId("field", field.uuid, "option", option.uuid),
						),
					}))
				: null;
		return {
			path,
			repeat: hidden ? null : repeat,
			group: hidden ? null : group,
			kind: field.kind,
			alwaysRequired:
				isConstantTrue(slot(field, "required")) ||
				(createNames.has(field.uuid) && !hidden),
			hasRelevant: slot(field, "relevant") !== undefined,
			hasConstraint: slot(field, "validate") !== undefined,
			hasCalculate: hidden && slot(field, "calculate") !== undefined,
			label: hidden
				? {}
				: proseByLanguage(
						doc,
						makeTranslationUnitId("field", field.uuid, "label"),
					),
			options,
			fieldUuid: field.uuid,
		};
	};
	const walk = (
		parentUuid: Uuid,
		repeat: string | null,
		group: string | null,
	): void => {
		for (const uuid of orderedFieldUuids(doc, parentUuid)) {
			const field = doc.fields[uuid];
			const location = locations.get(uuid);
			if (field === undefined || location === undefined) continue;
			const path = (location.path as FormPath).toXPath();
			if (field.kind === "repeat") {
				const query = field.repeat_mode === "query_bound";
				const counted =
					query &&
					structure !== undefined &&
					effectiveQueryRepeatPlacement(structure, uuid) === "count";
				const rowPath = query ? `${path}/item` : path;
				if (counted) {
					rows.push(rowOf(field, path, repeat, group));
					rows.push(rowOf(field, rowPath, repeat, path));
				} else rows.push(rowOf(field, rowPath, repeat, group));
				walk(uuid, rowPath, rowPath);
				continue;
			}
			rows.push(rowOf(field, path, repeat, group));
			if (field.kind === "group" || field.kind === "section")
				walk(uuid, repeat, path);
		}
	};
	walk(formUuid, null, null);
	return rows;
}

/** HQ's text per language, normalized, a language with no text left out. */
export function hqText(
	translations: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
	const out: Record<string, string> = {};
	for (const [language, text] of Object.entries(translations)) {
		const normalized = normalizedText(text);
		if (normalized !== "") out[language] = normalized;
	}
	return out;
}

/**
 * Whether a label CommCare HQ summarized agrees with the document's in every
 * language of the app: where HQ sends text, it is one rendering of the
 * document's (`rendersAs`); where HQ sends none in a language, the document's
 * text there is its text in the first language, in the app's order, for which
 * HQ sent text (the form builder's fill, and a missing translation printing
 * its source, land on that text); where HQ sends text in no language, the
 * document's renders as nothing in every language.
 */
export function summaryTextAgrees(
	languages: readonly string[],
	hq: Readonly<Record<string, string>>,
	held: Readonly<Record<string, SummaryText>>,
): boolean {
	const textIn = (language: string): SummaryText => held[language] ?? [];
	const firstSent = languages.find((language) => hq[language] !== undefined);
	if (firstSent === undefined)
		return languages.every((language) => rendersAs(textIn(language), ""));
	return languages.every((language) => {
		const sent = hq[language];
		return sent !== undefined
			? rendersAs(textIn(language), sent)
			: canonicalJsonText(textIn(language)) ===
					canonicalJsonText(textIn(firstSent));
	});
}

export interface SummaryAgreementInput {
	readonly source: HqAppSource;
	readonly modules: readonly HqAlignedModule[];
	readonly draft: ReadDraft;
	/** Identity agreement's `sourceIdentity` of the source, read here for `written` alone. */
	readonly sourceIdentity: SourceIdentity;
}

/**
 * Where the document says something other than CommCare HQ's summary of the
 * source, per form of each menu HQ summarized: its ids, then its rows joined
 * by path. A menu HQ could not summarize is skipped: there is no summary to
 * agree with, and the read has already named it.
 */
export function summaryDifferences(
	input: SummaryAgreementInput,
): readonly AcceptanceDifference[] {
	const { draft } = input;
	const doc = draft.doc;
	const places = sourcePlaces(input.source);
	const languages = commCareLocalization(doc).languages;
	const differences: AcceptanceDifference[] = [];
	const differ = (
		segments: readonly string[],
		place: HqPlace,
		detail: string,
	): void => {
		differences.push({
			check: "summary",
			signature: differenceSignature("summary", segments),
			place,
			detail,
		});
	};

	// Ids: every menu and form of a summarized menu has the real id HQ's
	// application resource gave.
	const summarizedMenus = new Set(
		input.modules.flatMap((module) =>
			module.kind === "aligned" && module.uniqueId !== null
				? [module.uniqueId]
				: [],
		),
	);
	const notSummarized = new Set(
		input.modules.flatMap((module) =>
			module.kind === "not-summarized" && module.uniqueId !== null
				? [module.uniqueId]
				: [],
		),
	);
	const menus = draft.identities.modules.filter(
		(module) => !notSummarized.has(module.uniqueId),
	);
	for (const form of draft.identities.forms) {
		if (notSummarized.has(form.moduleUniqueId)) continue;
		const verdict = adoptedIdentityRows(
			{ modules: menus, forms: [form] },
			input.modules,
		);
		if (verdict.ok) continue;
		const menuKnown = summarizedMenus.has(form.moduleUniqueId);
		differ(
			["ids", menuKnown ? "form" : "menu"],
			menuKnown
				? places.formOf(form.xmlns)
				: places.menuOfId(form.moduleUniqueId),
			`no real id for ${verdict.at}`,
		);
	}

	for (const module of input.modules) {
		if (module.kind !== "aligned") continue;
		for (const aligned of module.forms) {
			if (aligned.xmlns === null) continue;
			const xmlns = aligned.xmlns;
			const formUuid = draft.identities.forms.find(
				(one) => one.xmlns === xmlns,
			)?.uuid;
			if (formUuid === undefined) {
				differ(
					["ids", "form"],
					places.formOf(xmlns),
					`form ${xmlns} is not in the document`,
				);
				continue;
			}
			formSummaryDifferences({
				doc,
				formUuid,
				xmlns,
				languages,
				questions: aligned.questions,
				facts: draft.facts.forms.find((one) => one.xmlns === xmlns),
				written: input.sourceIdentity.forms.get(xmlns)?.written ?? new Map(),
				at: (path) => places.questionOf(xmlns, path),
				differ,
			});
		}
	}
	return differences;
}

function formSummaryDifferences(input: {
	readonly doc: BlueprintDoc;
	readonly formUuid: Uuid;
	readonly xmlns: string;
	readonly languages: readonly string[];
	readonly questions: readonly HqQuestionSummary[];
	readonly facts: ReadDraft["facts"]["forms"][number] | undefined;
	readonly written: ReadonlyMap<string, ControlAsWritten>;
	readonly at: (path: string) => HqPlace;
	readonly differ: (
		segments: readonly string[],
		place: HqPlace,
		detail: string,
	) => void;
}): void {
	const { doc, formUuid, languages, differ, at } = input;
	const rows = documentSummary(doc, formUuid);
	const byPath = new Map(rows.map((row) => [row.path, row]));
	const explained = [
		...(input.facts?.generated ?? []).map((node) => node.path),
		...(input.facts?.caseRegionPaths ?? []),
		...[...formConnectIds(doc, formUuid)].map((id) => `/data/${id}`),
	];
	const isExplained = (path: string) =>
		path.includes("/@") ||
		explained.some((root) => path === root || path.startsWith(`${root}/`));
	const guards = caseScalarTextGuards(doc, formUuid);
	const createNames = caseCreateNameFields(doc, formUuid);
	const seen = new Set<string>();

	for (const question of input.questions) {
		const path = question.path;
		const row = byPath.get(path);
		if (row === undefined) {
			if (!isExplained(path))
				differ(
					["row", "unread", question.type ?? "untyped"],
					at(path),
					`HQ's row ${path} is not in the document`,
				);
			continue;
		}
		seen.add(path);
		const field = doc.fields[row.fieldUuid];
		const dataOnly = question.type === DATA_BIND_ONLY;
		const place = at(path);

		if (!dataOnly && row.kind !== "hidden") {
			if ((question.repeat ?? null) !== row.repeat)
				differ(
					["question", "repeat"],
					place,
					`${path} repeat ${question.repeat} is ${row.repeat}`,
				);
			if ((question.group ?? null) !== row.group)
				differ(
					["question", "group"],
					place,
					`${path} group ${question.group} is ${row.group}`,
				);
		}
		if (question.required === true && !row.alwaysRequired)
			differ(["question", "required"], place, `${path} is required in HQ`);
		if (
			question.required === false &&
			row.alwaysRequired &&
			!createNames.has(row.fieldUuid)
		)
			differ(["question", "required"], place, `${path} is optional in HQ`);
		const queryRepeat =
			field?.kind === "repeat" && field.repeat_mode === "query_bound";
		if (!queryRepeat && present(question.relevant) !== row.hasRelevant)
			differ(
				["question", "relevant"],
				place,
				`${path} display condition ${question.relevant}`,
			);
		if (row.hasConstraint && !present(question.constraint))
			differ(
				["question", "constraint"],
				place,
				`${path} holds a validation HQ's source lacks`,
			);
		if (
			present(question.constraint) &&
			!row.hasConstraint &&
			!(guards.has(row.fieldUuid) && caseScalarTextGuardIsChecked(row.kind))
		)
			differ(
				["question", "constraint"],
				place,
				`${path} validation ${question.constraint} is not in the document`,
			);
		if (dataOnly && present(question.calculate) !== row.hasCalculate)
			differ(
				["question", "calculate"],
				place,
				`${path} calculation ${question.calculate}`,
			);
		const written = input.written.get(path);
		if (
			written?.labelRef === true &&
			!summaryTextAgrees(
				languages,
				hqText(question.labelTranslations),
				row.label,
			)
		)
			differ(
				["question", "label"],
				place,
				`${path} label ${JSON.stringify(question.labelTranslations)} is ${JSON.stringify(row.label)}`,
			);
		optionDifferences(
			question,
			row,
			written?.itemLabelRefs ?? [],
			languages,
			(segments, detail) => differ(segments, place, `${path} ${detail}`),
		);
	}
	for (const row of rows)
		if (!seen.has(row.path))
			differ(
				["row", "absent", row.kind],
				at(row.path),
				`${row.path} is not in HQ's summary`,
			);
}

function present(value: string | null): boolean {
	return value !== null && value !== "";
}

function optionDifferences(
	question: HqQuestionSummary,
	row: DocumentSummaryRow,
	itemLabelRefs: readonly boolean[],
	languages: readonly string[],
	differ: (segments: readonly string[], detail: string) => void,
): void {
	const hq = question.options ?? [];
	if (row.options === null) {
		if (hq.length > 0) differ(["question", "options"], "HQ holds choices");
		return;
	}
	if (hq.length !== row.options.length) {
		differ(
			["question", "options"],
			`${hq.length} choices are ${row.options.length}`,
		);
		return;
	}
	row.options.forEach((option, index) => {
		const held = hq[index];
		if (held === undefined) return;
		if (held.value.trim() !== option.value)
			differ(
				["question", "option", "value"],
				`choice ${index} value ${held.value} is ${option.value}`,
			);
		if (
			itemLabelRefs[index] === true &&
			!summaryTextAgrees(
				languages,
				hqText(held.labelTranslations),
				option.label,
			)
		)
			differ(
				["question", "option", "label"],
				`choice ${index} label ${JSON.stringify(held.labelTranslations)} is ${JSON.stringify(option.label)}`,
			);
	});
}
