/**
 * Batch-building planner for the two mutations that put a language into an
 * app.
 *
 * A language's CommCare wire code is an identity the app holds from the
 * moment the language joins it, so the mutation that adds the language
 * carries the code and the reducer stores it as carried. The code is minted
 * here, once, against the codes the app's languages hold at that point:
 * every producer (the builder, the assistant's tools, translation, the repair
 * scripts) builds its mutation through this file, so the held set is read one
 * way. A code minted in the reducer would be minted again at every replay,
 * from the language catalog as it stands then, and a later catalog change
 * would rename a code a deployment already holds.
 *
 * A producer that puts two `addLanguage` mutations in one batch adds the
 * first's code to the held set before it builds the second. A producer that
 * adds a replacement before it removes the old language mints against a set
 * that still holds the old code, which is the state the reducer applies the
 * add on.
 */

import { mintLanguageWireCode } from "@/lib/commcare/languageWire";
import type { BlueprintDoc, Mutation } from "@/lib/doc/types";
import {
	type AppLanguageIdentity,
	effectiveAppLocalization,
} from "@/lib/domain";

/** The codes the app's languages hold now. */
export function heldLanguageWireCodes(doc: BlueprintDoc): Set<string> {
	return new Set(
		Object.values(effectiveAppLocalization(doc.localization).wireCodes),
	);
}

/** `addLanguage` carrying the code this identity takes beside `held`. */
export function addLanguageMutation(
	held: ReadonlySet<string>,
	identity: AppLanguageIdentity,
): Extract<Mutation, { kind: "addLanguage" }> {
	return {
		kind: "addLanguage",
		language: identity,
		wireCode: mintLanguageWireCode(held, identity),
	};
}

/**
 * `relabelSourceLanguage` carrying the identity's preferred spelling. The
 * relabel replaces an app's only language, so no other code is held.
 */
export function relabelSourceLanguageMutation(
	identity: AppLanguageIdentity,
): Extract<Mutation, { kind: "relabelSourceLanguage" }> {
	return {
		kind: "relabelSourceLanguage",
		language: identity,
		wireCode: mintLanguageWireCode(new Set(), identity),
	};
}
