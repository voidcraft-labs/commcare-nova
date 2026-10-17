/**
 * Step `unsupplied-session-reads`: replaces each exact read of
 * `instance('commcaresession')/session/data/<id>` whose `<id>` the form's
 * entry does not declare by the string literal `''`. Core refuses to load a
 * form whose logic reads a datum its session does not hold, so such a form
 * never opened on any path, and the validator now refuses the read
 * (`SESSION_DATUM_NOT_SUPPLIED`; part 08 of step 2's plan, Finding 68).
 * After the edit the form opens with the value blank, the nearest working
 * app to what was stored.
 *
 * The declared ids come from this module's own walk of the raw rows,
 * written to the rule of `lib/commcare/formLinkProjection.ts::entrySessionDatums`
 * and held equal to it by `__tests__/equality.test.ts`: the case selections
 * of the menu and the menus it selects a parent case through, the ids the
 * form's own case changes mint, the worker's own case, a grouped tile's
 * companion, the ids the parent menu's entry renames them to or carries
 * forward, and a search-first menu's results. The slots are the registry's
 * XPath slots, each printed with this module's print context and read with
 * `sessionDataAccessInXPath`, which is handed the text alone; each read is
 * replaced as one edit of exactly its path's span in the syntax tree, inside
 * one text part, every other character kept.
 *
 * One `session-read-removed` line per field and datum, naming the field with
 * its form, or the form for a form-level slot, with the datum's id.
 */

import type { SyntaxNode } from "@lezer/common";
import { sessionDataAccessInXPath } from "@/lib/commcare/validator/bindingResolutionOracle";
import { parser } from "@/lib/commcare/xpath";
import { asUuid } from "@/lib/domain";
import {
	USERCASE_BUILT_IN_KEYS,
	USERCASE_CASE_TYPE,
} from "@/lib/domain/usercase";
import type { JsonRecord, RawDocument } from "../oldShape";
import type { CutoverStep, DocumentChange } from "../transform";
import {
	applyTextEdits,
	formXPathSlots,
	isRecord,
	printExpression,
	rawPrintContext,
	rawText,
	type TextEdit,
} from "./relativePaths";

// ── The datums a form's entry declares ──────────────────────────────

/** One datum of an entry, as much of it as its id depends on. */
interface EntryDatum {
	id: string;
	readonly caseType?: string;
	/** A case the worker selects, as opposed to an id the entry computes. */
	readonly selection: boolean;
	/** The menu whose case list supplies a selection. */
	readonly source?: string;
	readonly maximum?: number;
	readonly query?: true;
}

function moduleOf(document: RawDocument, uuid: string): JsonRecord | undefined {
	return document.modules[uuid];
}

/** `moduleCaseTypeForActions`: the menu's case type where it is in play. */
function caseTypeInPlay(document: RawDocument, moduleUuid: string): string {
	const module = moduleOf(document, moduleUuid);
	const caseType = rawText(module?.caseType);
	if (caseType === "") return "";
	const inPlay =
		module?.caseListOnly === true ||
		(document.formOrder[moduleUuid] ?? []).some(
			(formUuid) => document.forms[formUuid]?.type !== "survey",
		);
	return inPlay ? caseType : "";
}

function selectionOf(module: JsonRecord | undefined): JsonRecord | undefined {
	const config = module?.caseListConfig;
	const selection = isRecord(config) ? config.selection : undefined;
	return isRecord(selection) ? selection : undefined;
}

function maximumOf(module: JsonRecord | undefined): number {
	const maximum = selectionOf(module)?.maximum;
	return typeof maximum === "number" ? maximum : 1;
}

function cardinalityOf(module: JsonRecord | undefined): string {
	return rawText(selectionOf(module)?.kind) || "single";
}

/** `caseSelectionCanFlowBetweenModules`, over two stored menus. */
function selectionFlows(
	source: JsonRecord | undefined,
	target: JsonRecord | undefined,
): boolean {
	const caseType = source?.caseType;
	if (typeof caseType !== "string" || caseType !== target?.caseType) {
		return false;
	}
	return (
		cardinalityOf(source) === cardinalityOf(target) &&
		maximumOf(target) >= maximumOf(source)
	);
}

function searchFirst(module: JsonRecord | undefined): boolean {
	const config = module?.caseSearchConfig;
	return isRecord(config) && config.searchFirst === true;
}

/** The menus a menu selects a parent case through, outermost first, then itself. */
function selectionChain(document: RawDocument, moduleUuid: string): string[] {
	const chain = [moduleUuid];
	const seen = new Set(chain);
	let current = moduleUuid;
	while (true) {
		const parent = moduleOf(document, current)?.parentCaseModuleUuid;
		if (typeof parent !== "string" || seen.has(parent)) break;
		seen.add(parent);
		chain.unshift(parent);
		current = parent;
	}
	return chain;
}

/** `selectableDatums`: a case-loading entry's selections. */
function selectionDatums(
	document: RawDocument,
	moduleUuid: string,
	formType: string,
): EntryDatum[] {
	if (formType !== "followup" && formType !== "close") return [];
	const chain = selectionChain(document, moduleUuid);
	const datums: EntryDatum[] = [];
	chain.forEach((selected, index) => {
		const module = moduleOf(document, selected);
		const caseType = rawText(module?.caseType);
		if (caseType === "") return;
		const remaining = chain.length - index - 1;
		const multiple = cardinalityOf(module) === "multiple";
		const id = multiple
			? `${"parent_".repeat(remaining)}selected_cases`
			: remaining === 0
				? "case_id"
				: `${"parent_".repeat(remaining)}id`;
		datums.push({
			id,
			caseType,
			selection: true,
			source: selected,
			...(multiple && { maximum: maximumOf(module) }),
		});
	});
	return datums;
}

/** Each case type a form's fields write, by the bucket `deriveCaseWriteInventory` puts it in. */
function caseWriteBuckets(
	document: RawDocument,
	formUuid: string,
	moduleCaseType: string,
	formType: string,
): { usercase: boolean; children: { caseType: string; inRepeat: boolean }[] } {
	const writers: { caseType: string; property: string; repeat?: string }[] = [];
	const walk = (parent: string, repeat: string | undefined) => {
		for (const uuid of document.fieldOrder[parent] ?? []) {
			const field = document.fields[uuid];
			if (field === undefined) continue;
			const nextRepeat = field.kind === "repeat" ? uuid : repeat;
			const write = field.caseWrite;
			if (
				isRecord(write) &&
				rawText(write.caseType) !== "" &&
				rawText(write.property) !== ""
			) {
				writers.push({
					caseType: rawText(write.caseType),
					property: rawText(write.property),
					...(nextRepeat !== undefined && { repeat: nextRepeat }),
				});
			}
			if (document.fieldOrder[uuid] !== undefined) walk(uuid, nextRepeat);
		}
	};
	walk(formUuid, undefined);

	const slugs = new Set(
		Object.values(document.userProperties).map((property) =>
			rawText(property.slug),
		),
	);
	const usercase = writers.some(
		(writer) =>
			writer.caseType === USERCASE_CASE_TYPE &&
			!USERCASE_BUILT_IN_KEYS.includes(writer.property) &&
			slugs.has(writer.property),
	);
	if (formType === "survey" || moduleCaseType === "") {
		return { usercase, children: [] };
	}
	const declared = new Map<string, JsonRecord>();
	if (Array.isArray(document.caseTypes)) {
		for (const caseType of document.caseTypes) {
			if (isRecord(caseType)) declared.set(rawText(caseType.name), caseType);
		}
	}
	const children = new Map<string, { caseType: string; inRepeat: boolean }>();
	for (const writer of writers) {
		if (
			writer.caseType === USERCASE_CASE_TYPE ||
			writer.caseType === moduleCaseType
		) {
			continue;
		}
		if (declared.get(writer.caseType)?.parent_type !== moduleCaseType) continue;
		const key = JSON.stringify([writer.caseType, writer.repeat ?? null]);
		if (!children.has(key)) {
			children.set(key, {
				caseType: writer.caseType,
				inRepeat: writer.repeat !== undefined,
			});
		}
	}
	return { usercase, children: [...children.values()] };
}

/** `deriveSessionDatums`: the entry's own datums, before its parent menu's. */
function ownEntryDatums(
	document: RawDocument,
	moduleUuid: string,
	formUuid: string,
): EntryDatum[] {
	const form = document.forms[formUuid];
	const module = moduleOf(document, moduleUuid);
	const formType = rawText(form?.type);
	const caseType = caseTypeInPlay(document, moduleUuid);
	const datums = selectionDatums(document, moduleUuid, formType);
	const buckets = caseWriteBuckets(document, formUuid, caseType, formType);
	const opensCase = formType === "registration" && caseType !== "";
	if (opensCase) {
		datums.push({
			id: `case_id_new_${caseType}_0`,
			caseType,
			selection: false,
		});
	}
	buckets.children.forEach((child, index) => {
		if (child.inRepeat) return;
		datums.push({
			id: `case_id_new_${child.caseType}_${index + (opensCase ? 1 : 0)}`,
			caseType: child.caseType,
			selection: false,
		});
	});
	if (buckets.usercase) {
		datums.push({
			id: "usercase_id",
			caseType: USERCASE_CASE_TYPE,
			selection: false,
		});
	}
	const config = module?.caseListConfig;
	const tile = isRecord(config) ? config.tile : undefined;
	const own = [...datums]
		.reverse()
		.find((datum) => datum.selection && datum.caseType === caseType);
	if (isRecord(tile) && tile.grouping !== undefined && own !== undefined) {
		datums.push({ id: `${own.id}_parent_ids`, selection: false });
	}
	return datums;
}

/** `alignWithRootMenu`: the parent menu's entry renames and carries forward. */
function alignedWithParentMenu(
	document: RawDocument,
	moduleUuid: string,
	current: EntryDatum[],
): EntryDatum[] {
	const parentUuid = moduleOf(document, moduleUuid)?.parentModuleUuid;
	if (typeof parentUuid !== "string") return current;
	const firstForm = document.formOrder[parentUuid]?.[0];
	const parentDatums =
		firstForm === undefined
			? caseListDatums(document, parentUuid)
			: entryDatums(document, parentUuid, firstForm);
	if (parentDatums.length === 0) return current;
	const parentIds = new Set(parentDatums.map((datum) => datum.id));
	for (const datum of current) {
		if (parentIds.has(datum.id)) {
			datum.id = `${datum.id}_${datum.caseType ?? "child"}`;
		}
	}
	const remaining = [...current];
	const prefix: EntryDatum[] = [];
	for (const parentDatum of parentDatums) {
		if (parentDatum.query === true) continue;
		if (!parentDatum.selection) {
			prefix.push({ ...parentDatum });
			continue;
		}
		const matched = remaining[0];
		if (
			matched === undefined ||
			!matched.selection ||
			parentDatum.source === undefined ||
			matched.source === undefined ||
			!selectionFlows(
				moduleOf(document, parentDatum.source),
				moduleOf(document, matched.source),
			)
		) {
			continue;
		}
		remaining.shift();
		matched.id = parentDatum.id;
		prefix.push(matched);
	}
	return [...prefix, ...remaining];
}

/** `withInlineSearchQueries`: a search-first menu's results before its selection. */
function withSearchResults(
	document: RawDocument,
	datums: readonly EntryDatum[],
): EntryDatum[] {
	return datums.flatMap((datum) =>
		datum.selection &&
		datum.source !== undefined &&
		searchFirst(moduleOf(document, datum.source))
			? [
					{
						id: "results:inline",
						...(datum.caseType !== undefined && { caseType: datum.caseType }),
						selection: false,
						query: true as const,
					},
					datum,
				]
			: [datum],
	);
}

function caseListDatums(
	document: RawDocument,
	moduleUuid: string,
): EntryDatum[] {
	return withSearchResults(
		document,
		alignedWithParentMenu(
			document,
			moduleUuid,
			selectionDatums(document, moduleUuid, "followup"),
		),
	);
}

function entryDatums(
	document: RawDocument,
	moduleUuid: string,
	formUuid: string,
): EntryDatum[] {
	return withSearchResults(
		document,
		alignedWithParentMenu(
			document,
			moduleUuid,
			ownEntryDatums(document, moduleUuid, formUuid),
		),
	);
}

/** Every session datum id the form's entry declares. */
export function declaredSessionDatumIds(
	document: RawDocument,
	moduleUuid: string,
	formUuid: string,
): ReadonlySet<string> {
	return new Set(
		entryDatums(document, moduleUuid, formUuid).map((datum) => datum.id),
	);
}

// ── The reads ───────────────────────────────────────────────────────

/** Whether a path node is the left part of a longer path. */
function continued(path: SyntaxNode): boolean {
	const parent = path.parent;
	if (parent === null) return false;
	if (
		parent.name !== "Child" &&
		parent.name !== "Descendant" &&
		parent.name !== "Filtered"
	) {
		return false;
	}
	return parent.firstChild?.from === path.from;
}

/** The plain name of a path step, or undefined. */
function stepName(step: SyntaxNode | null, text: string): string | undefined {
	return step !== null && step.name === "NameTest" && step.firstChild === null
		? text.slice(step.from, step.to)
		: undefined;
}

/**
 * Each exact `instance('commcaresession')/session/data/<id>` read whose id
 * is in `unsupplied` and whose path ends there, as the span to replace.
 */
function sessionReadSpans(
	text: string,
	unsupplied: ReadonlySet<string>,
): { from: number; to: number; id: string }[] {
	const spans: { from: number; to: number; id: string }[] = [];
	parser.parse(text).iterate({
		enter(cursor) {
			const invoke = cursor.node;
			if (invoke.name !== "Invoke") return;
			const name = invoke.getChild("FunctionName");
			if (name === null || text.slice(name.from, name.to) !== "instance") {
				return;
			}
			const argument = invoke
				.getChild("ArgumentList")
				?.getChild("StringLiteral");
			const literal =
				argument === null || argument === undefined
					? ""
					: text.slice(argument.from + 1, argument.to - 1);
			if (literal !== "commcaresession") return;
			const steps: string[] = [];
			let path: SyntaxNode = invoke;
			while (steps.length < 3) {
				const parent: SyntaxNode | null = path.parent;
				if (
					parent === null ||
					parent.name !== "Child" ||
					parent.firstChild?.from !== path.from
				) {
					return;
				}
				const step = stepName(parent.lastChild, text);
				if (step === undefined) return;
				steps.push(step);
				path = parent;
			}
			const [session, data, id] = steps;
			if (session !== "session" || data !== "data" || id === undefined) return;
			if (!unsupplied.has(id) || continued(path)) return;
			spans.push({ from: path.from, to: path.to, id });
		},
	});
	return spans;
}

export const unsuppliedSessionReadsStep: CutoverStep = {
	id: "unsupplied-session-reads",
	apply(document) {
		const changes: DocumentChange[] = [];
		const context = rawPrintContext(document);
		for (const moduleUuid of document.moduleOrder) {
			for (const formUuid of document.formOrder[moduleUuid] ?? []) {
				const form = document.forms[formUuid];
				if (form === undefined) continue;
				const declared = declaredSessionDatumIds(
					document,
					moduleUuid,
					formUuid,
				);
				const named = new Set<string>();
				for (const slot of formXPathSlots(document, formUuid)) {
					const printed = printExpression(slot.value, context);
					if (printed === undefined || printed.text === "") continue;
					const unsupplied = new Set(
						[...sessionDataAccessInXPath(printed.text).exactDatumIds].filter(
							(id) => !declared.has(id),
						),
					);
					if (unsupplied.size === 0) continue;
					const spans = sessionReadSpans(printed.text, unsupplied).filter(
						(span) =>
							printed.parts.some(
								(part) =>
									part.isText && part.from <= span.from && span.to <= part.to,
							),
					);
					if (spans.length === 0) continue;
					applyTextEdits(
						printed,
						spans.map((span): TextEdit => ({ ...span, text: "''" })),
					);
					for (const span of spans) {
						const key = `${
							slot.carrier.kind === "field" ? slot.carrier.fieldUuid : slot.slot
						}\u0000${span.id}`;
						if (named.has(key)) continue;
						named.add(key);
						changes.push(
							slot.carrier.kind === "field"
								? {
										reason: "session-read-removed",
										entity: {
											type: "field",
											uuid: asUuid(slot.carrier.fieldUuid),
											nameAtMigration: rawText(
												document.fields[slot.carrier.fieldUuid]?.id,
											),
										},
										detail: { form: rawText(form.name), datum: span.id },
									}
								: {
										reason: "session-read-removed",
										entity: {
											type: "form",
											uuid: asUuid(formUuid),
											nameAtMigration: rawText(form.name),
										},
										detail: { datum: span.id, slot: slot.slot },
									},
						);
					}
				}
			}
		}
		return changes;
	},
};
