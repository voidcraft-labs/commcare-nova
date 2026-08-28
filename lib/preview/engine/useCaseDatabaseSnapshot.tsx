"use client";

import { memo, type ReactNode, useLayoutEffect, useMemo } from "react";
import { useReconcilerContext } from "@/lib/collab/context";
import { authoredXPathCarriers } from "@/lib/commcare/xpath/carriers";
import { useBlueprintDocEq } from "@/lib/doc/hooks/useBlueprintDoc";
import {
	type BlueprintDoc,
	materializableCaseTypes,
	USERCASE_CASE_TYPE,
} from "@/lib/domain";
import { useCaseDatabaseRevision } from "@/lib/preview/hooks/caseDataInvalidation";
import { useRestoreScopeKey } from "@/lib/preview/hooks/useRestoreScopeKey";
import {
	useAccessPhase,
	useAppId,
	usePreviewPersonaUuid,
	useProjectScopeEpoch,
} from "@/lib/session/hooks";
import { useEngineController } from "../hooks/useEngineController";
import { useReloadableResource } from "../hooks/useReloadableResource";
import { loadCaseDatabaseSnapshotAction } from "./caseDataBinding";
import type { CaseDatabaseControllerState } from "./engineController";
import {
	xpathReferencesCaseDatabaseHashtag,
	xpathReferencesInstance,
} from "./xpathInstanceReferences";
import type { CaseDatabaseSnapshot } from "./xpathInstances";

type CaseDatabaseState =
	| { readonly kind: "idle" }
	| { readonly kind: "loading" }
	| {
			readonly kind: "data";
			readonly token: string;
			readonly snapshot: CaseDatabaseSnapshot;
	  }
	| { readonly kind: "error"; readonly token: string };

interface CaseDatabaseRequirements {
	readonly required: boolean;
	readonly caseTypes: readonly string[];
}

const CaseDatabaseResourceBoundary = memo(
	function CaseDatabaseResourceBoundary({
		state,
		children,
	}: {
		readonly state: "idle" | "loading" | "ready" | "error";
		readonly children: ReactNode;
	}) {
		return (
			<>
				<span
					hidden
					aria-hidden="true"
					data-builder-resource="case-database"
					data-state={state}
				/>
				{children}
			</>
		);
	},
);

/** Canonical carrier scan shared by the hook and focused contract tests. A
 * session-only form-link reference must load casedb even when no form bind
 * reads it, because links execute after submission against the same device
 * instance world. */
export function caseDatabaseRequirements(
	doc: BlueprintDoc,
): CaseDatabaseRequirements {
	const explicitReference = authoredXPathCarriers(doc).some(
		(carrier) =>
			(carrier.profile === "preview-form" ||
				carrier.profile === "preview-session") &&
			(xpathReferencesInstance(carrier.source, "casedb") ||
				xpathReferencesCaseDatabaseHashtag(carrier.source)),
	);
	/* After-submit routing can carry an existing case, select an unchanged
	 * related case, or walk an unchanged ancestor even when none of its authored
	 * XPath mentions `instance('casedb')`. The transaction patch contains only
	 * affected rows, so every linked, case-bearing app needs the entry-time
	 * device snapshot as its baseline. */
	const hasAfterSubmitLink = Object.values(doc.forms).some(
		(form) => (form.formLinks?.length ?? 0) > 0,
	);
	const hasCaseBearingModule = Object.values(doc.modules).some(
		(module) => module.caseType !== undefined,
	);
	const required =
		explicitReference || (hasAfterSubmitLink && hasCaseBearingModule);
	const caseTypes = required
		? [
				...materializableCaseTypes(doc).map((caseType) => caseType.name),
				USERCASE_CASE_TYPE,
			].sort()
		: [];
	return { required, caseTypes };
}

function sameRequirements(
	left: CaseDatabaseRequirements,
	right: CaseDatabaseRequirements,
): boolean {
	return (
		left.required === right.required &&
		left.caseTypes.length === right.caseTypes.length &&
		left.caseTypes.every(
			(caseType, index) => right.caseTypes[index] === caseType,
		)
	);
}

/** Select only the facts that control the expensive device snapshot. The
 * server re-reads the committed blueprint; the client scan merely avoids
 * loading every case row for an app whose forms never address casedb. */
function useCaseDatabaseRequirements(): CaseDatabaseRequirements {
	return useBlueprintDocEq(caseDatabaseRequirements, sameRequirements);
}

/** Installs one device-scoped casedb snapshot on the long-lived form-engine
 * controller. It follows worker assignment, Project scope, and every affected
 * case-type invalidation; the action independently reauthorizes each read. */
export function PreviewCaseDatabaseProvider({
	children,
}: {
	children: ReactNode;
}) {
	const controller = useEngineController();
	const appId = useAppId();
	const accessPhase = useAccessPhase();
	const scopeEpoch = useProjectScopeEpoch();
	const personaUuid = usePreviewPersonaUuid();
	const restoreScopeKey = useRestoreScopeKey(personaUuid);
	const reconciler = useReconcilerContext();
	const runtimeScopeId = reconciler?.projectScopeId ?? "provider-light";
	const requirements = useCaseDatabaseRequirements();
	const caseRevision = useCaseDatabaseRevision(appId, requirements.caseTypes);

	const reloadToken = useMemo(
		() =>
			[
				runtimeScopeId,
				String(scopeEpoch),
				appId ?? "",
				accessPhase,
				personaUuid ?? "me",
				restoreScopeKey,
				requirements.caseTypes.join(","),
				caseRevision,
			].join("\u0000"),
		[
			runtimeScopeId,
			scopeEpoch,
			appId,
			accessPhase,
			personaUuid,
			restoreScopeKey,
			requirements.caseTypes,
			caseRevision,
		],
	);

	const { state } = useReloadableResource<CaseDatabaseState>({
		prepare: () => {
			if (
				!requirements.required ||
				appId === undefined ||
				accessPhase !== "authorized"
			) {
				return { notReady: { kind: "idle" } };
			}
			const selectedAppId = appId;
			return {
				fetch: async () => {
					const result = await loadCaseDatabaseSnapshotAction(
						selectedAppId,
						personaUuid,
					);
					return result.kind === "data"
						? { kind: "data", token: reloadToken, snapshot: result.snapshot }
						: { kind: "error", token: reloadToken };
				},
			};
		},
		loading: { kind: "loading" },
		toError: () => ({ kind: "error", token: reloadToken }),
		keepStale: (previous) => previous.kind === "data",
		reloadToken,
	});

	const controllerState = useMemo((): CaseDatabaseControllerState => {
		if (!requirements.required) return { required: false };
		if (
			accessPhase === "authorized" &&
			state.kind === "data" &&
			state.token === reloadToken
		) {
			return { required: true, status: "ready", snapshot: state.snapshot };
		}
		if (
			accessPhase === "authorized" &&
			state.kind === "error" &&
			state.token === reloadToken
		) {
			return { required: true, status: "error" };
		}
		return { required: true, status: "loading" };
	}, [accessPhase, reloadToken, requirements.required, state]);

	/* Descendant form activation uses passive effects. Commit the gate in a
	 * layout effect so it is installed before any descendant activation without
	 * mutating the long-lived controller during a render React may abandon. The
	 * setter semantic-compares states and changes controller state only on a
	 * material transition. */
	useLayoutEffect(() => {
		controller.setCaseDatabaseState(controllerState);
	}, [controller, controllerState]);

	return (
		<CaseDatabaseResourceBoundary
			state={controllerState.required ? controllerState.status : "idle"}
		>
			{children}
		</CaseDatabaseResourceBoundary>
	);
}
