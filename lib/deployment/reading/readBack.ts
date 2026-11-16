/**
 * The one comparison of a document with what a reading of its export gave:
 * the claim that a read back gives the document a reading must give, made the
 * same way by every caller that states it (the fuzz read back over Nova's own
 * emission, the proof lane's read back of a served source, and the question
 * whether two readings of CommCare HQ's app are one document).
 *
 * Pure, and no part of acceptance: acceptance compares a reading with its own
 * re-read exactly and never leaves a kind out. It applies no canonical form
 * either; a caller whose claim has one applies `canonDocument` to `expected`
 * before it calls here.
 */

import { KINDS_WITH_NO_EXTERNAL_KEY } from "@/lib/commcare/reader/identity";
import {
	type DocumentDifference,
	documentDifferences,
} from "@/lib/doc/documentDifferences";
import type { DeclarationChoice } from "@/lib/doc/platformDeclaration";
import type { BlueprintDoc } from "@/lib/domain";

/** One differing path between the document a read back must give and the one it gave. */
export type ReadBackDifference = DocumentDifference;

/** What a read back gave. */
export interface ReadBack {
	readonly doc: BlueprintDoc;
	/**
	 * The declarations the reading offers (`ReadDraft.declaration.choices`; empty where its kind is
	 * `none`). Null where the comparison is made whole: `doc` was read under one declaration and
	 * already holds that declaration's mutations.
	 */
	readonly choices: readonly Pick<DeclarationChoice, "runsOnlyOn">[] | null;
}

type KindWithNoExternalKey = (typeof KINDS_WITH_NO_EXTERNAL_KEY)[number];

/**
 * The document keys that hold each kind CommCare HQ's app holds nothing of:
 * its record and the membership array that orders it. A kind nested in
 * another (an automation's criteria, updates, recipients, events and
 * user-data filters) lives inside its owner's record. The record is total
 * over the kinds, so a kind added to the list is named here before anything
 * compiles.
 */
const KEYS_OF_KIND: Readonly<
	Record<KindWithNoExternalKey, readonly (keyof BlueprintDoc)[]>
> = {
	userType: ["userTypes", "userTypeOrder"],
	persona: ["personas", "personaOrder"],
	automation: ["automations", "automationOrder"],
	automationCriterion: ["automations", "automationOrder"],
	automationSetupOnlyCriterion: ["automations", "automationOrder"],
	automationUpdate: ["automations", "automationOrder"],
	automationRecipient: ["automations", "automationOrder"],
	automationEvent: ["automations", "automationOrder"],
	automationUserDataFilter: ["automations", "automationOrder"],
};

/** Every document key a reading never returns, because no wire carries its kind. */
export const KEYS_WITH_NO_EXTERNAL_KEY: ReadonlySet<keyof BlueprintDoc> =
	new Set(KINDS_WITH_NO_EXTERNAL_KEY.flatMap((kind) => KEYS_OF_KIND[kind]));

/** `doc` less every key `KEYS_WITH_NO_EXTERNAL_KEY` names, and less its declaration where asked. */
function compared(doc: BlueprintDoc, dropDeclaration: boolean): BlueprintDoc {
	const kept = Object.fromEntries(
		Object.entries(doc).filter(
			([key]) => !KEYS_WITH_NO_EXTERNAL_KEY.has(key as keyof BlueprintDoc),
		),
	) as unknown as BlueprintDoc;
	if (!dropDeclaration || doc.appSettings.runsOnlyOn === undefined) return kept;
	const { runsOnlyOn: _declared, ...appSettings } = doc.appSettings;
	return { ...kept, appSettings };
}

/**
 * Every differing path between `expected` and what the read back gave: both
 * documents less every kind no wire carries; then, where the reading offered
 * its declarations beside the document, `expected` less its declaration,
 * which a reading never writes, and one more difference at
 * `appSettings/runsOnlyOn` where no offered choice is the declaration
 * `expected` held. With `choices: null` the two declarations are compared in
 * place.
 */
export function readBackDifferences(
	expected: BlueprintDoc,
	read: ReadBack,
): readonly ReadBackDifference[] {
	const offered = read.choices;
	const differences = [
		...documentDifferences(
			compared(expected, offered !== null),
			compared(read.doc, false),
		),
	];
	if (
		offered !== null &&
		!offered.some(
			(choice) => choice.runsOnlyOn === expected.appSettings.runsOnlyOn,
		)
	)
		differences.push({ path: ["appSettings", "runsOnlyOn"], kind: "value" });
	return differences;
}
