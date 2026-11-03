/**
 * Step 9, `explicit-preloads` (part 09 §7.7; part 01 §11 and §22, class C7).
 *
 * `main` loaded each own-case writer of a one-case follow-up or close form
 * from the case when the form opened, by rule, after every starting value
 * had run. Step 5 states that load as the writer's starting value, the
 * `form-case` read of the property it saves, at the question's own place
 * among the starting values. The frozen preload rule
 * (`frozen/casePreload.ts`) lifted which writers `main` loaded, per form
 * (`LiftedFacts.preloadedWriters`); `lib/doc/explicitPreloads.ts::
 * planExplicitPreloads` writes each one's starting value, replacing any it
 * held.
 *
 * Two lines follow. A writer whose starting value was replaced gets
 * `starting-value-reads-case`. A later question whose starting value, or a
 * later query repeat whose ids query, reads a loaded writer gets
 * `load-time-value-reads-case`: it ran before the case's value replaced the
 * writer's, and now runs after it.
 */

import { planExplicitPreloads } from "@/lib/doc/explicitPreloads";
import { descendantFieldUuids, iterForms } from "@/lib/doc/fieldWalk";
import type { Mutation } from "@/lib/doc/types";
import type { BlueprintDoc, Expression, Field, Uuid } from "@/lib/domain";
import {
	type ExpressionNode,
	expressionChildren,
} from "@/lib/domain/expression/children";
import type { MigrationNoticeEntry } from "@/lib/notices/migrationNotice";
import { loadTimeValueReadsCase, startingValueReadsCase } from "../notice";
import type { LiftedFacts, PlannedChange } from "../types";
import { applyStepMutations, type StepResult, stoppedStep } from "./apply";

/** Whether `node`, at any depth, holds a `field` term naming one of `uuids`,
 *  walked over the expression's own child edges. */
function readsAnyField(
	node: ExpressionNode,
	uuids: ReadonlySet<Uuid>,
): boolean {
	if (node.kind === "field" && uuids.has(node.uuid)) return true;
	for (const child of expressionChildren(node)) {
		if (child.kind === "relation") continue;
		if (readsAnyField(child.value, uuids)) return true;
	}
	return false;
}

/** The expressions of `field` that run when the form opens: its starting
 *  value, and a query repeat's ids query. */
function loadTimeExpressions(field: Field): readonly Expression[] {
	const expressions: Expression[] = [];
	if ("default_value" in field && field.default_value !== undefined)
		expressions.push(field.default_value);
	if (field.kind === "repeat" && field.repeat_mode === "query_bound")
		expressions.push(field.data_source.ids_query);
	return expressions;
}

/** One later load-time reader of a loaded writer. */
export interface LaterLoadTimeReader {
	/** The field whose starting value or ids query reads the writer. */
	readonly readerUuid: Uuid;
	/** The first loaded writer, in data-tree order, it reads. */
	readonly writerUuid: Uuid;
}

/**
 * Every field of `formUuid` whose starting value or (for a query repeat)
 * ids query reads one of `writers` that comes earlier in data-tree order,
 * each once, in data-tree order. A writer reading itself is not a later
 * reader. Reads are found by walking each expression's child edges
 * (`expressionChildren`) for a `field` term, never by reading text.
 */
export function laterLoadTimeReaders(
	doc: BlueprintDoc,
	formUuid: Uuid,
	writers: readonly Uuid[],
): readonly LaterLoadTimeReader[] {
	const listed = new Set(writers);
	const passed: Uuid[] = [];
	const readers: LaterLoadTimeReader[] = [];
	for (const uuid of descendantFieldUuids(doc, formUuid)) {
		const field = doc.fields[uuid];
		if (field === undefined) continue;
		const expressions = loadTimeExpressions(field);
		const writer = passed.find((candidate) => {
			const reads = new Set([candidate]);
			return expressions.some((expression) => readsAnyField(expression, reads));
		});
		if (writer !== undefined)
			readers.push({ readerUuid: uuid, writerUuid: writer });
		if (listed.has(uuid)) passed.push(uuid);
	}
	return readers;
}

/** The property a planned starting value reads. */
function preloadProperty(mutation: Mutation): string | undefined {
	if (mutation.kind !== "updateField") return undefined;
	const preload = (mutation.patch as { default_value?: Expression })
		.default_value;
	return preload?.kind === "term" && preload.term.kind === "form-case"
		? preload.term.property
		: undefined;
}

/** Step `explicit-preloads` over the document the earlier steps left. */
export function explicitPreloadsStep(
	doc: BlueprintDoc,
	facts: Pick<LiftedFacts, "preloadedWriters">,
): StepResult {
	const mutations: Mutation[] = [];
	const changes: PlannedChange[] = [];
	const replaced: { field: Field; form: string; property: string }[] = [];
	const readersByForm: { formUuid: Uuid; writers: readonly Uuid[] }[] = [];
	for (const { formUuid } of iterForms(doc)) {
		const writers = facts.preloadedWriters.get(formUuid) ?? [];
		if (writers.length === 0) continue;
		readersByForm.push({ formUuid, writers });
		const form = doc.forms[formUuid]?.name ?? "";
		for (const mutation of planExplicitPreloads(doc, formUuid, writers)) {
			if (mutation.kind !== "updateField") continue;
			mutations.push(mutation);
			const field = doc.fields[mutation.uuid];
			const property = preloadProperty(mutation);
			if (field === undefined || property === undefined) continue;
			const hadStartingValue =
				"default_value" in field && field.default_value !== undefined;
			changes.push({
				step: "explicit-preloads",
				kind: "starting-value-written",
				entityUuid: field.uuid,
				detail: { replaced: hadStartingValue ? 1 : 0 },
			});
			if (hadStartingValue) replaced.push({ field, form, property });
		}
	}
	const applied = applyStepMutations(doc, mutations);
	if (!applied.ok) return stoppedStep(doc, [applied.blocker]);
	const target = applied.doc;
	const notice: MigrationNoticeEntry[] = replaced.map(
		({ field, form, property }) =>
			startingValueReadsCase(
				{ uuid: field.uuid, name: field.id },
				{ form, property },
			),
	);
	for (const { formUuid, writers } of readersByForm) {
		const form = target.forms[formUuid]?.name ?? "";
		for (const { readerUuid, writerUuid } of laterLoadTimeReaders(
			target,
			formUuid,
			writers,
		)) {
			const reader = target.fields[readerUuid];
			const writer = target.fields[writerUuid];
			if (reader === undefined || writer === undefined) continue;
			notice.push(
				loadTimeValueReadsCase(
					{ uuid: reader.uuid, name: reader.id },
					{ form, reads: writer.id },
				),
			);
		}
	}
	return { doc: target, changes, notice, blockers: [] };
}
