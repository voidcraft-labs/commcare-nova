import {
	assignedLocationUuids,
	levelHoldsWorkers,
	organizationLevelsOf,
	type Persona,
} from "@/lib/domain";
import { locationChoiceLabel } from "@/lib/organization/locationLabels";
import {
	type OrganizationRuleInputs,
	personaAssignmentIssue,
	personaAssignmentRemovalIssues,
} from "@/lib/organization/ownerTargetVerdicts";
import type { StoredLocation } from "@/lib/organization/types";
import {
	PERSONA_LOCATION_PAGE_SIZE,
	personaLocationPage,
} from "./organizationUi";

export interface PersonaLocationEditorInputs {
	readonly doc: OrganizationRuleInputs;
	readonly persona: Persona;
	readonly locations: readonly StoredLocation[];
	readonly loading: boolean;
	readonly error: string | undefined;
	readonly warning: string | undefined;
	readonly refreshing: boolean;
	readonly canEdit: boolean;
	readonly requestedPage: number;
}

/** Render the current catalog and authored assignments without interpreting an
 * incomplete read as deletion. Preflight only the visible removal candidates. */
export function personaLocationEditor(input: PersonaLocationEditorInputs) {
	const { doc, persona, locations, requestedPage, canEdit } = input;
	const assigned = assignedLocationUuids(persona.locations);
	const assignedSet = new Set(assigned);
	const authoritative =
		!input.loading &&
		input.error === undefined &&
		input.warning === undefined &&
		!input.refreshing;
	const levels = organizationLevelsOf(doc);
	const assignable = locations.filter(
		(location) =>
			location.archivedAt === null &&
			levels[location.levelUuid] !== undefined &&
			levelHoldsWorkers(levels[location.levelUuid]),
	);
	const available = assignable.filter(
		(location) => !assignedSet.has(location.id),
	);
	const assignedPage = personaLocationPage(assigned, requestedPage);
	const byId = new Map<string, StoredLocation>(
		locations.map((location) => [location.id, location]),
	);
	const removalIssues =
		canEdit && authoritative
			? personaAssignmentRemovalIssues(
					doc,
					locations,
					persona.uuid,
					assigned,
					assignedPage.ids,
				)
			: new Map<string, string>();
	const rows = assignedPage.ids.map((id, pageIndex) => {
		const location = byId.get(id);
		return {
			id,
			index: assignedPage.start + pageIndex,
			location,
			label:
				location !== undefined
					? locationChoiceLabel(location)
					: authoritative
						? "A place that no longer exists"
						: input.warning !== undefined
							? "Assigned place unavailable until places reload"
							: "Refreshing assigned place",
		};
	});
	const emptyMessage =
		authoritative && assigned.length === 0 && assignable.length === 0
			? locations.length === 0
				? "This app has no places yet. Add them in Organization, then assign this persona to one."
				: "No live place is at a level where people work. Change a level in Organization, then assign this persona."
			: undefined;
	return {
		assigned,
		assignedPage,
		authoritative,
		available,
		rows,
		removalIssues,
		emptyMessage,
	};
}

export type PersonaLocationChange = {
	readonly kind: "add" | "remove" | "main";
	readonly id: string;
};

/** A gesture proposes a complete assignment. The document mutation still owns
 * final admission; its refusal must not advance the page or reorder focus. */
export function planPersonaLocationChange(
	input: PersonaLocationEditorInputs,
	change: PersonaLocationChange,
):
	| {
			readonly ids: readonly string[];
			readonly page: number;
			readonly removedIndex?: number;
			readonly focusIndex?: number;
	  }
	| undefined {
	if (
		!input.canEdit ||
		input.loading ||
		input.error !== undefined ||
		input.warning !== undefined ||
		input.refreshing
	)
		return undefined;
	const assigned = assignedLocationUuids(input.persona.locations);
	const index = assigned.indexOf(change.id);
	if (change.kind === "add" ? index >= 0 : index < 0) return undefined;
	if (
		change.kind === "add" &&
		!input.locations.some((row) => row.id === change.id)
	)
		return undefined;
	const ids =
		change.kind === "add"
			? [...assigned, change.id]
			: change.kind === "main"
				? [change.id, ...assigned.filter((id) => id !== change.id)]
				: assigned.filter((id) => id !== change.id);
	if (
		personaAssignmentIssue(
			input.doc,
			input.locations,
			input.persona.uuid,
			ids,
		) !== undefined
	)
		return undefined;
	return {
		ids,
		page:
			change.kind === "main"
				? 0
				: change.kind === "add"
					? Math.floor(assigned.length / PERSONA_LOCATION_PAGE_SIZE)
					: personaLocationPage(ids, input.requestedPage).page,
		...(change.kind === "remove" ? { removedIndex: index } : {}),
		...(change.kind === "main" ? { focusIndex: 0 } : {}),
	};
}
