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
	entryDatumIds,
	entrySessionDatums,
	formLinkProjectionContext,
	owningModuleOf,
} from "@/lib/commcare/formLinkProjection";
import { serializeWire } from "@/lib/commcare/xpath/wire/serialize";
import {
	type BlueprintDoc,
	materializableCaseTypes,
	type Uuid,
} from "@/lib/domain";
import {
	entryDatumCaseId,
	entryDatumCaseKey,
} from "@/lib/domain/entryCaseIdentity";
import type { DatumRef } from "@/lib/domain/expression/types";
import type {
	PreviewCaseChoice,
	PreviewMenuCaseSelection,
} from "@/lib/session/types";
import { previewMenuCaseContext } from "../menuProjection";
import { xpathToString } from "../xpath/coerce";
import { evaluate } from "../xpath/evaluator";
import { invokeGeneratedJavaRosaFunction } from "../xpath/generatedJavaRosaFunctions";
import type { EvalContext } from "../xpath/types";
import type { SessionDatumValue } from "./formLinkEvaluation";
import type {
	PreviewSearchSessionValues,
	ResolvedPreviewIdentity,
} from "./identity";
import {
	type CaseDatabaseSnapshot,
	caseDatabaseXPathInstance,
	commcareSessionXPathInstance,
} from "./xpathInstances";

/** What the running app knows when a form's entry begins. */
export interface EntrySessionInput {
	/** The saved app the entry's `uuid()` datums are minted in. An app not
	 *  saved yet has no ids to mint, so those datums stay unvalued. */
	readonly appId: string | undefined;
	/** The cases the form is bound to, in selection order: the case target. */
	readonly boundCases: readonly PreviewCaseChoice[];
	/** The menu's case selections, keyed by the module that chose them. */
	readonly menuSelections: Readonly<Record<string, PreviewMenuCaseSelection>>;
}

export interface EntrySessionData {
	/** `session/data/<id>` → value, for the session instance. */
	readonly data: Readonly<Record<string, string>>;
	/** The same values with the name of each case a datum names, keyed by
	 *  datum id: what after-submit links read and carry. */
	readonly values: ReadonlyMap<string, SessionDatumValue>;
	/** The id the entry minted for the case a registration creates, when the
	 *  entry names one. The submission creates the case with it. */
	readonly newCaseId?: string;
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
		readonly caseDatabase: CaseDatabaseSnapshot | null;
		readonly identity:
			| ResolvedPreviewIdentity
			| PreviewSearchSessionValues
			| null;
	},
): EntrySessionData {
	const ctx = formLinkProjectionContext(doc, { entryMetadataOnly: true });
	const moduleUuid = owningModuleOf(ctx, formUuid);
	if (moduleUuid === undefined || doc.forms[formUuid] === undefined)
		return { data: {}, values: new Map() };
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
		materializableCaseTypes(doc),
	);
	const data: Record<string, string> = {};
	const values = new Map<string, SessionDatumValue>();
	let newCaseId: string | undefined;
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
		const selection = row.refs.filter(
			(ref): ref is Extract<DatumRef, { kind: "selected-case" }> =>
				ref.kind === "selected-case",
		);
		if (selection.length > 0) {
			// A several-case selection is the batch form's `selected-cases`.
			if (!row.scalar) continue;
			const chosen = selection
				.map((ref) => chosenCases(ref.module)[0])
				.find((candidate) => candidate !== undefined);
			if (chosen === undefined) continue;
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
							{ identity: args.identity, data, casedb },
						);
			const caseName =
				ref.kind === "worker-record" ? caseNameOf(value) : undefined;
			hold(datum.id, {
				value,
				...(caseName === undefined ? {} : { caseName }),
			});
			continue;
		}
		// A `uuid()` datum: the case this entry creates, or one no case names.
		if (args.appId === undefined) continue;
		const value = entryDatumCaseId(
			args.appId,
			args.entryKey,
			entryDatumCaseKey(
				ref?.kind === "new-case" || ref?.kind === "new-child-case"
					? ref
					: undefined,
				datum.id,
			),
		);
		if (ref?.kind === "new-case") newCaseId = value;
		hold(datum.id, { value });
	}
	return { data, values, ...(newCaseId === undefined ? {} : { newCaseId }) };
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
 * The keys of the cases a form's entry names (`new-case`,
 * `new-child-case:<type>`): the cases its submission creates with the ids the
 * entry minted. The server derives them from the committed document, never
 * from the client.
 */
export function entryCreatedCaseKeys(
	doc: BlueprintDoc,
	formUuid: Uuid,
): ReadonlySet<string> {
	const ctx = formLinkProjectionContext(doc, { entryMetadataOnly: true });
	const moduleUuid = owningModuleOf(ctx, formUuid);
	if (moduleUuid === undefined) return new Set();
	return new Set(
		entryDatumIds(doc, ctx, moduleUuid, formUuid).flatMap((row) =>
			row.refs.flatMap((ref) =>
				ref.kind === "new-case" || ref.kind === "new-child-case"
					? [entryDatumCaseKey(ref, row.id)]
					: [],
			),
		),
	);
}

/** Evaluate one datum function as Core does when the session reaches it: in
 *  the session's scope, over the device's casedb and the datums before it. */
function evaluateDatumFunction(
	source: string,
	world: {
		readonly identity:
			| ResolvedPreviewIdentity
			| PreviewSearchSessionValues
			| null;
		readonly data: Readonly<Record<string, string>>;
		readonly casedb: ReturnType<typeof caseDatabaseXPathInstance>;
	},
): string {
	const instances = new Map([
		[
			"commcaresession",
			commcareSessionXPathInstance(world.identity, { ...world.data }),
		],
		["casedb", world.casedb],
	] as const);
	const context: EvalContext = {
		contextPath: "",
		position: undefined,
		getValue: (path) => {
			throw new Error(
				`A session datum cannot read "${path}": a datum is valued before its form opens, so it reads only the session and the device's cases.`,
			);
		},
		resolveXPathInstance: (instanceId) =>
			instances.get(instanceId as "commcaresession" | "casedb"),
		invokeGeneratedFunction: invokeGeneratedJavaRosaFunction,
	};
	return xpathToString(evaluate(source, context));
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
