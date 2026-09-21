import {
	assignedLocationUuids,
	type BlueprintDoc,
	orderedOrganizationLevels,
	orderedPersonas,
	orderedUserProperties,
	orderedUserTypes,
	personaUserData,
} from "@/lib/domain";

/** Configuration facts only. Entry eligibility is observed in the running app;
 * a role or complete property set alone is not proof of a usable journey. */
export function workerReadiness(doc: BlueprintDoc) {
	const properties = orderedUserProperties(doc);
	const roles = orderedUserTypes(doc);
	const personas = orderedPersonas(doc);
	const assignmentLevels = orderedOrganizationLevels(doc)
		.filter((level) => level.caseFlow.workers === "assigned")
		.map(({ uuid, name }) => ({ uuid, name }));
	return {
		basis:
			"Authored worker configuration. Saved worker-record answers can differ; check the running app for actual entry eligibility.",
		asMember: {
			workerInformation:
				"The signed-in member starts without a configured role, worker information or assigned places.",
			missingRequiredInformation: properties
				.filter((p) => p.required)
				.map((p) => p.slug),
		},
		rolesWithoutPersonas: roles
			.filter((role) => !personas.some((p) => p.userTypeUuid === role.uuid))
			.map(({ uuid, name }) => ({ uuid, name })),
		assignmentLevels,
		personas: personas.map((persona) => {
			const values = personaUserData(persona, doc);
			const locations = assignedLocationUuids(persona.locations);
			return {
				uuid: persona.uuid,
				name: persona.name,
				...(persona.userTypeUuid && { roleUuid: persona.userTypeUuid }),
				effectiveValues: properties.map((p) => ({
					name: p.slug,
					value: values[p.uuid] ?? "",
				})),
				missingRequiredInformation: properties
					.filter((p) => p.required && !values[p.uuid]?.trim())
					.map((p) => p.slug),
				assignedLocationUuids: locations,
				locationContext:
					locations.length > 0
						? "assigned-places"
						: assignmentLevels.length > 0
							? "no-assigned-place"
							: "unassigned",
			};
		}),
	};
}
