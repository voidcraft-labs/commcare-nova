import AdmZip from "adm-zip";
import { isTag } from "domhandler";
import { findAll } from "domutils";
import { parseDocument } from "htmlparser2";
import { describe, expect, it } from "vitest";
import { TEST_RUNTIME_TARGET } from "@/lib/commcare/__tests__/runtimeTargetFixture";
import { compileCcz } from "@/lib/commcare/compiler";
import { expandDoc } from "@/lib/commcare/expander";
import {
	LOCATION_SCENARIOS,
	locationOwnerFixture,
} from "./locationOwnerFixture";

describe("admitted location owner exports", () => {
	it.each(LOCATION_SCENARIOS)(
		"%s declares the restore dependency in the consuming form",
		(scenario) => {
			const doc = locationOwnerFixture(scenario),
				hq = expandDoc(doc),
				zip = new AdmZip(
					compileCcz(hq, doc.appName, doc, {
						runtimeTarget: TEST_RUNTIME_TARGET,
					}),
				);
			const form = parseDocument(zip.readAsText("modules-0/forms-0.xml"), {
				xmlMode: true,
			});
			const instances = findAll(
				(node) => node.name === "instance" && node.attribs.id === "locations",
				form.children.filter(isTag),
			);
			expect(instances.map((node) => node.attribs)).toEqual(
				scenario === "plain"
					? []
					: [{ id: "locations", src: "jr://fixture/locations" }],
			);
			// Every app leaves the flat list to the project space's setting.
			expect(hq.location_fixture_restore).toBe("project_default");
			const suite = parseDocument(zip.readAsText("suite.xml"), {
				xmlMode: true,
			});
			expect(
				findAll(
					(node) =>
						node.attribs.id === "locations" ||
						node.attribs.src === "jr://fixture/locations",
					suite.children.filter(isTag),
				),
			).toEqual([]);
		},
	);
});

// A worker assigned nowhere holds no places, and Core refuses a read below
// them. Form logic reads blank there, guarded by the places' count; the case
// owner moved to a place stays bare, so Core refuses the form when it opens
// rather than writing a blank owner or turning the case away once the worker
// has filled the whole form.
describe("a read of places for a worker assigned nowhere", () => {
	it("prints the owner's move to a place bare and a form's own place read guarded", () => {
		const doc = locationOwnerFixture("direct", { placeRead: true });
		const zip = new AdmZip(
			compileCcz(expandDoc(doc), doc.appName, doc, {
				runtimeTarget: TEST_RUNTIME_TARGET,
			}),
		);
		const form = parseDocument(zip.readAsText("modules-0/forms-0.xml"), {
			xmlMode: true,
		});
		const calculate = (nodeset: string) =>
			findAll(
				(node) => node.name === "bind" && node.attribs.nodeset === nodeset,
				form.children.filter(isTag),
			)[0]?.attribs.calculate;
		expect(
			calculate("/data/nova_operations/transfer/case/update/owner_id"),
		).toBe(
			"replace(instance('locations')/locations/location[@type = 'clinic'][@district_id = instance('casedb')/casedb/case[@case_id = instance('commcaresession')/session/data/case_id]/@owner_id]/@id, '^[\\x00-\\x20]+|[\\x00-\\x20]+$', '')",
		);
		expect(calculate("/data/first_place")).toBe(
			"if(count(instance('locations')/locations/location) > 0, instance('locations')/locations/location/name, '')",
		);
	});
});
