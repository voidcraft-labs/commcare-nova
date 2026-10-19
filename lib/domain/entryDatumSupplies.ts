import type { BlueprintDoc } from "./blueprint";
import {
	deriveCaseWriteInventory,
	deriveCaseWriteInventoryForStructure,
} from "./caseWriteInventory";
import type { FormStructure } from "./expression/formStructure";
import { type DatumRef, datumRefKey } from "./expression/types";
import { CASE_LOADING_FORM_TYPES, type FormLinkTarget } from "./forms";
import { menuFormUuidsOf, moduleIsCaseFirst } from "./menuForms";
import { moduleParent } from "./moduleHierarchy";
import {
	caseSelectionCanFlowBetweenModules,
	caseSelectionCardinality,
	caseSelectionMaximum,
	moduleOpensOnSearch,
} from "./modules";
import type { Uuid } from "./uuid";

/** A physical entry. A browse entry includes its own selection; a case-list
 * evaluation point below runs before that selection has been made. */
export type DatumEntry =
	| { readonly kind: "form"; readonly module: Uuid; readonly form: Uuid }
	| { readonly kind: "browse"; readonly module: Uuid };

export type EntryDatumPoint =
	| Extract<DatumEntry, { kind: "form" }>
	| { readonly kind: "case-list" | "search"; readonly module: Uuid }
	| { readonly kind: "form-menu"; readonly module: Uuid; readonly form: Uuid };

export interface SelectionBoundMismatch {
	readonly moduleUuid: Uuid;
	readonly sourceModuleUuid: Uuid;
	readonly targetModuleUuid: Uuid;
	readonly sourceMaximum: number;
	readonly targetMaximum: number;
}

export interface RootSelectionAlignment {
	readonly parentEntry?: DatumEntry;
	/** Accepted pairs, in the parent's selection order. Both identities are
	 * the original modules in their entries' complete parent-selection chains. */
	readonly matches: readonly {
		readonly sourceModuleUuid: Uuid;
		readonly targetModuleUuid: Uuid;
	}[];
	readonly boundMismatches: readonly SelectionBoundMismatch[];
	readonly parentSelectionConflict: boolean;
}

export interface EntryDatumSupplies {
	readonly refs: readonly {
		readonly ref: DatumRef;
		readonly scalar: boolean;
	}[];
	readonly searchResults?: { readonly module: Uuid };
	/** At a `case-list` or `search` point: the refs the module's own entries
	 * supply before its selection, which another entry the list runs in
	 * (`module`'s) holds in another place or not at all, so no one datum id
	 * names the chosen case in every entry. */
	readonly differs?: readonly {
		readonly ref: DatumRef;
		readonly module: Uuid;
	}[];
}

const EMPTY_SUPPLIES: EntryDatumSupplies = { refs: [] };
const alignments = new WeakMap<
	BlueprintDoc,
	Map<string, RootSelectionAlignment>
>();
const supplies = new WeakMap<BlueprintDoc, Map<string, EntryDatumSupplies>>();

function entryKey(entry: DatumEntry): string {
	return entry.kind === "form"
		? JSON.stringify([entry.kind, entry.module, entry.form])
		: JSON.stringify([entry.kind, entry.module]);
}

function parentSelectionChain(doc: BlueprintDoc, moduleUuid: Uuid): Uuid[] {
	const reverse: Uuid[] = [];
	const seen = new Set<Uuid>([moduleUuid]);
	let current = moduleUuid;
	while (true) {
		const parent = doc.modules[current]?.parentCaseModuleUuid;
		if (parent === undefined || seen.has(parent)) break;
		seen.add(parent);
		reverse.push(parent);
		current = parent;
	}
	return reverse.reverse();
}

function selectionModules(
	doc: BlueprintDoc,
	entry: DatumEntry,
	prepared?: FormStructure,
): Uuid[] {
	if (doc.modules[entry.module] === undefined) return [];
	if (entry.kind === "form") {
		const form =
			prepared?.formUuid === entry.form ? prepared : doc.forms[entry.form];
		if (form === undefined || !CASE_LOADING_FORM_TYPES.has(form.type))
			return [];
	}
	return [...parentSelectionChain(doc, entry.module), entry.module].filter(
		(uuid) => Boolean(doc.modules[uuid]?.caseType),
	);
}

/** The one domain match used by both admission and wire projection. Computed
 * parent values do not consume a child selection; wire naming and their
 * placement remain with the entry projector. */
export function rootSelectionAlignment(
	doc: BlueprintDoc,
	entry: DatumEntry,
	prepared?: FormStructure,
): RootSelectionAlignment {
	const key = entryKey(entry);
	const cached =
		prepared === undefined ? alignments.get(doc)?.get(key) : undefined;
	if (cached !== undefined) return cached;
	const parentUuid = moduleParent(doc, entry.module);
	const parentForm =
		parentUuid === null || parentUuid === undefined
			? undefined
			: menuFormUuidsOf(doc, parentUuid)[0];
	const parentEntry: DatumEntry | undefined =
		parentUuid === null || parentUuid === undefined
			? undefined
			: parentForm === undefined
				? { kind: "browse", module: parentUuid }
				: { kind: "form", module: parentUuid, form: parentForm };
	const matches: Array<{
		sourceModuleUuid: Uuid;
		targetModuleUuid: Uuid;
	}> = [];
	const boundMismatches: SelectionBoundMismatch[] = [];
	let parentSelectionConflict = false;
	if (parentEntry !== undefined) {
		const remaining = selectionModules(doc, entry, prepared);
		const parentSelections = parentSelectionChain(doc, entry.module);
		for (const sourceModuleUuid of selectionModules(doc, parentEntry)) {
			const targetModuleUuid = remaining[0];
			if (targetModuleUuid === undefined) break;
			const source = doc.modules[sourceModuleUuid];
			const target = doc.modules[targetModuleUuid];
			if (source === undefined || target === undefined) continue;
			if (
				source.caseType === target.caseType &&
				caseSelectionCardinality(source) === "multiple" &&
				caseSelectionCardinality(target) === "multiple" &&
				caseSelectionMaximum(source) > caseSelectionMaximum(target)
			) {
				boundMismatches.push({
					moduleUuid: entry.module,
					sourceModuleUuid,
					targetModuleUuid,
					sourceMaximum: caseSelectionMaximum(source),
					targetMaximum: caseSelectionMaximum(target),
				});
			}
			if (!caseSelectionCanFlowBetweenModules(source, target)) continue;
			remaining.shift();
			matches.push({ sourceModuleUuid, targetModuleUuid });
			if (
				targetModuleUuid !== sourceModuleUuid &&
				parentSelections.includes(targetModuleUuid)
			) {
				parentSelectionConflict = true;
			}
		}
	}
	const result: RootSelectionAlignment = {
		...(parentEntry === undefined ? {} : { parentEntry }),
		matches,
		boundMismatches,
		parentSelectionConflict,
	};
	if (prepared !== undefined) return result;
	let byEntry = alignments.get(doc);
	if (byEntry === undefined) {
		byEntry = new Map();
		alignments.set(doc, byEntry);
	}
	byEntry.set(key, result);
	return result;
}

function suppliedAtEntry(
	doc: BlueprintDoc,
	entry: DatumEntry,
	visiting: ReadonlySet<Uuid>,
	prepared?: FormStructure,
): EntryDatumSupplies {
	const mod = doc.modules[entry.module];
	if (mod === undefined || visiting.has(entry.module)) return EMPTY_SUPPLIES;
	const refs = new Map<string, { ref: DatumRef; scalar: boolean }>();
	const add = (ref: DatumRef, scalar = true): void => {
		refs.set(datumRefKey(ref), { ref, scalar });
	};
	const selected = selectionModules(doc, entry, prepared);
	const alignment = rootSelectionAlignment(doc, entry, prepared);
	for (const module of selected) {
		const scalar = caseSelectionCardinality(doc.modules[module]) === "single";
		add({ kind: "selected-case", module }, scalar);
		const match = alignment.matches.find(
			(pair) => pair.targetModuleUuid === module,
		);
		if (match !== undefined)
			add({ kind: "selected-case", module: match.sourceModuleUuid }, scalar);
	}
	if (alignment.parentEntry !== undefined) {
		const parent = suppliedAtEntry(
			doc,
			alignment.parentEntry,
			new Set([...visiting, entry.module]),
		);
		for (const supplied of parent.refs) {
			if (
				supplied.ref.kind === "worker-record" ||
				supplied.ref.kind === "tile-group-parents"
			)
				add(supplied.ref, supplied.scalar);
		}
	}
	if (entry.kind === "form") {
		const form =
			prepared?.formUuid === entry.form ? prepared : doc.forms[entry.form];
		if (form === undefined) return EMPTY_SUPPLIES;
		const inventory =
			prepared?.formUuid === entry.form
				? deriveCaseWriteInventoryForStructure(doc, prepared, mod)
				: deriveCaseWriteInventory(doc, entry.form, mod, form.type);
		if (form.type === "registration" && mod.caseType !== undefined)
			add({ kind: "new-case" });
		for (const bucket of inventory.buckets) {
			if (bucket.kind === "usercase" && bucket.writers.length > 0)
				add({ kind: "worker-record" });
			if (
				bucket.kind === "child" &&
				bucket.repeatUuid === undefined &&
				caseSelectionCardinality(mod) === "single"
			)
				add({ kind: "new-child-case", caseType: bucket.caseType });
		}
		if (
			selected.includes(entry.module) &&
			mod.caseListConfig?.tile?.grouping !== undefined
		)
			add({ kind: "tile-group-parents", module: entry.module });
	}
	// Queries are inserted after alignment for the original selectable source,
	// never for an alias or an inherited computed value.
	const searched = selected.filter((module) =>
		moduleOpensOnSearch(doc.modules[module]),
	);
	return {
		refs: [...refs.values()],
		...(searched.length === 0
			? {}
			: { searchResults: { module: searched[searched.length - 1] } }),
	};
}

/** A module target contributes its command only. Each ancestor contributes
 * the selections common to every real form entry. Case-loading forms share
 * the same selection chain; a create or survey entry has none, so it ends
 * that common selection prefix. This is the domain half of frame assembly. */
export function formLinkTargetSupplies(
	doc: BlueprintDoc,
	target: FormLinkTarget,
): EntryDatumSupplies {
	const refs = new Map<string, EntryDatumSupplies["refs"][number]>();
	const addSelections = (entry: DatumEntry): void => {
		for (const row of suppliedAtEntry(doc, entry, new Set()).refs) {
			if (row.ref.kind === "selected-case") refs.set(datumRefKey(row.ref), row);
		}
	};
	const ancestors: Uuid[] = [];
	const seen = new Set<Uuid>([target.moduleUuid]);
	let parent = moduleParent(doc, target.moduleUuid);
	while (parent !== undefined && parent !== null && !seen.has(parent)) {
		seen.add(parent);
		ancestors.unshift(parent);
		parent = moduleParent(doc, parent);
	}
	for (const module of ancestors) {
		const forms = menuFormUuidsOf(doc, module);
		if (
			forms.length > 0 &&
			forms.every(
				(uuid) =>
					doc.forms[uuid] !== undefined &&
					CASE_LOADING_FORM_TYPES.has(doc.forms[uuid].type),
			)
		)
			addSelections({ kind: "form", module, form: forms[0] });
	}
	if (
		target.type === "form" &&
		doc.formOrder[target.moduleUuid]?.includes(target.formUuid)
	)
		addSelections({
			kind: "form",
			module: target.moduleUuid,
			form: target.formUuid,
		});
	return { refs: [...refs.values()] };
}

/**
 * One selection an entry makes, in its session's order, with a key that is
 * equal for two selections exactly when they print one datum id. The id half
 * (`lib/commcare/formLinkProjection.ts::selectableDatums`, `::alignWithRootMenu`)
 * spells that id from two facts this key holds without spelling it: the
 * selection's place counted back from the entry's last selection (the
 * `parent_` prefixes, and whether it holds several cases), and the root
 * alignment, under which an aligned selection takes the root datum's id and
 * an unaligned one that collides with a root datum is renamed by its case
 * type. A root datum other than a selection never collides with one.
 */
interface EntrySelection {
	readonly module: Uuid;
	readonly refs: readonly DatumRef[];
	readonly scalar: boolean;
	readonly key: string;
}

function entrySelections(
	doc: BlueprintDoc,
	entry: DatumEntry,
	visiting: ReadonlySet<Uuid> = new Set(),
): readonly EntrySelection[] {
	if (visiting.has(entry.module)) return [];
	const chain = [...parentSelectionChain(doc, entry.module), entry.module];
	const alignment = rootSelectionAlignment(doc, entry);
	const parent =
		alignment.parentEntry === undefined
			? []
			: entrySelections(
					doc,
					alignment.parentEntry,
					new Set([...visiting, entry.module]),
				);
	const parentKeys = new Set(parent.map((row) => row.key));
	return selectionModules(doc, entry).map((module) => {
		const mod = doc.modules[module];
		const scalar = caseSelectionCardinality(mod) === "single";
		const match = alignment.matches.find(
			(pair) => pair.targetModuleUuid === module,
		);
		const refs: DatumRef[] = [{ kind: "selected-case", module }];
		if (match !== undefined && match.sourceModuleUuid !== module)
			refs.push({ kind: "selected-case", module: match.sourceModuleUuid });
		const aligned =
			match === undefined
				? undefined
				: parent.find((row) => row.module === match.sourceModuleUuid);
		const place = chain.length - 1 - chain.indexOf(module);
		const own = JSON.stringify(["chain", place, scalar]);
		const key =
			aligned !== undefined
				? aligned.key
				: parentKeys.has(own)
					? JSON.stringify(["renamed", place, scalar, mod?.caseType ?? ""])
					: own;
		return { module, refs, scalar, key };
	});
}

/** The modules whose entries choose `moduleUuid`'s case before their own:
 * every module whose parent-selection chain passes through it. Their case
 * lists run in entries that hold `moduleUuid`'s choice. */
export function modulesSelectingThrough(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
): readonly Uuid[] {
	return (Object.keys(doc.modules) as Uuid[]).filter(
		(uuid) =>
			uuid !== moduleUuid &&
			parentSelectionChain(doc, uuid).includes(moduleUuid),
	);
}

/** The entry that stands for every entry of `moduleUuid` that selects its
 * case: they share one selection chain and one root alignment, so one is
 * enough. None when the module has neither a case-loading form nor a case
 * list of its own. */
function selectingEntry(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
): DatumEntry | undefined {
	const mod = doc.modules[moduleUuid];
	if (mod?.caseType === undefined) return undefined;
	const form = menuFormUuidsOf(doc, moduleUuid).find((uuid) => {
		const candidate = doc.forms[uuid];
		return (
			candidate !== undefined && CASE_LOADING_FORM_TYPES.has(candidate.type)
		);
	});
	if (form !== undefined) return { kind: "form", module: moduleUuid, form };
	return mod.caseListOnly === true
		? { kind: "browse", module: moduleUuid }
		: undefined;
}

/**
 * The set at a module's case list step (its `case-list` and `search`
 * points): the selections every entry whose session reaches the module's
 * list makes before the module's own selection. Those entries are the
 * module's own entries that select its case and the entries of every module
 * that selects through it as a parent (part 05 §1.3, "One id per slot"). The
 * filter, the detail and the remote request are each one text per module,
 * so a selection one of them supplies at another datum id, or not at all,
 * is in `differs` rather than `refs`.
 */
function caseListStepSupplies(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
): EntryDatumSupplies {
	const reaching = [moduleUuid, ...modulesSelectingThrough(doc, moduleUuid)];
	const befores = reaching.flatMap((module) => {
		const entry = selectingEntry(doc, module);
		if (entry === undefined) return [];
		const selections = entrySelections(doc, entry);
		const own = selections.findIndex((row) => row.module === moduleUuid);
		return own < 0 ? [] : [{ module, rows: selections.slice(0, own) }];
	});
	const [primary, ...others] = befores;
	if (primary === undefined) return EMPTY_SUPPLIES;
	const refs: { ref: DatumRef; scalar: boolean }[] = [];
	const differs: { ref: DatumRef; module: Uuid }[] = [];
	for (const row of primary.rows)
		for (const ref of row.refs) {
			const elsewhere = others.find(
				(other) =>
					!other.rows.some(
						(candidate) =>
							candidate.key === row.key &&
							candidate.refs.some(
								(held) => datumRefKey(held) === datumRefKey(ref),
							),
					),
			);
			if (elsewhere === undefined) refs.push({ ref, scalar: row.scalar });
			else differs.push({ ref, module: elsewhere.module });
		}
	return differs.length === 0 ? { refs } : { refs, differs };
}

/** Domain identities available at the evaluating slot, without session names. */
export function entryDatumSupplies(
	doc: BlueprintDoc,
	point: EntryDatumPoint,
	prepared?: FormStructure,
): EntryDatumSupplies {
	const key = JSON.stringify(point);
	const cached =
		prepared === undefined ? supplies.get(doc)?.get(key) : undefined;
	if (cached !== undefined) return cached;
	let result: EntryDatumSupplies = EMPTY_SUPPLIES;
	if (point.kind === "form") {
		result = suppliedAtEntry(doc, point, new Set(), prepared);
	} else if (point.kind === "form-menu") {
		if (moduleIsCaseFirst(doc, point.module, prepared)) {
			const entry = suppliedAtEntry(
				doc,
				{ ...point, kind: "form" },
				new Set(),
				prepared,
			);
			result = {
				refs: entry.refs.filter(({ ref }) => ref.kind === "selected-case"),
			};
		}
	} else result = caseListStepSupplies(doc, point.module);
	if (prepared !== undefined) return result;
	let byPoint = supplies.get(doc);
	if (byPoint === undefined) {
		byPoint = new Map();
		supplies.set(doc, byPoint);
	}
	byPoint.set(key, result);
	return result;
}
