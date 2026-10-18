import {
	SESSION_READS,
	sessionReadFixture,
} from "@/lib/commcare/__tests__/sessionReadFixture";
import { targetedDocument } from "../build";
import type { Expectation } from "../expected";
import { RESTORE_USER_ID, restoreXml } from "../restore";

/** All five datum kinds, and an edit that changes the selected datum's wire id. */
export function sessionReads() {
	const doc = sessionReadFixture();
	const edit = sessionReadFixture(true);
	const intent: Expectation[] = [];
	for (const exportName of ["local", "A", "B"] as const) {
		intent.push({
			id: `selected-and-group-${exportName}`,
			export: exportName,
			form: SESSION_READS.followup,
			restore: "restore.xml",
			request: {
				session: {
					command: "m1-f0",
					data: {
						case_id: "selected-visit",
						case_id_parent_ids: "selected-household",
					},
				},
				expressions: ["/data/selected_id", "/data/group_parent_ids"],
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
				{ pointer: "/values/3/value", value: true },
				{ pointer: "/values/4/value", value: true },
				{ pointer: "/values/5/value", value: true },
			],
		});
	}
	return targetedDocument({
		id: "targeted-session-reads",
		rows: ["session-datum-identity", "session-datum-parent-menu-edit"],
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
