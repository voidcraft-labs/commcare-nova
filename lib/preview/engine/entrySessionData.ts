import type { CompletedFormSearch } from "./xpathInstances";
// lib/preview/engine/entrySessionData.ts
//
// The session one form entry holds: `instance('commcaresession')/session/data`.
//
// CommCare values each datum of an entry once, when the session reaches it
// (`CommCareSession.getNeededData`), in entry order: a selection is the case
// the worker chose, a `uuid()` datum is a fresh id, and the worker's record
// (`usercase_id`) and a grouped tile's companion (`<datum>_parent_ids`) are
// functions evaluated over the device's casedb and the datums before them.
// The form reads that map for the whole entry and the session keeps it after
// the form closes, so its after-submit links read the same values.
//
// Preview builds the same map here, from the entry's datum ids
// (`formLinkProjection.ts::entryDatumIds`, the ids the wire prints) and the
// running app's menu case map, and mints each `uuid()` datum from the entry key
// (`lib/domain/entryCaseIdentity.ts`), so the submission creates its cases with
// the ids the form read.

import {
	caseListSessionDatums,
	entryDatumIds,
	entrySessionDatums,
	formLinkProjectionContext,
	owningModuleOf,
} from "@/lib/commcare/formLinkProjection";
import { CASE_LIST_SEARCH_TEXT_DATA_NAME } from "@/lib/commcare/sessionContext";
import { serializeWire } from "@/lib/commcare/xpath/wire/serialize";
import type { BlueprintDoc, Uuid } from "@/lib/domain";
import {
	explicitFormCaseSelections,
	formCaseSelections,
} from "@/lib/domain/advancedEntryDatums";
import { entryCaseTypes } from "@/lib/domain/effectiveCaseTypes";
import {
	entryDatumCaseId,
	entryDatumCaseKey,
	entryNewCaseKeyNumbering,
} from "@/lib/domain/entryCaseIdentity";
import { type DatumRef, datumRefKey } from "@/lib/domain/expression/types";
import { implicitFormSelectionId } from "@/lib/domain/formEntryCases";
import type {
	PreviewCaseChoice,
	PreviewEntryChoice,
	PreviewMenuCaseSelection,
} from "@/lib/session/types";
import { previewMenuCaseContext } from "../menuProjection";
import { toBoolean, xpathToString } from "../xpath/coerce";
import { evaluate } from "../xpath/evaluator";
import { invokeGeneratedJavaRosaFunction } from "../xpath/generatedJavaRosaFunctions";
import type { XPathInstance } from "../xpath/runtimeValues";
import { dayNumberEpochOf, type EvalContext } from "../xpath/types";
import { PreviewDataRefusal } from "./dataRefusal";
import type { SessionDatumValue } from "./formLinkEvaluation";
import type { PreviewSearchSessionValues } from "./identity";
import type { PreviewLookupData } from "./lookupEvaluation";
import {
	type CaseDatabaseSnapshot,
	caseDatabaseXPathInstance,
	commcareSessionXPathInstance,
	lookupXPathInstances,
	type SearchResultsSnapshot,
} from "./xpathInstances";

/** What the running app knows when a form's entry begins. */
export interface EntrySessionInput {
	/** The saved app the entry's `uuid()` datums are minted in. An app not
	 *  saved yet has no ids to mint, so those datums stay unvalued. */
	readonly appId: string | undefined;
	readonly entrySupplies?: import("@/lib/domain").CaseCreationLaunch;
	/** The cases the form is bound to, in selection order: the case target. */
	readonly boundCases: readonly PreviewCaseChoice[];
	/** Ordered input from this form's own entry. Two input positions may use the same menu. */
	readonly entryChoices?: readonly PreviewEntryChoice[];
	readonly heldEntryValues?: Readonly<Record<string, string>>;
	readonly openedEntryKey?: string;
	readonly resumedCheckpoint?: import("./formEngine").FormEngineEntryCheckpoint;
	readonly openingLookup?: PreviewLookupData;
	/** The menu's case selections, keyed by the module that chose them. */
	readonly menuSelections: Readonly<Record<string, PreviewMenuCaseSelection>>;
	/** What the search of the form's search-first module returned, which
	 *  the session holds on its query step for the whole entry. */
	readonly searchResults?: SearchResultsSnapshot;
	readonly searches?: readonly CompletedFormSearch[];
	/** What the worker typed into the case list's filter before choosing the
	 *  case: Core writes `session/data/stringquery` for a step that carries a
	 *  non-empty last query (`SessionInstanceBuilder.addUserQueryData`). */
	readonly caseListSearchText?: string;
}

export interface EntrySessionData {
	/** Stable reference identities, including alternate names for one physical datum. */
	readonly datumsByRef?: Readonly<Record<string, string>>;
	readonly reachedCaseIds: ReadonlyMap<Uuid, string>;
	/** Calculations already executed, keyed by immutable supply identity. */
	readonly resolvedEntryValues?: Readonly<Record<string, string>>;
	/** At a manual boundary the remaining datums have not run. */
	readonly nextSelection?: {
		readonly chosenCaseIds: Readonly<Record<string, string>>;
		readonly selectionUuid: Uuid;
		readonly moduleUuid: Uuid;
		readonly name: string;
		readonly confirms: boolean;
		readonly autoSelectSingle: boolean;
		readonly under?: {
			readonly caseId: string;
			readonly caseType: string;
			readonly identifier: string;
		};
	};
	/** `session/data/<id>` → value, for the session instance. */
	readonly data: Readonly<Record<string, string>>;
	/** The same values with the name of each case a datum names, keyed by
	 *  datum id: what after-submit links read and carry. */
	readonly values: ReadonlyMap<string, SessionDatumValue>;
	/** The id the entry minted for the case a registration creates, when the
	 *  entry names one. The submission creates the case with it. */
	readonly newCaseId?: string;
	/** Each several-case datum's cases in selection order, keyed by the
	 *  datum id the selected-entities instance is declared under. */
	readonly selectedCases: Readonly<Record<string, readonly string[]>>;
	/** What the entry's search returned, which its form and its links read
	 *  as `results:inline`. */
	readonly searchResults?: SearchResultsSnapshot;
	readonly searches?: readonly CompletedFormSearch[];
}

/**
 * Build one entry's session map. Every datum of the entry is visited in
 * order; a datum Preview has no value for (a several-case selection, which
 * the batch form reads through `selected-cases`; an inline search's query
 * datum) is absent, as an unvalued datum reads blank.
 */
export function entrySessionData(
	doc: BlueprintDoc,
	formUuid: Uuid,
	args: EntrySessionInput & {
		readonly entryKey: string;
		readonly lookupData?: PreviewLookupData | null;
		readonly caseDatabase: CaseDatabaseSnapshot | null;
		readonly session: PreviewSearchSessionValues;
	},
): EntrySessionData {
	const ctx = formLinkProjectionContext(doc, {
		entryMetadataOnly: true,
		renderEntryValues: true,
		lookupNaming: args.lookupData?.naming,
	});
	const moduleUuid = owningModuleOf(ctx, formUuid);
	if (moduleUuid === undefined || doc.forms[formUuid] === undefined)
		return {
			data: {},
			values: new Map(),
			selectedCases: {},
			reachedCaseIds: new Map(),
		};
	const datums = entrySessionDatums(doc, ctx, moduleUuid, formUuid);
	const ids = entryDatumIds(doc, ctx, moduleUuid, formUuid);
	if (ids.length !== datums.length)
		throw new Error(
			"The entry's datum identities disagree with its session datums. Both come from one projection; check `entryDatumIds`.",
		);
	const menuSource = { ...doc, caseTypes: doc.caseTypes ?? [] };
	const rowsById = new Map(
		(args.caseDatabase?.rows ?? []).map((row) => [row.case_id, row] as const),
	);
	const casedb = caseDatabaseXPathInstance(
		args.caseDatabase,
		entryCaseTypes(doc),
	);
	const data: Record<string, string> = Object.create(null);
	const values = new Map<string, SessionDatumValue>();
	const selectedCases: Record<string, readonly string[]> = Object.create(null);
	let newCaseId: string | undefined;
	let nextSelection: EntrySessionData["nextSelection"];
	// A frame may already supply a later choice while the worker still has to
	// answer an earlier one. Core checks collected data by name at each step.
	const suppliedChoices = new Map(
		args.entryChoices?.map((row) => [row.selectionUuid, row] as const),
	);
	const held = args.heldEntryValues ?? args.entryChoices?.at(-1)?.earlierValues;
	const resolvedEntryValues: Record<string, string> = Object.create(null);
	// A form that keeps its menu's choices walks them only where the caller
	// walks the entry choice by choice (`entryChoices`), and then only the
	// ones a worker chooses from a list: Core asks for each at its own step,
	// and one that opens its single match automatically never shows the list.
	const explicit = explicitFormCaseSelections(doc, formUuid);
	const selectionsById = new Map(
		(
			explicit ??
			(args.entryChoices === undefined
				? []
				: formCaseSelections(doc, formUuid).filter(
						(row) => row.source.kind === "choose",
					))
		).map((row) => [row.uuid, row] as const),
	);
	const reached = new Map<Uuid, string>();
	const newCaseKey = entryNewCaseKeyNumbering();
	const hold = (id: string, value: SessionDatumValue) => {
		data[id] = value.value;
		values.set(id, value);
	};
	/* The form's own module holds the bound cases; any other module holds
	 * what its menu chose. */
	const chosenCases = (module: Uuid): readonly PreviewCaseChoice[] =>
		module === moduleUuid
			? args.boundCases
			: (previewMenuCaseContext(menuSource, module, args.menuSelections)
					.selectedCase?.cases ?? []);
	const caseNameOf = (caseId: string, chosen?: PreviewCaseChoice) =>
		chosen?.caseName ?? rowsById.get(caseId)?.case_name;

	for (const [index, datum] of datums.entries()) {
		const row = ids[index];
		if (row === undefined || row.id !== datum.id)
			throw new Error(
				"The entry's datum identities are out of order with its session datums.",
			);
		if (datum.query !== undefined) continue;
		const supply = row.refs.find((ref) => ref.kind === "form-selection");
		let choice = supply && selectionsById.get(supply.selection);
		// A menu's own choice the running session already holds (the case the
		// menu or a link bound) is that case, as it is outside the walk.
		if (
			explicit === undefined &&
			choice !== undefined &&
			!suppliedChoices.has(choice.uuid) &&
			row.refs.some(
				(ref) =>
					ref.kind === "selected-case" && chosenCases(ref.module).length > 0,
			)
		)
			choice = undefined;
		if (choice?.source.kind === "choose") {
			const source = choice.source;
			const selected = suppliedChoices.get(choice.uuid);
			if (!selected) {
				const parentId = source.under && reached.get(source.under.selection);
				// List filters identify a choice by menu. The suite resolves the
				// first completed load for that menu, including a root-aligned alias.
				const chosenCaseIds: Record<string, string> = Object.create(null);
				for (const earlier of datums.slice(0, index)) {
					if (!values.has(earlier.id)) continue;
					for (const menu of [
						ctx.selectionSourceModules.get(earlier),
						ctx.alignedSelectionSources.get(earlier),
					]) {
						if (menu !== undefined) chosenCaseIds[menu] ??= data[earlier.id];
					}
				}
				nextSelection = {
					chosenCaseIds,
					selectionUuid: choice.uuid,
					moduleUuid: source.module,
					name: choice.name,
					confirms: datum.detailConfirm !== undefined,
					autoSelectSingle: datum.autoselect === true,
					...(source.under &&
						parentId !== undefined && {
							under: {
								caseId: parentId,
								caseType: rowsById.get(parentId)?.case_type ?? "",
								identifier: source.under.identifier,
							},
						}),
				};
				break;
			}
			const name = caseNameOf(selected.caseId, selected);
			hold(datum.id, {
				value: selected.caseId,
				...(name !== undefined && { caseName: name }),
			});
			reached.set(choice.uuid, selected.caseId);
			continue;
		}
		if (
			datum.function &&
			(choice || datum.entryValueUuid || datum.inheritedEntryFunction)
		) {
			const identity =
				choice?.uuid ?? datum.entryValueUuid ?? datum.inheritedEntryFunction;
			if (!identity)
				throw new Error("An entry function needs its supply identity.");
			const previous =
				held && Object.hasOwn(held, identity) ? held[identity] : undefined;
			if (previous !== undefined) {
				const caseName = choice && caseNameOf(previous);
				hold(datum.id, {
					value: previous,
					...(caseName !== undefined && { caseName }),
				});
				resolvedEntryValues[identity] = previous;
				if (choice) reached.set(choice.uuid, previous);
				continue;
			}
			const world = {
				session: args.session,
				data,
				casedb,
				lookupData: args.lookupData,
			};
			for (const assertion of datum.assertions ?? []) {
				const test = serializeWire(assertion.test, { target: "preview" }).text;
				if (choice && !toBoolean(evaluateSessionExpression(test, world))) {
					throw new PreviewDataRefusal({
						kind: "entry-record",
						selection: choice.name,
						source: choice.source.kind,
					});
				}
			}
			const value = evaluateDatumFunction(
				serializeWire(datum.function, { target: "preview" }).text,
				world,
			);
			const name = choice && caseNameOf(value);
			hold(datum.id, { value, ...(name !== undefined && { caseName: name }) });
			resolvedEntryValues[identity] = value;
			if (choice) reached.set(choice.uuid, value);
			continue;
		}
		const selection = row.refs.filter(
			(ref): ref is Extract<DatumRef, { kind: "selected-case" }> =>
				ref.kind === "selected-case",
		);
		if (selection.length > 0) {
			// A several-case selection is the batch form's `selected-cases`,
			// the selected-entities instance under the datum's id.
			if (!row.scalar) {
				const chosen = selection
					.map((ref) => chosenCases(ref.module))
					.find((candidates) => candidates.length > 0);
				if (chosen !== undefined)
					selectedCases[datum.id] = chosen.map((choice) => choice.caseId);
				continue;
			}
			const chosen = selection
				.map((ref) => chosenCases(ref.module)[0])
				.find((candidate) => candidate !== undefined);
			if (chosen === undefined) continue;
			if (supply) reached.set(supply.selection, chosen.caseId);
			for (const ref of selection)
				reached.set(
					implicitFormSelectionId(formUuid, ref.module),
					chosen.caseId,
				);
			const caseName = caseNameOf(chosen.caseId, chosen);
			hold(datum.id, {
				value: chosen.caseId,
				...(caseName === undefined ? {} : { caseName }),
			});
			continue;
		}
		if (datum.function === undefined) continue;
		const ref = row.refs[0];
		if (ref?.kind === "worker-record" || ref?.kind === "tile-group-parents") {
			const value =
				ref.kind === "tile-group-parents" && datumSelectsSeveral(datums, datum)
					? groupedParentIds(
							doc,
							ref.module,
							chosenCases(ref.module),
							args.caseDatabase,
						)
					: evaluateDatumFunction(
							serializeWire(datum.function, { target: "preview" }).text,
							{ session: args.session, data, casedb },
						);
			if (ref.kind === "worker-record") {
				if (supply) reached.set(supply.selection, value);
				reached.set(implicitFormSelectionId(formUuid, "worker-record"), value);
			}
			const caseName =
				ref.kind === "worker-record" ? caseNameOf(value) : undefined;
			hold(datum.id, {
				value,
				...(caseName === undefined ? {} : { caseName }),
			});
			continue;
		}
		// A `uuid()` datum: the case this entry creates, or one no case names.
		// Numbered before the app check, so every datum keeps its key.
		const key =
			ref?.kind === "new-case" || ref?.kind === "new-child-case"
				? newCaseKey(ref)
				: entryDatumCaseKey(undefined, datum.id);
		if (args.appId === undefined) continue;
		const supplied =
			row.caseCreationOperationUuid === undefined
				? undefined
				: args.entrySupplies?.creations.find(
						(input) => input.operationUuid === row.caseCreationOperationUuid,
					);
		const value =
			supplied?.caseId ?? entryDatumCaseId(args.appId, args.entryKey, key);
		if (ref?.kind === "new-case") newCaseId = value;
		hold(datum.id, { value });
	}
	if (args.caseListSearchText !== undefined && args.caseListSearchText !== "")
		data[CASE_LIST_SEARCH_TEXT_DATA_NAME] = args.caseListSearchText;
	const datumsByRef: Record<string, string> = Object.create(null);
	for (const row of ids) {
		const datum = values.get(row.id);
		if (row.scalar && datum !== undefined)
			for (const ref of row.refs) datumsByRef[datumRefKey(ref)] = datum.value;
	}
	return {
		data,
		values,
		datumsByRef,
		reachedCaseIds: reached,
		...(nextSelection && { nextSelection }),
		...(Object.keys(resolvedEntryValues).length && { resolvedEntryValues }),
		selectedCases,
		...(newCaseId === undefined ? {} : { newCaseId }),
		...(args.searches === undefined ? {} : { searches: args.searches }),
		...(args.searchResults === undefined
			? {}
			: { searchResults: args.searchResults }),
	};
}

/**
 * Whether Preview and App Tests walk `formUuid`'s entry choice by choice
 * (`entrySessionData` with `entryChoices`) rather than through its menu's
 * case list: the form keeps its own choices, or one of its datums opens its
 * single match automatically (`Module.autoSelectSingle` on an advanced
 * menu's list, which the ordinary case list never does on its own).
 */
export function entryWalksChoices(doc: BlueprintDoc, formUuid: Uuid): boolean {
	const form = doc.forms[formUuid];
	if (form === undefined) return false;
	if (form.caseSelections !== undefined || form.shadowOf) return true;
	const ctx = formLinkProjectionContext(doc, { entryMetadataOnly: true });
	const moduleUuid = owningModuleOf(ctx, formUuid);
	if (moduleUuid === undefined) return false;
	return entrySessionDatums(doc, ctx, moduleUuid, formUuid).some(
		(datum) => datum.autoselect === true,
	);
}

/** The session at a module's case list step. */
export interface CaseListStepSession {
	/** `session/data/<id>` → value for the datums supplied before the list:
	 * what the list's filter, its Search screen and the search request read. */
	readonly data: Readonly<Record<string, string>>;
	/** The case chosen in each menu before the list, by that menu's module:
	 * what a browse list's filter reads its chosen case by
	 * (`TermBindings.chosenCaseIds`). */
	readonly chosenCaseIds: Readonly<Record<string, string>>;
}

/**
 * The session a module's case list step holds: the datums the session
 * supplies before the module's own selection, valued as Core
 * values them when the session reaches them. A selection is the case the
 * menu chose (a parent selection, a copied root datum); the worker's record
 * and a grouped tile's companion are their functions over the device's cases
 * and the datums before them. The Search screen of the module runs at its
 * query step, after the same datums, so it reads this map too. A datum
 * Preview has no value for is absent, as an unvalued datum reads blank.
 */
export function caseListStepSession(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
	args: {
		readonly menuSelections: Readonly<Record<string, PreviewMenuCaseSelection>>;
		readonly caseDatabase: CaseDatabaseSnapshot | null;
		readonly session: PreviewSearchSessionValues;
	},
): CaseListStepSession {
	if (doc.modules[moduleUuid] === undefined)
		return { data: {}, chosenCaseIds: {} };
	const ctx = formLinkProjectionContext(doc, { entryMetadataOnly: true });
	const datums = caseListSessionDatums(doc, ctx, moduleUuid);
	const ids = entryDatumIds(doc, ctx, moduleUuid);
	if (ids.length !== datums.length)
		throw new Error(
			"The case list's datum identities disagree with its session datums. Both come from one projection; check `entryDatumIds`.",
		);
	const own = ids.findLastIndex((row) =>
		row.refs.some(
			(ref) => ref.kind === "selected-case" && ref.module === moduleUuid,
		),
	);
	const before = own === -1 ? ids.length : own;
	const menuSource = { ...doc, caseTypes: doc.caseTypes ?? [] };
	const casedb = caseDatabaseXPathInstance(
		args.caseDatabase,
		entryCaseTypes(doc),
	);
	const data: Record<string, string> = Object.create(null);
	const chosenCaseIds: Record<string, string> = {};
	const chosenCases = (module: Uuid): readonly PreviewCaseChoice[] =>
		previewMenuCaseContext(menuSource, module, args.menuSelections).selectedCase
			?.cases ?? [];
	for (const [index, datum] of datums.slice(0, before).entries()) {
		const row = ids[index];
		if (row === undefined || row.id !== datum.id)
			throw new Error(
				"The case list's datum identities are out of order with its session datums.",
			);
		if (datum.query !== undefined) continue;
		const selection = row.refs.filter(
			(ref): ref is Extract<DatumRef, { kind: "selected-case" }> =>
				ref.kind === "selected-case",
		);
		if (selection.length > 0) {
			if (!row.scalar) continue;
			for (const ref of selection) {
				const chosen = chosenCases(ref.module)[0];
				if (chosen === undefined) continue;
				data[datum.id] ??= chosen.caseId;
				chosenCaseIds[ref.module] = chosen.caseId;
			}
			continue;
		}
		if (datum.function === undefined) continue;
		const ref = row.refs[0];
		if (ref?.kind === "worker-record" || ref?.kind === "tile-group-parents")
			data[datum.id] =
				ref.kind === "tile-group-parents" && datumSelectsSeveral(datums, datum)
					? groupedParentIds(
							doc,
							ref.module,
							chosenCases(ref.module),
							args.caseDatabase,
						)
					: evaluateDatumFunction(
							serializeWire(datum.function, { target: "preview" }).text,
							{ session: args.session, data, casedb },
						);
	}
	return { data, chosenCaseIds };
}

/**
 * The entry's session once its submission has landed, what its after-submit
 * links read. The session does not change when the form closes, so every
 * datum keeps its value; a case the submission created gains the name it was
 * saved with. A registration's datum holds the case the submission actually
 * created: the id its entry minted, or, for a receipt replayed from before
 * entries minted ids, the id that receipt saved.
 */
export function afterSubmitSessionDatums(
	entry: EntrySessionData | undefined,
	submission: {
		readonly caseId?: string;
		readonly caseName?: string;
		readonly childCases: ReadonlyArray<{
			readonly caseId: string;
			readonly caseName?: string;
		}>;
	},
	registeredCaseId?: string,
): ReadonlyMap<string, SessionDatumValue> {
	if (entry === undefined) return new Map();
	const minted = entry.newCaseId;
	const created =
		registeredCaseId !== undefined && minted !== undefined
			? registeredCaseId
			: undefined;
	const names = new Map<string, string>();
	if (submission.caseId !== undefined && submission.caseName !== undefined)
		names.set(submission.caseId, submission.caseName);
	for (const child of submission.childCases)
		if (child.caseName !== undefined) names.set(child.caseId, child.caseName);
	return new Map(
		[...entry.values].map(([id, entryValue]) => {
			const held =
				created !== undefined && entryValue.value === minted
					? { ...entryValue, value: created }
					: entryValue;
			const caseName = held.caseName ?? names.get(held.value);
			return [id, caseName === undefined ? held : { ...held, caseName }];
		}),
	);
}

/**
 * The keys of the cases a form's entry names, in entry order (`new-case`,
 * `new-child-case:<type>`, and `new-child-case:<type>:<i>` for a later case
 * of a type, `entryNewCaseKeyNumbering`): the cases its submission creates
 * with the ids the entry minted. The server derives them from the committed
 * document, never from the client.
 */
export function entryCreatedCaseKeys(
	doc: BlueprintDoc,
	formUuid: Uuid,
): readonly string[] {
	const ctx = formLinkProjectionContext(doc, { entryMetadataOnly: true });
	const moduleUuid = owningModuleOf(ctx, formUuid);
	if (moduleUuid === undefined) return [];
	const newCaseKey = entryNewCaseKeyNumbering();
	return entryDatumIds(doc, ctx, moduleUuid, formUuid).flatMap((row) => {
		const ref = row.refs[0];
		return ref?.kind === "new-case" || ref?.kind === "new-child-case"
			? [newCaseKey(ref)]
			: [];
	});
}

/** Evaluate one datum function as Core does when the session reaches it: in
 *  the session's scope, over the device's casedb and the datums before it. */
interface EntryExpressionWorld {
	readonly session: PreviewSearchSessionValues;
	readonly data: Readonly<Record<string, string>>;
	readonly casedb: XPathInstance;
	readonly lookupData?: PreviewLookupData | null;
}
function evaluateDatumFunction(
	source: string,
	world: EntryExpressionWorld,
): string {
	return xpathToString(evaluateSessionExpression(source, world));
}
function evaluateSessionExpression(
	source: string,
	world: EntryExpressionWorld,
) {
	const instances = new Map<string, XPathInstance>([
		[
			"commcaresession",
			commcareSessionXPathInstance(world.session, { ...world.data }),
		],
		["casedb", world.casedb],
		...lookupXPathInstances(world.lookupData ?? null, {
			includeFixtureAliases: true,
		}),
	]);
	const context: EvalContext = {
		contextPath: "",
		position: undefined,
		getValue: (path) => {
			throw new Error(
				`A session datum cannot read "${path}": a datum is valued before its form opens, so it reads only the session and the device's cases.`,
			);
		},
		resolveXPathInstance: (instanceId) => instances.get(instanceId),
		invokeGeneratedFunction: invokeGeneratedJavaRosaFunction,
		dayNumberEpoch: dayNumberEpochOf(world.session),
	};
	return evaluate(source, context);
}

/** Whether the selection a grouped tile's companion reads chooses several
 *  cases. The companion follows its module's own selection datum. */
function datumSelectsSeveral(
	datums: ReturnType<typeof entrySessionDatums>,
	companion: (typeof datums)[number],
): boolean {
	const selection = datums.find(
		(datum) => `${datum.id}_parent_ids` === companion.id,
	);
	return selection?.maxSelectValue !== undefined;
}

/**
 * A several-case grouped tile's companion: the distinct targets of the
 * grouping index over the chosen cases, in casedb order, joined by spaces —
 * `join(' ', distinct-values(casedb/case[selected(…, @case_id)]/index/<id>))`
 * over the selection, which Core reads from the selected-entities instance.
 */
function groupedParentIds(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
	cases: readonly PreviewCaseChoice[],
	caseDatabase: CaseDatabaseSnapshot | null,
): string {
	const identifier =
		doc.modules[moduleUuid]?.caseListConfig?.tile?.grouping?.identifier;
	if (identifier === undefined) return "";
	const chosen = new Set(cases.map((choice) => choice.caseId));
	const targets = new Map<string, string>();
	for (const index of caseDatabase?.indices ?? []) {
		if (index.identifier !== identifier || !chosen.has(index.case_id)) continue;
		targets.set(index.case_id, index.ancestor_id);
	}
	const distinct: string[] = [];
	for (const row of caseDatabase?.rows ?? []) {
		const target = targets.get(row.case_id);
		if (target !== undefined && !distinct.includes(target))
			distinct.push(target);
	}
	return distinct.join(" ");
}
