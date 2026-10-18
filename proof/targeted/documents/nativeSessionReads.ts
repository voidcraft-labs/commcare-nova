import {
	SESSION_READS,
	sessionReadFixture,
} from "@/lib/commcare/__tests__/sessionReadFixture";
import { targetedDocument } from "../build";
import type { Expectation } from "../expected";
import { restoreXml } from "../restore";

function document(id: string, row: string, nested = false, linked = false) {
	const intent: Expectation[] = (["local", "A"] as const).map((exportName) => ({
		id: `selected-and-group-${exportName}`,
		export: exportName,
		form: SESSION_READS.followup,
		restore: "restore.xml",
		request: {
			session: {
				command: "m1-f0",
				data: {
					case_id: nested ? "selected-household" : "selected-visit",
					...(nested ? { case_id_visit: "selected-visit" } : {}),
					case_id_parent_ids: "selected-household",
				},
			},
			expressions: ["/data/selected_id", "/data/group_parent_ids"],
		},
		expect: [
			{ pointer: "/values/0/value", value: "selected-visit" },
			{ pointer: "/values/1/value", value: "selected-household" },
		],
	}));
	return targetedDocument({
		id,
		rows: [row],
		doc: sessionReadFixture(nested, linked),
		expected: { intent },
		files: {
			"restore.xml": restoreXml({
				cases: [
					{ id: "selected-household", type: "household", name: "Household" },
					{ id: "selected-visit", type: "visit", name: "Visit" },
				],
			}),
		},
	});
}

/** Native session witnesses live outside the fixed floor's balanced edits.
 * Their existing Core classes read these exact corpus archives and HQ forms. */
export function formLinkSessionReads() {
	return document(
		"targeted-form-link-session-reads",
		"native-form-link-session-datums",
		false,
		true,
	);
}

export function nestedMenuSessionReads() {
	return document(
		"targeted-nested-menu-session-reads",
		"native-nested-menu-session-datums",
		true,
	);
}

export function tileSessionReads() {
	return document(
		"targeted-tile-session-reads",
		"native-tile-group-session-datum",
	);
}
