/**
 * The validator over what the expression stage holds.
 *
 * Contract: over the emitter's own corpora, the document the expression
 * stage binds raises no validator finding that its held expressions cause.
 * A held slot is one the reading admitted under a HELD claim, so a finding a
 * held tree causes is one no claim reported, which acceptance's gate would
 * then stop on with nothing to show a person. A finding is caused by the held
 * trees where the document raises it and the same document with every held
 * slot put back to the placeholder its structure reader wrote does not.
 *
 * Plausible failure: a validator rule that reads an expression slot and that
 * the reader's own checks (the checker, the display-condition rules, CSQL
 * representability, the record dialect) do not stand for, so a held slot
 * fails the gate the reader holds every slot to.
 */
import { describe, expect, it } from "vitest";
import { recordDialectRoundTrip } from "@/lib/agent/authoring/recordRoundTrip";
import { runValidation } from "@/lib/commcare/validator/runner";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import type { BlueprintDoc } from "@/lib/domain/blueprint";
import { slotContext } from "@/lib/domain/expression/context";
import {
	expressionSlotKey,
	rewriteExpressionSlotValues,
} from "@/lib/domain/referenceSlots";
import type { Uuid } from "@/lib/domain/uuid";
import { pendingPlaceholder } from "../../pendingExpressions";
import {
	corpusDocs,
	type EmissionReading,
	READ_BACK_CORPORA,
	readEmission,
} from "./readBackCorpus";

/** Documents per corpus; the five corpora take a few seconds on a laptop. */
const DOCS_PER_CORPUS = 30;

/** `read` with every slot the reading held put back to its placeholder. */
function withoutHeld(
	read: BlueprintDoc,
	reading: EmissionReading,
): BlueprintDoc {
	const held = new Set(
		reading.slots
			.filter((slot) => slot.outcome.expression !== undefined)
			.map((slot) => expressionSlotKey(slot.registration.ref)),
	);
	const bare = structuredClone(read) as BlueprintDoc;
	const owners = [
		...Object.keys(bare.modules).map((uuid) => ({
			entity: "module" as const,
			uuid: uuid as Uuid,
		})),
		...Object.keys(bare.forms).map((uuid) => ({
			entity: "form" as const,
			uuid: uuid as Uuid,
		})),
		...Object.keys(bare.fields).map((uuid) => ({
			entity: "field" as const,
			uuid: uuid as Uuid,
		})),
	];
	for (const owner of owners)
		rewriteExpressionSlotValues(bare, owner, (value, ref) => {
			if (!held.has(expressionSlotKey(ref))) return value;
			const context = slotContext(read, ref, new Map());
			return pendingPlaceholder(
				context?.profile.expectation.kind === "condition"
					? "condition"
					: "value",
			);
		});
	return bare;
}

function findingKeys(doc: BlueprintDoc): Map<string, string> {
	return new Map(
		runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).map((finding) => [
			JSON.stringify([finding.code, finding.location, finding.details ?? {}]),
			finding.message,
		]),
	);
}

describe("the validator over the expressions a reading holds", () => {
	for (const corpus of READ_BACK_CORPORA)
		it(`finds nothing the held expressions of the ${corpus.name} corpus cause`, {
			timeout: 60_000,
		}, async () => {
			let held = 0;
			for (const doc of corpusDocs(corpus, DOCS_PER_CORPUS)) {
				const reading = await readEmission(doc, recordDialectRoundTrip);
				const read = reading.doc;
				if (read === undefined) continue;
				held += reading.slots.filter(
					(slot) => slot.outcome.expression !== undefined,
				).length;
				const bare = findingKeys(withoutHeld(read, reading));
				const caused = [...findingKeys(read)]
					.filter(([key]) => !bare.has(key))
					.map(([, message]) => message);
				expect(caused).toEqual([]);
			}
			expect(held).toBeGreaterThan(0);
		});
});
