import { z } from "zod";
import {
	authoringEncoders,
	projectAuthoringRead,
} from "@/lib/agent/authoring/output";
import { encodeAuthoringValues } from "@/lib/agent/authoring/schema";
import { formSnapshot } from "@/lib/agent/blueprintHelpers";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import {
	automationSchema,
	type BlueprintDoc,
	casePropertySchema,
	moduleSchema,
	orderedAutomations,
	orderedLocationProperties,
	orderedOrganizationLevels,
	orderedPersonas,
	orderedUserProperties,
	orderedUserTypes,
	type Uuid,
} from "@/lib/domain";
import { deriveCaseWriteInventory } from "@/lib/domain/caseWriteInventory";
import type { LookupTableDefinition } from "@/lib/lookup/types";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";

/** Current implementation facts, without inferred intent or execution claims.
 * Callers supply the canonical sequence or private workspace revision separately.
 * Source-language content uses the same readable projection as authoring tools.
 * External rows, deployment readiness and translation overlays are not inspected. */
export function projectBlueprintImplementation(
	doc: BlueprintDoc,
	tables?: readonly LookupTableDefinition[],
) {
	const unreadable: Array<{ kind: string; id: string; reason: string }> = [];
	function read<T>(kind: string, id: string, project: () => T): T | null {
		try {
			return project();
		} catch (error) {
			// A private candidate can contain the very broken reference a helper
			// needs to diagnose. Keep its address and failure, never imply absence.
			unreadable.push({
				kind,
				id,
				reason: error instanceof Error ? error.message : "Projection failed.",
			});
			return null;
		}
	}
	function projectForm(moduleUuid: Uuid, formUuid: Uuid) {
		const form = doc.forms[formUuid];
		const inventory = deriveCaseWriteInventory(
			doc,
			formUuid,
			doc.modules[moduleUuid],
			form.type,
		);
		return {
			uuid: formUuid,
			definition: read(
				"form",
				formUuid,
				() =>
					z.object({ form: z.unknown() }).parse(
						projectAuthoringRead({
							toolName: "getForm",
							data: { form: formSnapshot(doc, formUuid) },
							doc,
							tables,
						}),
					).form,
			),
			// These are the ordinary field-driven case actions. Explicit case
			// operations remain ordered in the form definition, with their guards.
			fieldActions: inventory.buckets.map((bucket) => ({
				kind: bucket.kind,
				action: bucket.action,
				caseType: bucket.caseType,
				...(bucket.repeatUuid && { repeatUuid: bucket.repeatUuid }),
				writes: bucket.writers.map((writer) => ({
					fieldUuid: writer.fieldUuid,
					property: writer.property,
				})),
			})),
			...(inventory.noActionWriters.length > 0 && {
				inactiveWriters: inventory.noActionWriters,
			}),
			...(inventory.invalidDestinationWriters.length > 0 && {
				invalidWriters: inventory.invalidDestinationWriters,
			}),
		};
	}
	const content = {
		version: 1,
		snapshotDigest: canonicalJsonDigest(toPersistableDoc(doc)),
		app: { id: doc.appId, name: doc.appName, connect: doc.connectType },
		records: (doc.caseTypes ?? []).map((record) => ({
			...record,
			properties: record.properties.map((property) => ({
				name: property.name,
				definition: read(
					"case-property",
					`${record.name}/${property.name}`,
					() =>
						encodeAuthoringValues(
							casePropertySchema,
							property,
							authoringEncoders({
								doc,
								tables,
								currentCaseType: record.name,
							}),
						),
				),
			})),
		})),
		modules: doc.moduleOrder.map((uuid) => {
			const module = doc.modules[uuid];
			return {
				uuid,
				definition: read("module", uuid, () =>
					encodeAuthoringValues(
						moduleSchema,
						module,
						authoringEncoders(
							{
								doc,
								tables,
								moduleUuid: uuid,
								currentCaseType: module.caseType,
							},
							module,
							true,
						),
					),
				),
				forms: (doc.formOrder[uuid] ?? []).map((formUuid) =>
					projectForm(uuid, formUuid),
				),
			};
		}),
		people: {
			properties: orderedUserProperties(doc),
			roles: orderedUserTypes(doc),
			personas: orderedPersonas(doc),
		},
		organization: {
			levels: orderedOrganizationLevels(doc),
			properties: orderedLocationProperties(doc),
		},
		automations: orderedAutomations(doc).map((automation) => ({
			uuid: automation.uuid,
			definition: read("automation", automation.uuid, () =>
				encodeAuthoringValues(
					automationSchema,
					automation,
					authoringEncoders({ doc, tables }),
				),
			),
		})),
		unreadable,
	};
	return { ...content, digest: canonicalJsonDigest(content) };
}

export type BlueprintImplementation = ReturnType<
	typeof projectBlueprintImplementation
>;
