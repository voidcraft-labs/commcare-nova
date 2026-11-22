/**
 * Two readings of CommCare HQ's app as a review makes them, over Nova's own
 * emission: a document's export served on CommCare HQ's shell, in the key
 * order a baseline stores (`inStoredKeyOrder`), and read by the production
 * reader through the identity map of the document Nova holds
 * (`mapOf`), its case types and its language codes, then put under that
 * document's own declaration, as the plan puts a reading. What
 * acceptance's re-read does, with no CommCare HQ.
 */

import { produce } from "immer";
import { expect } from "vitest";
import {
	knownCaseTypesOf,
	knownLanguageCodesOf,
	readHqApp,
} from "@/lib/commcare/reader";
import { matchingResolver } from "@/lib/commcare/reader/identity";
import { externalIdentityMap } from "@/lib/commcare/reader/identityMap";
import { whereText } from "@/lib/commcare/reader/place";
import {
	DERIVED_WIRE_IDENTITY,
	targetWireIdentity,
	type WireIdentity,
	type WireIdentityOverride,
} from "@/lib/commcare/wireIdentity";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { admitMutationBatch } from "@/lib/doc/mutationAdmission";
import { applyMutations } from "@/lib/doc/mutations";
import type { Mutation } from "@/lib/doc/types";
import type { BlueprintDoc } from "@/lib/domain";
import {
	readBackInput,
	servedExport,
} from "../../reading/__tests__/novaReading";
import { inStoredKeyOrder } from "../baselineSource";

/**
 * The reading of `doc`'s export through `mapOf`'s identities, under `mapOf`'s
 * declaration, the served body changed by `edit` where given, as a save in
 * CommCare HQ changes it.
 */
export async function readingOf(
	doc: BlueprintDoc,
	mapOf: BlueprintDoc,
	identity: WireIdentity = DERIVED_WIRE_IDENTITY,
	edit?: (body: Record<string, unknown>) => void,
): Promise<BlueprintDoc> {
	return (await readingWithIds(doc, mapOf, identity, edit)).doc;
}

/**
 * The reading `readingOf` gives, with the ids a publish of its document to
 * the same project space sends: each menu and form `mapOf` does not hold
 * under the id CommCare HQ holds it by, as a bring-in records them.
 */
export async function readingWithIds(
	doc: BlueprintDoc,
	mapOf: BlueprintDoc,
	identity: WireIdentity = DERIVED_WIRE_IDENTITY,
	edit?: (body: Record<string, unknown>) => void,
): Promise<{
	readonly doc: BlueprintDoc;
	readonly identity: WireIdentity;
}> {
	const served = servedExport(doc, { identity });
	edit?.(served.body);
	const input = await readBackInput(doc, served);
	const outcome = readHqApp({
		...input,
		source: inStoredKeyOrder(input.source),
		resolver: matchingResolver(
			mapOf.appId,
			externalIdentityMap(mapOf, DERIVED_WIRE_IDENTITY),
		),
		knownCaseTypes: knownCaseTypesOf(mapOf),
		knownLanguageCodes: knownLanguageCodesOf(mapOf),
	});
	if (outcome.kind !== "read")
		throw new Error(
			`The export read to an account: ${outcome.findings
				.map(
					(finding) =>
						`${finding.code} at ${whereText(finding.place)} (${finding.detail.name ?? ""})`,
				)
				.join("; ")}`,
		);
	const { declaration } = outcome.draft;
	const runs = mapOf.appSettings.runsOnlyOn ?? null;
	const choice =
		declaration.kind === "choices"
			? declaration.choices.find(
					(one) => (one.runsOnlyOn ?? null) === runs && !one.split,
				)
			: undefined;
	if (choice === undefined)
		throw new Error(
			"The reading offers no choice of the document's declaration.",
		);
	const held = (uuid: string) =>
		Object.hasOwn(mapOf.modules, uuid) || Object.hasOwn(mapOf.forms, uuid);
	const overrides: WireIdentityOverride[] = [
		...outcome.draft.identities.modules
			.filter((menu) => !held(menu.uuid))
			.map((menu) => ({
				entityKind: "module" as const,
				novaEntityUuid: menu.uuid,
				uniqueId: menu.uniqueId,
				xmlns: null,
			})),
		...outcome.draft.identities.forms
			.filter((form) => !held(form.uuid))
			.map((form) => ({
				entityKind: "form" as const,
				novaEntityUuid: form.uuid,
				uniqueId: null,
				xmlns: form.xmlns,
			})),
	];
	return {
		doc: produce(outcome.draft.doc, (draft) => {
			applyMutations(draft, choice.mutations);
		}),
		identity: targetWireIdentity(
			overrides,
			[],
			outcome.draft.identities.installationProfiles,
		),
	};
}

/** `doc` with `mutations` committed through the gate, which the test holds to admit them. */
export function committed(
	doc: BlueprintDoc,
	mutations: readonly Mutation[],
): BlueprintDoc {
	const verdict = mutationCommitVerdict(
		doc,
		admitMutationBatch(JSON.parse(JSON.stringify(mutations))),
		LOOKUP_CONTEXT_UNAVAILABLE,
	);
	expect(verdict.ok ? [] : verdict.findings.map((one) => one.code)).toEqual([]);
	return verdict.nextDoc;
}
