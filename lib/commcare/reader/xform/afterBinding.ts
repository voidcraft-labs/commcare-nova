/**
 * Stage 10: what the bound document decides for a form. A case choices
 * itemset compared with the nodeset Nova's emitter builds for it (10.1); a
 * count that reads the rows it creates (10.3); a model-iteration repeat held
 * to where Nova's own rule runs model iteration (10.4); a pair of load-time
 * values whose order a save in HQ's form builder changes, where one reads the
 * node the other sets (11.3); and a Hidden Value whose bind type is one Nova
 * would not write for it (11.4); and a protected validation message's composed
 * expression and its text's own forms (13.2). Each is compared with the production rule
 * over the document as the expression stage bound it. A check whose inputs a
 * finding withheld is skipped: that finding already sends the person to the
 * question or the form.
 */

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
import { planLanguageWire } from "../../languageWire";
import { commCareLocalization } from "../../localization";
import { inertLookupWireNaming } from "../../lookup/naming";
import { fieldBindType } from "../../xform/bindType";
import { protectConstraintMessage } from "../../xform/constraintMessage";
import { formNodeProjection } from "../../xpath/formNodeProjection";
import { readFormSyntax } from "../../xpath/formSyntax";
import { w } from "../../xpath/wire/builders";
import type { ReadContext } from "../context";
import { lookupTypes } from "../expressions/readExpression";
import { sameSyntax } from "../syntaxCompare";
import { ownText } from "../xmlCursor";
import { X } from "./claims";
import { G, HOLE, matchesHoles, sameTree } from "./generated";
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

/** A source path's field in Nova's document: the field it names, or the repeat whose node an
 *  attribute of it is. */
function targetField(names: ReadSourceNames, target: string): Uuid | undefined {
	const steps = target.split("/");
	const node = names.at([names.root, ...steps]);
	if (node?.kind === "field") return node.uuid;
	if (node?.kind === "repeat-attribute" || node?.kind === "query-row")
		return node.repeat;
	if (steps.at(-1)?.startsWith("@") === true) {
		const owner = names.at([names.root, ...steps.slice(0, -1)]);
		if (owner?.kind === "field") return owner.uuid;
	}
	return undefined;
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
	const pathOf = (uuid: Uuid) => names.fieldPath(uuid)?.slice(1);
	walkExpressionTerms(expression, (term) => {
		if (term.kind === "field") {
			const path = pathOf(term.uuid);
			if (path !== undefined) read.add(path.join("/"));
		} else if (term.kind === "repeat-row") {
			const path = pathOf(term.repeat);
			if (path === undefined) return;
			read.add([...path, "item", `@${term.attribute}`].join("/"));
			read.add([...path, "item", term.attribute].join("/"));
		} else if (term.kind === "form-node" && term.node.kind === "repeat") {
			const path = pathOf(term.node.repeat);
			if (path === undefined) return;
			if (term.node.role === "query-ids") read.add([...path, "@ids"].join("/"));
			if (term.node.role === "query-count")
				read.add([...path, "@count"].join("/"));
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
	const emitted = emittedLoadOrder(order, (step) => {
		const uuid = targetField(names, step.target);
		return uuid === undefined
			? positions.size
			: (positions.get(uuid) ?? positions.size);
	});
	const reads = new Map<LoadStep, Set<string>>();
	const readsOfStep = (step: LoadStep) => {
		const known = reads.get(step) ?? readsOf(doc, names, step);
		reads.set(step, known);
		return known;
	};
	for (const { reader } of loadOrderConflicts(order, emitted, readsOfStep))
		ctx.accounting.finding(X.loadOrder, reader.pending?.place ?? formPlace);
}

/** The Hidden Value bind type check of one form (11.4). */
function checkHiddenTypes(
	ctx: ReadContext,
	doc: BlueprintDoc,
	formPlace: DraftField["place"],
	xform: ReadXForm,
): void {
	const caseTypes = effectiveCaseTypes(doc);
	for (const field of fieldsOf(xform)) {
		if (field.standIn || field.kind !== "hidden" || field.uuid === undefined)
			continue;
		const stored = doc.fields[field.uuid] as Field | undefined;
		if (stored === undefined || stored.kind !== "hidden") continue;
		const bind = xform.binds.get(field.node);
		const source = bindTypeClass(bind?.type);
		if (source === undefined) continue;
		if (
			ctx.accounting.hasFindingAt(field.place) ||
			ctx.accounting.hasFindingAt(formPlace)
		)
			continue;
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
		settleCaseChoices(xform.cursor, xform.parsed, proposal, field.place, same);
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
 * One protected validation message (13.2): the question's `jr:constraintMsg` is the expression
 * `protectConstraintMessage` composes from the message as the document now holds it in every
 * language, each of its references standing where the text's own output does, and the text's
 * `__nova_` forms are exactly the ones it writes. Equal, the expression and the forms are
 * claimed as the message's; different, they are left for the close to report.
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
	const lower = (part: ProseAtomPart) => {
		const identity = JSON.stringify(part);
		const hole = holeOf.get(identity) ?? `${HOLE}_${holeOf.size}`;
		holeOf.set(identity, hole);
		return w.context([w.step(hole)]);
	};
	const localization = commCareLocalization(doc);
	const unitId = makeTranslationUnitId("field", uuid, "validate_msg");
	ctx.accounting.noteRebuild();
	const built = protectConstraintMessage(
		message.textId,
		localization.languages.map((language) => ({
			language,
			template: localization.prose(language, unitId),
		})),
		lower,
	);
	if (built === undefined) return;
	const expected = new Map(
		[...holeOf].map(([identity, hole]) => [hole, outputOf.get(identity)]),
	);
	const bound = matchesHoles(
		message.bind.attribs[message.attribute] ?? "",
		built.expression,
		(name) => expected.has(name),
	);
	const sameExpression =
		bound !== undefined &&
		[...expected].every(([hole, output]) => {
			const at = bound.get(hole);
			const read = output === undefined ? undefined : readFormSyntax(output);
			return (
				at !== undefined &&
				read?.ok === true &&
				read.node !== undefined &&
				sameSyntax(at, read.node, { ruleSet: "form" })
			);
		});
	// The text's own forms, language by language, against the ones the composition writes.
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
	const sameForms = owned.every(({ code, values }) => {
		const want = code === undefined ? undefined : built.forms.get(code);
		if (want === undefined || want.length !== values.length) return false;
		const held = new Map(
			values.map((value) => [value.attribs.form, ownText(value)] as const),
		);
		return want.every(
			(value) => held.get(value.attribs.form) === ownText(value),
		);
	});
	if (!sameExpression || !sameForms) return;
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

/** Stage 10: the checks of each form that need the bound document. */
export function finishForms(ctx: ReadContext): void {
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
		}
}
