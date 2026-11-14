/**
 * A form that closes the cases a menu selects several at once
 * (`targeted-several-case-close`): the close-only block Nova writes for each
 * selected case, `nova_close_selected_cases`, in that case's row of the
 * selected cases, under a close condition and under none
 * (`lib/commcare/xform/caseOps.ts::saveToCaseBlockShape`).
 *
 * A form over several cases reads none of them as its own
 * (`MULTI_SELECT_SHARED_CASE_EXPRESSION`), so a close condition there reads
 * the form's answers alone and holds alike for every selected case. Each
 * outcome is therefore a form of its own, its condition reading a Hidden
 * Value whose value the document fixes:
 *
 * - "Batches" (`m0`) selects several samples:
 *   - "Close finished" (`m0-f0`): its outcome holds `done`, and it closes
 *     where the outcome is `done`, so the condition holds and each selected
 *     sample is closed. Its block stands in the row's condition group,
 *     `nova_condition_close`, whose relevance is the condition (Save to Case
 *     shape `selected-cases/selected-case/operations/condition/block`).
 *   - "Close if finished" (`m0-f1`): its outcome holds `pending` under the
 *     same condition, so the condition does not hold, the condition group
 *     is not relevant in any row, and the submission carries no case block
 *     for any selected sample. CommCare HQ then records no transaction for a
 *     sample the form leaves open and does not move its `modified_on`
 *     (`casexml/apps/case/xform.py::_extract_case_blocks`,
 *     `backends/sql/update_strategy.py::SqlCaseUpdateStrategy.update_from_case_update`,
 *     over `_apply_case_update` and `add_transaction_for_form`), and every
 *     selected sample stays open.
 *   - "Close all" (`m0-f2`): no condition, so each selected sample is closed,
 *     its block directly in the row's operations group (Save to Case shape
 *     `selected-cases/selected-case/operations/block`).
 * - "Samples" (`m1`) selects one sample; "Close sample" (`m1-f0`) closes it
 *   under the same condition over the same outcome, `done`, which Case
 *   Management states, so its close is `close_case` under that condition and
 *   HQ's build writes the block.
 *
 * Each reader shows what CommCare's own code makes of the emission: HQ's
 * build of each state and its form builder's two saves read both shapes; each
 * walk of a several-case form chooses a sample from the list (the lane's case
 * database holds three samples, `proof/observe/casedata.py::CASES_PER_TYPE`)
 * and submits the form, which Formplayer runs and the Web Apps client
 * replays, and HQ's receiver processes: the held condition and "Close all"
 * close the chosen sample, and "Close if finished" leaves it open with no
 * case transaction.
 *
 * Choosing several cases runs in Web Apps alone, so the app declares Web
 * Apps.
 *
 * Fixed values: Core's evaluate seeds no several-case selection, so the
 * value check is the one-sample form's, on HQ's build of the first publish:
 * its outcome holds `done`, the value the held condition of "Close finished"
 * compares.
 */

import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { NEW_APP_SETTINGS, plainColumn, proseText } from "@/lib/domain";
import { caseListOf, targetedDocument, targetedUuid } from "../build";

const ID = "targeted-several-case-close";
const uuid = (name: string) => targetedUuid(ID, name);

/** The condition each conditional close states. */
const CLOSES_WHEN = "#form/outcome = 'done'";

/** A close form whose outcome is a Hidden Value holding `holds`, closing
 *  under `condition` or, with none, every time. */
function closeForm(
	name: string,
	title: string,
	holds: string,
	condition?: string,
) {
	return {
		uuid: uuid(name),
		name: title,
		type: "close" as const,
		...(condition !== undefined && { closeCondition: condition }),
		fields: [
			f({
				kind: "hidden",
				uuid: uuid(`${name}-outcome`),
				id: "outcome",
				calculate: `'${holds}'`,
			}),
		],
	};
}

export function severalCaseClose() {
	const doc = buildDoc({
		appId: ID,
		appName: "Sample batches",
		// Choosing several cases runs in Web Apps alone.
		appSettings: { ...NEW_APP_SETTINGS, runsOnlyOn: "web-apps" },
		caseTypes: [
			{
				name: "sample",
				properties: [{ name: "case_name", label: proseText("Name") }],
			},
		],
		modules: [
			{
				uuid: uuid("batches"),
				name: "Batches",
				caseType: "sample",
				caseListConfig: caseListOf(
					[plainColumn(uuid("batches-name"), "case_name", "Name")],
					{ selection: { kind: "multiple", maximum: 5 } },
				),
				forms: [
					closeForm("close-finished", "Close finished", "done", CLOSES_WHEN),
					closeForm(
						"close-if-finished",
						"Close if finished",
						"pending",
						CLOSES_WHEN,
					),
					closeForm("close-all", "Close all", "done"),
				],
			},
			{
				uuid: uuid("samples"),
				name: "Samples",
				caseType: "sample",
				caseListConfig: caseListOf([
					plainColumn(uuid("samples-name"), "case_name", "Name"),
				]),
				forms: [closeForm("close-sample", "Close sample", "done", CLOSES_WHEN)],
			},
		],
	});
	return targetedDocument({
		id: ID,
		rows: [
			"a form over several selected cases closes each under its close condition, and every one under none",
		],
		doc,
		expected: {
			intent: [
				{
					id: "outcome-held",
					export: "A",
					form: uuid("close-sample"),
					request: {
						session: {
							command: "m1-f0",
							data: { case_id: "targeted-sample" },
						},
						expressions: ["/data/outcome"],
					},
					expect: [{ pointer: "/values/0/value", value: "done" }],
				},
			],
		},
	});
}
