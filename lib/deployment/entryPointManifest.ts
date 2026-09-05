import AdmZip from "adm-zip";
import { compileCcz } from "@/lib/commcare/compiler";
import { emissionPlan } from "@/lib/commcare/emissionPlan";
import { projectEntryPoint } from "@/lib/commcare/entryPointProjection";
import { endpointSuiteSignature } from "@/lib/commcare/entryPointSignature";
import { formLinkProjectionContext } from "@/lib/commcare/formLinkProjection";
import { buildLookupFixtures } from "@/lib/commcare/lookup/fixtures";
import type { RuntimeTarget } from "@/lib/commcare/runtimeTarget";
import type { HqApplication } from "@/lib/commcare/types";
import { entryPointInventory } from "@/lib/domain";
import type { PreparedExportBoundary } from "@/lib/export/boundaryValidation";
import type { PublishedEntryPoint } from "./entryPointTypes";

/** Compile from the same prepared snapshot and exact JSON sent to HQ. */
export function publishedEntryPoints(
	prepared: PreparedExportBoundary,
	hqJson: HqApplication,
	appName: string,
	runtimeTarget: RuntimeTarget,
): PublishedEntryPoint[] {
	const inventory = entryPointInventory(prepared.doc);
	if (inventory.length === 0) return [];
	const zip = compileCcz(hqJson, appName, prepared.doc, {
		assets: prepared.assets,
		compiledAtSeq: prepared.compiledAtSeq,
		runtimeTarget,
		...(prepared.lookupNaming
			? {
					lookup: {
						naming: prepared.lookupNaming,
						fixtures: buildLookupFixtures(
							prepared.lookupNaming,
							prepared.lookupSnapshot.rowsByTable,
						),
					},
				}
			: {}),
	});
	const suite = new AdmZip(zip).readAsText("suite.xml");
	// Match the compiler's navigation owners: no-matches registrations are
	// relocated before computing a host module's common selection prefix.
	const loweredDoc = emissionPlan(prepared.doc).doc;
	const ctx = formLinkProjectionContext(loweredDoc, {
		runtimeTarget,
		attachmentTarget: prepared.attachmentTarget,
		...(prepared.lookupNaming && { lookupNaming: prepared.lookupNaming }),
	});
	return inventory.map(({ entryPoint, target }) => {
		const signature = endpointSuiteSignature(suite, entryPoint.id, {
			appIds: runtimeTarget.appId ? [runtimeTarget.appId] : [],
		});
		if (!signature)
			throw new Error("The compiled suite omitted a published entry point.");
		return {
			target,
			uuid: entryPoint.uuid,
			id: entryPoint.id,
			signature,
			requiredSelections: projectEntryPoint(loweredDoc, target, ctx)
				.requiredSelections,
		};
	});
}
