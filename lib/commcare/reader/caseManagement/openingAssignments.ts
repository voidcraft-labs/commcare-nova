import type { BlueprintDoc, FormOpeningAssignment, Uuid } from "@/lib/domain";
import {
	formCaseSelections,
	ownFormSelectionIndex,
} from "@/lib/domain/advancedEntryDatums";
import { authoredCasePropertyNameSchema } from "@/lib/domain/casePropertyName";
import {
	formFieldPath,
	formStructure,
} from "@/lib/domain/expression/formStructure";
import { XML_ELEMENT_NAME_PATTERN } from "@/lib/domain/expression/types";
import { openingAssignmentSource } from "@/lib/domain/formOpeningAssignments";
import { canonicalJsonText } from "@/lib/utils/canonicalJsonText";
import type { HqAppSource } from "../../hq/appSource";
import { withCandidate } from "../candidate";
import type { DraftForm, ReadContext } from "../context";
import { externalKey } from "../identity";
import { isJsonObject } from "../jsonCursor";
import { whereText } from "../place";
import type { DraftField } from "../xform";
import { ancestorSteps } from "./basicActions";
import { conditionQuestionPath } from "./conditions";

/** Another authored use gives a calculated hidden node its own identity.
 * Settle it before an update recognises a generated sibling by its shape. */
export function retainOpeningDestinations(
	ctx: ReadContext,
	form: DraftForm,
): void {
	const xform = form.xform;
	const actions = form.json.peek("actions");
	if (!xform?.candidates.length || !isJsonObject(actions)) return;
	const supplies =
		form.docType === "AdvancedForm"
			? Array.isArray(actions.load_update_cases)
				? actions.load_update_cases
				: []
			: form.json.peek("requires") === "case"
				? [actions.case_preload]
				: [];
	for (const supply of supplies) {
		if (!isJsonObject(supply) || !isJsonObject(supply.preload)) continue;
		for (const path of Object.keys(supply.preload)) {
			const relative = conditionQuestionPath(form, path);
			const node = relative && xform.nodes.get(relative);
			if (node && xform.candidates.includes(node))
				ctx.writeDraft(() => xform.settle(node, "field"));
		}
	}
}

type Source = FormOpeningAssignment["source"] | { kind: "load"; tag: string };
const carrier = (source: Source) =>
	source.kind === "load" ? ["load", source.tag] : [source.kind];
const signature = (source: Source, path: string, property: string) =>
	JSON.stringify([carrier(source), path, property]);

/** Two loads can reach the same question. An old fold remains equivalent
 * only while the whole opening sequence still has the same inputs. A stored
 * baseline holds every source map in canonical key order
 * (`baselineSource.ts::inStoredKeyOrder`), so the stages compare in that
 * order: a change of order alone within one preload map is not observable. */
function nativeOpeningStages(actions: unknown): string {
	if (!isJsonObject(actions)) return "[]";
	const loads = Array.isArray(actions.load_update_cases)
		? actions.load_update_cases
		: [];
	const stages = [
		["own", actions.case_preload],
		["worker", actions.usercase_preload],
		...loads.map((load) => ["load", load]),
	].flatMap(([kind, action]) => {
		if (!isJsonObject(action)) return [];
		// An earlier automatic or indexed load can supply a later load.
		const { update: _update, close_condition: _close, ...settings } = action;
		return [[kind, settings]];
	});
	return canonicalJsonText(stages);
}

/** Only an unchanged, previously held HQ assignment can keep its historical
 * representation as a field default. Compare the original raw action, never
 * infer an adoption change from the input stored by Nova. */
export function knownFormOpenings(doc: BlueprintDoc, baseline: HqAppSource) {
	const stages = new Map<string, string>();
	const original = new Map<string, Set<string>>();
	const attachments = new Map(
		baseline.modules.flatMap((menu) =>
			menu.forms.flatMap((form) =>
				form.xmlns && form.attachment !== null
					? [[form.xmlns, form.attachment] as const]
					: [],
			),
		),
	);
	const assigned = new Map<Uuid, FormOpeningAssignment>();
	const represented = new Set<string>();
	for (const form of Object.values(doc.forms)) {
		if (!form.openingAssignments?.length) continue;
		const choices = formCaseSelections(doc, form.uuid);
		const structure = formStructure(doc, form.uuid);
		if (!structure) continue;
		for (const row of form.openingAssignments ?? []) {
			assigned.set(row.uuid, row);
			const segments = formFieldPath(structure, row.field);
			if (!segments) continue;
			const path = ["", "data", ...segments].join("/");
			const source = openingAssignmentSource(doc, form.uuid, row.source);
			if (source.key === "own" || source.key === "worker-record")
				represented.add(JSON.stringify([form.uuid, [source.key], path]));
			const choice = choices[source.rank];
			if (choice)
				represented.add(
					JSON.stringify([form.uuid, ["load", choice.tag], path]),
				);
		}
	}
	const modules = baseline.raw.modules;
	for (const menu of Array.isArray(modules) ? modules : []) {
		if (!isJsonObject(menu) || !Array.isArray(menu.forms)) continue;
		for (const form of menu.forms) {
			if (
				!isJsonObject(form) ||
				typeof form.xmlns !== "string" ||
				!isJsonObject(form.actions)
			)
				continue;
			stages.set(form.xmlns, nativeOpeningStages(form.actions));
			const keys = new Set<string>();
			const add = (source: Source, action: unknown) => {
				if (!isJsonObject(action) || !isJsonObject(action.preload)) return;
				for (const [path, value] of Object.entries(action.preload))
					if (typeof value === "string")
						keys.add(signature(source, path, value));
			};
			add({ kind: "own" }, form.actions.case_preload);
			for (const load of Array.isArray(form.actions.load_update_cases)
				? form.actions.load_update_cases
				: [])
				if (isJsonObject(load) && typeof load.case_tag === "string")
					add({ kind: "load", tag: load.case_tag }, load);
			original.set(form.xmlns, keys);
		}
	}
	return { original, attachments, assigned, represented, stages };
}

export type KnownFormOpenings = ReturnType<typeof knownFormOpenings>;
interface Pending {
	readonly field: DraftField;
	readonly source: Source;
	readonly property: string;
	readonly indices: readonly string[];
}
const pending = new WeakMap<DraftForm, Pending[]>();
const currentStages = new WeakMap<DraftForm, string>();
export function holdsEarlierDefault(
	ctx: ReadContext,
	form: DraftForm,
	source: Source,
	path: string,
	property: string,
): boolean {
	const earlier = ctx.input.knownOpenings;
	if (!earlier) return false;
	let stages = currentStages.get(form);
	if (stages === undefined) {
		stages = nativeOpeningStages(form.json.peek("actions"));
		currentStages.set(form, stages);
	}
	const attachment =
		ctx.input.source.modules[form.menu]?.forms[form.index]?.attachment;
	// A formerly harmless fold may become observable when an HQ edit adds an
	// earlier reader or changes an initialization dependency elsewhere in the form.
	return (
		attachment != null &&
		earlier.attachments.get(form.xmlns) === attachment &&
		earlier.stages.get(form.xmlns) === stages &&
		earlier.original.get(form.xmlns)?.has(signature(source, path, property)) ===
			true &&
		!earlier.represented.has(JSON.stringify([form.uuid, carrier(source), path]))
	);
}

/** Whether Nova's document can hold a starting value read from `name`
 *  through `indices`: the property in Nova's case-property grammar and each
 *  index step an XML element name. HQ's grammar is wider (any Unicode letter,
 *  a hyphen in an index), and an entry outside Nova's goes on to the reader's
 *  placed refusal on its question rather than into the document. */
export function holdsAsOpeningAssignment(
	indices: readonly string[],
	name: string,
): boolean {
	return (
		authoredCasePropertyNameSchema.safeParse(name).success &&
		indices.every((step) => XML_ELEMENT_NAME_PATTERN.test(step))
	);
}

export function recordLateAssignment(form: DraftForm, row: Pending): void {
	const rows = pending.get(form);
	if (rows) rows.push(row);
	else pending.set(form, [row]);
}

export function settleOpeningAssignments(
	ctx: ReadContext,
	form: DraftForm,
): void {
	const doc = ctx.doc;
	const proposed = pending.get(form);
	if (!doc || !proposed?.length) return;
	const choices = formCaseSelections(doc, form.uuid);
	const index = ownFormSelectionIndex(doc, form.uuid);
	const worker = choices.find(
		(choice) => choice.source.kind === "worker-record",
	);
	const rows: FormOpeningAssignment[] = [];
	for (const entry of proposed) {
		const field = entry.field.uuid;
		if (!field) continue;
		const load = entry.source;
		const selected =
			load.kind === "load"
				? choices.find((choice) => choice.tag === load.tag)
				: undefined;
		let source: FormOpeningAssignment["source"];
		if (load.kind !== "load") source = load;
		else if (selected)
			source =
				selected.uuid === worker?.uuid
					? { kind: "worker-record" }
					: index !== undefined && choices[index]?.uuid === selected.uuid
						? { kind: "own" }
						: { kind: "selection", selection: selected.uuid };
		// The raw load's reader already accounted for the refusal that kept
		// its selection out of the candidate. Preserve that placed finding.
		else continue;
		const key = source.kind === "selection" ? source.selection : source.kind;
		const uuid = ctx.accounting.identity(
			ctx.identities.claim(
				externalKey.openingAssignment(form.uuid, key, field),
				whereText(entry.field.place),
			),
			entry.field.place,
			load.kind === "load"
				? "schema:LoadUpdateAction.preload"
				: "schema:PreloadAction.preload",
		);
		if (!uuid) continue;
		const existing = ctx.input.knownOpenings?.assigned.get(uuid);
		const retained = existing?.via;
		const type = openingAssignmentSource(doc, form.uuid, source).type;
		const matched =
			retained !== undefined &&
			retained.length === entry.indices.length &&
			retained.every((step, i) => step.identifier === entry.indices[i]);
		const fresh =
			type && entry.indices.length
				? ancestorSteps(ctx, type, entry.indices)?.steps
				: undefined;
		const steps = matched
			? retained
			: (fresh ?? entry.indices.map((identifier) => ({ identifier })));
		const [first, ...rest] = steps ?? [];
		const former =
			existing && openingAssignmentSource(doc, form.uuid, existing.source);
		const heldSource =
			existing && former && former.rank >= 0 && former.key === key
				? existing.source
				: source;
		rows.push({
			uuid,
			field,
			source: heldSource,
			property: entry.property,
			...(first && { via: [first, ...rest] }),
		});
	}
	if (rows.length)
		ctx.doc = withCandidate(doc, (draft) => {
			const target = draft.forms[form.uuid];
			target.openingAssignments = rows;
			if (form.docType === "Form") target.heldBasicOpening = true;
		});
}
