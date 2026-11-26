/**
 * The identity record of Nova's own emission names exactly the document's
 * questions.
 *
 * Contract: over the compiler's fuzz corpora, `sourceIdentity` of
 * `expandDoc(D)` leaves no form out; its leaves, less the generated nodes
 * `generatedNodePaths` places and the case and Connect regions, are exactly
 * the document's questions at `collectFieldLocations`' paths and each group
 * or repeat that holds no question (a leaf itself, or a model-iteration
 * repeat's row); and each question's type class is `coreTypeClass` of the type the emitter binds it with
 * (`fieldBindType`).
 *
 * The plausible failure is the extraction and the emitter drifting apart (a
 * leaf the extraction misses or invents, a generated node the plan places
 * elsewhere than the emitter writes it, a bind type read under another
 * class), after which every reading would fail the identity comparison, or a
 * wrong one would pass it.
 */
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
	assertGenerated,
	manifestFor,
} from "@/lib/commcare/__tests__/compilerEvidence";
import { suiteDocArbitrary } from "@/lib/commcare/__tests__/suiteDocArbitrary";
import { blueprintDocArbitrary } from "@/lib/commcare/__tests__/xformDocArbitrary";
import { expandDoc } from "@/lib/commcare/expander";
import { DERIVED_WIRE_IDENTITY } from "@/lib/commcare/wireIdentity";
import {
	inRegion,
	regionRoots,
} from "@/lib/commcare/xform/__tests__/formRegions";
import { fieldBindType } from "@/lib/commcare/xform/bindType";
import { collectFieldLocations } from "@/lib/commcare/xform/caseOps";
import { descendFormPathIntoField } from "@/lib/commcare/xform/formPath";
import { generatedNodePaths } from "@/lib/commcare/xform/generatedNodes";
import { rebuildFieldParent } from "@/lib/doc/fieldParent";
import { type BlueprintDoc, isContainer, type Uuid } from "@/lib/domain";
import { fieldCaseWriteViews } from "@/lib/domain/caseWriteViews";
import { effectiveCaseTypes } from "@/lib/domain/effectiveCaseTypes";
import { formStructure } from "@/lib/domain/expression/formStructure";
import { effectiveQueryRepeatPlacement } from "@/lib/domain/queryRepeatPlacement";
import { coreTypeClass, sourceIdentity } from "../sourceIdentity";

function holdsQuestions(doc: BlueprintDoc): void {
	rebuildFieldParent(doc);
	const identity = sourceIdentity(expandDoc(doc, { assets: manifestFor(doc) }));
	expect(identity.unread).toEqual([]);
	const caseTypes = effectiveCaseTypes(doc);
	for (const form of Object.values(doc.forms)) {
		const read = identity.forms.get(DERIVED_WIRE_IDENTITY.formXmlns(form));
		if (read === undefined)
			throw new Error(`The emission holds no form ${form.uuid}.`);
		const generated = generatedNodePaths(doc, form.uuid, null);
		const regions = regionRoots(doc, form.uuid);
		const structure = formStructure(doc, form.uuid);
		if (structure === undefined)
			throw new Error(`Form ${form.uuid} has no structure.`);
		const questions = new Map<string, Uuid>();
		const emptyContainers: string[] = [];
		for (const [uuid, location] of collectFieldLocations(doc, form.uuid)) {
			const field = doc.fields[uuid];
			// A Connect activity is its region, compared apart.
			if (field === undefined || field.kind === "connect_activity") continue;
			if (!isContainer(field)) {
				questions.set(location.path.toXPath(), uuid);
				continue;
			}
			if ((doc.fieldOrder[uuid] ?? []).length > 0) continue;
			// A container with no question is a leaf itself, or, for a query
			// repeat in model iteration, its row is.
			if (field.kind !== "repeat" || field.repeat_mode !== "query_bound")
				emptyContainers.push(location.path.toXPath());
			else if (
				effectiveQueryRepeatPlacement(structure, uuid) === "model-iteration"
			)
				emptyContainers.push(
					descendFormPathIntoField(field, location.path).toXPath(),
				);
		}
		const answers = [...read.leaves.keys()].filter(
			(path) => !generated.has(path) && !inRegion(path, regions),
		);
		expect(answers.sort()).toEqual(
			[...questions.keys(), ...emptyContainers].sort(),
		);
		for (const [path, uuid] of questions) {
			const field = doc.fields[uuid];
			if (field === undefined) continue;
			expect({
				path,
				typeClass: read.leaves.get(path)?.typeClass,
			}).toEqual({
				path,
				typeClass: coreTypeClass(
					fieldBindType(field, caseTypes, fieldCaseWriteViews(doc, uuid)),
				),
			});
		}
	}
}

describe("the identity record of Nova's own emission", () => {
	it("names exactly the document's questions, each under its bind's type class", {
		timeout: 120_000,
	}, () => {
		assertGenerated(fc.property(blueprintDocArbitrary, holdsQuestions), {
			seed: 20261115,
			numRuns: 80,
		});
		assertGenerated(fc.property(suiteDocArbitrary, holdsQuestions), {
			seed: 20261115,
			numRuns: 80,
		});
	});
});
