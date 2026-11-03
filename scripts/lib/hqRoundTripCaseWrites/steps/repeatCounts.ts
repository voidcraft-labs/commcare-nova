/**
 * Step 12, `repeat-counts` (part 09 §7.10; part 04 §7.1, classes Q2 and Q3).
 *
 * Q2: step 5 refuses a repeat count that is not a whole number, because
 * CommCare reads the count as `Integer.parseInt` of its text and stops the
 * form on anything else. `lib/doc/repeatCountWraps.ts::planRepeatCountWraps`
 * wraps each such count in `int(...)`, which the checker types `int` over
 * every argument, so the wrap meets no refusal of its own; each wrapped
 * repeat gets `repeat-count-whole-number`.
 *
 * Q3: `main` copied every count into a generated `nova_count_<repeat>` node.
 * Step 5 names a Hidden Value calculated as a whole number straight from
 * `jr:count` where nothing reads the count's result
 * (`lib/domain/repeatCount.ts::planRepeatCountCarriers`, over
 * `directRepeatCountReference`), so that node leaves the wire and CommCare
 * HQ's form exports stop filling its column. Nothing in the document
 * changes. In an app with a published deployment each such repeat gets
 * `repeat-count-node-removed`; `removedCountNodes` is also the cause
 * `count-node-removed` that step `deployment-lines` reads.
 *
 * `main` already named an integer question and a single select of whole
 * numbers directly, so only the Hidden Value is a change.
 */

import { lookupTypeIndex } from "@/lib/commcare/validator/lookupTypeContext";
import { descendantFieldUuids, iterForms } from "@/lib/doc/fieldWalk";
import { planRepeatCountWraps } from "@/lib/doc/repeatCountWraps";
import type { BlueprintDoc, Uuid } from "@/lib/domain";
import {
	expressionFacts,
	referencedCountResults,
} from "@/lib/domain/expression/context";
import { formStructure } from "@/lib/domain/expression/formStructure";
import { formOfField } from "@/lib/domain/fieldForm";
import { planRepeatCountCarriers } from "@/lib/domain/repeatCount";
import type { MigrationNoticeEntry } from "@/lib/notices/migrationNotice";
import { repeatCountNodeRemoved, repeatCountWholeNumber } from "../notice";
import type { PlannedChange, StepContext } from "../types";
import { applyStepMutations, type StepResult, stoppedStep } from "./apply";

/** One count repeat whose generated count node leaves the wire. */
export interface RemovedCountNode {
	readonly formUuid: Uuid;
	readonly repeatUuid: Uuid;
	/** The Hidden Value `jr:count` now names. */
	readonly hiddenUuid: Uuid;
}

/** Every count repeat whose count `jr:count` reads straight from a Hidden
 *  Value with no generated carrier, in form order and data-tree order. */
export function removedCountNodes(
	doc: BlueprintDoc,
): readonly RemovedCountNode[] {
	const facts = expressionFacts(doc);
	const removed: RemovedCountNode[] = [];
	for (const { formUuid } of iterForms(doc)) {
		const form = formStructure(doc, formUuid);
		if (form === undefined) continue;
		const carriers = planRepeatCountCarriers(
			form,
			referencedCountResults(doc, formUuid),
			facts,
		);
		for (const uuid of descendantFieldUuids(doc, formUuid)) {
			const field = doc.fields[uuid];
			if (field?.kind !== "repeat" || field.repeat_mode !== "count_bound")
				continue;
			const carrier = carriers.forRepeat(uuid);
			const direct = carrier?.directReference;
			if (carrier === undefined || direct === undefined || carrier.materialized)
				continue;
			if (doc.fields[direct]?.kind !== "hidden") continue;
			removed.push({ formUuid, repeatUuid: uuid, hiddenUuid: direct });
		}
	}
	return removed;
}

/** Step `repeat-counts` over the document the earlier steps left. */
export function repeatCountsStep(
	doc: BlueprintDoc,
	ctx: Pick<StepContext, "lookupContext" | "deployments">,
): StepResult {
	const mutations = planRepeatCountWraps(
		doc,
		lookupTypeIndex(ctx.lookupContext),
	);
	const changes: PlannedChange[] = [];
	const notice: MigrationNoticeEntry[] = [];
	for (const mutation of mutations) {
		if (mutation.kind !== "updateField") continue;
		const repeat = doc.fields[mutation.uuid];
		if (repeat === undefined) continue;
		changes.push({
			step: "repeat-counts",
			kind: "count-wrapped",
			entityUuid: repeat.uuid,
			detail: {},
		});
		const formUuid = formOfField(doc, repeat.uuid);
		notice.push(
			repeatCountWholeNumber(
				{ uuid: repeat.uuid, name: repeat.id },
				formUuid === undefined ? "" : (doc.forms[formUuid]?.name ?? ""),
			),
		);
	}
	const applied = applyStepMutations(doc, mutations);
	if (!applied.ok) return stoppedStep(doc, [applied.blocker]);
	const target = applied.doc;
	if (ctx.deployments.length > 0)
		for (const { formUuid, repeatUuid, hiddenUuid } of removedCountNodes(
			target,
		))
			notice.push(
				repeatCountNodeRemoved(
					{ uuid: repeatUuid, name: target.fields[repeatUuid]?.id ?? "" },
					{
						form: target.forms[formUuid]?.name ?? "",
						hidden: target.fields[hiddenUuid]?.id ?? "",
					},
				),
			);
	return { doc: target, changes, notice, blockers: [] };
}
