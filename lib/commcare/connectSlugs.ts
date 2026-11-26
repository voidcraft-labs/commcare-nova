import type { BlueprintDoc, Uuid } from "@/lib/domain";
import {
	type ConnectActivitySite,
	connectActivitySites,
} from "@/lib/domain/connectActivitySites";
/** Only activities present in a submitted form require a forwarder. */
export function appEmitsConnectBlocks(doc: BlueprintDoc): boolean {
	return Object.values(doc.fields).some(
		(field) => field.kind === "connect_activity",
	);
}

/** Ordered activities by form, for the Project's publish confirmations. */
export function formConnectActivities(doc: BlueprintDoc) {
	const result = new Map<Uuid, readonly ConnectActivitySite[]>();
	for (const module of doc.moduleOrder)
		for (const form of doc.formOrder[module] ?? []) {
			const sites = connectActivitySites(doc, form);
			if (sites.length) result.set(form, sites);
		}
	return result;
}
