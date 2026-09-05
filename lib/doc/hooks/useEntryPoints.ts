"use client";
import { useCallback, useContext, useMemo } from "react";
import { BlueprintAuthoringLanguageContext } from "@/lib/doc/authoringLanguageContext";
import { builderWriteAdmission } from "@/lib/doc/builderWriteAdmission";
import { useLookupCommitState } from "@/lib/doc/lookupCommitContext";
import { BlueprintEditableContext } from "@/lib/doc/provider";
import {
	asUuid,
	type CommitOutcome,
	type EntryPointTarget,
	entryPointInventory,
	type FormEntryPoint,
	projectLocalizedForm,
	projectLocalizedModule,
	resolveAppLanguage,
	suggestEntryPointId,
	type Uuid,
} from "@/lib/domain";
import {
	type EntryPointCommitPlan,
	planEntryPointAdd,
	planEntryPointRemove,
	planEntryPointUpdate,
} from "../entryPointMutations";
import {
	entryPointDestination,
	entryPointDestinations,
} from "../entryPointReview";
import type { Mutation } from "../types";
import { useBlueprintDoc, useBlueprintDocApi } from "./useBlueprintDoc";
import { useBlueprintMutations } from "./useBlueprintMutations";

export function useEntryPoints() {
	const doc = useBlueprintDoc((state) => state);
	const api = useBlueprintDocApi();
	const actions = useEntryPointActions();
	const selectedLanguage = useContext(BlueprintAuthoringLanguageContext);
	const isCurrent = useCallback(() => api.getState() === doc, [api, doc]);
	const canonicalDestinations = useMemo(
		() => entryPointDestinations(doc),
		[doc],
	);
	const destinations = useMemo(() => {
		const destinations = canonicalDestinations;
		if (selectedLanguage === null) return destinations;
		const language = resolveAppLanguage(doc.localization, selectedLanguage);
		return destinations.map((destination) => {
			const target = destination.target;
			const module = projectLocalizedModule(doc, language, target.moduleUuid);
			const form =
				target.kind === "form"
					? projectLocalizedForm(doc, language, target.formUuid)
					: undefined;
			return {
				...destination,
				label:
					target.kind === "form"
						? `${module?.name ?? "Module"} · ${form?.name ?? "Form"}`
						: `${module?.name ?? "Module"} · ${target.kind === "case-list" ? "Case list" : "Module"}`,
			};
		});
	}, [canonicalDestinations, doc, selectedLanguage]);
	return {
		...actions,
		isCurrent,
		destinations,
		entries: destinations.filter(
			(destination) => destination.entryPoint !== undefined,
		),
	};
}

/** Event-time writes without subscribing a destination's settings to the app. */
export function useEntryPointActions() {
	const canEdit = useContext(BlueprintEditableContext);
	const lookupCommitState = useLookupCommitState();
	const writeAdmission = builderWriteAdmission({ canEdit, lookupCommitState });
	const api = useBlueprintDocApi();
	const mutations = useBlueprintMutations();
	const commit = (plan: EntryPointCommitPlan): CommitOutcome =>
		plan.ok
			? mutations.inline.commitMany([...plan.mutations])
			: { ok: false, messages: [plan.reason.message] };
	return {
		writeAdmission,
		add(target: EntryPointTarget): CommitOutcome & { uuid?: Uuid } {
			const current = api.getState();
			const destination = entryPointDestination(current, target);
			if (destination.issue)
				return { ok: false, messages: [destination.issue] };
			const uuid = asUuid(crypto.randomUUID());
			const id = suggestEntryPointId(current, target);
			const outcome = commit(planEntryPointAdd(current, target, { uuid, id }));
			return { ...outcome, ...(outcome.ok ? { uuid } : {}) };
		},
		update(
			base: FormEntryPoint,
			patch: Extract<Mutation, { kind: "updateEntryPoint" }>["patch"],
		): CommitOutcome {
			const current = api.getState();
			const entry = entryPointInventory(current).find(
				(item) => item.entryPoint.uuid === base.uuid,
			)?.entryPoint;
			if (JSON.stringify(entry) !== JSON.stringify(base))
				return {
					ok: false,
					messages: [
						"This deep link changed in another editor. Review the shared settings and try again.",
					],
				};
			return commit(planEntryPointUpdate(current, base.uuid, patch));
		},
		remove(uuid: Uuid) {
			return commit(planEntryPointRemove(api.getState(), uuid));
		},
	};
}
