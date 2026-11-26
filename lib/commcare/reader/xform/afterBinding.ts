import { VELLUM_NS } from "../../xmlNamespaces";
import { ownNamespace } from "./join";
import { attributeNameIn } from "./model";
/**
 * Stage 10: what the bound document decides for a form. A case choices
 * itemset compared with the nodeset Nova's emitter builds for it; a
 * count that reads the rows it creates; a model-iteration repeat held
 * to where Nova's own rule runs model iteration; a pair of load-time
 * values whose order a save in HQ's form builder changes, where one reads the
 * node the other sets; a hidden answer type Nova's automatic type writes, and
 * the spellings of hidden answer types; and a protected validation message's composed
 * expression and its text's own forms. Each is compared with the production rule
 * over the document as the expression stage bound it. A check whose inputs a
 * finding withheld is skipped: that finding already sends the person to the
 * question or the form. A Hidden Value holding both a calculate and a
 * default keeps both, claimed by whether a runtime can read the default.
 */

import { type Element, isTag } from "domhandler";
import {
	type BlueprintDoc,
	effectiveCaseTypes,
	type Field,
	fieldCaseWriteViews,
	type ProseAtomPart,
	type ProseTemplate,
	type Uuid,
} from "@/lib/domain";
import { and } from "@/lib/domain/expression/builders";
import {
	type LookupTypeIndex,
	slotContext,
} from "@/lib/domain/expression/context";
import { formStructure } from "@/lib/domain/expression/formStructure";
import type {
	Expression,
	ExpressionSlotRef,
} from "@/lib/domain/expression/types";
import { walkExpressionTerms } from "@/lib/domain/expression/walk";
import {
	effectiveAppLocalization,
	makeTranslationUnitId,
} from "@/lib/domain/localization";
import { expressionSlotValue } from "@/lib/domain/referenceSlots";
import { TriggerDag } from "@/lib/preview/engine/triggerDag";
import { caseOptionsNodeset } from "../../caseOptions";

import { el, text as textNode } from "../../elementBuilders";
import { planLanguageWire } from "../../languageWire";
import { commCareLocalization } from "../../localization";
import { inertLookupWireNaming } from "../../lookup/naming";
import { type SourceTable, tableOf } from "../../sourceKeys";
import { rethrowWorkStop } from "../../workMeter";
import { fieldBindType, hiddenAnswerTypeOf } from "../../xform/bindType";
import { protectConstraintMessage } from "../../xform/constraintMessage";
import { questionDatetimeCaseValue } from "../../xform/datetimeCaseValue";
import { formNodeProjection } from "../../xpath/formNodeProjection";
import type { FormSyntax } from "../../xpath/formSyntax";
import { w } from "../../xpath/wire/builders";
import { withCandidate } from "../candidate";
import type { DraftForm, ReadContext } from "../context";
import { lookupTypes } from "../expressions/readExpression";
import { pointerToken, sameJson } from "../jsonCursor";
import { builtScopes, sameElementWhole } from "../sameElement";
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
const QUERY_NODE_OFFSET: SourceTable<number> = tableOf({
	"query-ids": 0.1,
	"query-count": 0.2,
	"query-position": 0.3,
	"query-row": 0.5,
	"query-id": 0.6,
	"query-index": 0.7,
});

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
		return at(node.repeat, QUERY_NODE_OFFSET.get("query-row"));
	if (node?.kind === "repeat-attribute")
		return node.attribute === "id" || node.attribute === "index"
			? at(node.repeat, QUERY_NODE_OFFSET.get("query-row"))
			: at(node.repeat);
	if (node?.kind === "generated") {
		const offset = QUERY_NODE_OFFSET.get(node.purpose);
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

/** Whether the expression stage held what a bind's attribute registered. */
function held(ctx: ReadContext, element: object, attribute: string): boolean {
	const index = ctx.pending.firstAt(element, attribute);
	return (
		index !== undefined && ctx.pending.outcome(index).expression !== undefined
	);
}

/** The load-time order check of one form. */
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

/**
 * Whether no runtime reads the default of a Hidden Value that holds both a calculate and a
 * default outside every repeat. Core runs a new form's `xforms-ready` setvalues in model order
 * and then evaluates every calculate, relevant or not (`FormDef.initialize` →
 * `initAllTriggerables`, `Recalculate.apply`), and resuming a saved form runs no setvalue, so
 * the calculate replaces the default before any screen. Only a later `xforms-ready` setvalue
 * that reads the node, directly or through the calculates of the nodes it reads, can see the
 * default. Any doubt counts as a read: the expression stage not holding the default or the
 * calculate in its own slot, another setvalue setting the node, or a later setvalue whose reads
 * no bound tree gives.
 */
function defaultUnread(
	ctx: ReadContext,
	doc: BlueprintDoc,
	xform: ReadXForm,
	field: DraftField,
): boolean {
	const names = xform.sourceNames;
	const uuid = field.uuid;
	if (names === undefined || uuid === undefined) return false;
	const stored = doc.fields[uuid] as Field | undefined;
	if (
		stored === undefined ||
		stored.kind !== "hidden" ||
		stored.calculate === undefined ||
		stored.default_value === undefined
	)
		return false;
	const bind = xform.binds.get(field.node);
	const path = field.node.path.join("/");
	const defaults = xform.setvalues.filter(
		(setvalue) => setvalue.target?.join("/") === path,
	);
	const only = defaults[0];
	if (
		bind === undefined ||
		defaults.length !== 1 ||
		only === undefined ||
		only.event !== "xforms-ready" ||
		!held(ctx, bind.element, "calculate") ||
		!held(ctx, only.element, "value")
	)
		return false;
	const order = effectiveLoadOrder(xform);
	const at = order.findIndex(
		(step) => step.event === "xforms-ready" && step.target === path,
	);
	if (at === -1) return false;
	for (const step of order.slice(at + 1)) {
		if (step.event !== "xforms-ready") continue;
		if (step.pending === undefined) {
			// A query repeat's count of its rows, which Nova's own shape sets from its ids
			// alone; any other value no bound tree gives is a doubt.
			const node = names.at([names.root, ...step.target.split("/")]);
			const rowCount =
				(node?.kind === "repeat-attribute" && node.attribute === "count") ||
				(node?.kind === "generated" && node.purpose === "query-count");
			if (rowCount) continue;
			return false;
		}
		const seen = new Set<string>();
		const reach = (read: string): boolean => {
			if (read === path) return true;
			if (seen.has(read)) return false;
			seen.add(read);
			const node = names.at([names.root, ...read.split("/")]);
			if (node?.kind !== "field") return false;
			const through = doc.fields[node.uuid] as Field | undefined;
			if (through?.kind !== "hidden" || through.calculate === undefined)
				return false;
			let reached = false;
			walkExpressionTerms(through.calculate, (term) => {
				if (reached || term.kind !== "field") return;
				const through = names.fieldPath(term.uuid);
				if (through !== undefined && reach(through.slice(1).join("/")))
					reached = true;
			});
			return reached;
		};
		for (const read of readsOf(doc, names, step)) if (reach(read)) return false;
	}
	return true;
}

/** Account for a root hidden question under the observed or overwritten
 * seed class once later assignments are bound. The worker's initialization
 * order matters to that classification. The saved question keeps both slots. */
function settleBothSources(ctx: ReadContext, form: DraftForm): void {
	const xform = form.xform;
	if (xform === null) return;
	for (const field of fieldsOf(xform)) {
		if (field.bothSources === undefined) continue;
		const doc = ctx.doc;
		const unread =
			doc !== undefined &&
			doc.forms[form.uuid] !== undefined &&
			defaultUnread(ctx, doc, xform, field);
		const sites = unread ? X.kind.hiddenBothUnread : X.kind.hiddenBothObserved;
		ctx.accounting.claimEntry(
			{ element: field.node.element },
			sites.node.entry,
			"mug:DataBindOnly",
			field.place,
		);
		const bind = xform.binds.get(field.node);
		if (
			field.bothSources.typeDeferred &&
			bind !== undefined &&
			sites.type !== undefined &&
			sites.type.key !== null
		)
			ctx.accounting.claimEntry(
				{ element: bind.element, attribute: "type" },
				sites.type.entry,
				sites.type.key,
				field.place,
			);
	}
}

/**
 * Each date-and-time sibling the case management stage settled as Nova's (`datetime`): the
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
		} catch (error) {
			rethrowWorkStop(error);
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
	return ctx.pending
		.of("field", uuid)
		.find((index) => list[index]?.ref.slot === slot);
}

/**
 * A case choices itemset over the bound document. Its filter is the expression stage's:
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
		settleCaseChoices(xform.cursor, proposal, field.place, same, filtered);
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

/** A count that reads the rows it creates: the cycle proof the gate refuses it by, its
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

/** Where model iteration is held, for each model-iteration repeat of the form. */
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
		const idsAt = order.findIndex((step) => step.target === ids);
		const event = order[idsAt]?.event;
		const setAfterIds = (fieldUuid: Uuid): boolean | undefined => {
			const path = names.fieldPath(fieldUuid)?.slice(1).join("/");
			if (path === undefined || idsAt < 0) return undefined;
			const own = order
				.map((step, at) => ({ step, at }))
				.filter(({ step }) => step.event === event && step.target === path);
			return own.length === 0 ? undefined : own.every(({ at }) => at > idsAt);
		};
		const verdict = modelIterationVerdict(doc, formUuid, uuid, setAfterIds);
		// The role's wire spelling is shared. Its one manifest class is known
		// only after the query, opening assignments and ancestors are bound.
		const attribute = attributeNameIn(
			repeat.node.element,
			xform.parsed,
			VELLUM_NS,
			"role",
		);
		if (attribute === undefined) continue;
		const claim =
			verdict.kind === "refused"
				? verdict.claim
				: verdict.existingTiming
					? X.modelIterationOutsideRule
					: X.modelIteration.role;
		ctx.accounting.claimEntry(
			{ element: repeat.node.element, attribute },
			claim.entry,
			"vellum-markup:model/instance//*@vellum:role",
			repeat.place,
		);
	}
}

/**
 * One protected validation message, held to what Core shows in each language.
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
	// Each atom once, with the syntax of the source output it was bound from, for a branch no
	// language's forms name. A message that names one reference twice holds it once here, as
	// `outputOf` and `holeFor` do.
	const atomSyntax = [
		...new Map(atoms.map((atom) => [JSON.stringify(atom), atom])).values(),
	].flatMap((atom) => {
		const read = readFormSyntax(outputOf.get(JSON.stringify(atom)) ?? "");
		return read.ok && read.node !== undefined
			? [{ atom, node: read.node }]
			: [];
	});
	const branches = messageBranches(
		stored,
		message.textId,
		owned,
		localization.languages,
		(code) => localization.prose(code, unitId),
		(node) => {
			const found = atomSyntax.filter((one) =>
				sameSyntax(node, one.node, { ruleSet: "form" }),
			);
			return found.length === 1 ? found[0]?.atom : undefined;
		},
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
			order.map(({ label, template }) => ({ language: label, template })),
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
			writerOf: new Map(
				order.flatMap(({ label, writer }) =>
					writer === undefined ? [] : [[label, writer] as const],
				),
			),
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
	// Each stored form is the value the composition writes for its text, whole: `form` its only
	// attribute and its text its only content (`xform/constraintMessage.ts`), since the forms
	// were compared by their text alone.
	const scope = xform.parsed.scope;
	const asWritten = owned.every(({ values }) =>
		values.every((value) => {
			const built = el("value", { form: value.attribs.form ?? "" }, [
				textNode(ownText(value)),
			]);
			const parent = value.parent;
			const outer =
				parent !== null && isTag(parent)
					? scope(parent)
					: new Map<string, string>();
			return sameElementWhole(value, scope, built, builtScopes(built, outer));
		}),
	);
	if (!asWritten) return;
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

/** One branch of a stored protected message: the `__nova_locale` value that chooses it, the
 *  message it composes, and the language whose forms hold that value and whose message it is.
 *  A branch rebuilt from the stored expression alone, which no language's forms name, has no
 *  such language. */
interface MessageBranch {
	readonly label: string;
	readonly template: ProseTemplate;
	readonly writer: string | undefined;
}

/** A language's own forms of a protected message, by its wire code where the app lists it. */
interface OwnedForms {
	readonly code: string | undefined;
	readonly values: readonly Element[];
}

/**
 * The orders of branches a stored protected message may hold, each to be printed back. A branch
 * is a `__nova_locale` value some language's own forms hold, each value the one the language it
 * was written for wrote (`protectConstraintMessage` writes a language's code); its message is
 * that language's: the one of that code where it still holds the value, else the first in the
 * app's order that does (a language CommCare HQ renamed keeps the forms written under its old
 * code). A branch no language's forms name is the branch of a language CommCare HQ removed
 * (`views/apps.py::edit_app_langs` changes `langs` alone, so the expression keeps the branch;
 * HQ's build drops the language's translation, `xform.py::XForm.exclude_languages`, and a save in
 * HQ's form builder drops it from the source, `javaRosa/plugin.js::loadXML` reading no language
 * the app does not list): a tested value no language's forms hold, or, where every value a
 * language's forms hold is tested, the chain's tail. No language a device shows reads it, so its
 * message is rebuilt from the stored branch alone (`rebuiltMessage`), so the expression prints
 * back. The order is the one the stored expression tests the values in, read from its tree, and
 * the value no test names is the last branch's; where several could be, each is an order. Only a
 * proposal: the composition over it is printed back and compared whole.
 */
function messageBranches(
	stored: string,
	id: string,
	owned: readonly OwnedForms[],
	languages: readonly string[],
	templateOf: (code: string) => ProseTemplate,
	atomOf: (node: FormSyntax) => ProseAtomPart | undefined,
): MessageBranch[][] {
	const localeOf = (values: readonly Element[]): string | undefined => {
		const locales = values.filter(
			(value) => value.attribs.form === "__nova_locale",
		);
		return locales.length === 1 && locales[0] !== undefined
			? ownText(locales[0])
			: undefined;
	};
	const writerOf = new Map<string, string>();
	for (const code of languages) {
		const label = localeOf(
			owned.filter((one) => one.code === code).flatMap(({ values }) => values),
		);
		if (label === undefined) continue;
		if (label === code || !writerOf.has(label)) writerOf.set(label, code);
	}
	const read = testedLocales(stored, id);
	if (read === undefined) return [];
	const tested = read.tested.map(({ label }) => label);
	const branch = (
		label: string,
		node: FormSyntax | undefined,
	): MessageBranch | undefined => {
		const writer = writerOf.get(label);
		if (writer !== undefined)
			return { label, template: templateOf(writer), writer };
		const template =
			node === undefined ? undefined : rebuiltMessage(node, id, atomOf);
		return template === undefined
			? undefined
			: { label, template, writer: undefined };
	};
	const head = read.tested.map(({ label, node }) => branch(label, node));
	if (head.some((one) => one === undefined)) return [];
	const untested = [...writerOf.keys()].filter(
		(label) => !tested.includes(label),
	);
	// Every value a language's forms hold is tested, so the tail is a removed language's, whose
	// value the expression never prints: any value no test names stands for it.
	let removed = "";
	while (tested.includes(removed)) removed += "_";
	return (untested.length > 0 ? untested : [removed]).flatMap((last) => {
		const tail = branch(last, read.rest);
		return tail === undefined ? [] : [[...(head as MessageBranch[]), tail]];
	});
}

/**
 * The `__nova_locale` values a stored protected message tests, in order, each with the branch
 * it chooses: the chain `if(jr:itext('<id>;__nova_locale') = '<value>', <branch>, …)` inside its
 * outer `__nova_mode` test, read from the parsed tree, and what the chain ends in, the last
 * branch. Undefined where the text does not parse; a chain of another shape ends the list, and
 * the print-back refuses it.
 */
function testedLocales(
	stored: string,
	id: string,
):
	| {
			readonly tested: readonly {
				readonly label: string;
				readonly node: FormSyntax | undefined;
			}[];
			readonly rest: FormSyntax | undefined;
	  }
	| undefined {
	const read = readFormSyntax(stored);
	if (!read.ok || read.node === undefined) return undefined;
	const branchesOf = (node: FormSyntax): FormSyntax | undefined => {
		const call = stripGroups(node);
		return call.kind === "call" && call.name === "if" && call.args.length === 3
			? call
			: undefined;
	};
	const tested: { label: string; node: FormSyntax | undefined }[] = [];
	const outer = branchesOf(read.node);
	if (outer === undefined || outer.kind !== "call")
		return { tested, rest: undefined };
	let chain = outer.args[2];
	while (chain !== undefined) {
		const call = branchesOf(chain);
		if (call === undefined || call.kind !== "call") break;
		const test = stripGroups(call.args[0] as FormSyntax);
		if (test.kind !== "binary" || test.op !== "=") break;
		const left = stripGroups(test.left);
		const right = stripGroups(test.right);
		if (
			left.kind !== "call" ||
			left.name !== "jr:itext" ||
			left.args.length !== 1 ||
			right.kind !== "string"
		)
			break;
		const name = stripGroups(left.args[0] as FormSyntax);
		if (name.kind !== "string" || name.value !== `${id};__nova_locale`) break;
		tested.push({ label: right.value, node: call.args[1] });
		chain = call.args[2];
	}
	return { tested, rest: chain };
}

function stripGroups(node: FormSyntax): FormSyntax {
	return node.kind === "group" ? stripGroups(node.value) : node;
}

/**
 * The words of a literal in a branch no language reads. The composition prints a literal at
 * place `n` as `json-property(jr:itext('<id>;__nova_piece_<n>'), 'v')` whatever it holds, so its
 * words reach no expression, and since no language reads the branch they reach no document and
 * no device either. They are `${` because a stored composition was written for a message that
 * needed protection, and a literal `${` is the one text that needs it without a reference
 * (`constraintMessage.ts::constraintMessageNeedsProtection`): the proposal then never fails on
 * words it cannot know.
 */
const UNREAD_LITERAL = "${";

/**
 * The message a stored branch no language reads composes, rebuilt from the branch alone, as
 * `protectConstraintMessage` composes a branch: `''`, one part or `concat` of the parts in
 * order, where a literal at place `n` is `json-property(jr:itext('<id>;__nova_piece_<n>'), 'v')`
 * (`UNREAD_LITERAL`), and a reference is the expression of the one atom whose source output has
 * its syntax (`atomOf`). A branch that reads an answer stands under the guard
 * `if(count(…) > 1 or …, '', …)`, and one that reads none does not. Undefined where a part is
 * neither. Only a proposal: the composition over it is printed back and compared whole.
 */
function rebuiltMessage(
	node: FormSyntax,
	id: string,
	atomOf: (node: FormSyntax) => ProseAtomPart | undefined,
): ProseTemplate | undefined {
	const partsOf = (
		composed: FormSyntax,
	): ProseTemplate["parts"][number][] | undefined => {
		const whole = stripGroups(composed);
		if (whole.kind === "string" && whole.value === "") return [];
		const args =
			whole.kind === "call" && whole.name === "concat" ? whole.args : [whole];
		const parts: ProseTemplate["parts"][number][] = [];
		for (const [index, arg] of args.entries()) {
			const call = stripGroups(arg);
			const property =
				call.kind === "call" &&
				call.name === "json-property" &&
				call.args.length === 2
					? call.args
					: undefined;
			const itext =
				property === undefined
					? undefined
					: stripGroups(property[0] as FormSyntax);
			const key =
				property === undefined
					? undefined
					: stripGroups(property[1] as FormSyntax);
			const name =
				itext?.kind === "call" &&
				itext.name === "jr:itext" &&
				itext.args.length === 1
					? stripGroups(itext.args[0] as FormSyntax)
					: undefined;
			if (
				name?.kind === "string" &&
				name.value === `${id};__nova_piece_${index}` &&
				key?.kind === "string" &&
				key.value === "v"
			) {
				parts.push({ kind: "text", text: UNREAD_LITERAL });
				continue;
			}
			const atom = atomOf(arg);
			if (atom === undefined) return undefined;
			parts.push(atom);
		}
		return parts;
	};
	const counted = (parts: readonly ProseTemplate["parts"][number][]) =>
		parts.some((part) => part.kind !== "text" && part.kind !== "value");
	const whole = stripGroups(node);
	if (whole.kind === "call" && whole.name === "if" && whole.args.length === 3) {
		const empty = stripGroups(whole.args[1] as FormSyntax);
		const guarded =
			empty.kind === "string" && empty.value === ""
				? partsOf(whole.args[2] as FormSyntax)
				: undefined;
		if (guarded !== undefined && counted(guarded)) return { parts: guarded };
	}
	const parts = partsOf(node);
	return parts !== undefined && !counted(parts) ? { parts } : undefined;
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
	owned: readonly OwnedForms[],
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

/** The bind type a Hidden Value's export writes, with the bound document's
 * writes: its chosen type's, or its automatic one. */
function emittedHiddenBind(
	doc: BlueprintDoc,
	field: Field,
): string | undefined {
	return (
		fieldBindType(
			field,
			effectiveCaseTypes(doc),
			fieldCaseWriteViews(doc, field.uuid),
		) ?? undefined
	);
}

/** A Hidden Value whose source binds the text or date-and-time class, which
 * the join left automatic: where Nova's automatic type, over the bound
 * document's writes and calculate, writes another class, the source's class
 * becomes the chosen answer type, so the export binds what the source binds.
 * Where it writes the same class the value stays automatic, which is how
 * Nova's own export of an automatic Hidden Value reads back. */
function settleHiddenAnswerTypes(
	ctx: ReadContext,
	xform: ReadXForm,
	doc: BlueprintDoc,
): void {
	const chosen = new Map<Uuid, "text" | "datetime">();
	for (const field of fieldsOf(xform)) {
		if (field.kind !== "hidden" || field.standIn || field.uuid === undefined)
			continue;
		const source = hiddenAnswerTypeOf(xform.binds.get(field.node)?.type);
		if (source !== "text" && source !== "datetime") continue;
		const stored = doc.fields[field.uuid];
		if (stored?.kind !== "hidden" || stored.answerType !== undefined) continue;
		if (hiddenAnswerTypeOf(emittedHiddenBind(doc, stored)) !== source)
			chosen.set(field.uuid, source);
	}
	if (chosen.size === 0) return;
	ctx.doc = withCandidate(doc, (draft) => {
		for (const [uuid, answerType] of chosen) {
			const held = draft.fields[uuid];
			if (held?.kind === "hidden") held.answerType = answerType;
		}
	});
}

/** A hidden answer's spelling can name the same answer class as the emitted
 * type. An unknown type and an absent type both hold UncastData. Record only
 * a source with an actual attribute whose next spelling changes. */
function recordHiddenAnswerSpellings(
	ctx: ReadContext,
	form: DraftForm,
	xform: ReadXForm,
	doc: BlueprintDoc,
): void {
	const readId =
		ctx.input.source.modules[form.menu]?.forms[form.index]?.readUniqueId;
	for (const field of fieldsOf(xform)) {
		if (field.kind !== "hidden" || field.standIn || field.uuid === undefined)
			continue;
		const spelling = xform.binds.get(field.node)?.type;
		if (spelling === undefined) continue;
		const stored = doc.fields[field.uuid];
		if (
			stored?.kind !== "hidden" ||
			emittedHiddenBind(doc, stored) === spelling
		)
			continue;
		// Inside a form's source a place names its data root `data`, whatever
		// the form calls it (`firstPublishPlaces.ts::FIRST_PUBLISH_PLACE_KINDS`,
		// `proof/checks/xform_parts.py::DATA`).
		const steps = [
			"_attachments",
			`${readId ?? form.xmlns}.xml`,
			"data",
			...field.node.path,
			":bind",
			"@type",
		];
		ctx.facts.sameStateRewrites.push({
			entry: X.hiddenTypedAnswer.entry,
			path: `/${steps.map(pointerToken).join("/")}`,
			register: "hidden-answer-types-respelled",
		});
	}
}

/**
 * A model iteration's display condition on its container's bind (the node
 * holding `@ids`, `@count` and `@current_index`), which the form builder never
 * writes: its question is the rows (`modeliteration.js::getPathName`), so it
 * discards a bind on the container (`parser.js::parseBindElement`). The
 * condition is the repeat's, and the next publish writes it on the rows, as
 * the form builder and Nova's export write a model iteration's condition
 * (`buildQueryRepeat`); a condition the rows hold as well is joined to it,
 * since Core hides a row where either is false. While it is false Core leaves
 * the container and its rows out of the submission
 * (`XFormSerializingVisitor.serializeNode`), and after the publish the
 * container with its ids, so the reading records the move for the first
 * publish's list.
 */
function moveContainerConditions(
	ctx: ReadContext,
	form: DraftForm,
	xform: ReadXForm,
	doc: BlueprintDoc,
): void {
	const readId =
		ctx.input.source.modules[form.menu]?.forms[form.index]?.readUniqueId;
	const joined = new Map<Uuid, Expression>();
	for (const repeat of xform.modelIterations) {
		const container = xform.binds.get(repeat.node);
		if (container?.logic.relevant === undefined || repeat.uuid === undefined)
			continue;
		if (doc.fields[repeat.uuid] === undefined) continue;
		const claim = X.modelIterationContainerCondition;
		ctx.accounting.claimEntryClass(
			{ element: container.element, attribute: "relevant" },
			claim.entry,
			"xform:model/bind@relevant",
			repeat.place,
		);
		const row = [...xform.roles].find(
			([, role]) => role.kind === "query-row" && role.repeat === repeat,
		)?.[0];
		// The move takes the condition off the container's bind and writes it on the rows'.
		for (const node of row === undefined ? [repeat.node] : [repeat.node, row]) {
			const steps = [
				"_attachments",
				`${readId ?? form.xmlns}.xml`,
				"data",
				...node.path,
				":bind",
				"@relevant",
			];
			ctx.facts.sameStateRewrites.push({
				entry: claim.entry,
				path: `/${steps.map(pointerToken).join("/")}`,
				register: "model-iteration-conditions-moved-to-rows",
			});
		}
		const rowBind = row === undefined ? undefined : xform.binds.get(row);
		if (rowBind?.logic.relevant === undefined) continue;
		const own = ctx.pending.firstAt(container.element, "relevant");
		const rows = ctx.pending.firstAt(rowBind.element, "relevant");
		const ownTree =
			own === undefined ? undefined : ctx.pending.outcome(own).expression;
		const rowTree =
			rows === undefined ? undefined : ctx.pending.outcome(rows).expression;
		if (ownTree !== undefined && rowTree !== undefined)
			joined.set(repeat.uuid, and(ownTree, rowTree));
	}
	if (joined.size === 0) return;
	ctx.doc = withCandidate(doc, (draft) => {
		for (const [uuid, condition] of joined) {
			const held = draft.fields[uuid];
			if (held?.kind === "repeat") held.relevant = condition;
		}
	});
}

/** The entry a data node's namespace is held under where the node inherits the form's own. */
const FORM_NAMESPACE =
	"forms-and-case-writes/xmlns-form-json-and-xform-data-node";

/**
 * Each data node's namespace, which Core reads of every node of the main instance
 * (`XFormParser.buildInstanceStructure`), where the node declares none of its own: the form's
 * data namespace, held as the form's `xmlns` is. A node declaring its own is claimed where it is
 * read (`join.ts::claimNode`, a Hidden Value's receiving namespace), and one no reading claimed
 * stays unclaimed. Claimed last, so every reading's own claim of a namespace stands first.
 */
function claimInheritedNamespaces(
	ctx: ReadContext,
	form: DraftForm,
	xform: ReadXForm,
): void {
	for (const node of xform.nodes.values()) {
		if (node.path.length === 0 || ownNamespace(node, xform.parsed)) continue;
		// A refused thing is claimed whole, nothing inside it apart.
		if (xform.refusals.over({ element: node.element }) !== undefined) continue;
		ctx.accounting.claimEntry(
			{ element: node.element, attribute: "xmlns" },
			FORM_NAMESPACE,
			"xform:model/instance//*@xmlns",
			form.place,
			undefined,
			{ unlessClaimed: true },
		);
	}
}

/** Stage 10: the checks of each form that need the bound document. */
export function finishForms(ctx: ReadContext): void {
	const types = lookupTypes(expressionEnvOf(ctx));
	for (const module of ctx.draft.modules)
		for (const form of module.forms) {
			const xform = form.xform;
			settleBothSources(ctx, form);
			const doc = ctx.doc;
			if (doc === undefined || xform === null) continue;
			if (doc.forms[form.uuid] === undefined) continue;
			settleHiddenAnswerTypes(ctx, xform, doc);
			const bound = ctx.doc ?? doc;
			recordHiddenAnswerSpellings(ctx, form, xform, bound);
			settleChoices(ctx, bound, xform, types);
			for (const message of formText(xform)?.protectedMessages ?? [])
				settleProtectedMessage(ctx, bound, xform, message);
			checkCountFeedback(ctx, bound, form.uuid, xform);
			checkModelIterations(ctx, bound, form.uuid, xform);
			moveContainerConditions(ctx, form, xform, ctx.doc ?? bound);
			claimInheritedNamespaces(ctx, form, xform);
			checkLoadOrder(ctx, bound, form.uuid, form.place, xform);
			checkDatetimeSiblings(ctx, bound, xform, types);
		}
}
