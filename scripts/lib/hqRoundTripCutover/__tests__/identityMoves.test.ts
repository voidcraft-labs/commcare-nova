/**
 * The identities that move once for a deployment made before step 2, read by
 * parsing both emissions, never by pattern: for every corpus fixture, the
 * pre-step bytes retained under `proof/hq-reads/cutover/<document>/legacy/`
 * against what this head's emitter makes of the transformed fixture. Each
 * row of part 09's table (Why `proof/identity-moves.json` stays empty) whose
 * fix has landed adds its assertions here; what the table says moves for
 * nothing stays equal. HQ's menu and form ids for a deployment whose ids the
 * cutover recorded are the ledger test's (`ledger.postgres.test.ts`).
 */

import AdmZip from "adm-zip";
import { isTag } from "domhandler";
import { describe, expect, it } from "vitest";
import { TEST_RUNTIME_TARGET } from "@/lib/commcare/__tests__/runtimeTargetFixture";
import { compileCcz } from "@/lib/commcare/compiler";
import { expandDoc } from "@/lib/commcare/expander";
import { buildLookupFixtures } from "@/lib/commcare/lookup/fixtures";
import { lookupWireNaming } from "@/lib/commcare/lookup/naming";
import { derivedFormXmlns, derivedUniqueId } from "@/lib/commcare/wireIdentity";
import { parseXml } from "@/lib/commcare/xmlParse";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import { asUuid, blueprintDocSchema } from "@/lib/domain";
import { collectHqPaths } from "../matching";
import { rawDocumentAssembly, readRawDocument } from "../oldShape";
import { questionPaths } from "../questionPaths";
import { transformDocument } from "../transform";
import { readLegacyApp } from "./fixtures/legacyBodies";
import {
	LEGACY_DIRECTORY,
	readFixtureCarriers,
	readFixtureManifest,
	readFixtureProject,
} from "./fixtures/preStep";

type HqApp = {
	langs: string[];
	modules: {
		unique_id: string;
		forms: { unique_id: string; xmlns: string }[];
	}[];
	_attachments: Record<string, string>;
};

const DOCUMENTS = readFixtureManifest()
	.fixtures.filter((fixture) => fixture.kind === "corpus")
	.map((fixture) => fixture.id);

function emitted(id: string) {
	const raw = readRawDocument(id, readFixtureCarriers(id));
	const { target } = transformDocument(raw, {
		appId: id,
		projectId: "fixture-project",
		lookupColumnTypes: new Map(),
		deployments: [],
	});
	const doc = hydratePersistedBlueprint(
		blueprintDocSchema.parse(rawDocumentAssembly(id, target)),
	);
	// The Project's lookup tables, as the export boundary names them.
	const snapshot = readFixtureProject(id).lookup as
		| {
				definitions: Parameters<typeof lookupWireNaming>[0];
				rowsByTable: Record<string, unknown[]>;
		  }
		| undefined;
	const naming =
		snapshot === undefined ? undefined : lookupWireNaming(snapshot.definitions);
	const lookup =
		snapshot === undefined || naming === undefined
			? undefined
			: {
					naming,
					fixtures: buildLookupFixtures(
						naming,
						new Map(Object.entries(snapshot.rowsByTable)) as never,
					),
				};
	const hq = expandDoc(doc, {
		...(naming !== undefined && { lookupNaming: naming }),
	}) as unknown as HqApp;
	return { doc, hq, lookup, menus: questionPaths(target) };
}

/** Each form's XForm in order, by the app JSON's own form ids. */
function xforms(app: HqApp): string[] {
	return app.modules.flatMap((module) =>
		module.forms.map((form) => app._attachments[`${form.unique_id}.xml`] ?? ""),
	);
}

/** The data root's `xmlns` declaration of one XForm. */
function dataXmlns(xform: string): string | undefined {
	const find = (nodes: readonly unknown[]): string | undefined => {
		for (const node of nodes) {
			if (!isTag(node as never)) continue;
			const element = node as import("domhandler").Element;
			if (element.name.endsWith("instance")) {
				const root = element.children.find((child) => isTag(child));
				return (root as import("domhandler").Element | undefined)?.attribs
					.xmlns;
			}
			const found = find(element.children);
			if (found !== undefined) return found;
		}
		return undefined;
	};
	return find(parseXml(xform).children);
}

describe.each(DOCUMENTS)("over %s", (id) => {
	const legacy = readLegacyApp(id, "republish") as unknown as HqApp;

	it("keeps every language's wire code", () => {
		expect(emitted(id).hq.langs).toEqual(legacy.langs);
	});

	it("keeps every question path no step renames", () => {
		const after = xforms(emitted(id).hq);
		const before = xforms(legacy);
		expect(after).toHaveLength(before.length);
		const authored = (xform: string) =>
			collectHqPaths(xform)
				.filter((entry) => !entry.generated)
				.map((entry) => entry.path)
				.sort();
		before.forEach((xform, index) => {
			expect(authored(after[index] ?? "")).toEqual(authored(xform));
		});
	});

	it("moves every menu id, form id and xmlns of a deployment no credential read from HQ's values to the derived ones", () => {
		const { hq, menus } = emitted(id);
		const forms = menus.flatMap((menu) => menu.forms);
		expect(hq.modules.map((module) => module.unique_id)).toEqual(
			menus.map((menu) => derivedUniqueId(asUuid(menu.uuid))),
		);
		expect(
			hq.modules.flatMap((module) =>
				module.forms.map((form) => form.unique_id),
			),
		).toEqual(forms.map((form) => derivedUniqueId(asUuid(form.uuid))));
		expect(
			hq.modules.flatMap((module) => module.forms.map((form) => form.xmlns)),
		).toEqual(forms.map((form) => derivedFormXmlns(asUuid(form.uuid))));
		for (const [index, module] of legacy.modules.entries()) {
			expect(module.unique_id).not.toBe(hq.modules[index]?.unique_id);
			for (const [formIndex, form] of module.forms.entries()) {
				expect(form.xmlns).not.toBe(hq.modules[index]?.forms[formIndex]?.xmlns);
			}
		}
	});

	it("moves each form's xmlns in the local archive from a drawn one to the derived one", () => {
		const { doc, hq, lookup, menus } = emitted(id);
		const archive = new AdmZip(
			compileCcz(hq as never, doc.appName, doc, {
				runtimeTarget: TEST_RUNTIME_TARGET,
				...(lookup !== undefined && { lookup }),
			}),
		);
		const before = new AdmZip(`${LEGACY_DIRECTORY}/${id}/legacy/local.ccz`);
		menus.forEach((menu, menuIndex) => {
			menu.forms.forEach((form, formIndex) => {
				const entry = `modules-${menuIndex}/forms-${formIndex}.xml`;
				const now = dataXmlns(archive.readAsText(entry));
				expect(now).toBe(derivedFormXmlns(asUuid(form.uuid)));
				expect(dataXmlns(before.readAsText(entry))).not.toBe(now);
			});
		});
	});
});
