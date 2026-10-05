import {
	type PreviousTaskSelection,
	readPreviousTaskProjection,
} from "@/lib/commcare";
import {
	type BlueprintDoc,
	formNavigation as configuredFormNavigation,
	effectivePostSubmit,
	type NavigationDestination,
	type Uuid,
} from "@/lib/domain";

/** Authoring reads describe the same preceding task the running app resolves. */
export function formNavigation(doc: BlueprintDoc, formUuid: Uuid) {
	let previous: NavigationDestination | undefined;
	let retainedRecordSelections:
		| Omit<PreviousTaskSelection, "source">[]
		| undefined;
	if (effectivePostSubmit(doc, formUuid) === "previous") {
		const read = readPreviousTaskProjection(doc, formUuid);
		if (read.kind === "incomplete")
			return configuredFormNavigation(doc, formUuid, {
				screen: "unavailable",
				reason: read.reason,
			});
		const plan = read.projection;
		const target = plan.destination;
		retainedRecordSelections = plan.retainedSelections.map(
			({ source: _source, ...selection }) => selection,
		);
		previous =
			target.kind === "home"
				? { screen: "home" }
				: target.kind === "menu"
					? {
							screen: "menu",
							moduleUuid: target.moduleUuid,
							name: doc.modules[target.moduleUuid].name,
						}
					: {
							screen: "record-selection",
							moduleUuid: target.moduleUuid,
							formUuid: target.formUuid,
							selectingModuleUuids: target.selectingModuleUuids,
							name: doc.forms[target.formUuid].name,
						};
	}
	const navigation = configuredFormNavigation(doc, formUuid, previous);
	return (
		navigation && {
			...navigation,
			afterSubmit: {
				...navigation.afterSubmit,
				...(retainedRecordSelections !== undefined && {
					retainedRecordSelections,
				}),
			},
		}
	);
}
