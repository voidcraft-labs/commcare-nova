/**
 * useFormEngine — activate the form preview's engine for a given form.
 *
 * Calls `controller.activateForm(formUuid, caseData)` on mount and
 * `controller.deactivate()` on unmount (or when the form UUID changes).
 * The controller itself comes from `BuilderFormEngineProvider`, so this
 * hook only owns the per-screen lifecycle: wiring the doc store
 * subscriptions (expression fingerprint, field order, form metadata)
 * that back per-field runtime state for the active form.
 *
 * Pass `undefined` for `formUuid` while the URL is still being parsed —
 * the effect no-ops until a real UUID arrives. The controller is
 * returned for imperative access (`setValue`, `touch`, `validateAll`)
 * by the form screen.
 */
"use client";
import { useEffect, useRef } from "react";
import type { Uuid } from "@/lib/doc/types";
import type { EngineController } from "@/lib/preview/engine/engineController";
import type { CaseDataByType } from "@/lib/preview/engine/formEngine";
import { useBuilderFormEngine } from "@/lib/preview/engine/provider";
import type { CaseDatabaseSnapshot } from "@/lib/preview/engine/xpathInstances";
import { useAccessPhase, useAppId, useProjectId } from "@/lib/session/hooks";

/** A list row and its later detail read can supply identical preloads through
 * different Map instances. They do not represent a new engine input. */
function sameCasePreloads(
	a: CaseDataByType | undefined,
	b: CaseDataByType | undefined,
): boolean {
	if (a === b) return true;
	if (a === undefined || b === undefined || a.size !== b.size) return false;
	for (const [type, properties] of a) {
		const other = b.get(type);
		if (other === undefined || other.size !== properties.size) return false;
		for (const [property, value] of properties)
			if (!other.has(property) || other.get(property) !== value) return false;
	}
	return true;
}

export function useFormEngine(
	formUuid: Uuid | undefined,
	caseData?: CaseDataByType,
	caseDatabase?: CaseDatabaseSnapshot,
	/** An admitted no-matches launch's search answers; fixed for the entry,
	 * like `caseDatabase`. */
	searchAnswers?: ReadonlyMap<string, string>,
): EngineController {
	const controller = useBuilderFormEngine();
	const accessPhase = useAccessPhase();
	const appId = useAppId();
	const projectId = useProjectId();
	const appliedPreloads = useRef<CaseDataByType | undefined>(undefined);

	/* A form transition is a genuinely new entry. Access refreshes are not:
	 * `beginAccessRefresh()` deliberately pauses write authority before the
	 * authoritative snapshot returns, but the same app/form/worker must keep
	 * its entry key, answers, and attachment coordinator state throughout that
	 * window. The app/provider and preview-identity lifecycles own their own
	 * terminal boundaries. */
	// biome-ignore lint/correctness/useExhaustiveDependencies: caseData cold arrivals rebuild the same entry in the authorized effect below; caseDatabase and searchAnswers are explicit navigation snapshots captured only for the initial activation
	useEffect(() => {
		if (!formUuid) {
			controller.deactivate();
			return;
		}
		if (controller.entryStore.getState().fault?.formUuid === formUuid) return;
		appliedPreloads.current = caseData;
		const activation = controller.activateFormAsync(
			formUuid,
			caseData,
			caseDatabase,
			searchAnswers,
		);
		activation.catch(() => undefined);
		return () => controller.deactivate();
	}, [controller, formUuid]);

	/* A confirmed terminal access state is different from a transient refresh:
	 * retire the entry immediately and never let it survive revoked access or a
	 * client-version boundary. These phases cannot transition back to
	 * authorized without replacing the surrounding builder session. */
	useEffect(() => {
		if (accessPhase === "revoked" || accessPhase === "upgradeRequired") {
			controller.deactivate();
		}
	}, [accessPhase, controller]);

	/* Case data commonly resolves after the screen activates. Rebuild the same
	 * entry so its attachment key survives that cold arrival. A confirmed
	 * app/Project change deactivates the provider controller synchronously; the
	 * authorized snapshot then activates a fresh entry even for survey and
	 * registration forms whose `caseData` is undefined. */
	// biome-ignore lint/correctness/useExhaustiveDependencies: appId/projectId re-run activation after the provider retires a confirmed old scope
	useEffect(() => {
		if (!formUuid || accessPhase !== "authorized") {
			return;
		}
		if (controller.entryStore.getState().fault?.formUuid === formUuid) return;
		if (controller.formUuid !== formUuid) {
			appliedPreloads.current = caseData;
			controller
				.activateFormAsync(formUuid, caseData, caseDatabase, searchAnswers)
				.catch(() => undefined);
			return;
		}
		if (caseData === undefined) return;
		if (sameCasePreloads(appliedPreloads.current, caseData)) return;
		appliedPreloads.current = caseData;
		controller
			.rebuildActiveFormAsync(formUuid, caseData)
			.catch(() => undefined);
	}, [
		controller,
		formUuid,
		caseData,
		caseDatabase,
		searchAnswers,
		accessPhase,
		appId,
		projectId,
	]);

	return controller;
}
