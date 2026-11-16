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
import type { BlueprintDoc, Uuid } from "@/lib/domain";
import { planCaseRetype } from "@/lib/domain/caseRetype";
import {
	caseScalarTextGuardIsChecked,
	caseScalarTextGuards,
} from "@/lib/domain/caseScalarTextGuard";
import { moduleUuidOfForm } from "@/lib/domain/postSubmit";
import { planFormCaseWire } from "../../casePlacementPlan";
import {
	entryFactsDifference,
	hqEntryFacts,
	menuFactsDifference,
} from "../../hq/entryFacts";
import {
	activeActions,
	isMultiSelectMenu,
	menuMayLoadRegistryCase,
	type PublishedCaseBlocks,
	publishedCaseBlocks,
} from "../../hq/publishedCaseBlocks";
import {
	type PlacementSubject,
	placedBasic,
	planPlacements,
} from "../../placement";
import {
	type CaseWriteDuplicateReason,
	type LinkInvalidReason,
	type SessionUnavailableReason,
	type TargetInvalidReason,
	type TargetTypeMismatchReason,
	validateCaseOperations,
} from "../../validator/rules/caseOperations";
import { multiSelectFormSemantics } from "../../validator/rules/multiSelect";
import {
	type GeneratedNodePurpose,
	planGeneratedNodes,
} from "../../xform/generatedNodes";
import type { Claim } from "../claims";
import type { DraftApp, DraftForm, ReadContext } from "../context";
import { readerDefect } from "../defects";
import { EXPRESSION_CLAIMS } from "../expressions/findings";
import { isJsonObject, sameJson } from "../jsonCursor";
import { appPlace, whereText } from "../place";
import { readExpansionSteps, readProjectionInputs } from "../projectionInputs";
import { provisionalDocument } from "../provisional";
import { heldWorkerSlugs, holdsWorkerRecordWrite } from "../worldEntities";
import type { DraftField, ReadXForm } from "../xform";
import {
	ADVANCED_CLAIMS,
	advancedCaseReading,
	readAdvancedActions,
	readAdvancedMenu,
	settleAdvancedForm,
	settleAdvancedMenu,
	writeAdvancedChains,
	writeAdvancedOperations,
} from "./advancedActions";
import {
	BASIC_CLAIMS,
	basicCaseReading,
	ownerQuestionPath,
	readBasicActions,
	settleDatetimeJoins,
	writeBasicOperations,
} from "./basicActions";
import {
	carryRetypedProperties,
	readCaseCatalog,
	settleWriterTypes,
	takeBackWriterTypedDateTimes,
} from "./catalog";
import {
	conditionFinding,
	readActionCondition,
	statedBack,
} from "./conditions";
import { inWireScopeOrder, ORDER_CLAIMS } from "./operationOrder";
import {
	readPreloads,
	settlePreloadDefaults,
	settlePreloads,
} from "./preloads";
import {
	readSaveToCaseBlocks,
	SAVE_TO_CASE_CLAIMS,
	saveToCaseBlockPlace,
	saveToCaseReading,
	scalarFieldsOfRefusedBlocks,
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
			holdWireScopeOrder(ctx, form);
		}
	writeAdvancedChains(ctx);
	refuseWritesOfFoldedWorkerNames(ctx);
	readCaseCatalog(ctx, app);
}

/**
 * One finding at the form for each write of the worker's record to a name another write of it
 * spells in other letters only (`region` beside `Region`): CommCare keeps the two apart, but a
 * reading declares one worker property of the two (`worldEntities.ts::heldWorkerSlugs`, the
 * first in code-unit order), since CommCare HQ's user-data schema and the gate hold slugs unique
 * whatever their capitalization (`custom_data_fields/edit_model.py::
 * CustomDataFieldsForm.verify_no_duplicates`, `USER_PROPERTY_SLUG_DUPLICATE`), and the gate holds
 * every write of the worker's record to a declared one (`validateWorkerRecordProperty`). So the
 * other is a key no worker property takes, refused under that entry by the claim of the place
 * it was read from, with the key in `detail.name`.
 */
function refuseWritesOfFoldedWorkerNames(ctx: ReadContext): void {
	const held = new Set(heldWorkerSlugs([], workerRecordWriteSlugs(ctx)));
	for (const module of ctx.draft.modules)
		for (const form of module.forms)
			for (const operation of form.form.caseOperations ?? [])
				if (
					operation.action !== "own" &&
					operation.target.kind === "worker-record"
				)
					for (const write of operation.writes ?? [])
						if (
							holdsWorkerRecordWrite(write.property) &&
							!held.has(write.property)
						)
							ctx.accounting.finding(
								operation.placement?.kind === "save-to-case"
									? SAVE_TO_CASE_CLAIMS.workerKey
									: operation.placement?.kind === "advanced"
										? ADVANCED_CLAIMS.loadWorkerKey
										: BASIC_CLAIMS.workerKey,
								form.place,
								{ name: write.property },
							);
}

/**
 * The worker properties the reading's writes of the worker's record name: a
 * write of `commcare-user` saves to a worker property the app declares
 * (`validator/rules/caseOperations.ts::validateWorkerRecordProperty`), and no
 * export carries the declaration, so the reading declares one for each slug a
 * write names, beside those its logic reads (`provisional.ts::bindExpressions`).
 * Every write a reader stage holds names one (`worldEntities.ts::
 * holdsWorkerRecordWrite`, asked where each stage reads the key), so each slug
 * here is declared, but one of two that differ only in capitalization, whose
 * writes are refused (`refuseWritesOfFoldedWorkerNames`).
 */
export function workerRecordWriteSlugs(ctx: ReadContext): string[] {
	const slugs: string[] = [];
	for (const module of ctx.draft.modules)
		for (const form of module.forms)
			for (const operation of form.form.caseOperations ?? [])
				if (
					operation.action !== "own" &&
					operation.target.kind === "worker-record"
				)
					for (const write of operation.writes ?? [])
						if (holdsWorkerRecordWrite(write.property))
							slugs.push(write.property);
	return slugs;
}

/** `form`'s operations in the order the gate admits (`operationOrder.ts::
 *  inWireScopeOrder`), over its multiplicity scopes as `lib/doc/
 *  caseOperationOrder.ts::caseOperationMultiplicityScopes` walks them: the
 *  root first, then each repeat after every field inside it. */
function holdWireScopeOrder(ctx: ReadContext, form: DraftForm): void {
	const operations = form.form.caseOperations;
	const xform = form.xform;
	if (operations === undefined || xform === null || xform === undefined) return;
	const scopes: (Uuid | undefined)[] = [undefined];
	const walk = (parent: DraftField | null) => {
		for (const field of xform.childrenOf(parent)) {
			walk(field);
			if (field.kind === "repeat" && field.uuid !== undefined)
				scopes.push(field.uuid);
		}
	};
	walk(null);
	const ordered = inWireScopeOrder(
		operations,
		new Map(scopes.map((scope, index) => [scope, index])),
	);
	if (ordered !== operations)
		ctx.writeDraft(() => {
			form.form.caseOperations = [...ordered];
		});
}

// ── Acceptance by re-emission ───────────────────────────────────────────

type JsonObject = Readonly<Record<string, unknown>>;

function object(value: unknown): JsonObject {
	return isJsonObject(value) ? value : {};
}

/** A question path of a form's actions mapped to the question it reads: the
 *  path itself, or a generated sibling's owner. */
type OwnerPath = (path: unknown) => string | null;

/** The purposes of a sibling a basic action names in place of its question. */
const ACTION_SIBLINGS: ReadonlySet<GeneratedNodePurpose> = new Set([
	"trimmed",
	"url",
	"datetime",
]);

/**
 * The question each question path of a form's actions reads, the same map
 * for the stored actions and for Nova's print of them: first through the
 * source's own node graph (`basicActions.ts::ownerQuestionPath`), then each
 * sibling Nova's print names in place of its question (a case name's or
 * external id's `nova_trimmed_`, a capture's `nova_url_`, a date and time's
 * `nova_datetime_`) through Nova's own plan of the form's generated nodes
 * (`xform/generatedNodes.ts::planGeneratedNodes`) to the question that owns
 * it. The source's graph holds no such sibling where CommCare HQ's Case
 * Management names the question itself, or holds Nova's earlier one beside
 * it as the person's own Hidden Value, so the print names another; and it
 * holds a sibling the reading settles only once its join is bound under the
 * sibling's own name. The plan never gives a sibling an authored question's
 * name (the allocator suffixes past one), so the second step moves no path
 * that reads a question of the person's own.
 */
function actionOwners(doc: BlueprintDoc, form: DraftForm): OwnerPath {
	const xform = form.xform;
	const siblings = new Map<string, string>();
	if (xform !== null && xform !== undefined) {
		const pathOf = new Map<string, readonly string[]>();
		for (const field of readFields(xform))
			if (field.uuid !== undefined) pathOf.set(field.uuid, field.node.path);
		for (const node of planGeneratedNodes(doc, form.uuid).nodes) {
			if (!ACTION_SIBLINGS.has(node.purpose)) continue;
			const owner = pathOf.get(node.owner);
			if (owner === undefined) continue;
			siblings.set(
				[...owner.slice(0, -1), node.name].join("/"),
				owner.join("/"),
			);
		}
	}
	return (path) => {
		const read = ownerQuestionPath(form, path);
		return read === null ? null : (siblings.get(read) ?? read);
	};
}

function condition(owner: OwnerPath, stored: unknown): unknown {
	const value = object(stored);
	const type = value.type ?? "never";
	if (type !== "if") return type;
	return {
		question: owner(value.question),
		answer: value.answer ?? null,
		operator: value.operator ?? "=",
	};
}

/** An update map as `[key, question, mode]`, the key's order left out. */
function updates(
	owner: OwnerPath,
	stored: unknown,
	applied: boolean,
): readonly unknown[] {
	return Object.entries(object(stored))
		.map(([key, update]) => {
			const one = object(update);
			const mode = one.update_mode === "edit" && applied ? "edit" : "always";
			return [key, owner(one.question_path), mode] as const;
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
	owner: OwnerPath,
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
					condition: condition(owner, open.condition),
					name: owner(object(open.name_update).question_path),
				}
			: null,
		update_case: updates(owner, updateMap, applied),
		close_case: closes
			? condition(owner, object(stored.close_case).condition)
			: "never",
		subcases: subcases.map((one) => {
			const subcase = object(one);
			return {
				case_type: subcase.case_type ?? null,
				name: owner(object(subcase.name_update).question_path),
				case_properties: updates(owner, subcase.case_properties, applied),
				repeat_context: owner(subcase.repeat_context),
				condition: condition(owner, subcase.condition),
				close_condition: condition(owner, subcase.close_condition),
			};
		}),
		usercase_update: live.has("usercase_update")
			? updates(owner, usercase.update, applied)
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
		// A question that names no question of the form is pass 1's finding.
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
	// The emitter's own question: a name or an external id a Save to Case
	// block writes is checked by that block, never on its question.
	const guards = caseScalarTextGuards(doc, form.uuid, {
		placedBasic: placedBasic(doc, form.uuid),
	});
	// A block the reading refuses, or an advanced form's actions it refuses
	// part of, whose check its question carries, is that finding: the
	// document leaves the change and its check out together.
	const advanced = advancedCaseReading(form);
	const refused = new Set([
		...scalarFieldsOfRefusedBlocks(form),
		...(advanced?.refused === true ? advanced.createNames : []),
		...(basicCaseReading(form)?.refusedScalarFields ?? []),
	]);
	for (const field of readFields(xform)) {
		if (field.scalarCheck === undefined || field.uuid === undefined) continue;
		if (refused.has(field) && !guards.has(field.uuid)) continue;
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
	// A finding at the form already stands for every key pass 1 refused there,
	// which the draft leaves out and the stored actions hold: comparing the two
	// would name that cause a second time.
	if (ctx.accounting.hasFindingAt(form.place)) return;
	const inputs = readProjectionInputs(ctx);
	let planned: ReturnType<typeof planFormCaseWire>;
	try {
		planned = planFormCaseWire(doc, form.uuid, {
			identity: inputs.identity,
			attachmentTarget: inputs.attachmentTarget,
		});
	} catch {
		ctx.accounting.defect(
			form.place,
			`schema:${form.docType}.actions`,
			readerDefect.emissionThrew(form.place, "planFormCaseWire"),
		);
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
	const owners = actionOwners(doc, form);
	const difference = firstDifference(
		comparable(owners, form.json.peek("actions"), reads, applied),
		comparable(owners, planned.actions, reads, true),
	);
	if (difference !== undefined) {
		unrecognized(ctx, form, difference);
		return;
	}
	const unheld = placementsHeld(doc, form);
	if (unheld !== undefined) unrecognized(ctx, form, unheld);
}

/** `finding.details[key]`, where a gate finding states one. */
function detail(
	finding: { readonly details?: unknown },
	key: "reason" | "operationUuid",
): unknown {
	const details = finding.details;
	return typeof details === "object" && details !== null
		? (details as Record<string, unknown>)[key]
		: undefined;
}

/**
 * The gate's own verdict over a form's case changes
 * (`validator/rules/caseOperations.ts::validateCaseOperations`, and
 * `validator/rules/multiSelect.ts::multiSelectFormSemantics` for a form of a
 * menu that chooses several cases, asked once of the bound document in the
 * order the reading holds), each refusal a reader
 * stage cannot see on one change alone given as one finding under the entry
 * of the source shape that gives it. No rule is stated a second time here:
 * each refusal is the gate's, told apart by the reason the gate gives it
 * (`details.reason`, typed by the rule's exported reason union), and this
 * function chooses only its entry.
 *
 * How the form's changes stand beside one another, one finding at the form:
 *
 * - `CASE_OPERATION_EXECUTION_ORDER` (`lib/doc/caseOperationOrder.ts::
 *   caseOperationWireOrderViolationDetails`), once the reading's own order is
 *   applied (`operationOrder.ts::inWireScopeOrder`): a keyed create after a
 *   change that is no create in every order Nova writes, or a later change in
 *   its repeat row that may be of its case;
 * - `CASE_OPERATION_TARGET_TYPE_MISMATCH` reason `type-change`
 *   (`caseOperationTargetTypeOrderViolations`, a violation that is
 *   `retyped`): a block that gives a case another type where a later change,
 *   Case Management's change of the form's own case among them, may read that
 *   case as its earlier type, or a `case_type` row in a repeat that may meet
 *   the type an earlier row gave. A device and CommCare HQ's server apply both
 *   in one order, and Nova's types hold neither;
 * - `CASE_WRITE_DUPLICATE_PROPERTY` reason `own-case` and
 *   `CASE_OPERATION_CLOSES_OWN_CASE` (`ownCaseIndependenceFindings`), of a
 *   change read from a block: a Save to Case block that writes a property of
 *   the form's own case the form's own change writes too (its name and owner
 *   among them), or closes that case. HQ's build appends Case Management's
 *   block after every authored node (`app_manager/xform.py::XForm.
 *   _create_casexml`, `case_parent.append`), a device applies blocks in the
 *   form's order (Core's `CaseXmlParser`), and HQ's server groups a case's
 *   blocks and sorts them stably by their first action
 *   (`casexml/apps/case/xform.py::get_case_updates`, `order_updates`), so both
 *   run and the later block's row stands where it is present. Nova keeps one
 *   write of each property of the own case and lets no other change close it,
 *   and no one change prints both blocks;
 * - `CASE_OPERATION_TARGET_INVALID` reason `worker-record-twice`
 *   (`workerRecordFindings`), where the reading holds a block of
 *   `commcare-user`: that block beside another update of the worker's record
 *   (HQ's basic `usercase_update`, an advanced form's load of it, or another
 *   such block). HQ's form builder keeps each block (`saveToCase.js` refuses
 *   only a create, a close or a link of `commcare-user`), a device and HQ's
 *   server apply both in the form's order, and Nova keeps a form's every write
 *   of the worker's record in one update. A second load of the worker's record
 *   with no block is refused where it is read.
 *
 * Of one change read from a block, one finding at the block, unless a reader
 * stage's finding already stands there (a device's refusal first, since it
 * names what stops every submission):
 *
 * - a device refuses on every submission: `CASE_OPERATION_SESSION_UNAVAILABLE`
 *   reason `target`, a case id of the case a menu chooses on a form that
 *   chooses none (a survey, a registration); `CASE_OPERATION_TARGET_INVALID`
 *   reason `blank-target`, a case id that is a blank literal; and
 *   `CASE_OPERATION_LINK_INVALID` reason `self-link`, a link of the block's
 *   case to itself. The case id is blank on every submission in the first
 *   two, which HQ's server refuses (`form_processor/casedb_base.py::get`,
 *   `IllegalCaseId`), and Core refuses an update or close of no case
 *   (`CaseXmlParser.loadCase`) and a case's link to itself
 *   (`CaseXmlParser.indexCase`), on Android and in Web Apps
 *   (`FormplayerCaseXmlParser`);
 * - `CASE_OPERATION_SESSION_UNAVAILABLE` reasons `link-target` and
 *   `case-read`: a link to the case a menu chooses, or a value, condition or
 *   case id expression that reads that case, on a form that chooses none. The
 *   form's entry holds no such case, so the link is blank, which Core and HQ's
 *   server take as no link (`CaseXmlParser.indexCase`,
 *   `update_strategy.py::_apply_index_action`), and the read reads nothing;
 * - `CASE_OPERATION_TARGET_TYPE_MISMATCH` reason `declared-type`: a block that
 *   names the case it changes, or a link that names the case it points to, by
 *   a type other than the one the case holds there, with no type change
 *   behind it. Neither runtime reads a block's `vellum:case_type`, and both
 *   keep a link's `case_type` as written (Core's `CaseIndex`, HQ's
 *   `CommCareCaseIndex.referenced_type`);
 * - `CASE_OPERATION_TARGET_INVALID` reason `id-of-target`: a case id
 *   expression that reads the id of a case the form creates, which Nova holds
 *   only as that create's own target;
 * - `CASE_OPERATION_AMBIGUOUS_REFERENCE` and
 *   `CASE_OPERATION_REPEAT_CORRELATION`: a change that reads the case a
 *   create of a repeat makes from outside that repeat's rows (a change at the
 *   root, or in another repeat), or a value of a repeat's answer from outside
 *   it. Each row of the repeat holds its own case and answer, and Nova holds
 *   such a read only in the same row, so the expression is outside Nova's
 *   typed vocabulary, the entry the expression stage gives a value it cannot
 *   hold; a create keyed by such an answer is the authored create id's;
 * - `MULTI_SELECT_SESSION_OPERATION_LINK` and
 *   `MULTI_SELECT_APP_OPERATION_CASE_READ`: on a form of a menu that chooses
 *   several cases, a change that runs once for the form and links to, or
 *   reads, "the" chosen case, which the form holds as a set
 *   (`validator/rules/multiSelect.ts::multiSelectFormSemantics`); and
 *   `MULTI_SELECT_AUTHORED_KEY_CREATE`, a create there keyed by one answer,
 *   the authored create id's entry.
 *
 * The gate's other refusals of a change on its own are a reader stage's,
 * where it reads the change (a slot's expression, a key, a link's name, a
 * create's key), and the case management tests hold every reading to the
 * whole gate (`__tests__/heldReading.ts`).
 */
/** A Save to Case expression outside Nova's typed vocabularies, its case id,
 *  owner, conditions and values alike. */
const OUTSIDE_VOCABULARY =
	EXPRESSION_CLAIMS[
		"savetocase-expressions-outside-nova-s-typed-vocabularies-case-id"
	];

function settleCaseChanges(
	ctx: ReadContext,
	doc: BlueprintDoc,
	form: DraftForm,
): void {
	const operations = doc.forms[form.uuid]?.caseOperations ?? [];
	if (operations.length === 0) return;
	const moduleUuid = moduleUuidOfForm(doc, form.uuid);
	if (moduleUuid === undefined) return;
	const module = doc.modules[moduleUuid];
	const formDoc = doc.forms[form.uuid];
	const verdict = [
		...validateCaseOperations(doc, form.uuid, moduleUuid),
		...(module === undefined || formDoc === undefined
			? []
			: multiSelectFormSemantics(doc, formDoc, module, {
					moduleUuid,
					moduleName: module.name,
					formUuid: form.uuid,
					formName: formDoc.name,
				})),
	];
	const operationOf = (finding: { readonly details?: unknown }) => {
		const uuid = detail(finding, "operationUuid");
		return operations.find((one) => one.uuid === uuid);
	};
	const workerBlock = operations.some(
		(one) =>
			one.action !== "own" &&
			one.target.kind === "worker-record" &&
			one.placement?.kind === "save-to-case",
	);
	// Each finding at the form, with the changes the gate names it of.
	const formFindings = new Map<Claim<"refuse">, (Uuid | undefined)[]>();
	let named: Uuid | undefined;
	const atForm = {
		add(claim: Claim<"refuse">): void {
			formFindings.set(claim, [...(formFindings.get(claim) ?? []), named]);
		},
	};
	const atBlock = new Map<Uuid, Claim<"refuse">>();
	// A device's refusal of the block stands over any other finding of it.
	const refuseBlock = (uuid: Uuid, claim: Claim<"refuse">) => {
		if (claim === SAVE_TO_CASE_CLAIMS.deviceRefuses || !atBlock.has(uuid))
			atBlock.set(uuid, claim);
	};
	for (const finding of verdict) {
		const operation = operationOf(finding);
		named = operation?.uuid;
		const block =
			operation?.placement?.kind === "save-to-case" ? operation : undefined;
		const reason = detail(finding, "reason");
		switch (finding.code) {
			case "CASE_OPERATION_EXECUTION_ORDER":
				atForm.add(ORDER_CLAIMS.noOrder);
				break;
			case "CASE_OPERATION_TARGET_TYPE_MISMATCH":
				if (reason === ("declared-type" satisfies TargetTypeMismatchReason))
					if (block !== undefined)
						refuseBlock(block.uuid, SAVE_TO_CASE_CLAIMS.declaredType);
					else atForm.add(SAVE_TO_CASE_CLAIMS.declaredType);
				else atForm.add(ORDER_CLAIMS.typeChange);
				break;
			case "CASE_WRITE_DUPLICATE_PROPERTY":
				if (
					reason === ("own-case" satisfies CaseWriteDuplicateReason) &&
					block !== undefined
				)
					atForm.add(SAVE_TO_CASE_CLAIMS.ownCaseBeside);
				break;
			case "CASE_OPERATION_CLOSES_OWN_CASE":
				if (block !== undefined) atForm.add(SAVE_TO_CASE_CLAIMS.ownCaseBeside);
				break;
			case "CASE_OPERATION_TARGET_INVALID":
				if (reason === ("worker-record-twice" satisfies TargetInvalidReason)) {
					if (workerBlock) atForm.add(SAVE_TO_CASE_CLAIMS.workerTwice);
				} else if (block === undefined) break;
				else if (reason === ("blank-target" satisfies TargetInvalidReason))
					refuseBlock(block.uuid, SAVE_TO_CASE_CLAIMS.deviceRefuses);
				else if (reason === ("id-of-target" satisfies TargetInvalidReason))
					refuseBlock(block.uuid, OUTSIDE_VOCABULARY);
				break;
			case "CASE_OPERATION_SESSION_UNAVAILABLE":
				if (block === undefined) break;
				refuseBlock(
					block.uuid,
					reason === ("target" satisfies SessionUnavailableReason)
						? SAVE_TO_CASE_CLAIMS.deviceRefuses
						: SAVE_TO_CASE_CLAIMS.readsMenuCase,
				);
				break;
			case "CASE_OPERATION_LINK_INVALID":
				if (
					block !== undefined &&
					reason === ("self-link" satisfies LinkInvalidReason)
				)
					refuseBlock(block.uuid, SAVE_TO_CASE_CLAIMS.deviceRefuses);
				break;
			case "CASE_OPERATION_AMBIGUOUS_REFERENCE":
			case "CASE_OPERATION_REPEAT_CORRELATION":
			case "MULTI_SELECT_SESSION_OPERATION_LINK":
			case "MULTI_SELECT_APP_OPERATION_CASE_READ":
				if (block !== undefined) refuseBlock(block.uuid, OUTSIDE_VOCABULARY);
				break;
			case "MULTI_SELECT_AUTHORED_KEY_CREATE":
				if (block !== undefined)
					refuseBlock(block.uuid, SAVE_TO_CASE_CLAIMS.authoredCreateId);
				break;
			case "CAPTURE_CASE_WRITE_STANDARD_PROPERTY":
				if (block !== undefined) refuseBlock(block.uuid, OUTSIDE_VOCABULARY);
				break;
			case "CASE_OPERATION_RETYPE_UNSAFE": {
				if (block === undefined || block.action !== "update") break;
				// The gate's own plan tells the two causes apart: a change of the
				// type of a case a create keyed by an answer makes, whose next
				// submission's create gives the case its earlier type again, and a
				// type that holds a property the earlier type holds as another type.
				const plan =
					block.retype === undefined
						? undefined
						: planCaseRetype(doc, block.caseType, block.retype);
				if (plan === undefined || plan.wirePortable)
					atForm.add(ORDER_CLAIMS.typeChange);
				else refuseBlock(block.uuid, SAVE_TO_CASE_CLAIMS.retypeConverts);
				break;
			}
		}
	}
	const placeOf = (uuid: Uuid) =>
		saveToCaseBlockPlace(form, uuid) ?? form.place;
	// A finding at the form that names only changes a finding at their own
	// block refuses is that block's: the reading holds none of them, and the
	// block's finding names what to change.
	const refusedAtBlock = (uuid: Uuid | undefined) =>
		uuid !== undefined &&
		(atBlock.has(uuid) ||
			(saveToCaseBlockPlace(form, uuid) !== undefined &&
				ctx.accounting.hasFindingAt(placeOf(uuid))));
	for (const [claim, of] of formFindings)
		if (!of.every(refusedAtBlock)) ctx.accounting.finding(claim, form.place);
	for (const [uuid, claim] of atBlock) {
		const place = placeOf(uuid);
		if (!ctx.accounting.hasFindingAt(place))
			ctx.accounting.finding(claim, place);
	}
}

/**
 * Step 6, pass 2: each preload's default written over the authored default it
 * replaces, every basic form's reading accepted over the bound document, its
 * scalar checks held to the emitter's, and its preloads judged.
 */
export function settleCaseManagement(ctx: ReadContext, app: DraftApp): void {
	settlePreloadDefaults(
		ctx,
		app.modules.flatMap((module) => module.forms),
	);
	for (const module of app.modules)
		for (const form of module.forms) settleDatetimeJoins(ctx, form);
	if (ctx.doc !== undefined)
		ctx.doc = carryRetypedProperties(
			takeBackWriterTypedDateTimes(ctx, ctx.doc),
		);
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
			settleCaseChanges(ctx, ctx.doc ?? doc, form);
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
	const steps = compareEntryFactsSteps(ctx, app);
	while (!steps.next().done);
}

/** `compareEntryFacts`, stopping between the source's facts, Nova's emission
 *  and the emission's facts until it is resumed. */
export function* compareEntryFactsSteps(
	ctx: ReadContext,
	app: DraftApp,
): Generator<void, void, void> {
	const doc = provisionalDocument(ctx);
	const source = hqEntryFacts(ctx.input.source.raw);
	yield;
	let emitted: ReturnType<typeof hqEntryFacts>;
	try {
		const expansion = yield* readExpansionSteps(ctx, doc);
		yield;
		emitted = hqEntryFacts(expansion);
	} catch {
		ctx.accounting.defect(
			appPlace(),
			"schema:Application.modules",
			readerDefect.emissionThrew(appPlace(), "expandDoc"),
		);
		return;
	}
	let blocks: PublishedCaseBlocks | undefined;
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
			if (key === "loads") {
				// Loads that differ only in tags, each on a load for which HQ's build
				// writes no block, carry tags Nova would not derive; any other
				// difference is not the menu's one chain.
				const sameButTags =
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
				const differing = facts.loads.filter(
					(load, i) => load.tag !== ours.loads[i]?.tag,
				);
				blocks ??= publishedCaseBlocks(ctx.input.source.raw);
				const written = new Set(
					(blocks.forms.get(form.xmlns)?.blocks ?? []).flatMap((block) =>
						block.kind === "advanced" && block.action === "load"
							? [block.tag]
							: [],
					),
				);
				const underived =
					sameButTags &&
					differing.length > 0 &&
					differing.every((load) => !written.has(load.tag));
				const claim = underived
					? ADVANCED_CLAIMS.underivedTag
					: ADVANCED_CLAIMS.notOneChain;
				// One class is one finding: pass 1 may have raised it at the form.
				// A form whose stored actions pass 1 refused part of has that
				// finding at the form, and the document leaves the refused loads
				// out, so the loads the entry carries differ for that one cause.
				const standing =
					(advancedCaseReading(form)?.refused === true &&
						ctx.accounting.hasFindingAt(form.place)) ||
					ctx.accounting
						.findings()
						.some(
							(one) =>
								one.code === claim.entry &&
								whereText(one.place) === whereText(form.place),
						);
				if (!standing)
					ctx.accounting.finding(claim, form.place, {
						name:
							differing[0]?.tag ??
							facts.loads[facts.loads.length - 1]?.tag ??
							"",
					});
			} else if (key === "moduleKind") {
				if (!ctx.accounting.hasFindingAt(module.place))
					ctx.accounting.finding(ADVANCED_CLAIMS.kindBlocked, module.place);
			} else raise(form.place, key);
			ctx.facts.entryFactsRefused.push(form.uuid);
		}
	}
}
