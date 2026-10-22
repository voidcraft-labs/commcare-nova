import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	SESSION_READS,
	sessionIdentityFixture,
} from "@/lib/commcare/__tests__/sessionReadFixture";
import { rebuildFieldParent } from "@/lib/doc/fieldParent";
import { type BlueprintDoc, plainColumn } from "@/lib/domain";
import { count } from "@/lib/domain/expression";
import { caseListOf, targetedDocument, targetedUuid } from "../build";
import type { Expectation } from "../expected";
import { RESTORE_USER_ID, restoreXml } from "../restore";

const ID = "targeted-session-reads";
const uuid = (name: string) => targetedUuid(ID, name);

/**
 * The document with a several-case menu after its others: "Visit batch"
 * chooses visits together, and its form counts them with
 * `count(instance('selected_cases')/results/value)`, the datum id HQ gives a
 * several-case selection (`suite_xml/utils.py::get_select_chain_with_sessions`).
 * Core's evaluate seeds no several-case selection, so no hand-fixed value
 * holds the count; every walk of the document reads it.
 */
function withBatch(doc: BlueprintDoc): BlueprintDoc {
	const module = uuid("batch-module");
	const batch = buildDoc({
		appId: doc.appId,
		modules: [
			{
				uuid: module,
				name: "Visit batch",
				caseType: "visit",
				caseListConfig: caseListOf(
					[plainColumn(uuid("batch-name"), "case_name", "Name")],
					{ selection: { kind: "multiple", maximum: 10 } },
				),
				forms: [
					{
						uuid: uuid("batch-form"),
						name: "Count chosen visits",
						type: "followup",
						fields: [
							f({
								kind: "hidden",
								uuid: uuid("chosen-count"),
								id: "chosen_count",
								calculate: count({ kind: "selected-cases", module }),
							}),
						],
					},
				],
			},
		],
	});
	const merged: BlueprintDoc = {
		...doc,
		modules: { ...doc.modules, ...batch.modules },
		moduleOrder: [...doc.moduleOrder, ...batch.moduleOrder],
		forms: { ...doc.forms, ...batch.forms },
		formOrder: { ...doc.formOrder, ...batch.formOrder },
		fields: { ...doc.fields, ...batch.fields },
		fieldOrder: { ...doc.fieldOrder, ...batch.fieldOrder },
	};
	rebuildFieldParent(merged);
	return merged;
}

/** All five datum kinds and a several-case form's chosen cases, and an edit
 * that changes the selected datum's wire id. */
export function sessionReads() {
	const doc = withBatch(sessionIdentityFixture());
	const edit = withBatch(sessionIdentityFixture(true));
	const intent: Expectation[] = [];
	for (const exportName of ["local", "A", "B"] as const) {
		intent.push({
			id: `selected-and-parent-${exportName}`,
			export: exportName,
			form: SESSION_READS.followup,
			restore: "restore.xml",
			request: {
				session: {
					command: "m1-f0",
					data: {
						case_id: "selected-visit",
						parent_id: "selected-household",
					},
				},
				expressions: ["/data/selected_id", "/data/parent_selected_id"],
			},
			expect: [
				{ pointer: "/values/0/value", value: "selected-visit" },
				{ pointer: "/values/1/value", value: "selected-household" },
			],
		});
		intent.push({
			id: `group-parents-${exportName}`,
			export: exportName,
			form: SESSION_READS.groupedFollowup,
			restore: "restore.xml",
			request: {
				session: {
					command: "m3-f0",
					data: {
						case_id: "selected-visit",
						case_id_parent_ids: "selected-household",
					},
				},
				expressions: ["/data/group_selected_id", "/data/group_parent_ids"],
			},
			expect: [
				{ pointer: "/values/0/value", value: "selected-visit" },
				{ pointer: "/values/1/value", value: "selected-household" },
			],
		});
		intent.push({
			id: `created-and-worker-${exportName}`,
			export: exportName,
			form: SESSION_READS.registration,
			restore: "restore.xml",
			request: {
				session: {
					command: "m1-f1",
					data: {
						case_id_new_visit_0: "created-visit",
						case_id_new_note_1: "created-note",
						usercase_id: "worker-record",
					},
				},
				expressions: [
					"/data/new_id",
					"/data/child_id",
					"/data/worker_id",
					"/data/new_id = /data/case/@case_id",
					"/data/child_id = /data/subcase_0/case/@case_id",
					"/data/worker_id = /data/commcare_usercase/case/@case_id",
				],
			},
			expect: [
				{ pointer: "/values/0/value", value: "created-visit" },
				{ pointer: "/values/1/value", value: "created-note" },
				{ pointer: "/values/2/value", value: "worker-record" },
				...[0, 1, 2].flatMap((index) => [
					{ pointer: `/values/${index}/type`, value: "nodeset" },
					{ pointer: `/values/${index}/size`, value: 1 },
				]),
				// Evaluate.describe reports scalar text beside its actual Core type.
				...[3, 4, 5].flatMap((index) => [
					{ pointer: `/values/${index}/type`, value: "boolean" },
					{ pointer: `/values/${index}/value`, value: "true" },
				]),
			],
		});
	}
	return targetedDocument({
		id: ID,
		rows: [
			"session-datum-identity",
			"session-datum-parent-menu-edit",
			"selected-cases-read",
		],
		doc,
		edit,
		expected: { intent },
		files: {
			"restore.xml": restoreXml({
				cases: [
					{ id: "selected-household", type: "household", name: "Household" },
					{ id: "selected-visit", type: "visit", name: "Visit" },
					{
						id: "worker-record",
						type: "commcare-user",
						name: "Worker",
						properties: { hq_user_id: RESTORE_USER_ID },
					},
				],
			}),
		},
	});
}
