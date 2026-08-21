// lib/doc/formSectionMutations.ts
//
// The batch-building planners for a form's sections: how "split here",
// "add a section", "merge with the previous one", "remove this section",
// "move this section", and the SA's desired-state `set_form_sections`
// become one gated batch of ordinary `addField` / `moveField` /
// `removeField` / `updateField` mutations that the builder, the SA, and the
// MCP surface dispatch identically.
//
// Three rules every planner keeps:
//
//   - **One partition, one core.** Every gesture is "here is the desired
//     partition of the form's top-level questions into pages"; each planner
//     derives that partition from the current document and hands it to
//     `planPartition`, which emits the minimal batch reaching it. A
//     sectioned form is a closed state (`FORM_SECTIONS_INCOMPLETE` refuses
//     every half-way shape), so the batch commits atomically and the gate
//     never meets the intermediate states.
//
//   - **Re-anchoring.** A moved field names `after` as its predecessor IN
//     THE LANDING SEQUENCE (the field placed before it by this batch, or
//     `null` for the first), never a stale source neighbour, so the batch
//     replays to the same document and a concurrent peer removal degrades
//     to an append rather than a throw.
//
//   - **A rejected plan commits nothing.** Every refusal is a sentence in
//     Nova's voice naming what and what to do next; the SA tools return it
//     verbatim, the builder shows it. The placement sentences themselves
//     live in `formSectionVerdicts.ts`, so the three editors say one thing.

import {
	asUuid,
	type BlueprintDoc,
	type Field,
	fieldRegistry,
	type ProseTemplate,
	proseTemplateText,
	slugifyId,
	type Uuid,
} from "@/lib/domain";
import { deepEqual } from "./deepEqual";
import { orderedFieldUuids } from "./fieldWalk";
import {
	FIELD_PLACEMENT_MESSAGES,
	formIsSectioned,
	formOfField,
	formSectionsOf,
	subtreeHasUserRepeat,
} from "./formSectionVerdicts";
import { fieldIdVerdict } from "./identifierVerdicts";
import type { Mutation } from "./types";

export type FormSectionPlan =
	| {
			readonly ok: true;
			readonly mutations: Mutation[];
			/** The form's root sections AFTER the batch, in page order. */
			readonly sectionUuids: readonly Uuid[];
	  }
	| { readonly ok: false; readonly reason: string };

/** One page of a desired partition. */
export interface DesiredSection {
	/** An existing root section to keep (its identity survives), or a new
	 *  uuid to create the page under. Absent mints one. */
	readonly sectionUuid?: Uuid;
	/** The title. `null` = untitled. Omitted = keep a kept section's current
	 *  title, untitled for a new one. */
	readonly label?: ProseTemplate | null;
	/** The page's top-level questions, in order: root fields, or direct
	 *  children of a current section. A group or repeat moves with
	 *  everything inside it. */
	readonly fields: readonly Uuid[];
}

function fail(reason: string): FormSectionPlan {
	return { ok: false, reason };
}

function quoteId(doc: BlueprintDoc, uuid: Uuid): string {
	const field = doc.fields[uuid];
	return field === undefined ? uuid : `"${field.id}"`;
}

/** "Section 2" or its title, for a refusal. */
function pageName(
	doc: BlueprintDoc,
	section: DesiredSection,
	index: number,
): string {
	const existing =
		section.sectionUuid === undefined
			? undefined
			: doc.fields[section.sectionUuid];
	const label =
		section.label === undefined
			? existing?.kind === "section"
				? existing.label
				: undefined
			: section.label;
	const text = label ? proseTemplateText(label).trim() : "";
	return text.length > 0 ? `"${text}"` : `section ${index + 1}`;
}

/**
 * The current partition: every root section with its children, in order,
 * each keeping its identity and title. The starting point every gesture
 * edits.
 */
export function currentPartition(
	doc: BlueprintDoc,
	formUuid: Uuid,
): DesiredSection[] {
	return formSectionsOf(doc, formUuid).map((sectionUuid) => ({
		sectionUuid,
		fields: orderedFieldUuids(doc, sectionUuid),
	}));
}

/** The form and position of a root section, or a refusal. */
function sectionContext(
	doc: BlueprintDoc,
	sectionUuid: Uuid,
):
	| { ok: true; formUuid: Uuid; index: number; sections: readonly Uuid[] }
	| { ok: false; reason: string } {
	const field = doc.fields[sectionUuid];
	if (field?.kind !== "section") {
		return { ok: false, reason: `${sectionUuid} isn't a section.` };
	}
	const formUuid = doc.fieldParent[sectionUuid];
	if (formUuid === undefined || doc.forms[formUuid] === undefined) {
		return {
			ok: false,
			reason: `Section "${field.id}" isn't at its form's top level, so it can't be re-paged from here.`,
		};
	}
	const sections = formSectionsOf(doc, formUuid);
	const index = sections.indexOf(sectionUuid);
	if (index === -1)
		return { ok: false, reason: `${sectionUuid} isn't a section.` };
	return { ok: true, formUuid, index, sections };
}

/**
 * A root-unique, XML-legal id for a new section: the title's slug when it
 * has one and it is legal, else `section_<n>`, suffixed until free among
 * the form's current root siblings and the ids this batch already claimed.
 */
function mintSectionId(
	doc: BlueprintDoc,
	formUuid: Uuid,
	title: ProseTemplate | null | undefined,
	index: number,
	pending: Set<string>,
): string {
	const fallback = `section_${index + 1}`;
	let base = title ? slugifyId(proseTemplateText(title), fallback) : fallback;
	let candidate = base;
	let n = 2;
	for (;;) {
		const verdict = fieldIdVerdict({
			doc,
			parentUuid: formUuid,
			proposedId: candidate,
			pendingSiblingIds: pending,
		});
		if (verdict.ok) break;
		if (candidate === base && base !== fallback) {
			// The slug itself is not a legal id (a leading digit, the reserved
			// prefix): fall back to the numbered name before suffixing.
			base = fallback;
			candidate = fallback;
			continue;
		}
		candidate = `${base}_${n++}`;
	}
	pending.add(candidate);
	return candidate;
}

/**
 * A small model of the sequences the batch edits, so a move that would
 * leave a field exactly where it already is emits nothing — a title
 * change on a forty-question form is one mutation, not forty-one.
 */
class SequenceModel {
	private readonly orders = new Map<Uuid, Uuid[]>();
	private readonly parents = new Map<Uuid, Uuid>();

	constructor(doc: BlueprintDoc, parents: readonly Uuid[]) {
		for (const parent of parents) {
			const order = [...orderedFieldUuids(doc, parent)];
			this.orders.set(parent, order);
			for (const uuid of order) this.parents.set(uuid, parent);
		}
	}

	/** Whether `uuid` already follows `after` (or leads, for `null`) under `parent`. */
	inPlace(uuid: Uuid, parent: Uuid, after: Uuid | null): boolean {
		if (this.parents.get(uuid) !== parent) return false;
		const order = this.orders.get(parent) ?? [];
		const index = order.indexOf(uuid);
		if (index === -1) return false;
		return after === null ? index === 0 : order[index - 1] === after;
	}

	place(uuid: Uuid, parent: Uuid, after: Uuid | null): void {
		const from = this.parents.get(uuid);
		if (from !== undefined) {
			const source = this.orders.get(from) ?? [];
			const at = source.indexOf(uuid);
			if (at !== -1) source.splice(at, 1);
		}
		const target = this.orders.get(parent) ?? [];
		const anchor = after === null ? -1 : target.indexOf(after);
		target.splice(anchor + 1, 0, uuid);
		this.orders.set(parent, target);
		this.parents.set(uuid, parent);
	}

	declare_(parent: Uuid): void {
		if (!this.orders.has(parent)) this.orders.set(parent, []);
	}
}

/**
 * The core: the minimal batch that turns the form's current top-level
 * questions into the desired partition, or a refusal. An empty `desired`
 * returns the form to a single page (every section's questions back to the
 * root, in document order; the sections removed).
 */
function planPartition(
	doc: BlueprintDoc,
	formUuid: Uuid,
	desired: readonly DesiredSection[],
): FormSectionPlan {
	const form = doc.forms[formUuid];
	if (form === undefined) return fail(`${formUuid} isn't a form.`);
	const formName = `"${form.name}"`;
	const root = orderedFieldUuids(doc, formUuid);
	const currentSections = formSectionsOf(doc, formUuid);

	// The form's top-level questions, in document order, and where each sits.
	const questions: Uuid[] = [];
	const questionParent = new Map<Uuid, Uuid>();
	for (const uuid of root) {
		if (doc.fields[uuid]?.kind === "section") {
			for (const child of orderedFieldUuids(doc, uuid)) {
				questions.push(child);
				questionParent.set(child, uuid);
			}
		} else {
			questions.push(uuid);
			questionParent.set(uuid, formUuid);
		}
	}

	// ── Validate the partition ──────────────────────────────────────
	const seenField = new Map<Uuid, number>();
	const seenSection = new Set<Uuid>();
	for (const [i, section] of desired.entries()) {
		const name = pageName(doc, section, i);
		if (section.sectionUuid !== undefined) {
			if (seenSection.has(section.sectionUuid)) {
				return fail(`Section ${section.sectionUuid} is listed twice.`);
			}
			seenSection.add(section.sectionUuid);
			if (
				doc.fields[section.sectionUuid] !== undefined &&
				!currentSections.includes(section.sectionUuid)
			) {
				return fail(`${section.sectionUuid} isn't a section of ${formName}.`);
			}
		}
		for (const uuid of section.fields) {
			const parent = questionParent.get(uuid);
			if (parent === undefined) {
				const field = doc.fields[uuid];
				if (field?.kind === "section" && currentSections.includes(uuid)) {
					return fail(
						`Section ${name} names ${uuid}, which is a section of ${formName}, not a question. Name the questions inside it instead.`,
					);
				}
				if (field !== undefined && formOfField(doc, uuid) === formUuid) {
					const holder = doc.fieldParent[uuid];
					const container =
						holder === undefined ? undefined : doc.fields[holder];
					const holderPhrase =
						container === undefined
							? "a container"
							: `the ${fieldRegistry[container.kind].label.toLowerCase()} "${container.id}"`;
					return fail(
						`Section ${name} names ${quoteId(doc, uuid)} (${uuid}), which sits inside ${holderPhrase} and moves with it. Name the ${container === undefined ? "container" : fieldRegistry[container.kind].label.toLowerCase()} instead.`,
					);
				}
				return fail(
					`Section ${name} names ${uuid}, which isn't a question of ${formName}. Read the form again and use its current question uuids.`,
				);
			}
			const earlier = seenField.get(uuid);
			if (earlier !== undefined) {
				const first = desired[earlier];
				const firstName =
					first === undefined
						? `section ${earlier + 1}`
						: pageName(doc, first, earlier);
				return fail(
					`Question ${quoteId(doc, uuid)} (${uuid}) appears in two sections (${firstName} and ${name}). A question belongs to one page.`,
				);
			}
			seenField.set(uuid, i);
			if (subtreeHasUserRepeat(doc, uuid)) {
				return fail(FIELD_PLACEMENT_MESSAGES["user-repeat-in-section"]);
			}
		}
	}
	if (desired.length > 0) {
		const missing = questions.filter((uuid) => !seenField.has(uuid));
		if (missing.length > 0) {
			const n = missing.length;
			const ids = missing
				.map((uuid) => `${quoteId(doc, uuid)} (${uuid})`)
				.join(", ");
			return fail(
				`Every top-level question needs a page. ${n === 1 ? "This one isn't" : `These ${n} aren't`} in any section: ${ids}. Add ${n === 1 ? "it" : "them"} to a section, or pass an empty list of sections to go back to a single page.`,
			);
		}
	}

	// ── Emit ────────────────────────────────────────────────────────
	const mutations: Mutation[] = [];
	const model = new SequenceModel(doc, [formUuid, ...currentSections]);

	if (desired.length === 0) {
		let prev: Uuid | null = null;
		for (const uuid of root) {
			if (doc.fields[uuid]?.kind === "section") {
				for (const child of orderedFieldUuids(doc, uuid)) {
					if (!model.inPlace(child, formUuid, prev)) {
						mutations.push({
							kind: "moveField",
							uuid: child,
							toParentUuid: formUuid,
							after: prev,
						});
						model.place(child, formUuid, prev);
					}
					prev = child;
				}
			} else {
				if (!model.inPlace(uuid, formUuid, prev)) {
					mutations.push({
						kind: "moveField",
						uuid,
						toParentUuid: formUuid,
						after: prev,
					});
					model.place(uuid, formUuid, prev);
				}
				prev = uuid;
			}
		}
		for (const sectionUuid of currentSections) {
			mutations.push({ kind: "removeField", uuid: sectionUuid });
		}
		return { ok: true, mutations, sectionUuids: [] };
	}

	const pendingIds = new Set<string>();
	const pages: {
		readonly sectionUuid: Uuid;
		readonly fields: readonly Uuid[];
	}[] = [];
	let prevSection: Uuid | null = null;
	for (const [i, section] of desired.entries()) {
		const keep =
			section.sectionUuid !== undefined &&
			currentSections.includes(section.sectionUuid);
		const uuid = section.sectionUuid ?? asUuid(crypto.randomUUID());
		if (keep) {
			if (!model.inPlace(uuid, formUuid, prevSection)) {
				mutations.push({
					kind: "moveField",
					uuid,
					toParentUuid: formUuid,
					after: prevSection,
				});
				model.place(uuid, formUuid, prevSection);
			}
			const existing = doc.fields[uuid];
			if (
				section.label !== undefined &&
				existing?.kind === "section" &&
				!deepEqual(existing.label ?? null, section.label)
			) {
				mutations.push({
					kind: "updateField",
					uuid,
					targetKind: "section",
					patch: { label: section.label },
				});
			}
		} else {
			const id = mintSectionId(doc, formUuid, section.label, i, pendingIds);
			const field: Field = {
				uuid,
				kind: "section",
				id,
				...(section.label ? { label: section.label } : {}),
			};
			mutations.push({
				kind: "addField",
				parentUuid: formUuid,
				field,
				after: prevSection,
			});
			model.declare_(uuid);
			model.place(uuid, formUuid, prevSection);
		}
		pages.push({ sectionUuid: uuid, fields: section.fields });
		prevSection = uuid;
	}
	const finals = pages.map((page) => page.sectionUuid);

	for (const { sectionUuid, fields } of pages) {
		let prev: Uuid | null = null;
		for (const uuid of fields) {
			if (!model.inPlace(uuid, sectionUuid, prev)) {
				mutations.push({
					kind: "moveField",
					uuid,
					toParentUuid: sectionUuid,
					after: prev,
				});
				model.place(uuid, sectionUuid, prev);
			}
			prev = uuid;
		}
	}

	for (const sectionUuid of currentSections) {
		if (!finals.includes(sectionUuid)) {
			mutations.push({ kind: "removeField", uuid: sectionUuid });
		}
	}

	return { ok: true, mutations, sectionUuids: finals };
}

// ── Public planners ────────────────────────────────────────────────

/**
 * Split a single-page form into sections. With `atFieldUuid` (a top-level
 * field), the questions before it become page one and it and everything
 * after become page two; without one (or at the first field) one section
 * takes every question. An empty form gets one empty section.
 */
export function splitIntoSections(
	doc: BlueprintDoc,
	formUuid: Uuid,
	opts: {
		readonly atFieldUuid?: Uuid;
		readonly titles?: readonly [ProseTemplate?, ProseTemplate?];
		readonly sectionUuids?: readonly [Uuid?, Uuid?];
	} = {},
): FormSectionPlan {
	const form = doc.forms[formUuid];
	if (form === undefined) return fail(`${formUuid} isn't a form.`);
	if (formIsSectioned(doc, formUuid)) {
		return fail(
			`"${form.name}" is already split into sections. Split one of its sections instead.`,
		);
	}
	const root = orderedFieldUuids(doc, formUuid);
	let cut = 0;
	if (opts.atFieldUuid !== undefined) {
		cut = root.indexOf(opts.atFieldUuid);
		if (cut === -1) {
			return fail(
				`${opts.atFieldUuid} isn't a top-level field of "${form.name}", so the form can't be split there.`,
			);
		}
	}
	const first: DesiredSection = {
		sectionUuid: opts.sectionUuids?.[0],
		label: opts.titles?.[0] ?? null,
		fields: cut <= 0 || cut >= root.length ? root : root.slice(0, cut),
	};
	const desired: DesiredSection[] =
		cut <= 0 || cut >= root.length
			? [first]
			: [
					first,
					{
						sectionUuid: opts.sectionUuids?.[1],
						label: opts.titles?.[1] ?? null,
						fields: root.slice(cut),
					},
				];
	return planPartition(doc, formUuid, desired);
}

/**
 * Split a section before `atFieldUuid` (one of its direct children): it and
 * every later sibling move to a new section placed right after this one.
 */
export function splitSection(
	doc: BlueprintDoc,
	sectionUuid: Uuid,
	atFieldUuid: Uuid,
	opts: { readonly title?: ProseTemplate; readonly sectionUuid?: Uuid } = {},
): FormSectionPlan {
	const ctx = sectionContext(doc, sectionUuid);
	if (!ctx.ok) return fail(ctx.reason);
	const parts = currentPartition(doc, ctx.formUuid);
	const here = parts[ctx.index] as DesiredSection;
	const cut = here.fields.indexOf(atFieldUuid);
	if (cut === -1) {
		return fail(
			`${atFieldUuid} isn't a top-level question of this section, so the section can't be split there.`,
		);
	}
	const before: DesiredSection = { ...here, fields: here.fields.slice(0, cut) };
	const after: DesiredSection = {
		sectionUuid: opts.sectionUuid,
		label: opts.title ?? null,
		fields: here.fields.slice(cut),
	};
	parts.splice(ctx.index, 1, before, after);
	return planPartition(doc, ctx.formUuid, parts);
}

/**
 * Add an empty section to a sectioned (or empty) form: after the named
 * section, first for `null`, last when unspecified.
 */
export function addSection(
	doc: BlueprintDoc,
	formUuid: Uuid,
	opts: {
		readonly after?: Uuid | null;
		readonly title?: ProseTemplate;
		readonly sectionUuid?: Uuid;
	} = {},
): FormSectionPlan {
	const form = doc.forms[formUuid];
	if (form === undefined) return fail(`${formUuid} isn't a form.`);
	const parts = currentPartition(doc, formUuid);
	if (parts.length === 0 && orderedFieldUuids(doc, formUuid).length > 0) {
		return fail(
			`"${form.name}" isn't split into sections yet. Split it into sections first, and a new section has somewhere to go.`,
		);
	}
	let at = parts.length;
	if (opts.after === null) {
		at = 0;
	} else if (opts.after !== undefined) {
		const index = parts.findIndex((p) => p.sectionUuid === opts.after);
		if (index === -1) {
			return fail(`${opts.after} isn't a section of "${form.name}".`);
		}
		at = index + 1;
	}
	parts.splice(at, 0, {
		sectionUuid: opts.sectionUuid,
		label: opts.title ?? null,
		fields: [],
	});
	return planPartition(doc, formUuid, parts);
}

/** Fold a section into the one before it: its questions go to the end of
 *  the previous page, and the section goes away. */
export function mergeWithPrevious(
	doc: BlueprintDoc,
	sectionUuid: Uuid,
): FormSectionPlan {
	const ctx = sectionContext(doc, sectionUuid);
	if (!ctx.ok) return fail(ctx.reason);
	if (ctx.index === 0) {
		return fail(
			"This is the first section, so there's nothing before it to merge with.",
		);
	}
	const parts = currentPartition(doc, ctx.formUuid);
	const prev = parts[ctx.index - 1] as DesiredSection;
	const here = parts[ctx.index] as DesiredSection;
	parts.splice(ctx.index - 1, 2, {
		...prev,
		fields: [...prev.fields, ...here.fields],
	});
	return planPartition(doc, ctx.formUuid, parts);
}

/**
 * Remove a section but keep its questions: they join the end of the
 * previous page (or the start of the next, for the first section). Removing
 * the LAST remaining section returns the form to a single page.
 */
export function removeSectionKeepingQuestions(
	doc: BlueprintDoc,
	sectionUuid: Uuid,
): FormSectionPlan {
	const ctx = sectionContext(doc, sectionUuid);
	if (!ctx.ok) return fail(ctx.reason);
	const parts = currentPartition(doc, ctx.formUuid);
	if (parts.length === 1) return planPartition(doc, ctx.formUuid, []);
	const here = parts[ctx.index] as DesiredSection;
	if (ctx.index === 0) {
		const next = parts[1] as DesiredSection;
		parts.splice(0, 2, { ...next, fields: [...here.fields, ...next.fields] });
	} else {
		const prev = parts[ctx.index - 1] as DesiredSection;
		parts.splice(ctx.index - 1, 2, {
			...prev,
			fields: [...prev.fields, ...here.fields],
		});
	}
	return planPartition(doc, ctx.formUuid, parts);
}

/** Remove a section and everything on it. The caller confirms first. */
export function removeSectionWithQuestions(
	doc: BlueprintDoc,
	sectionUuid: Uuid,
): FormSectionPlan {
	const ctx = sectionContext(doc, sectionUuid);
	if (!ctx.ok) return fail(ctx.reason);
	return {
		ok: true,
		mutations: [{ kind: "removeField", uuid: sectionUuid }],
		sectionUuids: ctx.sections.filter((uuid) => uuid !== sectionUuid),
	};
}

/** Reorder a section among its siblings: after `after`, or first for `null`. */
export function moveSection(
	doc: BlueprintDoc,
	sectionUuid: Uuid,
	after: Uuid | null,
): FormSectionPlan {
	const ctx = sectionContext(doc, sectionUuid);
	if (!ctx.ok) return fail(ctx.reason);
	if (after === sectionUuid) {
		return fail("A section can't be placed after itself.");
	}
	if (after !== null && !ctx.sections.includes(after)) {
		return fail(`${after} isn't a section of this form.`);
	}
	const parts = currentPartition(doc, ctx.formUuid);
	const [here] = parts.splice(ctx.index, 1) as [DesiredSection];
	const at =
		after === null ? 0 : parts.findIndex((p) => p.sectionUuid === after) + 1;
	parts.splice(at, 0, here);
	return planPartition(doc, ctx.formUuid, parts);
}

/**
 * The desired-state planner behind `set_form_sections`: the complete
 * partition of the form's top-level questions into pages, first page first.
 * Kept sections are named by `sectionUuid`; unnamed ones are created;
 * current sections left out are removed once their questions have moved.
 * An empty list returns the form to a single page.
 */
export function setFormSections(
	doc: BlueprintDoc,
	formUuid: Uuid,
	desired: readonly DesiredSection[],
): FormSectionPlan {
	return planPartition(doc, formUuid, desired);
}
