/**
 * The case management stages: each form's type, case operations,
 * conditions and preloads read from its `actions`, basic or advanced, and
 * from its Save to Case blocks (`readCaseManagement`); written once its
 * questions are minted, with each advanced menu's parent selection and the
 * app's case catalog (`writeCaseOperations`); and accepted over the bound
 * document by the production emitter (`settleCaseManagement`): every
 * condition stated back by `stateCondition`, the form's actions planned
 * again by `planFormCaseWire` and compared with the stored ones, every
 * Save to Case block written again and compared, every placement held
 * where it was read, and each scalar check folded out of a constraint
 * written back.
 */
import type { BlueprintDoc } from "@/lib/domain";
import {
	caseScalarTextGuardIsChecked,
	caseScalarTextGuards,
} from "@/lib/domain/caseScalarTextGuard";
import { planFormCaseWire } from "../../casePlacementPlan";
import { expandDoc } from "../../expander";
import {
	entryFactsDifference,
	hqEntryFacts,
	menuFactsDifference,
} from "../../hq/entryFacts";
import {
	activeActions,
	isMultiSelectMenu,
	menuMayLoadRegistryCase,
} from "../../hq/publishedCaseBlocks";
import { type PlacementSubject, planPlacements } from "../../placement";
import type { DraftApp, DraftForm, ReadContext } from "../context";
import { isJsonObject, sameJson } from "../jsonCursor";
import { appPlace } from "../place";
import { readProjectionInputs } from "../projectionInputs";
import { provisionalDocument } from "../provisional";
import type { DraftField, ReadXForm } from "../xform";
import {
	ADVANCED_CLAIMS,
	readAdvancedActions,
	readAdvancedMenu,
	settleAdvancedForm,
	settleAdvancedMenu,
	writeAdvancedChains,
	writeAdvancedOperations,
} from "./advancedActions";
import {
	basicCaseReading,
	readBasicActions,
	settleDatetimeJoins,
	writeBasicOperations,
} from "./basicActions";
import { readCaseCatalog, settleWriterTypes } from "./catalog";
import {
	conditionFinding,
	readActionCondition,
	statedBack,
} from "./conditions";
import { readPreloads, settlePreloads } from "./preloads";
import {
	readSaveToCaseBlocks,
	saveToCaseReading,
	settleSaveToCase,
	writeSaveToCaseOperations,
} from "./saveToCase";

/**
 * Step 3, pass 1: every form's type, case operations and preloads, read from
 * its `actions` with every key claimed, and from its Save to Case blocks;
 * every advanced menu's own keys. The operations' questions are minted after
 * this (`mintFields`), so they reach the draft in `writeCaseOperations`.
 */
export function readCaseManagement(ctx: ReadContext, app: DraftApp): void {
	for (const module of app.modules) {
		readAdvancedMenu(ctx, module);
		for (const form of module.forms) {
			if (form.xform === null) continue;
			if (form.docType === "Form") {
				readBasicActions(ctx, module, form);
				readPreloads(ctx, module, form);
			} else readAdvancedActions(ctx, module, form);
			readSaveToCaseBlocks(ctx, module, form);
		}
	}
}

/** Step 3, once the forms' questions are minted: each form's case
 *  operations and conditions, written into its draft; each advanced menu's
 *  parent selection from its forms' loads; and the app's case catalog. */
export function writeCaseOperations(ctx: ReadContext, app: DraftApp): void {
	for (const module of app.modules)
		for (const form of module.forms) {
			writeBasicOperations(
				ctx,
				form,
				(saveToCaseReading(form)?.proposals ?? []).some(
					(one) => one.action === "own",
				),
			);
			writeAdvancedOperations(ctx, form);
			writeSaveToCaseOperations(ctx, form);
		}
	writeAdvancedChains(ctx);
	readCaseCatalog(ctx, app);
}

// ── Acceptance by re-emission ───────────────────────────────────────────

type JsonObject = Readonly<Record<string, unknown>>;

function object(value: unknown): JsonObject {
	return isJsonObject(value) ? value : {};
}

/** A question path of `form`, mapped through each generated node to the
 *  question it belongs to, as a path from the data root. */
function ownerPath(form: DraftForm, path: unknown): string | null {
	if (typeof path !== "string" || path === "") return null;
	const xform = form.xform;
	if (xform === null) return path;
	const root = xform.parsed.dataRoot.name;
	const relative = path.startsWith(`/${root}/`)
		? path.slice(root.length + 2)
		: path;
	const node = xform.nodes.get(relative);
	const role = node === undefined ? undefined : xform.roles.get(node);
	if (role?.kind === "generated") return role.owner.path.join("/");
	return relative;
}

function condition(form: DraftForm, stored: unknown): unknown {
	const value = object(stored);
	const type = value.type ?? "never";
	if (type !== "if") return type;
	return {
		question: ownerPath(form, value.question),
		answer: value.answer ?? null,
		operator: value.operator ?? "=",
	};
}

/** An update map as `[key, question, mode]`, the key's order left out. */
function updates(
	form: DraftForm,
	stored: unknown,
	applied: boolean,
): readonly unknown[] {
	return Object.entries(object(stored))
		.map(([key, update]) => {
			const one = object(update);
			const mode = one.update_mode === "edit" && applied ? "edit" : "always";
			return [key, ownerPath(form, one.question_path), mode] as const;
		})
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** What decides which of a basic form's actions HQ's build reads: the form's
 *  `requires`, and whether its menu selects several cases or may load a data
 *  registry's case (`xform.py::XForm._create_casexml`). */
interface BuildReads {
	readonly requires: unknown;
	readonly multi: boolean;
	readonly registry: boolean;
}

/**
 * A basic form's actions as the comparison reads them: only the actions HQ's
 * build reads, so every key the first pass claimed INERT or read past is left
 * out (an action `activeActions` leaves inactive for the form's `requires`,
 * such as an open action on a form that requires a case; a survey's close,
 * for which HQ builds no case block; the update, close and child cases of a
 * form whose menu selects several cases or loads a data registry's case,
 * where `default_case_management` is false, unless the form opens its case);
 * `update_case.condition` left out, `open_case.external_id` read as the
 * external id write Nova writes, each `name_update`'s mode and each
 * `reference_id` left out, an unapplied `edit` read as `always`, and every
 * question path mapped to its question.
 */
function comparable(
	form: DraftForm,
	actions: unknown,
	reads: BuildReads,
	applied: boolean,
): Readonly<Record<string, unknown>> {
	const stored = object(actions);
	const live = activeActions(stored, reads.requires);
	const open = object(stored.open_case);
	const update = object(stored.update_case);
	const opens = live.has("open_case");
	const defaultCaseManagement = (!reads.multi && !reads.registry) || opens;
	// HQ's build writes no case block on a form that requires no case and opens none.
	const block = reads.requires !== "none" || opens;
	const updateMap = {
		...(live.has("update_case") && defaultCaseManagement && block
			? object(update.update)
			: {}),
		...(opens && typeof open.external_id === "string" && open.external_id !== ""
			? { external_id: { question_path: open.external_id } }
			: {}),
	};
	const usercase = object(stored.usercase_update);
	const closes = live.has("close_case") && defaultCaseManagement && block;
	const subcases =
		live.has("subcases") &&
		defaultCaseManagement &&
		Array.isArray(stored.subcases)
			? stored.subcases
			: [];
	return {
		open_case: opens
			? {
					condition: condition(form, open.condition),
					name: ownerPath(form, object(open.name_update).question_path),
				}
			: null,
		update_case: updates(form, updateMap, applied),
		close_case: closes
			? condition(form, object(stored.close_case).condition)
			: "never",
		subcases: subcases.map((one) => {
			const subcase = object(one);
			return {
				case_type: subcase.case_type ?? null,
				name: ownerPath(form, object(subcase.name_update).question_path),
				case_properties: updates(form, subcase.case_properties, applied),
				repeat_context: ownerPath(form, subcase.repeat_context),
				condition: condition(form, subcase.condition),
				close_condition: condition(form, subcase.close_condition),
			};
		}),
		usercase_update: live.has("usercase_update")
			? updates(form, usercase.update, applied)
			: [],
	};
}

/** The surface key of the first part of two comparable actions that differs. */
function firstDifference(
	a: Readonly<Record<string, unknown>>,
	b: Readonly<Record<string, unknown>>,
): string | undefined {
	for (const key of Object.keys(a))
		if (!sameJson(a[key], b[key])) return `schema:FormActions.${key}`;
	return undefined;
}

/** Raises a form's `unrecognized` reading once, at the form. */
function unrecognized(ctx: ReadContext, form: DraftForm, name: string): void {
	ctx.accounting.circumstance("unrecognized", form.place, { name });
}

/** The conditions of one basic form, each stated back by `stateCondition`. */
function settleConditions(
	ctx: ReadContext,
	doc: BlueprintDoc,
	form: DraftForm,
): boolean {
	const reading = basicCaseReading(form);
	if (reading === undefined) return true;
	let ok = true;
	for (const { condition } of reading.conditions) {
		const read = readActionCondition(
			condition.stored,
			{ own: condition.own, repeat: condition.repeat?.uuid },
			form,
		);
		if (read.kind === "finding") {
			ok = false;
			continue;
		}
		if (read.kind !== "if") continue;
		const stated = statedBack(doc, form.uuid, read.expression, {
			own: condition.own,
			repeat: condition.repeat?.uuid,
		});
		if (stated.reasons.length > 0) {
			const claim = conditionFinding(stated.reasons, condition.own);
			if (claim !== undefined) ctx.accounting.finding(claim, condition.place);
			else unrecognized(ctx, form, "schema:FormActionCondition.question");
			ok = false;
			continue;
		}
		const stored = object(condition.stored);
		// The stored condition stated back: the same operator, and the same
		// answer wherever the operator compares one.
		const back = stated.stated;
		const sameAnswer =
			back?.operator === "boolean_true" ||
			(back?.answer ?? null) === (stored.answer ?? null);
		if (
			back === undefined ||
			doc.fields[back.question] === undefined ||
			back.operator !== (stored.operator ?? "=") ||
			!sameAnswer
		) {
			unrecognized(ctx, form, "schema:FormActionCondition.question");
			ok = false;
		}
	}
	return ok;
}

/** The surface key of the action a basic form's operation, or its own close,
 *  was read from. */
function operationKey(
	doc: BlueprintDoc,
	form: DraftForm,
	subject: PlacementSubject,
): string {
	if (subject.kind === "own-close") return "schema:FormActions.close_case";
	const operation = doc.forms[form.uuid]?.caseOperations?.find(
		(one) => one.uuid === subject.operationUuid,
	);
	const placement = operation?.placement;
	if (placement?.kind === "save-to-case") return "mug:SaveToCase";
	if (placement?.kind !== "basic") return "schema:Form.actions";
	if (placement.slot === "usercase")
		return "schema:FormActions.usercase_update";
	if (placement.slot === "own")
		return doc.forms[form.uuid]?.type === "registration"
			? "schema:FormActions.open_case"
			: "schema:FormActions.update_case";
	return "schema:FormActions.subcases";
}

/** Each placement the reader read, planned where it was read: undefined where
 *  every one is, else the surface key the form's `unrecognized` names. A held
 *  placement that no longer expresses its operation names the operation's key. */
function placementsHeld(
	doc: BlueprintDoc,
	form: DraftForm,
): string | undefined {
	const plan = planPlacements(doc, form.uuid);
	const stranded = plan.inexpressible[0];
	if (stranded !== undefined) return operationKey(doc, form, stranded.subject);
	const unheld = "schema:Form.actions";
	const operations = doc.forms[form.uuid]?.caseOperations ?? [];
	const own = operations.find((one) => one.action === "own");
	for (const operation of operations) {
		const planned = plan.placements.get(operation.uuid);
		if (operation.placement !== undefined) {
			if (planned?.held !== true) return unheld;
			continue;
		}
		if (operation.action !== "close" || operation.target.kind !== "op")
			continue;
		const create = operations.find(
			(one) =>
				operation.target.kind === "op" && one.uuid === operation.target.opUuid,
		);
		if (
			planned?.sharesWith !== create?.uuid ||
			create?.placement === undefined ||
			!sameJson(planned?.placement, create.placement)
		)
			return unheld;
	}
	const form_ = doc.forms[form.uuid];
	const closesOwn =
		form_?.type === "close" ||
		(form_?.type === "registration" && form_.closeCondition !== undefined);
	if (
		closesOwn &&
		own !== undefined &&
		form_?.ownClosePlacement === undefined
	) {
		const planned = plan.placements.get("own-close");
		if (
			planned?.sharesWith !== own.uuid ||
			!sameJson(planned.placement, own.placement)
		)
			return unheld;
	}
	return undefined;
}

/** Every field of a form's reading in document order. */
function readFields(xform: ReadXForm): DraftField[] {
	const order: DraftField[] = [];
	const walk = (parent: DraftField | null) => {
		for (const field of xform.childrenOf(parent)) {
			order.push(field);
			walk(field);
		}
	};
	walk(null);
	return order;
}

/** The scalar check part of each question's constraint, written back only
 *  where Nova's emitter writes the same check there. */
function settleScalarChecks(
	ctx: ReadContext,
	doc: BlueprintDoc,
	form: DraftForm,
): void {
	const xform = form.xform;
	if (xform === null || doc.forms[form.uuid] === undefined) return;
	const guards = caseScalarTextGuards(doc, form.uuid);
	for (const field of readFields(xform)) {
		if (field.scalarCheck === undefined || field.uuid === undefined) continue;
		if (
			guards.get(field.uuid) !== field.scalarCheck ||
			!caseScalarTextGuardIsChecked(field.kind)
		)
			ctx.accounting.circumstance("unrecognized", field.place, {
				name: "xform:model/bind@constraint",
			});
	}
}

/** One basic form's actions planned again and compared with the stored ones. */
function settleBasicForm(
	ctx: ReadContext,
	doc: BlueprintDoc,
	form: DraftForm,
): void {
	if (!settleConditions(ctx, doc, form)) return;
	const inputs = readProjectionInputs(ctx);
	let planned: ReturnType<typeof planFormCaseWire>;
	try {
		planned = planFormCaseWire(doc, form.uuid, {
			identity: inputs.identity,
			attachmentTarget: inputs.attachmentTarget,
		});
	} catch {
		unrecognized(ctx, form, "planFormCaseWire");
		return;
	}
	if (planned.kind !== "basic") {
		unrecognized(ctx, form, "schema:Form.actions");
		return;
	}
	const applied = ctx.input.saveOnlyEditedApplied === true;
	const menu = ctx.draft.modules.find((one) => one.forms.includes(form));
	const menuJson = {
		case_details: menu?.json.peek("case_details"),
		search_config: menu?.json.peek("search_config"),
	};
	const reads: BuildReads = {
		requires: form.json.peek("requires") ?? "none",
		multi: isMultiSelectMenu(menuJson),
		registry: menuMayLoadRegistryCase(menuJson),
	};
	const difference = firstDifference(
		comparable(form, form.json.peek("actions"), reads, applied),
		comparable(form, planned.actions, reads, true),
	);
	if (difference !== undefined) {
		unrecognized(ctx, form, difference);
		return;
	}
	const unheld = placementsHeld(doc, form);
	if (unheld !== undefined) unrecognized(ctx, form, unheld);
}

/**
 * Step 6, pass 2: every basic form's reading accepted over the bound
 * document, its scalar checks held to the emitter's, and its preloads judged.
 */
export function settleCaseManagement(ctx: ReadContext, app: DraftApp): void {
	for (const module of app.modules)
		for (const form of module.forms) settleDatetimeJoins(ctx, form);
	const doc = ctx.doc;
	if (doc === undefined) {
		// No document to emit: each form's blocks stand as pass 1 read them,
		// and its `save` map is judged against them.
		for (const module of app.modules)
			for (const form of module.forms) settleSaveToCase(ctx, form);
		return;
	}
	for (const module of app.modules) {
		settleAdvancedMenu(ctx, doc, module);
		for (const form of module.forms) {
			if (doc.forms[form.uuid] === undefined) {
				settleSaveToCase(ctx, form);
				continue;
			}
			if (form.docType === "Form" && basicCaseReading(form) !== undefined)
				settleBasicForm(ctx, doc, form);
			if (form.docType === "AdvancedForm")
				settleAdvancedForm(ctx, ctx.doc ?? doc, form);
			settleSaveToCase(ctx, form);
			settleScalarChecks(ctx, ctx.doc ?? doc, form);
			settlePreloads(ctx, form);
		}
	}
	settleWriterTypes(ctx, app, ctx.doc ?? doc);
}

// ── The entry facts ─────────────────────────────────────────────────────

/**
 * Compares the facts CommCare HQ's entry builder reads, menu by menu and
 * form by form, between the source and Nova's emission of the document the
 * drafts give before any expression is bound (`provisionalDocument`): run
 * once every slot a fact reads is written and nothing is bound. Each form
 * that differs is listed in `ctx.facts.entryFactsRefused`, with its finding.
 */
export function compareEntryFacts(ctx: ReadContext, app: DraftApp): void {
	const doc = provisionalDocument(ctx);
	const source = hqEntryFacts(ctx.input.source.raw);
	let emitted: ReturnType<typeof hqEntryFacts>;
	try {
		emitted = hqEntryFacts(expandDoc(doc, readProjectionInputs(ctx)));
	} catch {
		ctx.accounting.circumstance("unrecognized", appPlace(), {
			name: "expandDoc",
		});
		return;
	}
	// A slot a finding of a structure stage left absent is why its fact
	// differs; that finding already sends the person there.
	const raise = (place: DraftForm["place"], key: string) => {
		if (ctx.accounting.hasFindingAt(place)) return;
		if (key === "moduleKind")
			ctx.accounting.finding(ADVANCED_CLAIMS.kindBlocked, place);
		else
			ctx.accounting.circumstance("unrecognized", place, {
				name: `entry-fact:${key}`,
			});
	};
	for (const module of app.modules) {
		const a = source.menus.get(module.uniqueId);
		const b = emitted.menus.get(module.uniqueId);
		if (a !== undefined && b !== undefined) {
			const key = menuFactsDifference(a, b);
			if (key !== undefined) raise(module.place, key);
		}
		for (const form of module.forms) {
			const facts = source.forms.get(form.xmlns);
			const ours = emitted.forms.get(form.xmlns);
			if (facts === undefined || ours === undefined) continue;
			const key = entryFactsDifference(facts, ours);
			if (key === undefined) continue;
			if (key === "loads" && !ctx.accounting.hasFindingAt(form.place)) {
				// A load whose only difference is its tag, on a load that changes no
				// case, is a tag Nova would not derive; any other is not the menu's chain.
				const tagOnly =
					facts.loads.length === ours.loads.length &&
					facts.loads.every((load, i) => {
						const other = ours.loads[i];
						return (
							other !== undefined &&
							sameJson(
								{ ...load, tag: "", indexTag: null },
								{ ...other, tag: "", indexTag: null },
							)
						);
					});
				const differing = facts.loads.find(
					(load, i) => load.tag !== ours.loads[i]?.tag,
				);
				ctx.accounting.finding(
					tagOnly ? ADVANCED_CLAIMS.underivedTag : ADVANCED_CLAIMS.notOneChain,
					form.place,
					{
						name:
							differing?.tag ?? facts.loads[facts.loads.length - 1]?.tag ?? "",
					},
				);
			} else if (key === "moduleKind") {
				if (!ctx.accounting.hasFindingAt(module.place))
					ctx.accounting.finding(ADVANCED_CLAIMS.kindBlocked, module.place);
			} else raise(form.place, key);
			ctx.facts.entryFactsRefused.push(form.uuid);
		}
	}
}
