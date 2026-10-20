/**
 * The cutover's own walks equal the head's (part 09 §4, §5, §15):
 *
 * - the slot walk over raw rows visits exactly the slots the head registry
 *   lists for the same document, over documents built in the head schema
 *   and decomposed through `blueprintScalars` and `decomposeBlueprint`;
 * - step 3's choice binder is the record dialect's binder
 *   (`AuthoringScope.choice`), over every static select the corpus holds;
 * - step 5's least type is `text` for a read that only prints or compares,
 *   `decimal` for one that adds or orders against a number, the temporal
 *   type it orders against otherwise, and a conflict where reads disagree.
 *
 * A walk that misses a slot would leave a stored value unlifted, or lift one
 * the head never reads; a binder that differs would store a choice the
 * record dialect would not, so a read-back of the slot would change it.
 */

import { describe, expect, it } from "vitest";
import { AuthoringScope } from "@/lib/agent/authoring/bindings";
import { parseFormExpression } from "@/lib/commcare/xpath/expressionAst";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import {
	type BlueprintDoc,
	blueprintDocSchema,
	type PersistableDoc,
} from "@/lib/domain/blueprint";
import { slotContext } from "@/lib/domain/expression/context";
import type { ExpressionSlotRef, Literal } from "@/lib/domain/expression/types";
import {
	expressionSlotKey,
	expressionSlotValues,
	FIELD_REFERENCE_SLOTS,
	FORM_REFERENCE_SLOTS,
	MODULE_REFERENCE_SLOTS,
} from "@/lib/domain/referenceSlots";
import type { Uuid } from "@/lib/domain/uuid";
import { producerDocuments } from "../../../../proof/corpus/producers";
import { targetedDocuments } from "../../../../proof/targeted/index";
import { readRawDocument } from "../oldShape";
import {
	leastReadType,
	propertyReads,
	type ReadUse,
} from "../steps/declareReadProperties";
import { recordChoiceFor } from "../steps/recordExpressions";
import { WorkingDocument } from "../steps/working";
import { carriersOfDoc, transformFixture } from "./transformHarness";

/** One module of the corpus with a Search button condition, the one slot no corpus document fills. */
function withSearchButtonCondition(
	docs: readonly PersistableDoc[],
): PersistableDoc {
	for (const doc of docs)
		for (const [uuid, module] of Object.entries(doc.modules))
			if (module.caseSearchConfig !== undefined) {
				const changed = structuredClone(doc);
				changed.modules[uuid as Uuid] = {
					...module,
					caseSearchConfig: {
						...module.caseSearchConfig,
						searchButtonDisplayCondition: { kind: "match-all" },
					},
				} as never;
				return blueprintDocSchema.parse(changed);
			}
	throw new Error("No corpus module carries a Search configuration.");
}

const corpus = [...producerDocuments(), ...targetedDocuments()].map(
	(entry) => entry.doc,
);
const DOCUMENTS: readonly PersistableDoc[] = [
	...corpus,
	withSearchButtonCondition(corpus),
];

function registrySlots(doc: BlueprintDoc): ExpressionSlotRef[] {
	const refs: ExpressionSlotRef[] = [];
	for (const [entity, records] of [
		["module", doc.modules],
		["form", doc.forms],
		["field", doc.fields],
	] as const)
		for (const uuid of Object.keys(records))
			for (const { ref } of expressionSlotValues(doc, {
				entity,
				uuid: uuid as Uuid,
			}))
				refs.push(ref);
	return refs;
}

describe("the slot walk", () => {
	it("visits exactly the head registry's slots of every document", () => {
		const visited = new Set<string>();
		for (const doc of DOCUMENTS) {
			const working = new WorkingDocument(
				doc.appId,
				readRawDocument(doc.appId, carriersOfDoc(doc)),
				LOOKUP_CONTEXT_UNAVAILABLE,
			);
			const walked = working.slots().map((slot) => slot.key);
			const listed = registrySlots(hydratePersistedBlueprint(doc));
			expect(new Set(walked), doc.appId).toEqual(
				new Set(listed.map(expressionSlotKey)),
			);
			expect(walked.length, doc.appId).toBe(listed.length);
			for (const ref of listed) visited.add(ref.slot);
		}
		// Every expression and options-source entry of the registry is met.
		expect([...visited].sort()).toEqual(
			[
				...FIELD_REFERENCE_SLOTS,
				...FORM_REFERENCE_SLOTS,
				...MODULE_REFERENCE_SLOTS,
			]
				.filter(
					(entry) =>
						entry.kind === "expression" || entry.kind === "options-source",
				)
				.map((entry) => entry.slot)
				.sort(),
		);
	});
});

describe("step 3's choice binder", () => {
	it("equals the record dialect's binder over every static select", () => {
		const choices = transformFixture("choices").target;
		if (choices === undefined) throw new Error("choices has no target");
		let compared = 0;
		for (const persisted of [...DOCUMENTS, choices]) {
			const doc = hydratePersistedBlueprint(persisted);
			const scope = new AuthoringScope({ doc });
			for (const field of Object.values(doc.fields)) {
				const source =
					"optionsSource" in field ? field.optionsSource : undefined;
				const values =
					source?.kind === "inline"
						? source.options.map((option) => option.value)
						: [];
				const candidates: Literal["value"][] = [
					...values,
					values.join(" "),
					` ${values.join("  ")} `,
					"no such choice",
					"",
					1,
				];
				for (const value of candidates) {
					const literal: Literal = { kind: "literal", value };
					expect(recordChoiceFor(doc, field.uuid, literal)).toEqual(
						scope.choice(field.uuid, literal),
					);
					compared += 1;
				}
			}
		}
		expect(compared).toBeGreaterThan(100);
	});
});

describe("step 5's least type", () => {
	const doc = (() => {
		const target = transformFixture("declare-read-properties").target;
		if (target === undefined) throw new Error("no target");
		return hydratePersistedBlueprint(target);
	})();
	const hidden = Object.values(doc.fields).find(
		(field) => field.kind === "hidden",
	);
	if (hidden === undefined) throw new Error("no Hidden Value");
	const slot: ExpressionSlotRef = {
		entity: "field",
		uuid: hidden.uuid,
		slot: "calculate",
	};
	const ctx = slotContext(doc, slot, new Map());
	const query = "instance('casedb')/casedb/case[@case_type = 'patient']/probe";
	function uses(text: string): ReadUse[] {
		const parsed = parseFormExpression(text, { doc, slot, lookup: new Map() });
		if (!parsed.ok || parsed.expression === undefined || ctx === undefined)
			throw new Error(`${text} does not parse`);
		return propertyReads(parsed.expression, ctx)
			.filter((read) => read.property === "probe")
			.map((read) => read.use);
	}

	it.each([
		[`${query}`, ["print"], "text"],
		[`concat(${query}, 'x')`, ["print"], "text"],
		[`${query} = 'x'`, ["print"], "text"],
		[`${query} + 1`, ["arithmetic"], "decimal"],
		[`${query} < 5`, ["number"], "decimal"],
		[`today() > ${query}`, ["date"], "date"],
		[`${query} >= now()`, ["datetime"], "datetime"],
	])(
		"%s reads the property as %j, so it is declared %s",
		(text, expected, type) => {
			expect(uses(text)).toEqual(expected);
			expect(leastReadType(uses(text))).toBe(type);
		},
	);

	it.each([
		[["print", "number"], "decimal"],
		[["print", "arithmetic", "number"], "decimal"],
		[["arithmetic", "date"], "conflict"],
		[["date", "datetime"], "conflict"],
		[[], "text"],
	] as const)("%j admit %s", (reads, type) => {
		expect(leastReadType(reads)).toBe(type);
	});
});
