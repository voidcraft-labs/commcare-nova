import {
	isOrdinaryCaseSearchConfig,
	type OrdinaryCaseSearchConfig,
	projectSearchOf,
	type SearchInputDef,
} from "@/lib/domain/modules";
import type { Uuid } from "@/lib/domain/uuid";
import { caseSearchConfigPatchMutations } from "./caseSearchConfigPatchMutations";
import type { BlueprintDoc, Mutation } from "./types";

type Defaults = NonNullable<
	OrdinaryCaseSearchConfig["projectSearch"]
>["defaults"];
type Destination =
	| { kind: "create"; uuid: Uuid; name: string }
	| { kind: "existing"; uuid: Uuid };
type Change =
	| {
			kind: "project";
			destination: Destination;
			defaults: Defaults;
			replaceFieldMatching: boolean;
	  }
	| { kind: "rename"; uuid: Uuid; name: string }
	| { kind: "remove"; uuid: Uuid }
	| { kind: "ordinary"; properties: ReadonlyMap<Uuid, string> };

type OrdinarySearchField = Extract<
	SearchInputDef,
	{ kind: "simple" | "advanced" }
>;

function questionWithoutMatching(field: OrdinarySearchField) {
	if (field.kind === "advanced") {
		const { predicate: _predicate, ...question } = field;
		return question;
	}
	const {
		property: _property,
		via: _via,
		mode: _mode,
		matching: _matching,
		...question
	} = field;
	return question;
}

function toParameter(field: OrdinarySearchField): SearchInputDef {
	const question = questionWithoutMatching(field);
	if ("options" in question) {
		const { options, ...visible } = question;
		if (options.kind !== "lookup")
			throw new Error(
				`Choose a lookup table for “${question.label || question.name}” before switching to a project search.`,
			);
		return { ...visible, options, kind: "parameter", sendAnswer: true };
	}
	return { ...question, kind: "parameter", sendAnswer: true };
}

/** Switching the source changes the meaning of each field. Keep its identity,
 * labels, validation and choice source. Each saved answer still has the same
 * consumers after a switch. The caller explicitly chooses when to replace
 * ordinary matching rules or how to match fields when going back. */
export function projectSearchEditBatch(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
	change: Change,
): Mutation[] {
	const module = doc.modules[moduleUuid];
	if (!module) throw new Error("This menu is no longer in the app.");
	if (change.kind === "rename" || change.kind === "remove") {
		if (!Object.hasOwn(doc.appSettings.projectSearches ?? {}, change.uuid))
			throw new Error(
				"That search was removed. Choose a search in the current app.",
			);
		if (change.kind === "remove") {
			const uses = Object.values(doc.modules).filter(
				(other) => projectSearchOf(other)?.searchUuid === change.uuid,
			);
			if (uses.length)
				throw new Error(
					"Choose another search in " +
						uses.map((other) => other.name).join(", ") +
						" before removing this search.",
				);
			return [
				{
					kind: "setAppSettings",
					settings: {
						projectSearch: { operation: "remove", uuid: change.uuid },
					},
				},
			];
		}
		return [
			{
				kind: "setAppSettings",
				settings: {
					projectSearch: {
						operation: "rename",
						uuid: change.uuid,
						name: change.name,
					},
				},
			},
		];
	}
	const current = module.caseSearchConfig;
	const ordinary: OrdinaryCaseSearchConfig = isOrdinaryCaseSearchConfig(current)
		? { ...current }
		: current
			? { excludedOwnerIds: current.excludedOwnerIds }
			: {};
	const fields = module.caseListConfig?.searchInputs ?? [];
	const mutations: Mutation[] = [];
	const changeField = (field: SearchInputDef) => {
		const { uuid, ...searchInput } = field;
		mutations.push({
			kind: "updateSearchInput",
			moduleUuid,
			uuid,
			searchInput,
		});
	};
	if (change.kind === "ordinary") {
		if (!projectSearchOf(module)) return [];
		for (const field of fields) {
			if (field.kind === "hidden" && field.sendAnswer) {
				const { sendAnswer: _send, ...hidden } = field;
				changeField(hidden);
			}
			if (field.kind !== "parameter") continue;
			const property = change.properties.get(field.uuid);
			if (!property)
				throw new Error(
					`Choose the case property “${field.label || field.name}” will search before switching back.`,
				);
			const { sendAnswer: _send, ...question } = field;
			if (question.type === "date-range")
				changeField({
					...question,
					kind: "simple",
					property,
					mode: { kind: "range" },
				});
			else changeField({ ...question, kind: "simple", property });
		}
		delete ordinary.projectSearch;
	} else {
		const { destination } = change;
		if (destination.kind === "create") {
			if (doc.appSettings.projectSearches?.[destination.uuid])
				throw new Error(
					"That search already belongs to the app. Choose it from the app’s searches.",
				);
			mutations.push({
				kind: "setAppSettings",
				settings: {
					projectSearch: {
						operation: "add",
						uuid: destination.uuid,
						name: destination.name,
					},
				},
			});
		} else if (!doc.appSettings.projectSearches?.[destination.uuid])
			throw new Error(
				"That search was removed. Choose a search in the current app.",
			);
		for (const field of fields) {
			if (field.kind !== "simple" && field.kind !== "advanced") continue;
			if (!change.replaceFieldMatching)
				throw new Error(
					"Switching makes the project space decide which cases match these answers. Review the fields before replacing their matching rules.",
				);
			changeField(toParameter(field));
		}
		ordinary.projectSearch = {
			searchUuid: destination.uuid,
			defaults: change.defaults,
		};
	}
	return [
		...mutations,
		...caseSearchConfigPatchMutations(moduleUuid, current, ordinary),
	];
}
