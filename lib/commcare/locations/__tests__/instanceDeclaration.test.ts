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
