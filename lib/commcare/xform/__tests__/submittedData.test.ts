import { isTag } from "domhandler";
import { parseDocument } from "htmlparser2";
import { expect, it } from "vitest";
import { assertAnswerDataReachesReceiver } from "../submittedData";

function inspect(xml: string, webApps: boolean) {
	const root = parseDocument(xml, { xmlMode: true }).children.find(isTag);
	if (!root) throw new Error("Missing submission envelope");
	assertAnswerDataReachesReceiver(root, webApps);
}

it("checks ordinary submitted answers below the envelope", () => {
	for (const name of ["case_note", "script", "sync"]) {
		for (const web of [true, false])
			expect(() =>
				inspect(`<case><group><${name}/></group></case>`, web),
			).not.toThrow();
	}
	for (const name of ["case", "Case"]) {
		for (const web of [true, false])
			expect(() =>
				inspect(`<visit><group><${name}/></group></visit>`, web),
			).toThrow("/visit/group/");
	}
});

it("lets the declared worker platform determine which names are ordinary answers", () => {
	for (const name of ["registration", "Registration", "fixture", "Schema"]) {
		const xml = `<visit><group><${name}/></group></visit>`;
		expect(() => inspect(xml, false)).not.toThrow();
		expect(() => inspect(xml, true)).toThrow("/visit/group/");
	}
	const sync = '<visit><sync xmlns="http://commcarehq.org/sync"/></visit>';
	expect(() => inspect(sync, false)).not.toThrow();
	expect(() => inspect(sync, true)).toThrow("/visit/sync");
});

it("uses the effective namespace and leaves a genuine generated case transaction to its receiver", () => {
	const submitted =
		'<visit><new_household><cx:case xmlns:cx="http://commcarehq.org/case/transaction/v2" case_id="" date_modified=""><cx:update><cx:fixture/></cx:update></cx:case></new_household></visit>';
	for (const web of [true, false]) {
		expect(() => inspect(submitted, web)).not.toThrow();
		expect(() =>
			inspect(
				'<visit><value xmlns="http://commcarehq.org/ledger/v1"/></visit>',
				web,
			),
		).toThrow("/visit/value");
	}
});
