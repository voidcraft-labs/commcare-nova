/**
 * A case preload read as the question's default value. CommCare HQ loads a
 * case value into a question by appending an `xforms-ready` setvalue after
 * every setvalue the form's source holds (`xform.py::XForm.add_case_preloads`);
 * Nova holds the load as the question's default (`casePreload.ts::fieldPreload`),
 * which runs at the question's place in data order. The reading is the same
 * load only where moving it there changes nothing: no load-time value after
 * the question reads it.
 */
import {
	type BlueprintDoc,
	type Expression,
	externalUserPropertyNameSchema,
	fieldKindDeclaresKey,
	type Term,
	type UserProperty,
	type Uuid,
} from "@/lib/domain";
import { term } from "@/lib/domain/expression/builders";
import { walkExpressionTerms } from "@/lib/domain/expression/walk";
import { NO_ENTRIES, recordFromEntries } from "@/lib/domain/records";
import { USERCASE_BUILT_IN_KEYS } from "@/lib/domain/usercase";
import type { FindingDetail, HqPlace } from "@/lib/publish/hqFindings";
import { caseTypeHopMap } from "../../caseTypeDepths";
import { HQ_CASE_RESERVED_WORDS } from "../../constants";
import { activeActions, isMultiSelectMenu } from "../../hq/publishedCaseBlocks";
import type { Admitted } from "../accounting";
import { withCandidate } from "../candidate";
import { type Claim, defineClaims, drop, refuse, take } from "../claims";
import type { DraftForm, DraftModule, ReadContext } from "../context";
import { EXPRESSION_CLAIMS } from "../expressions/findings";
import { externalKey } from "../identity";
import { isJsonObject, sameJson } from "../jsonCursor";
import { appPlace, questionPlace, whereText } from "../place";
import { holdsWorkerProperty } from "../worldEntities";
import type { DraftField } from "../xform";
import {
	actionsCursorOf,
	ancestorSteps,
	HQ_PROPERTY_PATH,
	inactiveClaimOf,
	repeatOfField,
} from "./basicActions";
import { conditionQuestionPath } from "./conditions";

const F = "forms-and-case-writes";

export const PRELOAD_CLAIMS = defineClaims("caseManagement.preloads", {
	casePreload: take(
		`${F}/case-preload-question-property-into-a-question-outside-any`,
		"schema:FormActions.case_preload",
	),
	casePreloadMap: take(
		`${F}/case-preload-question-property-into-a-question-outside-any`,
		"schema:PreloadAction.preload",
	),
	parentPreload: take(
		`${F}/case-preload-from-parent-paths-into-a-question-outside-any`,
		"schema:FormActions.case_preload",
	),
	parentPreloadMap: take(
		`${F}/case-preload-from-parent-paths-into-a-question-outside-any`,
		"schema:PreloadAction.preload",
	),
	insideRepeat: drop(
		`${F}/case-preload-into-a-question-inside-a-repeat`,
		"schema:FormActions.case_preload",
	),
	multiSelectChild: take(
		`${F}/case-preload-into-a-question-outside-any-repeat-in-a-multi-select-child`,
		"schema:FormActions.case_preload",
	),
	multiSelectChildMap: take(
		`${F}/case-preload-into-a-question-outside-any-repeat-in-a-multi-select-child`,
		"schema:PreloadAction.preload",
	),
	condition: drop(
		`${F}/preload-action-condition`,
		"schema:PreloadAction.condition",
	),
	movesValues: refuse(
		`${F}/case-preload-into-a-question-outside-any-repeat-where-the-held`,
		"schema:PreloadAction.preload",
	),
	otherPath: refuse(
		`${F}/case-preload-from-any-other-index-path-host-user-a-mixed-path`,
		"schema:PreloadAction.preload",
	),
	ancestorUnknown: refuse(
		`${F}/index-path-through-a-case-type-the-app-does-not-fix`,
		"schema:PreloadAction.preload",
	),
	multiSelect: refuse(
		`${F}/case-preload-into-a-question-outside-any-repeat-in-a-multi-select-module`,
		"schema:PreloadAction.preload",
	),
	onSurvey: drop(
		`${F}/case-preload-active-on-a-requires-none-form-naming-valid`,
		"schema:FormActions.case_preload",
	),
	onSurveyReserved: refuse(
		`${F}/case-preload-on-a-requires-none-form-naming-a-reserved-or`,
		"schema:FormActions.case_preload",
	),
	noDefault: refuse(
		`${F}/case-preload-into-a-question-that-holds-no-default`,
		"schema:PreloadAction.preload",
	),
	/** No preload beside an own case change that writes a question: the writer holds no default
	 *  that reads the case, read at `case_preload`'s default. */
	writerWithoutPreload: take(
		`${F}/a-writer-question-with-no-case-preload-update-only`,
		"schema:FormActions.case_preload",
	),
	illegalProperty: refuse(
		`${F}/update-key-failing-hq-s-grammar-or-in-case-reserved-words-json`,
		"schema:PreloadAction.preload",
	),
	label: refuse(
		`${F}/a-case-write-name-or-preload-on-a-question-the-picker-does-not`,
		"schema:PreloadAction.preload",
	),
	usercasePreload: take(
		`${F}/usercase-preload-into-a-question-outside-any-repeat-on-a-form`,
		"schema:FormActions.usercase_preload",
	),
	usercaseOther: refuse(
		`${F}/any-other-usercase-preload`,
		"schema:FormActions.usercase_preload",
	),
	loadFromFormKept: drop(
		`${F}/load-from-form-whose-paths-the-form-still-has`,
		"schema:FormActions.load_from_form",
	),
	loadFromFormMissing: refuse(
		`${F}/load-from-form-naming-a-path-the-form-no-longer-has-on-a-form`,
		"schema:FormActions.load_from_form",
	),
	loadFromFormNoCase: drop(
		`${F}/load-from-form-on-a-form-that-does-not-require-a-case`,
		"schema:FormActions.load_from_form",
	),
});

/** The finding for a preload HQ's build reads from a case child no property
 *  name of Nova's names (`preloadReadOf`): the checker's own refusal of a case
 *  property outside Nova's name grammar, which the expression stage gives a
 *  form expression reading one (`findings.ts::nameGrammarEntry`). */
export const UNNAMED_PRELOAD =
	EXPRESSION_CLAIMS["a-form-expression-outside-what-nova-types"];

/** The rows a case preload's question reads under, in the table's order. */
const PRELOAD_ROWS = [
	"plain",
	"parent",
	"repeat",
	"multi-select-child",
] as const;
type PreloadRow = (typeof PRELOAD_ROWS)[number];

/** The claims on `case_preload` and on its map, by the row the map is read under. */
const PRELOAD_ROW_CLAIMS: Record<
	Exclude<PreloadRow, "repeat">,
	{ readonly container: Claim<"take">; readonly map: Claim<"take"> }
> = {
	plain: {
		container: PRELOAD_CLAIMS.casePreload,
		map: PRELOAD_CLAIMS.casePreloadMap,
	},
	parent: {
		container: PRELOAD_CLAIMS.parentPreload,
		map: PRELOAD_CLAIMS.parentPreloadMap,
	},
	"multi-select-child": {
		container: PRELOAD_CLAIMS.multiSelectChild,
		map: PRELOAD_CLAIMS.multiSelectChildMap,
	},
};

/** Reads an admitted value the reading keeps in no slot of its own. */
function readPast<T>(admitted: Admitted<T>): T {
	return admitted.value;
}

/** One question a preload reads into, held until the expression stage has bound the form. */
export interface PreloadCandidate {
	readonly field: DraftField;
	readonly place: HqPlace;
	/** A worker-record load, which the settle writes once the app's worker properties are known. */
	readonly usercase?: string;
	/** The finding a load a later load-time value reads is; the basic preload's where absent. */
	readonly moves?: Claim<"refuse">;
	/** A case preload read as a `form-case` read of `caseType`, which walks from the form's
	 *  own case the indices `caseTypeDepths.ts::caseTypeHopMap` gives `caseType`: it names
	 *  the case HQ loads (through the `hops` indices, from the own case up: a basic preload's
	 *  `parent` steps, an advanced load's own case through each later load's index) only
	 *  where the document walks exactly `hops`, which the settle checks once the catalog and
	 *  the app's links are read, and is the finding `otherCase` where it does not. */
	readonly load?: {
		readonly caseType: string;
		readonly hops: readonly string[];
		readonly otherCase: Claim<"refuse">;
	};
}

const CANDIDATES = new WeakMap<DraftForm, PreloadCandidate[]>();

/** The question of the form a preload's path names. */
export function fieldAt(form: DraftForm, path: string): DraftField | undefined {
	const relative = conditionQuestionPath(form, path);
	const node =
		relative === undefined ? undefined : form.xform?.nodes.get(relative);
	const role = node === undefined ? undefined : form.xform?.roles.get(node);
	return role?.kind === "field" ? role.field : undefined;
}

/**
 * The place of the node a preload path names, where it is one Nova generates beside a question
 * (the role the form stage gave it, settled or proposed) and its bind carries a calculate, which
 * CommCare HQ's form builder reads as a Hidden Value it calculates; undefined for any other path.
 */
function calculatedGeneratedNodePlace(
	form: DraftForm,
	path: string,
): HqPlace | undefined {
	const relative = conditionQuestionPath(form, path);
	const xform = form.xform;
	const node = relative === undefined ? undefined : xform?.nodes.get(relative);
	if (xform === null || xform === undefined || node === undefined)
		return undefined;
	const role = xform.roles.get(node);
	if (role?.kind !== "generated" && role?.kind !== "generated-candidate")
		return undefined;
	if (xform.binds.get(node)?.logic.calculate === undefined) return undefined;
	return form.place.kind === "form"
		? questionPlace(form.place, node.path)
		: undefined;
}

/** Whether a question holds a default Nova can give it: its kind holds one,
 *  and it is no Hidden Value whose bind calculates it. */
export function holdsDefault(form: DraftForm, field: DraftField): boolean {
	if (!fieldKindDeclaresKey(field.kind, "default_value")) return false;
	return !(
		field.kind === "hidden" &&
		form.xform?.binds.get(field.node)?.logic.calculate !== undefined
	);
}

/** The default each preload gives its question, by form: written into the
 *  document once every expression is bound (`settlePreloadDefaults`). */
const PRELOAD_DEFAULTS = new WeakMap<
	DraftForm,
	Map<DraftField, Expression | undefined>
>();

/** Moves a question's default to the preload. The authored default HQ's load
 *  runs after stays registered as the form stage read it (`xform/logic.ts::readDefaults`:
 *  the setvalue, its `event` and its `ref` the form stage's, its `value` the
 *  expression stage's), so the expression stage judges and claims its value
 *  as it does a default no preload replaces: a value HQ's build refuses, or
 *  one Core fails on as the form loads, keeps the form out under its own
 *  finding, since the form never loads to run the preload. The preload's
 *  default takes the slot once every expression is bound
 *  (`settlePreloadDefaults`). */
export function writeDefault(
	ctx: ReadContext,
	form: DraftForm,
	field: DraftField,
	value: Expression | undefined,
): void {
	if (form.xform === null) return;
	ctx.writeDraft(() => {
		if (value === undefined) delete field.field.default_value;
		else field.field.default_value = value;
	});
	const known = PRELOAD_DEFAULTS.get(form);
	if (known === undefined)
		PRELOAD_DEFAULTS.set(form, new Map([[field, value]]));
	else known.set(field, value);
}

/** Writes each preload's default over the authored default the expression
 *  stage bound in its place (`writeDefault`), before any settle reads the
 *  document's defaults. */
export function settlePreloadDefaults(
	ctx: ReadContext,
	forms: readonly DraftForm[],
): void {
	const doc = ctx.doc;
	if (doc === undefined) return;
	const writes: [Uuid, Expression | undefined][] = [];
	for (const form of forms)
		for (const [field, value] of PRELOAD_DEFAULTS.get(form) ?? []) {
			const uuid = field.uuid;
			if (uuid === undefined || doc.fields[uuid] === undefined) continue;
			const now = (doc.fields[uuid] as { default_value?: Expression })
				.default_value;
			if (!sameJson(now, value)) writes.push([uuid, value]);
		}
	if (writes.length === 0) return;
	ctx.doc = withCandidate(doc, (draft) => {
		for (const [uuid, value] of writes) {
			const field = draft.fields[uuid] as Record<string, unknown> | undefined;
			if (field === undefined) continue;
			if (value === undefined) delete field.default_value;
			else field.default_value = value;
		}
	});
}

/**
 * Reads `case_preload`, `usercase_preload` and `load_from_form` of a basic
 * form. A case preload's default is written into the draft here; a worker
 * record's, and the judgement of every preload, wait for the bound form.
 */
export function readPreloads(
	ctx: ReadContext,
	module: DraftModule,
	form: DraftForm,
): void {
	const json = form.json;
	const actionsStored = json.peek("actions");
	const A = actionsCursorOf(form);
	if (!isJsonObject(actionsStored) || A === undefined) return;
	const requires = json.peek("requires") ?? "none";
	const active = activeActions(actionsStored, requires);
	const candidates: PreloadCandidate[] = [];
	const caseType = module.module.caseType ?? "";
	const rewrite = (path: string) =>
		ctx.facts.sameStateRewrites.push({
			entry: PRELOAD_CLAIMS.casePreload.entry,
			path,
			register: "case-settings-respelled",
		});

	const casePreload = isJsonObject(actionsStored.case_preload)
		? actionsStored.case_preload
		: NO_ENTRIES;
	const caseMap = isJsonObject(casePreload.preload)
		? casePreload.preload
		: NO_ENTRIES;
	if (Object.keys(caseMap).length === 0) {
		const updateCase = isJsonObject(actionsStored.update_case)
			? actionsStored.update_case
			: NO_ENTRIES;
		if (
			active.has("update_case") &&
			isJsonObject(updateCase.update) &&
			Object.keys(updateCase.update).length > 0
		)
			A.takeDefault("case_preload", PRELOAD_CLAIMS.writerWithoutPreload);
		A.derived("case_preload", inactiveClaimOf(form, "case_preload"));
	} else {
		if (requires !== "case") {
			// HQ's validator holds every preloaded property to its grammar, index
			// steps included, and its last step out of the reserved words
			// (`helpers/validators.py::IndexedFormBaseValidator.check_case_properties`).
			const reserved = Object.values(caseMap).some(
				(property) =>
					typeof property !== "string" || hqBuildRefusesProperty(property),
			);
			if (reserved) A.refuse("case_preload", PRELOAD_CLAIMS.onSurveyReserved);
			else A.drop("case_preload", PRELOAD_CLAIMS.onSurvey);
		} else {
			const multi = isMultiSelectMenu({
				case_details: module.json.peek("case_details"),
			});
			const topLevel =
				module.module.parentModuleUuid === undefined &&
				module.module.parentCaseModuleUuid === undefined;
			// A refusal of an entry of the map is a class of the map and the actions that hold it,
			// so it stands at each of them its entry names (`Accounting.findingAt`).
			const refuseEntry = (
				claim: Claim,
				place: HqPlace,
				detail?: FindingDetail,
			) =>
				ctx.accounting.findingAt(
					claim,
					place,
					`${A.pointer}/case_preload`,
					detail,
				);
			// The rows the map's questions read under, in the table's order; the
			// map is claimed under the first of them.
			const rows = new Set<PreloadRow>();
			for (const [path, property] of Object.entries(caseMap)) {
				const field = fieldAt(form, path);
				// HQ's build refuses the form, wherever the question stands: its validator holds
				// every preloaded property to its grammar and out of the reserved words.
				if (typeof property === "string" && hqBuildRefusesProperty(property)) {
					refuseEntry(
						PRELOAD_CLAIMS.illegalProperty,
						field?.place ?? form.place,
						{ name: property },
					);
					continue;
				}
				// A node Nova generates beside a question is, to CommCare HQ's form builder, a
				// Hidden Value its bind calculates: a load into it is overwritten by the calculate.
				const generated =
					field === undefined
						? calculatedGeneratedNodePlace(form, path)
						: undefined;
				if (generated !== undefined) {
					refuseEntry(PRELOAD_CLAIMS.noDefault, generated);
					continue;
				}
				if (field === undefined || typeof property !== "string") {
					refuseEntry(PRELOAD_CLAIMS.label, form.place, {
						name: path,
					});
					continue;
				}
				// An `xforms-ready` load runs before any row exists, and fills none.
				if (repeatOfField(field) !== undefined) {
					rows.add("repeat");
					continue;
				}
				if (multi && topLevel) {
					refuseEntry(PRELOAD_CLAIMS.multiSelect, field.place);
					continue;
				}
				if (field.kind === "label") {
					refuseEntry(PRELOAD_CLAIMS.label, field.place);
					continue;
				}
				if (!holdsDefault(form, field)) {
					refuseEntry(PRELOAD_CLAIMS.noDefault, field.place);
					continue;
				}
				const { indices, name } = preloadReadOf(property);
				if (indices.some((segment) => segment !== "parent")) {
					refuseEntry(PRELOAD_CLAIMS.otherPath, field.place, {
						name: property,
					});
					continue;
				}
				const chain = ancestorSteps(ctx, caseType, indices);
				// A `form-case` term names its case by type, so a chain two of whose
				// cases share one names neither.
				const readType =
					chain === undefined ||
					new Set(chain.types).size !== chain.types.length
						? undefined
						: chain.types[chain.types.length - 1];
				if (readType === undefined) {
					refuseEntry(PRELOAD_CLAIMS.ancestorUnknown, field.place, {
						name: property,
					});
					continue;
				}
				if (multi) {
					// HQ loads it from the selection's storage id, which names no
					// case, so the load sets it empty after every other setvalue:
					// the question holds no default. Its own default, where it had
					// one, is held only where no later load-time value read it.
					const authored =
						field.field.default_value !== undefined ||
						field.expressions.some((one) => one.slot === "default_value");
					rows.add("multi-select-child");
					writeDefault(ctx, form, field, undefined);
					if (authored) candidates.push({ field, place: field.place });
					continue;
				}
				if (name === undefined) {
					// HQ's build reads a child element no property name of Nova's names.
					refuseEntry(UNNAMED_PRELOAD, field.place, {
						name: property,
						reason: "name:case-property",
					});
					continue;
				}
				const caseRead: Term = {
					kind: "form-case",
					caseType: readType,
					property: name,
				};
				rows.add(indices.length > 0 ? "parent" : "plain");
				writeDefault(ctx, form, field, term(caseRead));
				// The read walks the indices the document links its type through, which
				// are HQ's `parent/` steps only where they are as many and all `parent`.
				candidates.push({
					field,
					place: field.place,
					load: {
						caseType: readType,
						hops: indices,
						otherCase: PRELOAD_CLAIMS.ancestorUnknown,
					},
				});
			}
			const row =
				PRELOAD_ROWS.find((one) => rows.has(one)) ?? ("plain" as const);
			rewrite(`${A.pointer}/case_preload/preload`);
			if (row === "repeat") A.drop("case_preload", PRELOAD_CLAIMS.insideRepeat);
			else {
				const claims = PRELOAD_ROW_CLAIMS[row];
				const P = A.object("case_preload", "PreloadAction", claims.container);
				P.drop("condition", PRELOAD_CLAIMS.condition);
				readPast(P.take("preload", claims.map, (value) => value));
			}
		}
	}

	const usercasePreload = isJsonObject(actionsStored.usercase_preload)
		? actionsStored.usercase_preload
		: NO_ENTRIES;
	const usercaseMap = isJsonObject(usercasePreload.preload)
		? usercasePreload.preload
		: NO_ENTRIES;
	if (Object.keys(usercaseMap).length === 0)
		A.derived("usercase_preload", inactiveClaimOf(form, "usercase_preload"));
	else {
		const usercaseUpdate = isJsonObject(actionsStored.usercase_update)
			? actionsStored.usercase_update
			: NO_ENTRIES;
		const writesWorker =
			active.has("usercase_update") &&
			isJsonObject(usercaseUpdate.update) &&
			Object.keys(usercaseUpdate.update).length > 0;
		const fields = Object.entries(usercaseMap).map(([path, property]) => ({
			field: fieldAt(form, path),
			property: usercaseRead(property),
		}));
		const held =
			writesWorker &&
			fields.every(
				({ field, property }) =>
					field !== undefined &&
					property !== undefined &&
					repeatOfField(field) === undefined,
			);
		// A question that takes no default: a label is the picker's row, any
		// other the row of a question that holds none.
		const noDefault = held
			? fields
					.map(({ field }) =>
						field === undefined || holdsDefault(form, field)
							? undefined
							: field.kind === "label"
								? PRELOAD_CLAIMS.label
								: PRELOAD_CLAIMS.noDefault,
					)
					.find((claim) => claim !== undefined)
			: undefined;
		if (!held) A.refuse("usercase_preload", PRELOAD_CLAIMS.usercaseOther);
		else if (noDefault !== undefined) {
			const U = A.object(
				"usercase_preload",
				"PreloadAction",
				PRELOAD_CLAIMS.usercasePreload,
			);
			U.drop("condition", PRELOAD_CLAIMS.condition);
			U.refuse("preload", noDefault);
		} else {
			const U = A.object(
				"usercase_preload",
				"PreloadAction",
				PRELOAD_CLAIMS.usercasePreload,
			);
			U.drop("condition", PRELOAD_CLAIMS.condition);
			readPast(
				U.take("preload", PRELOAD_CLAIMS.casePreloadMap, (value) => value),
			);
			rewrite(`${U.pointer}/preload`);
			for (const { field, property } of fields) {
				const question = field as DraftField;
				writeDefault(ctx, form, question, undefined);
				candidates.push({
					field: question,
					place: question.place,
					usercase: property as string,
				});
			}
		}
	}

	const loadFromForm = isJsonObject(actionsStored.load_from_form)
		? actionsStored.load_from_form
		: NO_ENTRIES;
	const loadMap = isJsonObject(loadFromForm.preload)
		? loadFromForm.preload
		: NO_ENTRIES;
	if (Object.keys(loadMap).length === 0)
		A.derived("load_from_form", inactiveClaimOf(form, "load_from_form"));
	else {
		if (requires !== "case")
			A.drop("load_from_form", PRELOAD_CLAIMS.loadFromFormNoCase);
		else if (
			Object.keys(loadMap).every((path) => fieldAt(form, path) !== undefined)
		)
			A.drop("load_from_form", PRELOAD_CLAIMS.loadFromFormKept);
		else A.refuse("load_from_form", PRELOAD_CLAIMS.loadFromFormMissing);
	}
	for (const candidate of candidates) addPreloadCandidate(form, candidate);
}

/** Holds a preload's question until the bound form says whether moving its load changes anything. */
export function addPreloadCandidate(
	form: DraftForm,
	candidate: PreloadCandidate,
): void {
	const known = CANDIDATES.get(form);
	if (known === undefined) CANDIDATES.set(form, [candidate]);
	else known.push(candidate);
}

/** Every field of a form in data order, each with whether it stands in a repeat. */
function dataOrder(
	doc: BlueprintDoc,
	formUuid: Uuid,
): { uuid: Uuid; inRepeat: boolean; parent: Uuid }[] {
	const order: { uuid: Uuid; inRepeat: boolean; parent: Uuid }[] = [];
	const walk = (parent: Uuid, inRepeat: boolean) => {
		for (const uuid of doc.fieldOrder[parent] ?? []) {
			const field = doc.fields[uuid];
			if (field === undefined) continue;
			order.push({ uuid, inRepeat, parent });
			walk(uuid, inRepeat || field.kind === "repeat");
		}
	};
	walk(formUuid, false);
	return order;
}

/** Whether `expression` reads a field of `set`. */
function readsAny(expression: unknown, set: ReadonlySet<Uuid>): boolean {
	if (typeof expression !== "object" || expression === null) return false;
	let found = false;
	walkExpressionTerms(expression as Expression, (one) => {
		if (one.kind === "field" && set.has(one.uuid)) found = true;
	});
	return found;
}

/** The questions whose load-time value changes when `field` is set earlier in the load. */
export function laterLoadReaders(
	doc: BlueprintDoc,
	formUuid: Uuid,
	field: Uuid,
): readonly Uuid[] {
	const order = dataOrder(doc, formUuid);
	const slot = (uuid: Uuid, key: string): unknown =>
		(doc.fields[uuid] as Record<string, unknown> | undefined)?.[key];
	// What reads `field` while the form loads: a calculation or a relevance
	// over it, and everything under a container whose relevance reads it,
	// which reads blank while the container is not relevant.
	const set = new Set<Uuid>([field]);
	const hiding = new Set<Uuid>();
	let grew = true;
	while (grew) {
		grew = false;
		for (const { uuid, parent } of order) {
			if (set.has(uuid)) continue;
			const byRelevance = readsAny(slot(uuid, "relevant"), set);
			if (
				readsAny(slot(uuid, "calculate"), set) ||
				byRelevance ||
				hiding.has(parent)
			) {
				set.add(uuid);
				if (byRelevance || hiding.has(parent)) hiding.add(uuid);
				grew = true;
			}
		}
	}
	const position = order.findIndex((one) => one.uuid === field);
	const readers: Uuid[] = [];
	order.forEach((one, index) => {
		if (index <= position || one.inRepeat) return;
		if (readsAny(slot(one.uuid, "default_value"), set)) readers.push(one.uuid);
	});
	return readers;
}

/**
 * Whether HQ's build refuses a form for a preloaded property (`case_preload`, an advanced
 * load's `preload`) or an advanced action's written key (a load's or an open action's
 * `case_properties`): `helpers/validators.py::IndexedFormBaseValidator.check_case_properties`
 * reads every one (`FormActions.all_property_names`, and `LoadUpdateAction.get_property_names`
 * and `AdvancedAction.get_property_names` over `AdvancedFormValidator.check_actions`'
 * `get_all_actions`), refuses a path outside `validate_property`'s grammar (parents allowed) and a last step in
 * `case-reserved-words.json` (`HQ_CASE_RESERVED_WORDS`). `owner_id` is no reserved word of
 * HQ's (HQ reads it as the case's `@owner_id`, `xform.py::XForm.add_case_preloads`).
 */
export function hqBuildRefusesProperty(property: string): boolean {
	// HQ splits the last step off as it is stored (`util.py::split_path`), so a
	// trailing newline stays on it and no reserved word matches.
	const segments = property.split("/");
	const name = segments[segments.length - 1] as string;
	return !HQ_PROPERTY_PATH.test(property) || HQ_CASE_RESERVED_WORDS.has(name);
}

/** The children of a case in CommCare's case database that Nova reads by
 *  the same element (`CaseChildElement`; `rowScope.ts::casePropertyStep` prints
 *  each as a child step): the reserved words HQ's grammar admits only with a
 *  trailing newline. */
const CASE_CHILD_ELEMENTS: ReadonlySet<string> = new Set([
	"case_name",
	"date_opened",
	"last_modified",
]);

/**
 * What a preload of `property`, one HQ's build admits (`hqBuildRefusesProperty`
 * false), reads, as Nova names it: the index steps HQ walks and the case
 * property. HQ's build reads `name` as `case_name` and `owner_id` as the
 * attribute `@owner_id`, every other last step as the child element it names
 * (`xform.py::XForm.add_case_preloads`, and the advanced load's own loop). A
 * last step with the one trailing newline HQ's grammar admits is mapped by
 * neither, and Core's XPath lexer drops the newline (`Lexer.java`, whitespace
 * between tokens), so it reads the child element of the name without it.
 * Nova reads that element only where its own read of the name prints it: a
 * name HQ's build reads the same way without the newline, or a child element
 * of every case (`CASE_CHILD_ELEMENTS`). The `name` is `undefined` for every other such name
 * (`name`, `owner_id`, `case_id`, `status`, a reserved word such as `type`),
 * a child Nova's property grammar has no name for.
 */
export function preloadReadOf(property: string): {
	readonly indices: readonly string[];
	readonly name: string | undefined;
} {
	const newline = property.endsWith("\n");
	const indices = (newline ? property.slice(0, -1) : property).split("/");
	const last = indices.pop() as string;
	if (!newline) return { indices, name: last === "name" ? "case_name" : last };
	const unnamed =
		!CASE_CHILD_ELEMENTS.has(last) &&
		(last === "name" ||
			last === "owner_id" ||
			HQ_CASE_RESERVED_WORDS.has(last));
	return { indices, name: unnamed ? undefined : last };
}

/**
 * The element of the worker's case a `usercase_preload` of `property` reads, as HQ's build
 * reads it (`xform.py::XForm.add_case_preloads`, called by `_add_usercase` for the usercase):
 * `name` is the case's `case_name`, and every other property but `owner_id` the child element
 * of its name, which is what a worker-record read prints (`fromExpression.ts::workerProperty`);
 * a name with the one trailing newline HQ's grammar admits reads the child element of the
 * name without it (`preloadReadOf`). `undefined` for every other, each the finding
 * `any-other-usercase-preload` (no editor of HQ's makes any `usercase_preload`, so only the
 * class Nova reads is held):
 *
 * - `owner_id`, which HQ reads as the case's `@owner_id` attribute and no worker-record read
 *   prints;
 * - a path through an index (`parent/<property>`), which HQ's build accepts
 *   (`helpers/validators.py::validate_property` allows parents) and reads from an ancestor of
 *   the worker's case (`get_case_parent_id_xpath`), which no worker-record read reaches;
 * - a property HQ's build refuses: one outside `validate_property`'s grammar, or one in
 *   `case-reserved-words.json` (`IndexedFormBaseValidator.check_case_properties` holds every
 *   `usercase_preload` property to both);
 * - a name with that trailing newline whose element Nova names no property (`preloadReadOf`:
 *   `name`, `owner_id`, `case_id`, `status`, `type` and HQ's other reserved words), each the
 *   child element of the worker's case without the newline, which no worker-record read prints;
 * - a name Nova's worker-record read cannot spell (`externalUserPropertyNameSchema`: ASCII
 *   letters, digits, `_` and `-`), where HQ's grammar takes any letter after the first.
 */
function usercaseRead(property: unknown): string | undefined {
	if (typeof property !== "string" || hqBuildRefusesProperty(property))
		return undefined;
	const { indices, name } = preloadReadOf(property);
	// HQ's `owner_id` is the worker case's attribute, which no worker-record read prints.
	if (name === undefined || indices.length > 0 || name === "owner_id")
		return undefined;
	if (name === "case_name") return name;
	return externalUserPropertyNameSchema.safeParse(name).success
		? name
		: undefined;
}

/**
 * The worker-record read of `slug` the expression stage gives `#user/<slug>`
 * (`expressions/canonical.ts::workerRecordLeaf`, `worldEntities.ts::worldEntitiesFromReads`):
 * the name-backed read of one of the worker case's own keys (`USERCASE_BUILT_IN_KEYS`) or of a
 * slug Nova holds as no worker property; else the worker property of that slug, the one the
 * document holds or one minted under the key a re-read mints it by. A slug a held property
 * spells in other letters only, which HQ's duplicate check reads as the same, stays name-backed.
 * `undefined` where the minting failed, which the accounting has recorded.
 */
function workerRecordRead(
	ctx: ReadContext,
	doc: BlueprintDoc,
	slug: string,
	place: HqPlace,
):
	| { readonly kind: "property"; readonly property: UserProperty }
	| { readonly kind: "name"; readonly term: Term }
	| undefined {
	const named: Term = {
		kind: "session-user",
		field: slug,
		source: "worker-record",
	};
	if (USERCASE_BUILT_IN_KEYS.includes(slug))
		return { kind: "name", term: named };
	const matches = Object.values(doc.userProperties ?? {}).filter(
		(one) => one.slug.toLowerCase() === slug.toLowerCase(),
	);
	const [only] = matches;
	if (matches.length === 1 && only !== undefined && only.slug === slug)
		return { kind: "property", property: only };
	if (matches.length > 0 || !holdsWorkerProperty(slug))
		return { kind: "name", term: named };
	const minted = ctx.accounting.identity(
		ctx.identities.claim(externalKey.userProperty(slug), whereText(appPlace())),
		place,
		"schema:PreloadAction.preload",
	);
	return minted === undefined
		? undefined
		: { kind: "property", property: { uuid: minted, slug, label: slug } };
}

/**
 * Judges each preload of `form` over the bound document: a worker record's
 * default is written now that the app's worker properties are known, and a
 * load a later load-time value reads is the finding that it would move.
 */
export function settlePreloads(ctx: ReadContext, form: DraftForm): void {
	const candidates = CANDIDATES.get(form);
	if (candidates === undefined || ctx.doc === undefined) return;
	const ownType = ctx.draft.modules.find((one) => one.forms.includes(form))
		?.module.caseType;
	const walks = caseTypeHopMap(ctx.doc, ownType);
	for (const candidate of candidates) {
		const uuid = candidate.field.uuid;
		if (uuid === undefined) continue;
		const load = candidate.load;
		if (load !== undefined && !sameJson(walks.get(load.caseType), load.hops)) {
			ctx.accounting.finding(load.otherCase, candidate.place, {
				name: candidate.field.id,
			});
			continue;
		}
		if (candidate.usercase !== undefined) {
			const read = workerRecordRead(
				ctx,
				ctx.doc,
				candidate.usercase,
				candidate.place,
			);
			if (read === undefined) continue;
			ctx.doc = withCandidate(ctx.doc, (draft) => {
				let leaf: Term;
				if (read.kind === "name") leaf = read.term;
				else {
					const known = read.property;
					if (draft.userProperties?.[known.uuid] === undefined) {
						const properties = recordFromEntries([
							...Object.entries(draft.userProperties ?? NO_ENTRIES),
							[known.uuid, known],
						]);
						draft.userProperties = properties;
						// In the code-unit order of the slugs, as the properties the logic reads
						// stand (`worldEntitiesFromReads`), so a re-read that meets this read in
						// the logic gives the same order.
						const order = [...(draft.userPropertyOrder ?? [])];
						const after = order.findIndex(
							(uuid) => (properties[uuid]?.slug ?? "") > known.slug,
						);
						order.splice(after < 0 ? order.length : after, 0, known.uuid);
						draft.userPropertyOrder = order;
					}
					leaf = {
						kind: "session-user-property",
						userPropertyUuid: known.uuid,
						source: "worker-record",
					};
				}
				const field = draft.fields[uuid] as Record<string, unknown> | undefined;
				if (field !== undefined) field.default_value = term(leaf);
			});
		}
		if (laterLoadReaders(ctx.doc, form.uuid, uuid).length > 0)
			ctx.accounting.finding(
				candidate.moves ?? PRELOAD_CLAIMS.movesValues,
				candidate.place,
				{
					name: candidate.field.id,
				},
			);
	}
}
