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
	readonly differs?: readonly DatumRef[];
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
	}
	if (prepared !== undefined) return result;
	// The before-selection record points acquire their across-entry identity
	// proof with the record chosen-case surface; no such read is admitted yet.
	let byPoint = supplies.get(doc);
	if (byPoint === undefined) {
		byPoint = new Map();
		supplies.set(doc, byPoint);
	}
	byPoint.set(key, result);
	return result;
}
