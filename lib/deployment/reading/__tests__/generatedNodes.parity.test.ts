/**
 * The register's two lists of generated nodes are kept by one key.
 *
 * Contract: for a document's own emission as CommCare HQ serves it, the
 * reader's `generated` list of each form (`ReadFormFacts.generated`) and
 * `emittedGeneratedNodes` of the document are the same set of
 * `(purpose, owner, name, path)`, over the documents CommCare HQ's retained
 * sources read to, over the compiler's fuzz corpora, and over the named
 * fixtures that place the nodes the corpora never draw (a link, a protected
 * message, an owner, a date and time); and
 * `generatedDifference` pairs a question's several counts in name order,
 * reports a moved suffix as a rename and leaves a guard out.
 *
 * Plausible failures: the two builders keying an owner two ways, so the
 * register takes every node for added and dropped and tells a person their
 * case names are newly checked; a rename read as a new node; a guard
 * declared as a hidden value.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
	caseCaptureFixture,
	caseCaptureScenarios,
} from "@/lib/commcare/__tests__/caseCaptureFixture";
import {
	caseOperationFixture,
	operationScenarios,
} from "@/lib/commcare/__tests__/caseOperationFixture";
import {
	constraintMessageFixture,
	constraintMessageScenarios,
} from "@/lib/commcare/__tests__/constraintMessageFixture";
import {
	extensionCaseFixture,
	extensionScenarios,
} from "@/lib/commcare/__tests__/extensionCaseFixture";
import { suiteDocArbitrary } from "@/lib/commcare/__tests__/suiteDocArbitrary";
import { blueprintDocArbitrary } from "@/lib/commcare/__tests__/xformDocArbitrary";
import type { ReadGeneratedNode } from "@/lib/commcare/reader/types";
import type { AttachmentUrlTarget } from "@/lib/commcare/xform/captureUrlNode";
import { rebuildFieldParent } from "@/lib/doc/fieldParent";
import type { BlueprintDoc } from "@/lib/domain";
import {
	emittedGeneratedNodes,
	generatedDifference,
} from "../firstPublishChanges";
import { exportForms, readExport, retainedReadings } from "./registerReadings";

const TARGET: AttachmentUrlTarget = {
	origin: "https://india.commcarehq.org",
	domain: "clinic",
};

function keys(nodes: readonly ReadGeneratedNode[]): string[] {
	return nodes
		.map((node) =>
			JSON.stringify([node.purpose, node.owner, node.name, node.path]),
		)
		.sort();
}

/** The reader's list for the document's own export against the emitter's plan, form by form. */
async function holdsParity(
	doc: BlueprintDoc,
	seen?: Set<ReadGeneratedNode["purpose"]>,
): Promise<number> {
	const reading = await readExport(doc, TARGET);
	const emitted = emittedGeneratedNodes(
		doc,
		exportForms(doc, reading.draft),
		TARGET,
	);
	const read = reading.draft.facts.forms.map((form) => form.generated);
	expect(read.map(keys)).toEqual(emitted.map(keys));
	for (const nodes of read) for (const one of nodes) seen?.add(one.purpose);
	return read.reduce((sum, nodes) => sum + nodes.length, 0);
}

describe("the reader's generated nodes and the emitter's", () => {
	it("are one set for the export of every document a retained source reads to", {
		timeout: 120_000,
	}, async () => {
		const readings = await retainedReadings();
		expect(readings.length).toBeGreaterThanOrEqual(3);
		let nodes = 0;
		for (const reading of readings)
			nodes += await holdsParity(reading.draft.doc);
		expect(nodes).toBeGreaterThan(0);
	});

	it("are one set for the nodes the corpora do not draw: a link, a protected message, an owner, a date and time", {
		timeout: 120_000,
	}, async () => {
		const seen = new Set<ReadGeneratedNode["purpose"]>();
		for (const scenario of caseCaptureScenarios)
			await holdsParity(caseCaptureFixture(scenario), seen);
		for (const scenario of constraintMessageScenarios)
			await holdsParity(constraintMessageFixture(scenario).doc, seen);
		for (const scenario of operationScenarios)
			await holdsParity(caseOperationFixture(scenario), seen);
		for (const scenario of extensionScenarios)
			await holdsParity(extensionCaseFixture(scenario), seen);
		expect([...seen]).toEqual(
			expect.arrayContaining([
				"constraint-message",
				"datetime",
				"owner",
				"url",
			]),
		);
	});

	it("are one set over the fuzz corpora", { timeout: 240_000 }, async () => {
		let nodes = 0;
		for (const arbitrary of [blueprintDocArbitrary, suiteDocArbitrary])
			await fc.assert(
				fc.asyncProperty(arbitrary, async (doc) => {
					rebuildFieldParent(doc);
					nodes += await holdsParity(doc);
				}),
				{ seed: 20261115, numRuns: 40 },
			);
		expect(nodes).toBeGreaterThan(0);
	});
});

const node = (
	purpose: ReadGeneratedNode["purpose"],
	owner: string,
	name: string,
): ReadGeneratedNode => ({
	purpose,
	owner,
	name,
	path: `${owner.slice(0, owner.lastIndexOf("/"))}/${name}`,
});

describe("generatedDifference", () => {
	it("pairs a question's several counts in name order", () => {
		const before = [
			node("constraint-count", "/data/age", "nova_constraint_age_1"),
			node("constraint-count", "/data/age", "nova_constraint_age_2"),
		];
		const after = [
			node("constraint-count", "/data/age", "nova_constraint_age_2"),
			node("constraint-count", "/data/age", "nova_constraint_age_1"),
			node("constraint-count", "/data/age", "nova_constraint_age_3"),
		];
		expect(generatedDifference([before], [after])).toEqual({
			added: [node("constraint-count", "/data/age", "nova_constraint_age_3")],
			dropped: [],
			renamed: [],
		});
	});

	it("reports a moved suffix as a rename", () => {
		const from = node("trimmed", "/data/name", "nova_trimmed_name");
		const to = node("trimmed", "/data/name", "nova_trimmed_name_1");
		expect(generatedDifference([[from]], [[to]])).toEqual({
			added: [],
			dropped: [],
			renamed: [{ from, to }],
		});
	});

	it("matches nodes form by form, never across forms", () => {
		const one = node("url", "/data/photo", "nova_url_photo");
		expect(generatedDifference([[one], []], [[], [one]])).toEqual({
			added: [one],
			dropped: [one],
			renamed: [],
		});
	});

	it("leaves a difference of guards alone empty", () => {
		const guard = node("guard", "/data#visit", "nova_guard_visit_text");
		expect(generatedDifference([[]], [[guard]])).toEqual({
			added: [],
			dropped: [],
			renamed: [],
		});
		expect(generatedDifference([[guard]], [[]])).toEqual({
			added: [],
			dropped: [],
			renamed: [],
		});
	});
});
