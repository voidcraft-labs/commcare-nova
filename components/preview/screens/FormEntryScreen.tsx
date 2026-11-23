"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { v4 as uuidv4 } from "uuid";
import { Button } from "@/components/shadcn/button";
import { entrySelectionSettings } from "@/lib/domain/formEntryCases";
import { blueprintRevisionDigest } from "@/lib/preview/engine/caseDataBindingClient";
import { entryWalksChoices } from "@/lib/preview/engine/entrySessionData";
import { readFormOpeningAction } from "@/lib/preview/engine/formOpeningAction";
import {
	type FormOpeningState,
	formNeedsOpeningEvidence,
} from "@/lib/preview/engine/formOpeningSnapshot";
import type { PreviewScreen } from "@/lib/preview/engine/types";
import { usePreviewMenuSource } from "@/lib/preview/hooks/usePreviewMenuSource";
import { useReloadableResource } from "@/lib/preview/hooks/useReloadableResource";
import {
	pushBuilderHistory,
	readBuilderHistoryMove,
} from "@/lib/routing/useClientPath";
import {
	useAppId,
	useEditMode,
	usePreviewCaseTarget,
	usePreviewDevice,
	usePreviewMenuCaseSelections,
	usePreviewPersonaUuid,
	usePreviewSessionId,
	useSetPreviewCaseTarget,
} from "@/lib/session/hooks";
import { useBuilderSessionApi } from "@/lib/session/provider";
import type { PreviewCaseChoice } from "@/lib/session/types";
import { PreviewDataRefusalPanel } from "../shared/PreviewDataRefusal";
import { CaseListScreen } from "./CaseListScreen";
import { FormScreen } from "./FormScreen";

type Screen = Extract<PreviewScreen, { type: "form" }>;
type OpeningResult = Awaited<ReturnType<typeof readFormOpeningAction>>;
type RequestResult =
	| { kind: "loading" }
	| Exclude<OpeningResult, { kind: "opening" }>
	| { kind: "ready"; opening: FormOpeningState };

/** A form opens through its signed opening where it needs one
 * (`formNeedsOpeningEvidence`) or where it walks its entry choice by choice
 * because a datum opens its single match automatically
 * (`entryWalksChoices`), unless the running session already bound its
 * cases (a case-first menu or a link), which the form opens on as usual. */
export function FormEntryScreen({ screen }: { screen: Screen }) {
	const { doc } = usePreviewMenuSource();
	const mode = useEditMode();
	const run = usePreviewSessionId();
	const target = usePreviewCaseTarget();
	const walks =
		target?.formUuid === screen.formUuid &&
		target.entryChoices !== undefined &&
		entryWalksChoices(doc, screen.formUuid);
	if (
		mode !== "preview" ||
		!(walks || formNeedsOpeningEvidence(doc, screen.formUuid))
	)
		return <FormScreen screen={screen} />;
	return (
		<ConfiguredFormEntry
			key={`${screen.moduleUuid}/${screen.formUuid}/${run}`}
			screen={screen}
			run={run}
		/>
	);
}

function ConfiguredFormEntry({ screen, run }: { screen: Screen; run: string }) {
	const { doc } = usePreviewMenuSource();
	const app = useAppId();
	const persona = usePreviewPersonaUuid();
	const device = usePreviewDevice();
	const current = usePreviewCaseTarget();
	const setTarget = useSetPreviewCaseTarget();
	const session = useBuilderSessionApi();
	const target = current?.formUuid === screen.formUuid ? current : undefined;
	const stored =
		target?.opening?.binding.run === run &&
		target.opening.binding.module === screen.moduleUuid
			? target.opening
			: undefined;
	const [entry, setEntry] = useState(() => uuidv4());
	const [choiceFailure, setChoiceFailure] = useState<RequestResult>();
	const pending = useRef(false);
	const issuedHere = useRef<string | undefined>(undefined);
	const mounted = useRef(false);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);
	const bound =
		// A second entry keeps its own choices, as a form with its own does.
		entrySelectionSettings(doc.forms[screen.formUuid]) === undefined
			? (screen.cases ?? target?.cases)
			: undefined;
	const linkedChoices = target?.openedByLink ? target.entryChoices : undefined;
	const selections = usePreviewMenuCaseSelections();
	const parentChoices = useMemo(() => {
		const chosen: Record<string, string[]> = {};
		const seen = new Set([screen.moduleUuid]);
		let parent = doc.modules[screen.moduleUuid]?.parentCaseModuleUuid;
		while (parent && !seen.has(parent)) {
			seen.add(parent);
			const selected = selections[parent];
			if (selected?.cases.length)
				chosen[parent] = selected.cases.map((row) => row.caseId);
			parent = doc.modules[parent]?.parentCaseModuleUuid;
		}
		return chosen;
	}, [doc, screen.moduleUuid, selections]);
	const token = useMemo(
		() => ({
			app,
			persona,
			device,
			doc,
			entry,
			stored,
			bound,
			parentChoices,
			linkedChoices,
		}),
		[
			app,
			persona,
			device,
			doc,
			entry,
			stored,
			bound,
			parentChoices,
			linkedChoices,
		],
	);
	const initial = useReloadableResource<RequestResult>({
		reloadToken: token,
		loading: { kind: "loading" },
		keepStale: () => false,
		toError: () => ({
			kind: "error",
			message: "The opening records could not be loaded.",
		}),
		prepare: () => {
			if (stored && issuedHere.current === stored.binding.evidence.signature)
				return { notReady: { kind: "ready", opening: stored } };
			if (!app) return { notReady: { kind: "loading" } };
			return {
				fetch: async () => {
					const blueprintDigest = await blueprintRevisionDigest(doc);
					const result = await readFormOpeningAction(
						{
							app,
							form: screen.formUuid,
							module: screen.moduleUuid,
							run,
							entry: stored?.entry ?? entry,
							blueprintDigest,
							persona,
							...(stored
								? { previous: stored.binding.evidence, restore: true as const }
								: {
										bound: bound?.map((choice) => choice.caseId),
										parentChoices,
										carried: linkedChoices?.map((row) => ({
											selection: row.selectionUuid,
											caseId: row.caseId,
										})),
									}),
						},
						device,
					);
					if (result.kind === "opening")
						issuedHere.current = result.evidence.signature;
					return result.kind === "opening"
						? {
								kind: "ready",
								opening: {
									entry: stored?.entry ?? entry,
									blueprintDigest,
									projection: result.projection,
									binding: {
										run,
										module: screen.moduleUuid,
										evidence: result.evidence,
									},
									next: result.next,
								},
							}
						: result;
				},
			};
		},
	});
	const loaded =
		initial.state.kind === "ready" ? initial.state.opening : undefined;
	const opening = stored
		? loaded?.binding.evidence.signature === stored.binding.evidence.signature
			? loaded
			: undefined
		: loaded?.entry === entry
			? loaded
			: undefined;
	const projection = opening?.projection;
	useEffect(() => {
		// Save the empty prefix too: Android Back can return to the first choice.
		if (opening && !stored && session.getState().previewSessionId === run) {
			setTarget({
				...target,
				formUuid: screen.formUuid,
				entryChoices: target?.entryChoices ?? [],
				opening,
			});
		}
	}, [opening, stored, session, run, setTarget, target, screen.formUuid]);
	const restart = useCallback(() => {
		setChoiceFailure(undefined);
		setEntry(uuidv4());
		setTarget({
			...target,
			formUuid: screen.formUuid,
			opening: undefined,
			entryChoices: [],
			cases: bound,
		});
	}, [target, screen.formUuid, setTarget, bound]);
	const failure =
		choiceFailure ??
		(initial.state.kind !== "ready" ? initial.state : undefined);
	if (failure?.kind === "data-refused")
		return (
			<PreviewDataRefusalPanel
				surface="form"
				reason={failure.reason}
				moduleUuid={screen.moduleUuid}
			/>
		);
	if (failure && failure.kind !== "loading" && failure.kind !== "ready") {
		return (
			<div className="space-y-3 p-4">
				<p role="status">
					{"message" in failure ? failure.message : "Sign in to open the form."}
				</p>
				<Button onClick={restart}>Reopen form</Button>
			</div>
		);
	}
	if (!app || !opening || !projection)
		return (
			<p role="status" className="p-4 text-sm text-nova-text-muted">
				Opening the form
			</p>
		);
	const next = opening.next;
	if (next) {
		const choose = async (row: PreviewCaseChoice, automatic: boolean) => {
			if (pending.current) return;
			pending.current = true;
			const move = readBuilderHistoryMove();
			const isCurrent = () =>
				mounted.current &&
				readBuilderHistoryMove() === move &&
				session.getState().previewSessionId === run &&
				session.getState().previewCaseTarget?.opening?.binding.evidence
					.signature === opening.binding.evidence.signature;
			try {
				const result = await readFormOpeningAction(
					{
						app,
						form: screen.formUuid,
						module: screen.moduleUuid,
						run,
						entry: opening.entry,
						blueprintDigest: opening.blueprintDigest,
						persona,
						previous: opening.binding.evidence,
						choice: { selection: next.selectionUuid, caseId: row.caseId },
					},
					device,
				);
				if (!isCurrent()) return;
				if (result.kind !== "opening") {
					setChoiceFailure(result);
					return;
				}
				issuedHere.current = result.evidence.signature;
				const entryChoices = [
					...(target?.entryChoices ?? []),
					{
						...row,
						selectionUuid: next.selectionUuid,
						earlierValues: projection.resolvedEntries,
					},
				];
				if (!automatic) pushBuilderHistory(window.location.href, false);
				setTarget({
					...target,
					formUuid: screen.formUuid,
					entryChoices,
					opening: {
						...opening,
						projection: result.projection,
						binding: { ...opening.binding, evidence: result.evidence },
						next: result.next,
					},
				});
			} catch {
				if (isCurrent())
					setChoiceFailure({
						kind: "error",
						message: "The chosen record could not be opened.",
					});
			} finally {
				pending.current = false;
			}
		};
		return (
			<section aria-label={next.name}>
				<header className="flex items-center gap-3 px-4 pt-3">
					{projection.choices.length > 0 && (
						<Button variant="ghost" onClick={() => window.history.back()}>
							Back
						</Button>
					)}
					<h1 className="font-display text-lg font-semibold">{next.name}</h1>
				</header>
				<CaseListScreen
					key={next.selectionUuid}
					screen={{ type: "caseList", moduleUuid: next.moduleUuid }}
					current
					entryStep={{
						...next,
						sessionData: projection.sessionData,
						onChoose: (row, automatic) => {
							void choose(row, automatic);
						},
					}}
				/>
			</section>
		);
	}
	return (
		<FormScreen
			key={opening.entry}
			screen={screen}
			opening={opening}
			projection={projection}
			onReopen={restart}
		/>
	);
}
