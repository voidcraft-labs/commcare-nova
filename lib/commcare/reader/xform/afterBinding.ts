/**
 * Stage 10: what the bound document decides for a form. A case choices
 * itemset compared with the nodeset Nova's emitter builds for it (10.1); a
 * count that reads the rows it creates (10.3); a model-iteration repeat held
 * to where Nova's own rule runs model iteration (10.4); a pair of load-time
 * values whose order a save in HQ's form builder changes, where one reads the
 * node the other sets (11.3); and a Hidden Value whose bind type is one Nova
 * would not write for it (11.4); and a protected validation message's composed
 * expression and its text's own forms (13.2); and a Connect slot that holds the default the
 * emitter writes for an unset one, read as unset. Each is compared with the production rule
 * over the document as the expression stage bound it. A check whose inputs a
 * finding withheld is skipped: that finding already sends the person to the
 * question or the form.
 */

import type { Element } from "domhandler";
import {
	type BlueprintDoc,
	type Field,
	fieldCaseWriteViews,
	type ProseAtomPart,
	type ProseTemplate,
	type Uuid,
} from "@/lib/domain";
import { effectiveCaseTypes } from "@/lib/domain/effectiveCaseTypes";
import {
	type LookupTypeIndex,
	slotContext,
} from "@/lib/domain/expression/context";
import { formStructure } from "@/lib/domain/expression/formStructure";
import type { ExpressionSlotRef } from "@/lib/domain/expression/types";
import { walkExpressionTerms } from "@/lib/domain/expression/walk";
import {
	effectiveAppLocalization,
	makeTranslationUnitId,
} from "@/lib/domain/localization";
import { expressionSlotValue } from "@/lib/domain/referenceSlots";
import { TriggerDag } from "@/lib/preview/engine/triggerDag";
import { caseOptionsNodeset } from "../../caseOptions";
import {
	DEFAULT_ASSESSMENT_USER_SCORE_EXPRESSION,
	DEFAULT_DELIVER_ENTITY_ID_EXPRESSION,
	DEFAULT_DELIVER_ENTITY_NAME_EXPRESSION,
} from "../../connectDefaults";
import { planLanguageWire } from "../../languageWire";
import { commCareLocalization } from "../../localization";
import { inertLookupWireNaming } from "../../lookup/naming";
import { fieldBindType } from "../../xform/bindType";
import { protectConstraintMessage } from "../../xform/constraintMessage";
import { questionDatetimeCaseValue } from "../../xform/datetimeCaseValue";
import { formNodeProjection } from "../../xpath/formNodeProjection";
import type { FormSyntax } from "../../xpath/formSyntax";
import { w } from "../../xpath/wire/builders";
import { withCandidate } from "../candidate";
import { claimRegistry } from "../claims";
import type { ReadContext } from "../context";
import { lookupTypes } from "../expressions/readExpression";
import { sameJson } from "../jsonCursor";
import { sameSyntax } from "../syntaxCompare";
import { readFormSyntax } from "../syntaxRead";
import { ownText } from "../xmlCursor";
import { X } from "./claims";
import { datetimeSpelling, G, HOLE, matchesHoles, sameTree } from "./generated";
import {
	type DraftField,
	expressionEnvOf,
	type ReadSourceNames,
	type ReadXForm,
} from "./index";
import {
	effectiveLoadOrder,
	type LoadStep,
	loadOrderConflicts,
} from "./loadOrder";
import { formPathOf } from "./model";
import { settleCaseChoices } from "./options";
import { formText, type ProtectedMessage } from "./prose";
import { modelIterationVerdict } from "./repeats";

/** Every field of a form in the order Nova's document holds them. */
function documentOrder(doc: BlueprintDoc, formUuid: Uuid): Map<Uuid, number> {
	const order = new Map<Uuid, number>();
	const walk = (parent: Uuid) => {
		for (const uuid of doc.fieldOrder[parent] ?? []) {
			order.set(uuid, order.size);
			walk(uuid);
		}
	};
	walk(formUuid);
	return order;
}

/**
 * Where a query repeat's own nodes stand in Nova's data tree, between the repeat's node and its
 * first authored child: the wrapper's ids and count (model iteration's `@ids` and `@count` on
 * the repeat itself), then the row, then the row's id and index (model iteration's `@id` and
 * `@index` on the row), as `builder.ts::buildQueryRepeat` and `countPlacementRow.ts` write them.
 */
const QUERY_NODE_OFFSET: Readonly<Record<string, number>> = {
	"query-ids": 0.1,
	"query-count": 0.2,
	"query-position": 0.3,
	"query-row": 0.5,
	"query-id": 0.6,
	"query-index": 0.7,
};

/** A setvalue target's place in Nova's data tree, as `builder.ts::inDataTreeOrder` places the
 *  setvalue that sets it, from each field's place in the document; `end` where the document
 *  holds no node for it. */
function loadPosition(
	names: ReadSourceNames,
	positions: ReadonlyMap<Uuid, number>,
	target: string,
	end: number,
): number {
	const at = (uuid: Uuid, offset = 0) => {
		const position = positions.get(uuid);
		return position === undefined ? end : position + offset;
	};
	const steps = target.split("/");
	const node = names.at([names.root, ...steps]);
	if (node?.kind === "field") return at(node.uuid);
	if (node?.kind === "query-row")
		return at(node.repeat, QUERY_NODE_OFFSET["query-row"]);
	if (node?.kind === "repeat-attribute")
		return node.attribute === "id" || node.attribute === "index"
			? at(node.repeat, QUERY_NODE_OFFSET["query-row"])
			: at(node.repeat);
	if (node?.kind === "generated") {
		const offset = QUERY_NODE_OFFSET[node.purpose];
		return offset === undefined ? end : at(node.owner, offset);
	}
	if (steps.at(-1)?.startsWith("@") === true) {
		const owner = names.at([names.root, ...steps.slice(0, -1)]);
		if (owner?.kind === "field") return at(owner.uuid);
	}
	return end;
}

/** The order Nova's emission writes the same setvalues in: by where each target stands in the
 *  data tree, setvalues on one node keeping their order (`builder.ts::inDataTreeOrder`). */
export function emittedLoadOrder(
	steps: readonly LoadStep[],
	position: (step: LoadStep) => number,
): LoadStep[] {
	return steps
		.map((step, index) => ({ step, index, at: position(step) }))
		.sort((a, b) => a.at - b.at || a.index - b.index)
		.map(({ step }) => step);
}

/** The source paths a step's bound value reads: its field, form-node and repeat-row terms. */
function readsOf(
	doc: BlueprintDoc,
	names: ReadSourceNames,
	step: LoadStep,
): Set<string> {
	const read = new Set<string>();
	const ref = step.pending?.ref;
	if (ref === undefined) return read;
	const expression = expressionSlotValue(doc, ref as ExpressionSlotRef);
	if (expression === undefined) return read;
	const add = (path: readonly string[] | undefined) => {
		if (path !== undefined) read.add(path.slice(1).join("/"));
	};
	// A query repeat's node is the count placement's generated node where the source holds
	// one, and model iteration's attribute otherwise.
	const queryNode = (
		repeat: Uuid,
		purpose: "query-ids" | "query-count" | "query-id" | "query-index",
		attribute: "ids" | "count" | "id" | "index",
	) =>
		names.nodePath({ kind: "generated", purpose, owner: repeat }) ??
		names.nodePath({ kind: "repeat-attribute", repeat, attribute });
	walkExpressionTerms(expression, (term) => {
		if (term.kind === "field") add(names.fieldPath(term.uuid));
		else if (term.kind === "repeat-row")
			add(
				term.attribute === "id"
					? queryNode(term.repeat, "query-id", "id")
					: queryNode(term.repeat, "query-index", "index"),
			);
		else if (term.kind === "form-node" && term.node.kind === "repeat") {
			if (term.node.role === "query-ids")
				add(queryNode(term.node.repeat, "query-ids", "ids"));
			if (term.node.role === "query-count")
				add(queryNode(term.node.repeat, "query-count", "count"));
		}
	});
	return read;
}

function fieldsOf(form: ReadXForm): DraftField[] {
	const order: DraftField[] = [];
	const walk = (parent: DraftField | null) => {
		for (const field of form.childrenOf(parent)) {
			order.push(field);
			walk(field);
		}
	};
	walk(null);
	return order;
}

/** A Hidden Value's bind type as a class: text (absent or `xsd:string`), or date and time. */
function bindTypeClass(
	type: string | undefined,
): "text" | "datetime" | undefined {
	if (type === undefined) return "text";
	const local = type.startsWith("xsd:") ? type.slice(4) : type;
	if (local === "string") return "text";
	if (local === "dateTime") return "datetime";
	return undefined;
}

/** Whether the expression stage held what a bind's attribute registered. */
function held(ctx: ReadContext, element: object, attribute: string): boolean {
	const list = ctx.pending.list();
	for (let index = 0; index < list.length; index++) {
		const at = ctx.pending.site(index).at;
		if ("element" in at && at.element === element && at.attribute === attribute)
			return ctx.pending.outcome(index).expression !== undefined;
	}
	return false;
}

/** The load-time order check of one form (11.3). */
function checkLoadOrder(
	ctx: ReadContext,
	doc: BlueprintDoc,
	formUuid: Uuid,
	formPlace: DraftField["place"],
	xform: ReadXForm,
): void {
	const names = xform.sourceNames;
	if (names === undefined) return;
	const order = effectiveLoadOrder(xform);
	const positions = documentOrder(doc, formUuid);
	const emitted = emittedLoadOrder(order, (step) =>
		loadPosition(names, positions, step.target, positions.size),
	);
	const reads = new Map<LoadStep, Set<string>>();
	const readsOfStep = (step: LoadStep) => {
		const known = reads.get(step) ?? readsOf(doc, names, step);
		reads.set(step, known);
		return known;
	};
	for (const { reader } of loadOrderConflicts(order, emitted, readsOfStep))
		ctx.accounting.finding(X.loadOrder, reader.pending?.place ?? formPlace);
}

/** The entries the case management stage raises a finding under. */
function caseStageEntryIds(): ReadonlySet<string> {
	const entries = new Set<string>();
	for (const [name, claim] of claimRegistry())
		if (
			name.startsWith("caseManagement.") &&
			(claim.use === "refuse" || claim.use === "account")
		)
			entries.add(claim.entry);
	return entries;
}

/**
 * Whether a case write of the form was itself a finding, so the document may lack a write the
 * source makes: a finding the case management stage raised at the form or at one of its
 * questions, or any finding at a node of the form's case region (a Save to Case block, its
 * rows and their values).
 */
function caseWritesUnread(
	ctx: ReadContext,
	formPlace: DraftField["place"],
	xform: ReadXForm,
): boolean {
	if (formPlace.kind !== "form") return false;
	const entries = caseStageEntryIds();
	return ctx.accounting.findings().some((finding) => {
		const place = finding.place;
		if (place.kind !== "form" && place.kind !== "question") return false;
		if (place.menu !== formPlace.menu || place.form !== formPlace.form)
			return false;
		if (entries.has(finding.code)) return true;
		if (place.kind !== "question") return false;
		const node = xform.nodes.get(place.path);
		return node !== undefined && xform.roles.get(node)?.kind === "case-region";
	});
}

/** The Hidden Value bind type check of one form (11.4): skipped for a Hidden Value whose
 *  calculate the expression stage did not hold, and for every one of a form a case write of
 *  which was itself a finding, since the inputs of either are not known. */
function checkHiddenTypes(
	ctx: ReadContext,
	doc: BlueprintDoc,
	formPlace: DraftField["place"],
	xform: ReadXForm,
): void {
	const caseTypes = effectiveCaseTypes(doc);
	const unread = caseWritesUnread(ctx, formPlace, xform);
	for (const field of fieldsOf(xform)) {
		if (field.standIn || field.kind !== "hidden" || field.uuid === undefined)
			continue;
		const stored = doc.fields[field.uuid] as Field | undefined;
		if (stored === undefined || stored.kind !== "hidden") continue;
		const bind = xform.binds.get(field.node);
		const source = bindTypeClass(bind?.type);
		if (source === undefined) continue;
		if (unread) continue;
		if (
			bind !== undefined &&
			bind.logic.calculate !== undefined &&
			!held(ctx, bind.element, "calculate")
		)
			continue;
		const nova =
			fieldBindType(stored, caseTypes, fieldCaseWriteViews(doc, field.uuid)) ===
			"xsd:dateTime"
				? "datetime"
				: "text";
		if (nova !== source)
			ctx.accounting.finding(X.refusedKind.hiddenOtherType, field.place);
	}
}

/**
 * Each date-and-time sibling the case management stage settled as Nova's (13.2, `datetime`): the
 * form stage proposed it by its question's kind, and here, with the document's types bound, its
 * calculate must be the tree `questionDatetimeCaseValue` gives the question, or the earlier tree
 * (`typedInstantValue`), whose first publish the register already holds. A Hidden Value holding
 * text is written as a copy and one holding a typed date and time as CommCare HQ's stored text,
 * so a sibling in the other spelling is one Nova would write differently: `unrecognized` at the
 * question. Skipped where the question's own calculate was not held, or a finding already stands
 * there, since its type is then not known.
 */
function checkDatetimeSiblings(
	ctx: ReadContext,
	doc: BlueprintDoc,
	xform: ReadXForm,
	types: LookupTypeIndex,
): void {
	for (const [node, role] of xform.roles) {
		// A candidate the case management stage settled as Nova's keeps its proposed role and
		// leaves `candidates`; by stage 10 every other one is a field.
		if (
			(role.kind !== "generated" && role.kind !== "generated-candidate") ||
			role.purpose !== "datetime" ||
			role.owner === null ||
			xform.candidates.includes(node)
		)
			continue;
		const ownerRole = xform.roles.get(role.owner);
		if (ownerRole?.kind !== "field") continue;
		const field = ownerRole.field;
		const uuid = field.uuid;
		const calculate = xform.binds.get(node)?.logic.calculate;
		const ownerPath = formPathOf(role.owner);
		if (
			uuid === undefined ||
			doc.fields[uuid] === undefined ||
			calculate === undefined ||
			ownerPath === undefined ||
			ctx.accounting.hasFindingAt(field.place)
		)
			continue;
		const ownerBind = xform.binds.get(field.node);
		if (
			ownerBind?.logic.calculate !== undefined &&
			!held(ctx, ownerBind.element, "calculate")
		)
			continue;
		if (datetimeSpelling(calculate, ownerPath) === "earlier") continue;
		const context = slotContext(
			doc,
			{ entity: "field", uuid, slot: "relevant" },
			types,
		);
		if (context === undefined) continue;
		ctx.accounting.noteRebuild();
		let expected: ReturnType<typeof questionDatetimeCaseValue>;
		try {
			expected = questionDatetimeCaseValue(uuid, ownerPath, context);
		} catch {
			ctx.accounting.circumstance("unrecognized", field.place, {
				name: "xform:model/bind@calculate",
			});
			continue;
		}
		if (!sameTree(calculate, expected))
			ctx.accounting.circumstance("unrecognized", field.place, {
				name: "xform:model/bind@calculate",
			});
	}
}

/** The registration of a field's slot, where its form stage registered one. */
function registrationOf(
	ctx: ReadContext,
	uuid: Uuid,
	slot: string,
): number | undefined {
	const list = ctx.pending.list();
	for (let index = 0; index < list.length; index++) {
		const ref = list[index]?.ref;
		if (ref?.entity === "field" && ref.uuid === uuid && ref.slot === slot)
			return index;
	}
	return undefined;
}

/**
 * A case choices itemset over the bound document (10.1). Its filter is the expression stage's:
 * printed in the slot through the same `caseOptionsNodeset` and compared there. The rest of the
 * nodeset, the source's text with the filter's predicate left out, is compared here with the
 * nodeset `caseOptionsNodeset` builds for the cases source with no filter: equal, the itemset is
 * Nova's case choices; different, it is an itemset of another shape.
 */
function settleChoices(
	ctx: ReadContext,
	doc: BlueprintDoc,
	xform: ReadXForm,
	types: LookupTypeIndex,
): void {
	for (const [field, proposal] of xform.caseChoices) {
		const uuid = field.uuid;
		if (uuid === undefined || doc.fields[uuid] === undefined) continue;
		const nodeset = proposal.itemset.attribs.nodeset ?? "";
		const read = readFormSyntax(nodeset);
		const top = read.ok ? read.node : undefined;
		const filtered =
			registrationOf(ctx, uuid, "lookup_options_source") !== undefined;
		const head =
			top === undefined
				? undefined
				: filtered
					? top.kind === "filter"
						? nodeset.slice(top.base.from, top.base.to)
						: undefined
					: nodeset;
		const context = slotContext(
			doc,
			{ entity: "field", uuid, slot: "lookup_options_source" },
			types,
		);
		const form = context?.form;
		const same =
			head !== undefined &&
			context !== undefined &&
			form !== undefined &&
			sameTree(
				head,
				caseOptionsNodeset(
					{
						kind: "cases",
						caseType: proposal.caseType,
						labelProperty: proposal.labelProperty,
					},
					context,
					{
						lookup: { naming: inertLookupWireNaming(), instanceScope: "xform" },
					},
					formNodeProjection(doc, form, { surface: "wire" }),
				),
			);
		settleCaseChoices(
			xform.cursor,
			xform.parsed,
			proposal,
			field.place,
			same,
			filtered,
		);
	}
}

/** Each count-bound repeat's row path as the cycle proof labels it, to the repeat's draft. */
function countRowPaths(
	doc: BlueprintDoc,
	formUuid: Uuid,
	xform: ReadXForm,
): Map<string, DraftField> {
	const paths = new Map<string, DraftField>();
	const form = formStructure(doc, formUuid);
	if (form === undefined) return paths;
	const projection = formNodeProjection(doc, form, { surface: "wire" });
	for (const field of fieldsOf(xform)) {
		const uuid = field.uuid;
		if (field.kind !== "repeat" || uuid === undefined) continue;
		const coordinates = projection.graph.path({ kind: "field", uuid });
		if (coordinates === undefined) continue;
		let label = "";
		for (const coordinate of coordinates) {
			const step = projection.step(coordinate);
			if (step === undefined) {
				label = "";
				break;
			}
			label += `/${step.attribute ? "@" : ""}${step.name}`;
		}
		if (label !== "") paths.set(label, field);
	}
	return paths;
}

/** A count that reads the rows it creates (10.3): the cycle proof the gate refuses it by, its
 *  count feedback mapped to the repeat. */
function checkCountFeedback(
	ctx: ReadContext,
	doc: BlueprintDoc,
	formUuid: Uuid,
	xform: ReadXForm,
): void {
	const rows = countRowPaths(doc, formUuid, xform);
	if (rows.size === 0) return;
	const raised = new Set<DraftField>();
	for (const cycle of new TriggerDag().reportCycles([], doc, formUuid)) {
		if (cycle.countFeedback === undefined) continue;
		const repeat = rows.get(cycle.countFeedback);
		if (repeat === undefined || raised.has(repeat)) continue;
		raised.add(repeat);
		if (ctx.accounting.hasFindingAt(repeat.place)) continue;
		ctx.accounting.finding(X.countReadingItsRows, repeat.place);
	}
}

/** Where model iteration is held (10.4), for each model-iteration repeat of the form. */
function checkModelIterations(
	ctx: ReadContext,
	doc: BlueprintDoc,
	formUuid: Uuid,
	xform: ReadXForm,
): void {
	const names = xform.sourceNames;
	if (names === undefined) return;
	const order = effectiveLoadOrder(xform);
	for (const repeat of xform.modelIterations) {
		const uuid = repeat.uuid;
		if (uuid === undefined || doc.fields[uuid] === undefined) continue;
		if (ctx.accounting.hasFindingAt(repeat.place)) continue;
		const ids = [...repeat.node.path, "@ids"].join("/");
		const idsAt = order.findIndex(
			(step) => step.event === "xforms-ready" && step.target === ids,
		);
		const setAfterIds = (fieldUuid: Uuid): boolean => {
			const path = names.fieldPath(fieldUuid)?.slice(1).join("/");
			if (path === undefined || idsAt < 0) return false;
			const own = order
				.map((step, at) => ({ step, at }))
				.filter(
					({ step }) => step.event === "xforms-ready" && step.target === path,
				);
			return own.length > 0 && own.every(({ at }) => at > idsAt);
		};
		const verdict = modelIterationVerdict(doc, formUuid, uuid, setAfterIds);
		if (verdict.kind === "refused")
			ctx.accounting.finding(verdict.claim, repeat.place);
	}
}

/**
 * One protected validation message (13.2), held to what Core shows in each language.
 *
 * Core evaluates the stored `jr:constraintMsg` in a language over that language's text table,
 * which is the default language's text under every id and form key with the language's own laid
 * over it (`Localizer.getLocaleData`; `jr:itext` reads it, `FormDef.initEvalContext`): the
 * `__nova_locale` form it reads chooses a branch, and the `__nova_piece_` forms it reads are
 * that branch's words. The stored expression is the composition over the languages the app held
 * when Nova last wrote the form, each branch tested by the `__nova_locale` value its language
 * wrote, and CommCare HQ rewrites neither when it adds a language, renames one (`rename_language`
 * changes only the translation's `lang`) or reorders them, nor does a save in HQ's form builder,
 * which fills a language that lacks a form with the default's (`javaRosa/plugin.js`,
 * `getValueOrDefault`). So the composition is rebuilt over the branches the source holds
 * (`messageBranches`), each the message of the language that wrote its forms, and printed back
 * against the source with each of the message's references standing where the text's own
 * output does; then every language must read (`shownForms`) exactly one branch's forms, and that
 * branch's message must be the one the document holds for the language. A language CommCare HQ
 * added after the publish, one whose text lacks the forms and one the form builder filled from
 * the default thus read the default's message, which is what the document holds for them, and
 * the first publish writes the composition over every language and each language's own forms
 * (`forms-and-settings-rewritten`). Equal, the expression and the forms are claimed as the
 * message's; different, they are left for the close to report.
 */
function settleProtectedMessage(
	ctx: ReadContext,
	doc: BlueprintDoc,
	xform: ReadXForm,
	message: ProtectedMessage,
): void {
	const text = formText(xform);
	const uuid = message.field.uuid;
	if (text === undefined || uuid === undefined) return;
	const source = (
		doc.fields[uuid] as { validate_msg?: ProseTemplate } | undefined
	)?.validate_msg;
	const slot = text.slots.find(
		(one) =>
			one.owner.field === message.field &&
			one.owner.slot === "validate_msg" &&
			one.id === message.textId,
	);
	if (source === undefined || slot === undefined || slot.refused) return;
	// Each reference of the message stands where the source output it was bound from does.
	const atoms = source.parts.filter((part) => part.kind !== "text");
	if (atoms.length !== slot.registered.length) return;
	const outputOf = new Map<string, string>();
	atoms.forEach((atom, index) => {
		outputOf.set(JSON.stringify(atom), slot.registered[index]?.text ?? "");
	});
	const holeOf = new Map<string, string>();
	const holeFor = (part: ProseAtomPart): string => {
		const identity = JSON.stringify(part);
		const hole = holeOf.get(identity) ?? `${HOLE}_${holeOf.size}`;
		holeOf.set(identity, hole);
		return hole;
	};
	const localization = commCareLocalization(doc);
	const unitId = makeTranslationUnitId("field", uuid, "validate_msg");
	// The text's own forms, language by language.
	const wireCodes = planLanguageWire(
		effectiveAppLocalization(doc.localization),
	).wireCodeByTag;
	const owned = [...text.itext.allValues(message.textId)].map(
		([language, values]) => ({
			code: wireCodes.get(language),
			values: values.filter((value) =>
				(value.attribs.form ?? "").startsWith("__nova_"),
			),
		}),
	);
	if (!owned.every(({ code }) => code !== undefined)) return;
	const defaultCode =
		text.itext.defaultLanguage === undefined
			? undefined
			: wireCodes.get(text.itext.defaultLanguage);
	const stored = message.bind.attribs[message.attribute] ?? "";
	const branches = messageBranches(
		stored,
		message.textId,
		owned,
		localization.languages,
	);
	// The branches the stored composition holds, each the message of the language whose forms
	// it was written from, printed back against the source.
	let held:
		| {
				readonly forms: ReadonlyMap<string, Element[]>;
				readonly writerOf: ReadonlyMap<string, string>;
		  }
		| undefined;
	for (const order of branches) {
		ctx.accounting.noteRebuild();
		const used = new Map<string, string | undefined>();
		const composed = protectConstraintMessage(
			message.textId,
			order.map(({ label, writer: code }) => ({
				language: label,
				template: localization.prose(code, unitId),
			})),
			(part) => {
				const hole = holeFor(part);
				used.set(hole, outputOf.get(JSON.stringify(part)));
				return w.context([w.step(hole)]);
			},
		);
		if (composed === undefined) continue;
		const bound = matchesHoles(stored, composed.expression, (name) =>
			used.has(name),
		);
		const sameExpression =
			bound !== undefined &&
			[...used].every(([hole, output]) => {
				const at = bound.get(hole);
				const read = output === undefined ? undefined : readFormSyntax(output);
				return (
					at !== undefined &&
					read?.ok === true &&
					read.node !== undefined &&
					sameSyntax(at, read.node, { ruleSet: "form" })
				);
			});
		if (!sameExpression) continue;
		held = {
			forms: composed.forms,
			writerOf: new Map(order.map(({ label, writer: code }) => [label, code])),
		};
		break;
	}
	if (held === undefined) return;
	// Every language reads one branch's forms, and that branch shows the message the document
	// holds for the language.
	const { forms, writerOf } = held;
	const sameForms = localization.languages.every((code) => {
		const shown = shownForms(owned, code, defaultCode);
		if (shown === undefined) return false;
		const chosen = [...forms].find(([, want]) =>
			sameFormValues(shown, want),
		)?.[0];
		const from = chosen === undefined ? undefined : writerOf.get(chosen);
		return (
			from !== undefined &&
			sameJson(
				localization.prose(from, unitId),
				localization.prose(code, unitId),
			)
		);
	});
	if (!sameForms) return;
	xform.cursor.derived(
		{ element: message.bind, attribute: message.attribute },
		G.messageExpression,
	);
	for (const { values } of owned)
		for (const value of values)
			if (value.attribs.form === "__nova_identity")
				xform.cursor.dropSubtree(value, G.messageIdentity);
			else xform.cursor.derivedSubtree(value, G.messageForms);
}

/** One branch of a stored protected message: the `__nova_locale` value that chooses it and the
 *  language whose forms hold that value, whose message the branch composes. */
interface MessageBranch {
	readonly label: string;
	readonly writer: string;
}

/**
 * The orders of branches a stored protected message may hold, each to be printed back. A branch
 * is a `__nova_locale` value some language's own forms hold, each value the one the language it
 * was written for wrote (`protectConstraintMessage` writes a language's code); its message is
 * that language's: the one of that code where it still holds the value, else the first in the
 * app's order that does (a language CommCare HQ renamed keeps the forms written under its old
 * code). The order is the one the stored expression tests the values in, read from its tree, and
 * the value no test names is the last branch's; where several could be, each is an order.
 * Only a proposal: the composition over it is printed back and compared whole.
 */
function messageBranches(
	stored: string,
	id: string,
	owned: readonly {
		readonly code: string | undefined;
		readonly values: readonly Element[];
	}[],
	languages: readonly string[],
): MessageBranch[][] {
	const ownLocale = (code: string): string | undefined => {
		const values = owned
			.filter((one) => one.code === code)
			.flatMap(({ values }) => values)
			.filter((value) => value.attribs.form === "__nova_locale");
		return values.length === 1 && values[0] !== undefined
			? ownText(values[0])
			: undefined;
	};
	const writerOf = new Map<string, string>();
	for (const code of languages) {
		const label = ownLocale(code);
		if (label === undefined) continue;
		if (label === code || !writerOf.has(label)) writerOf.set(label, code);
	}
	const tested = testedLocales(stored, id);
	if (tested === undefined) return [];
	const branch = (label: string): MessageBranch | undefined => {
		const writer = writerOf.get(label);
		return writer === undefined ? undefined : { label, writer };
	};
	const head = tested.map(branch);
	if (head.some((one) => one === undefined)) return [];
	const lasts = [...writerOf.keys()].filter((label) => !tested.includes(label));
	return lasts.map((last) => [
		...(head as MessageBranch[]),
		{ label: last, writer: writerOf.get(last) as string },
	]);
}

/**
 * The `__nova_locale` values a stored protected message tests, in order: the chain
 * `if(jr:itext('<id>;__nova_locale') = '<value>', …, …)` inside its outer `__nova_mode` test,
 * read from the parsed tree. Undefined where the text does not parse; a chain of another shape
 * ends the list, and the print-back refuses it.
 */
function testedLocales(stored: string, id: string): string[] | undefined {
	const read = readFormSyntax(stored);
	if (!read.ok || read.node === undefined) return undefined;
	const strip = (node: FormSyntax): FormSyntax =>
		node.kind === "group" ? strip(node.value) : node;
	const branchesOf = (node: FormSyntax): FormSyntax | undefined => {
		const call = strip(node);
		return call.kind === "call" && call.name === "if" && call.args.length === 3
			? call
			: undefined;
	};
	const tested: string[] = [];
	const outer = branchesOf(read.node);
	if (outer === undefined || outer.kind !== "call") return tested;
	let chain = outer.args[2];
	while (chain !== undefined) {
		const call = branchesOf(chain);
		if (call === undefined || call.kind !== "call") break;
		const test = strip(call.args[0] as FormSyntax);
		if (test.kind !== "binary" || test.op !== "=") break;
		const left = strip(test.left);
		const right = strip(test.right);
		if (
			left.kind !== "call" ||
			left.name !== "jr:itext" ||
			left.args.length !== 1 ||
			right.kind !== "string"
		)
			break;
		const name = strip(left.args[0] as FormSyntax);
		if (name.kind !== "string" || name.value !== `${id};__nova_locale`) break;
		tested.push(right.value);
		chain = call.args[2];
	}
	return tested;
}

/**
 * The `__nova_` forms of a protected message's text a device in language `code` reads, by form
 * name: each of the language's own, and each it lacks the default language's
 * (`Localizer.getLocaleData` loads the default locale's text under every id and form key, then
 * the language's own over it, and `jr:itext` reads that merge, `FormDef.initEvalContext`). So a
 * language whose translation lacks the text, or holds it without the forms, reads the default's
 * forms, as a language HQ added after the publish does until its forms are written. Undefined
 * where one translation holds two values of one form, which Core refuses
 * (`XFormParser.parseTranslation`). A form neither holds falls back to the text's own value
 * (`Localizer.getText`), which is no form Nova writes, so it leaves the form out and the
 * comparison fails.
 */
function shownForms(
	owned: readonly {
		readonly code: string | undefined;
		readonly values: readonly Element[];
	}[],
	code: string,
	defaultCode: string | undefined,
): Map<string, string> | undefined {
	const formsOf = (of: string | undefined): Map<string, string> | undefined => {
		const forms = new Map<string, string>();
		if (of === undefined) return forms;
		for (const { code: held, values } of owned)
			if (held === of)
				for (const value of values) {
					const form = value.attribs.form ?? "";
					if (forms.has(form)) return undefined;
					forms.set(form, ownText(value));
				}
		return forms;
	};
	const own = formsOf(code);
	const fallback = code === defaultCode ? new Map() : formsOf(defaultCode);
	if (own === undefined || fallback === undefined) return undefined;
	return new Map([...fallback, ...own]);
}

/** Whether the forms a language shows are exactly the values the composition writes. */
function sameFormValues(
	shown: ReadonlyMap<string, string>,
	want: readonly Element[],
): boolean {
	return (
		shown.size === want.length &&
		want.every(
			(value) => shown.get(value.attribs.form ?? "") === ownText(value),
		)
	);
}

/** Each Connect slot the emitter fills from its default where the slot is unset
 *  (`connectDefaults.ts::effectiveAssessmentUserScore`, `effectiveDeliverEntities`). */
const CONNECT_DEFAULTS = [
	{
		block: "assessment",
		slot: "user_score",
		value: DEFAULT_ASSESSMENT_USER_SCORE_EXPRESSION,
	},
	{
		block: "deliver_unit",
		slot: "entity_id",
		value: DEFAULT_DELIVER_ENTITY_ID_EXPRESSION,
	},
	{
		block: "deliver_unit",
		slot: "entity_name",
		value: DEFAULT_DELIVER_ENTITY_NAME_EXPRESSION,
	},
] as const;

/**
 * The document with each Connect slot that holds its default unset: the emitter writes the
 * default's calculate for an unset slot, so an unset slot and one holding the default print one
 * block, and the reading returns the unset one (`finishForms`).
 */
export function connectDefaultsUnset(doc: BlueprintDoc): BlueprintDoc {
	const unset: { form: Uuid; block: string; slot: string }[] = [];
	for (const [formUuid, form] of Object.entries(doc.forms) as [
		Uuid,
		BlueprintDoc["forms"][Uuid],
	][]) {
		const connect = form.connect as
			| Record<string, Record<string, unknown> | undefined>
			| undefined;
		if (connect === undefined) continue;
		for (const { block, slot, value } of CONNECT_DEFAULTS) {
			const held = connect[block]?.[slot];
			if (held !== undefined && sameJson(held, value))
				unset.push({ form: formUuid, block, slot });
		}
	}
	if (unset.length === 0) return doc;
	return withCandidate(doc, (draft) => {
		for (const { form, block, slot } of unset) {
			const config = (
				draft.forms[form]?.connect as
					| Record<string, Record<string, unknown> | undefined>
					| undefined
			)?.[block];
			if (config !== undefined) delete config[slot];
		}
	});
}

/** Stage 10: the checks of each form that need the bound document. */
export function finishForms(ctx: ReadContext): void {
	if (ctx.doc !== undefined) ctx.doc = connectDefaultsUnset(ctx.doc);
	const types = lookupTypes(expressionEnvOf(ctx));
	for (const module of ctx.draft.modules)
		for (const form of module.forms) {
			const doc = ctx.doc;
			const xform = form.xform;
			if (doc === undefined || xform === null) continue;
			if (doc.forms[form.uuid] === undefined) continue;
			settleChoices(ctx, doc, xform, types);
			for (const message of formText(xform)?.protectedMessages ?? [])
				settleProtectedMessage(ctx, doc, xform, message);
			checkCountFeedback(ctx, doc, form.uuid, xform);
			checkModelIterations(ctx, doc, form.uuid, xform);
			checkLoadOrder(ctx, doc, form.uuid, form.place, xform);
			checkHiddenTypes(ctx, doc, form.place, xform);
			checkDatetimeSiblings(ctx, doc, xform, types);
		}
}
