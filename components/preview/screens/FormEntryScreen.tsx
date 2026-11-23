"use client";

import { useMemo } from "react";
import { Button } from "@/components/shadcn/button";
import { useForm } from "@/lib/doc/hooks/useEntity";
import {
	formCaseSelections,
	ownFormSelectionIndex,
} from "@/lib/domain/advancedEntryDatums";
import { readPreviewScreen } from "@/lib/preview/engine/dataRefusal";
import {
	entrySessionData,
	entryWalksChoices,
} from "@/lib/preview/engine/entrySessionData";
import { previewSessionValues } from "@/lib/preview/engine/identity";
import { formLogicLookupsCovered } from "@/lib/preview/engine/lookupEvaluation";
import type { PreviewScreen } from "@/lib/preview/engine/types";
import {
	usePreviewLookupReload,
	usePreviewLookupStatus,
} from "@/lib/preview/engine/useLookupPreviewData";
import {
	useDeviceCaseDatabaseLoad,
	useNavigationDeviceCases,
} from "@/lib/preview/engine/useNavigationDeviceCases";
import { usePreviewMenuSource } from "@/lib/preview/hooks/usePreviewMenuSource";
import { useSelectedPreviewIdentity } from "@/lib/preview/hooks/useSelectedPreviewIdentity";
import { pushBuilderHistory } from "@/lib/routing/useClientPath";
import {
	useEditMode,
	usePreviewCaseTarget,
	usePreviewDevice,
	usePreviewMenuCaseSelections,
	useSetPreviewCaseTarget,
} from "@/lib/session/hooks";
import type {
	PreviewCaseChoice,
	PreviewEntryChoice,
} from "@/lib/session/types";
import { PreviewDataRefusalPanel } from "../shared/PreviewDataRefusal";
import { CaseListScreen } from "./CaseListScreen";
import { FormScreen } from "./FormScreen";

type Screen = Extract<PreviewScreen, { type: "form" }>;
const emptyChoices: readonly PreviewEntryChoice[] = [];

/** A form walks its entry choice by choice where it keeps its own choices
 * or a datum opens its single match automatically
 * (`entryWalksChoices`), unless the running session already bound its
 * cases (a case-first menu or a link), which the form opens on as usual. */
export function FormEntryScreen({ screen }: { screen: Screen }) {
	const form = useForm(screen.formUuid);
	const mode = useEditMode();
	const menu = usePreviewMenuSource();
	const target = usePreviewCaseTarget();
	const walks = useMemo(
		() =>
			form !== undefined &&
			(form.caseSelections !== undefined ||
				(target?.formUuid === screen.formUuid &&
					target.entryChoices !== undefined &&
					entryWalksChoices(menu.doc, screen.formUuid))),
		[form, target, screen.formUuid, menu.doc],
	);
	if (mode !== "preview" || !walks) return <FormScreen screen={screen} />;
	return <ConfiguredFormEntry screen={screen} />;
}

/** A manual choice is one history entry, including when two adjacent choices
 * use the same list. Each entry's saved prefix ends before its next choice. */
function ConfiguredFormEntry({ screen }: { screen: Screen }) {
	const menu = usePreviewMenuSource();
	const identity = useSelectedPreviewIdentity();
	const device = usePreviewDevice();
	const currentTarget = usePreviewCaseTarget();
	const target =
		currentTarget?.formUuid === screen.formUuid ? currentTarget : undefined;
	const setTarget = useSetPreviewCaseTarget();
	const menuSelections = usePreviewMenuCaseSelections();
	const restored = useNavigationDeviceCases(menu.caseTypes);
	const casesLoad = useDeviceCaseDatabaseLoad();
	const lookup = usePreviewLookupStatus();
	const reloadLookup = usePreviewLookupReload();
	const doc = menu.doc;
	const cases = target?.caseDatabase ?? restored.snapshot;
	const data = lookup.kind === "data" ? lookup.data : undefined;
	const prefix = target?.entryChoices ?? emptyChoices;
	const needsCases = formCaseSelections(doc, screen.formUuid).length > 0;
	const lookupReady = formLogicLookupsCovered(doc, screen.formUuid, data);
	const output = useMemo(() => {
		if (!identity || (needsCases && cases === null) || !lookupReady)
			return undefined;
		return readPreviewScreen(() =>
			entrySessionData(doc, screen.formUuid, {
				// The form controller mints created-case IDs after the final choice.
				appId: undefined,
				entryKey: "",
				boundCases: target?.cases ?? [],
				entryChoices: prefix,
				menuSelections,
				caseDatabase: cases,
				session: previewSessionValues(identity, device),
				lookupData: data,
			}),
		);
	}, [
		doc,
		screen.formUuid,
		needsCases,
		cases,
		data,
		identity,
		device,
		lookupReady,
		target?.cases,
		prefix,
		menuSelections,
	]);
	if (!output) {
		if (casesLoad.status === "error" || lookup.kind === "error")
			return (
				<Button
					onClick={() => {
						if (casesLoad.status === "error") void casesLoad.retry();
						if (lookup.kind === "error") reloadLookup();
					}}
				>
					Try loading records again
				</Button>
			);
		return (
			<p role="status" className="p-4 text-sm text-nova-text-muted">
				Opening the form
			</p>
		);
	}
	if (output.kind === "refused")
		return (
			<PreviewDataRefusalPanel
				surface="form"
				reason={output.refusal.reason}
				moduleUuid={screen.moduleUuid}
			/>
		);
	const { nextSelection, resolvedEntryValues } = output.value;
	if (nextSelection) {
		const choose = (row: PreviewCaseChoice, automatic: boolean) => {
			const entryChoices = [
				...prefix,
				{
					...row,
					selectionUuid: nextSelection.selectionUuid,
					earlierValues: resolvedEntryValues,
				},
			];
			const ownIndex = ownFormSelectionIndex(doc, screen.formUuid);
			const ownId =
				ownIndex === undefined
					? undefined
					: formCaseSelections(doc, screen.formUuid)[ownIndex]?.uuid;
			const own = entryChoices.find((choice) => choice.selectionUuid === ownId);
			if (!automatic) pushBuilderHistory(window.location.href, false);
			setTarget({
				...target,
				formUuid: screen.formUuid,
				entryChoices,
				...(own && { cases: [{ caseId: own.caseId, caseName: own.caseName }] }),
			});
		};
		return (
			<section aria-label={nextSelection.name}>
				<header className="flex items-center gap-3 px-4 pt-3">
					{prefix.length > 0 && (
						<Button variant="ghost" onClick={() => window.history.back()}>
							Back
						</Button>
					)}
					<h1 className="font-display text-lg font-semibold">
						{nextSelection.name}
					</h1>
				</header>
				<CaseListScreen
					key={nextSelection.selectionUuid}
					screen={{ type: "caseList", moduleUuid: nextSelection.moduleUuid }}
					current
					entryStep={{
						...nextSelection,
						sessionData: output.value.data,
						onChoose: choose,
					}}
				/>
			</section>
		);
	}
	return (
		<FormScreen
			screen={{ ...screen, ...(target?.cases && { cases: target.cases }) }}
			heldEntryValues={resolvedEntryValues}
		/>
	);
}
