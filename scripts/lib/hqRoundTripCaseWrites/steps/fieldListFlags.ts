/**
 * Step 13, `field-list-flags` (part 09 §7.11; part 04 §7.1, class Q4).
 *
 * `main` showed a group's questions on one screen on Android exactly where
 * its label showed in some language of the app. Step 5 stores that choice as
 * the group's `fieldList` flag. The frozen label rule
 * (`frozen/groupLabel.ts`) lifted which groups `main` labelled
 * (`LiftedFacts.labelledGroups`), and `lib/doc/groupFieldLists.ts::
 * planGroupFieldLists` gives the flag to each of them that holds no repeat a
 * worker adds rows to, at any depth. Every other group stays without the key,
 * never `false`, and a section, one screen by its kind, takes nothing.
 *
 * A labelled group left without the flag holds such a repeat, which Android
 * cannot grow on a shared screen: it gets `group-shows-one-per-screen`.
 */

import { descendantFieldUuids, iterForms } from "@/lib/doc/fieldWalk";
import { planGroupFieldLists } from "@/lib/doc/groupFieldLists";
import type { BlueprintDoc } from "@/lib/domain";
import type { MigrationNoticeEntry } from "@/lib/notices/migrationNotice";
import { groupShowsOnePerScreen } from "../notice";
import type { LiftedFacts, PlannedChange } from "../types";
import { applyStepMutations, type StepResult, stoppedStep } from "./apply";

/** Step `field-list-flags` over the document the earlier steps left. */
export function fieldListFlagsStep(
	doc: BlueprintDoc,
	facts: Pick<LiftedFacts, "labelledGroups">,
): StepResult {
	const mutations = planGroupFieldLists(doc, (_doc, groupUuid) =>
		facts.labelledGroups.has(groupUuid),
	);
	const changes: PlannedChange[] = mutations.flatMap((mutation) =>
		mutation.kind === "updateField"
			? [
					{
						step: "field-list-flags",
						kind: "field-list-set",
						entityUuid: mutation.uuid,
						detail: {},
					},
				]
			: [],
	);
	const applied = applyStepMutations(doc, mutations);
	if (!applied.ok) return stoppedStep(doc, [applied.blocker]);
	const target = applied.doc;
	const notice: MigrationNoticeEntry[] = [];
	for (const { formUuid } of iterForms(target)) {
		const form = target.forms[formUuid]?.name ?? "";
		for (const uuid of descendantFieldUuids(target, formUuid)) {
			const field = target.fields[uuid];
			if (field?.kind !== "group" || field.fieldList === true) continue;
			if (!facts.labelledGroups.has(uuid)) continue;
			notice.push(groupShowsOnePerScreen({ uuid, name: field.id }, form));
		}
	}
	return { doc: target, changes, notice, blockers: [] };
}
