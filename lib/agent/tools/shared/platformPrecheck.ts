/**
 * The platform pre-checks the SA and MCP tools run before staging.
 *
 * Private work (the change-set host) stages a batch whatever its validator
 * findings and reports them as diagnostics, so a gated write alone would
 * stage a question or a declaration the app's platforms refuse, and the
 * refusal would first reach the model at `saveWork`, far from the call that
 * caused it. These checks refuse at that call instead, and write no sentence
 * of their own: each returns the commit gate's own words for the same batch,
 * so a pre-check and the gate cannot drift. The gate stays the authority.
 *
 *   - `fieldKindPlatformRefusal`: a question kind the app's platforms can't
 *     run (the date-and-time question in an app that runs in Web Apps), in
 *     the message the platform rule's `PLATFORM_FEATURE_UNAVAILABLE` finding
 *     carries for that question.
 *   - `declarationPlatformRefusal`: a change of where the app runs that
 *     strands a feature, in `describeCommitFindings`' frame over the gate's
 *     platform findings, the frame a refusal at `saveWork` uses.
 */

import {
	describeCommitFindings,
	mutationCommitVerdict,
} from "@/lib/doc/commitVerdicts";
import {
	extractLookupReferenceTargets,
	LOOKUP_CONTEXT_UNAVAILABLE,
	type LookupValidationContext,
	unionLookupReferenceTargetSets,
} from "@/lib/doc/lookupReferences";
import {
	type BlueprintDoc,
	declaredPlatforms,
	type FieldKind,
	featureForFieldKind,
	platformRefusal,
	platformRefusalMessage,
	type Uuid,
	unavailableUses,
} from "@/lib/domain";
import type { ToolInvocationContext } from "../../workspace/types";
import { applyToDoc } from "../common";

/**
 * Every item whose kind a platform the app declares can't run, each in the
 * gate finding's own message (`platformRefusalMessage` with the subject the
 * platform rule gives a question), one per line; `undefined` when every
 * kind runs where the app runs.
 */
export function fieldKindPlatformRefusal(
	doc: BlueprintDoc,
	formUuid: Uuid,
	items: readonly { readonly kind: FieldKind; readonly id: string }[],
): string | undefined {
	const platforms = declaredPlatforms(doc);
	const formName = doc.forms[formUuid]?.name ?? "";
	const messages = items.flatMap((item) => {
		const feature = featureForFieldKind(item.kind);
		const refusal =
			feature === undefined ? undefined : platformRefusal(feature, platforms);
		return refusal === undefined
			? []
			: [
					platformRefusalMessage({
						...refusal,
						platforms,
						subject: `Question "${item.id}" in form "${formName}"`,
					}),
				];
	});
	return messages.length === 0 ? undefined : messages.join("\n");
}

/**
 * The lookup context the gate needs for `doc` and the batch's candidate,
 * built as the change-set workspace builds it: the Project's definitions of
 * every table either document reads, or unavailable when they read none or
 * the host gives no definitions.
 */
export async function precheckLookupContext(
	ctx: ToolInvocationContext,
	doc: BlueprintDoc,
	candidate: BlueprintDoc,
): Promise<LookupValidationContext> {
	const targets = unionLookupReferenceTargetSets(
		extractLookupReferenceTargets(doc),
		extractLookupReferenceTargets(candidate),
	);
	if (targets.tableIds.length === 0 || ctx.lookupDefinitions === undefined)
		return LOOKUP_CONTEXT_UNAVAILABLE;
	const snapshot = await ctx.lookupDefinitions(targets.tableIds);
	return {
		kind: "available",
		projectId: snapshot.projectId,
		projectRevision: snapshot.projectRevision,
		definitions: snapshot.definitions,
	};
}

/**
 * Whether the batch's change of where the app runs strands a feature the
 * new declaration can't run: the gate's platform findings for the
 * candidate (the platform rule's `PLATFORM_FEATURE_UNAVAILABLE` and the
 * checker's `platform-unavailable` leaves, each carrying `details.feature`),
 * in `describeCommitFindings`' frame; `undefined` when nothing is stranded.
 */
export function declarationPlatformRefusal(
	doc: BlueprintDoc,
	mutations: unknown,
	lookupContext: LookupValidationContext,
): string | undefined {
	const candidate = applyToDoc(doc, mutations);
	if (unavailableUses(candidate, declaredPlatforms(candidate)).length === 0)
		return undefined;
	const verdict = mutationCommitVerdict(doc, mutations, lookupContext);
	if (verdict.ok) return undefined;
	const findings = verdict.findings.filter(
		(finding) => typeof finding.details?.feature === "string",
	);
	return findings.length === 0 ? undefined : describeCommitFindings(findings);
}
