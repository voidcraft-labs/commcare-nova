/** A worker's personal record and the owner of each restored case. The three
 * restores distinguish membership from ownership and the signed-in worker
 * from a different user case in the same restored population. */
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { plainColumn } from "@/lib/domain";
import { caseListOf, targetedDocument, targetedUuid } from "../build";
import { RESTORE_USER_ID, restoreXml } from "../restore";

export function workerRecordColumns() {
	const id = "targeted-worker-record-columns";
	const uuid = (key: string) => targetedUuid(id, key);
	const form = uuid("visit");
	const doc = buildDoc({
		appId: id,
		appName: "Household visits",
		caseTypes: [
			{ name: "household", properties: [] },
			{ name: "visit", parent_type: "household", properties: [] },
		],
		modules: [
			{
				name: "Visits",
				caseType: "visit",
				caseListConfig: caseListOf([
					plainColumn(uuid("case"), "case_name", "Visit"),
					plainColumn(uuid("worker"), "first_name", "Worker", {
						readFrom: "worker-record",
					}),
					plainColumn(uuid("owner"), "owner_id", "Assigned to", {
						showOwner: "name",
					}),
					plainColumn(uuid("parent"), "owner_id", "Household owner", {
						via: [{ identifier: "parent" }],
						showOwner: "name",
					}),
					plainColumn(uuid("worker-owner"), "owner_id", "Worker record owner", {
						readFrom: "worker-record",
						showOwner: "name",
					}),
				]),
				forms: [
					{
						uuid: form,
						name: "Note",
						type: "followup",
						fields: [f({ kind: "text", id: "note" })],
					},
				],
			},
		],
	});
	const cases = [
		{ id: "family", type: "household", name: "River Road", owner: "team" },
		{
			id: "visit",
			type: "visit",
			name: "Check-in",
			owner: RESTORE_USER_ID,
			indices: [
				{ identifier: "parent", caseType: "household", caseId: "family" },
			],
		},
		{
			id: "someone-else",
			type: "commcare-user",
			name: "Another worker",
			properties: { hq_user_id: "another-id", first_name: "Another" },
		},
		{
			id: "current-worker",
			type: "commcare-user",
			name: "Amina",
			owner: "team",
			properties: { hq_user_id: RESTORE_USER_ID, first_name: "Amina" },
		},
	];
	const circumstances = [
		{
			key: "known",
			groups: [{ id: "team", name: "North ward" }],
			expected: ["Check-in", "Amina", "test", "North ward", "North ward"],
		},
		{
			key: "unknown",
			groups: [],
			expected: ["Check-in", "Amina", "test", "", ""],
		},
		{
			key: "group-first",
			groups: [
				{ id: RESTORE_USER_ID, name: "Shared caseload" },
				{ id: "team", name: "" },
			],
			expected: ["Check-in", "Amina", "Shared caseload", "", ""],
		},
	];
	return targetedDocument({
		id,
		doc,
		rows: [
			"Case views: the signed-in worker's record and the name of a case owner",
		],
		expected: {
			intent: circumstances.map(({ key, expected }) => ({
				id: key,
				export: "local" as const,
				form,
				restore: `${key}.xml`,
				request: { session: { command: "m0-f0" }, caseList: {} },
				expect: expected.map((value, index) => ({
					pointer: `/caseList/rows/0/fields/${index}`,
					value,
				})),
			})),
		},
		files: Object.fromEntries(
			circumstances.map(({ key, groups }) => [
				`${key}.xml`,
				restoreXml({ cases, groups }),
			]),
		),
	});
}
