"use client";
import { Icon } from "@iconify/react/offline";
import tablerLoader2 from "@iconify-icons/tabler/loader-2";
import tablerSparkles from "@iconify-icons/tabler/sparkles";
import { motion } from "motion/react";
import { useState } from "react";
import { useBlueprintDocApi } from "@/lib/doc/hooks/useBlueprintDoc";
import { useCaseTypes } from "@/lib/doc/hooks/useCaseTypes";
import { useModule as useModuleEntity } from "@/lib/doc/hooks/useEntity";
import { useFirstFormForModule } from "@/lib/doc/hooks/useFirstFormForModule";
import {
	caseRowDisplayValue,
	pickBlueprintDoc,
} from "@/lib/preview/engine/caseDataBindingHelpers";
import type { PreviewScreen } from "@/lib/preview/engine/types";
import {
	useCases,
	usePopulateSampleCases,
} from "@/lib/preview/hooks/useCaseDataBinding";
import { useLocation, useNavigate } from "@/lib/routing/hooks";
import { useAppId } from "@/lib/session/hooks";

interface CaseListScreenProps {
	/** This screen's identity — which module the case list belongs to.
	 *  Passed from PreviewShell so the component remains valid while Activity
	 *  hides it. */
	screen: Extract<PreviewScreen, { type: "caseList" }>;
}

/**
 * Case list screen — renders the running-app view's case-list table for
 * the active module's case-type.
 *
 * Subscribes to `useCases({appId, caseType})` and renders one of:
 *   - `loading` — spinner while the action is in flight.
 *   - `empty` — "Generate sample data" affordance per the spec's
 *     always-in-valid-state principle (an empty case-type is a button,
 *     not an error).
 *   - `rows` — the standard table; one row per `CaseRow`, columns
 *     supplied by `module.caseListColumns`. Cell values resolve through
 *     `caseRowDisplayValue` so a JSONB property reads as its display
 *     string regardless of underlying JSON shape.
 *   - `unauthenticated` / `error` — typed failure cards with the
 *     action's message.
 */
export function CaseListScreen({ screen: _screen }: CaseListScreenProps) {
	const loc = useLocation();
	const navigate = useNavigate();
	const caseTypes = useCaseTypes();
	const appId = useAppId();
	const docApi = useBlueprintDocApi();

	/** Module and form uuids from the URL — used for uuid-first navigation.
	 *  The case list screen is reached via `?m=<moduleUuid>&view=cases`. The
	 *  form that the user will enter after selecting a case is determined at
	 *  click time by looking up the first case-loading form in the module. */
	const moduleUuid = loc.kind === "cases" ? loc.moduleUuid : undefined;

	/** First form in this module — the case list always opens into it
	 *  (the case-loading form). Returns the whole entity so the header
	 *  row can show the form's display name without a second subscription. */
	const firstForm = useFirstFormForModule(moduleUuid);
	const firstFormUuid = firstForm?.uuid;
	const firstFormName = firstForm?.name;

	const mod = useModuleEntity(moduleUuid);
	const caseType = caseTypes.find((ct) => ct.name === mod?.caseType);
	const columns = mod?.caseListColumns ?? [];

	/** Subscribe to the case-list rows for this module's case-type.
	 *  The hook stays in `loading` until both `appId` and `caseType` are
	 *  bound — the URL parser may resolve the module before the session
	 *  store has populated `appId`. */
	const { state, reload } = useCases({
		appId,
		caseType: caseType?.name,
	});

	/** Populate-action callback. The hook closes over the live
	 *  blueprint snapshot, projected down to the bare `BlueprintDoc`
	 *  shape via `pickBlueprintDoc` — Server Actions reject function
	 *  values during serialization, and the store's state carries
	 *  action methods alongside the data. The `getState()` read does
	 *  not subscribe, so the component does not re-render on every
	 *  doc tick. */
	const populate = usePopulateSampleCases({
		appId,
		caseType: caseType?.name,
		blueprint:
			state.kind === "empty" ? pickBlueprintDoc(docApi.getState()) : undefined,
	});

	/** Local UI state for the populate button. The hook itself is stateless;
	 *  this component owns the spinner / error display because the visual
	 *  treatment is the consumer's responsibility (see the
	 *  `useCaseDataBinding.ts` hook docs for rationale). */
	const [populateStatus, setPopulateStatus] = useState<
		{ kind: "idle" } | { kind: "running" } | { kind: "error"; message: string }
	>({ kind: "idle" });

	/* `handleGenerate` is intentionally NOT wrapped in `useCallback`.
	 * `populate` is a fresh closure every render (see
	 * `usePopulateSampleCases` for rationale), so a `useCallback` on
	 * `[populate, reload]` would invalidate on every render —
	 * memoization would be structurally empty. Closure allocation is
	 * cheap; pretending to memoize is misleading. */
	const handleGenerate = async () => {
		setPopulateStatus({ kind: "running" });
		try {
			const result = await populate();
			if (result.kind === "ok") {
				setPopulateStatus({ kind: "idle" });
				reload();
				return;
			}
			setPopulateStatus({
				kind: "error",
				message:
					result.kind === "unauthenticated"
						? "Sign in to generate sample data."
						: result.message,
			});
		} catch {
			/* Wire-level failures (the Server Action's promise rejecting
			 * before its body ran — RSC serialization, transport, etc.)
			 * bypass the typed `result` arms entirely. The catch maps
			 * them to the same `error` shape so the button never sticks
			 * on "Generating..." after a network failure. */
			setPopulateStatus({
				kind: "error",
				message: "Could not generate sample data. Try again.",
			});
		}
	};

	if (!mod || !caseType || columns.length === 0) {
		return (
			<div className="p-6 text-center text-nova-text-muted">
				No case list configured for this module.
			</div>
		);
	}

	/** Navigate to the first form in the module (the case-loading form).
	 *  The form URL schema has slots for module / form / field UUIDs but
	 *  not for a case-id; the case-list-to-form transition lands the user
	 *  on the form without a bound case. `FormScreen`'s "no cases
	 *  available" empty state handles followup forms reached this way. */
	const handleRowClick = () => {
		if (!moduleUuid || !firstFormUuid) return;
		navigate.openForm(moduleUuid, firstFormUuid);
	};

	const heading = (
		<>
			<div className="flex items-center gap-2 mb-1">
				<h2 className="text-lg font-display font-semibold text-nova-text">
					{firstFormName ?? "Cases"}
				</h2>
			</div>
			<p className="text-sm text-nova-text-muted mb-4">
				Select a case to continue
			</p>
		</>
	);

	if (state.kind === "idle" || state.kind === "loading") {
		return (
			<div className="p-6 max-w-3xl mx-auto">
				{heading}
				<div className="flex items-center justify-center py-12 text-nova-text-muted">
					{state.kind === "loading" ? (
						<Icon
							icon={tablerLoader2}
							width="20"
							height="20"
							className="animate-spin"
						/>
					) : null}
				</div>
			</div>
		);
	}

	if (state.kind === "unauthenticated") {
		return (
			<div className="p-6 max-w-3xl mx-auto">
				{heading}
				<div className="rounded-lg border border-pv-input-border p-6 text-center text-nova-text-muted">
					Sign in to view case data.
				</div>
			</div>
		);
	}

	if (state.kind === "error") {
		return (
			<div className="p-6 max-w-3xl mx-auto">
				{heading}
				<div className="rounded-lg border border-red-700/50 bg-red-950/20 p-6 text-center text-red-300">
					{state.message}
				</div>
			</div>
		);
	}

	if (state.kind === "empty") {
		return (
			<div className="p-6 max-w-3xl mx-auto">
				{heading}
				<div className="rounded-lg border border-pv-input-border p-8 text-center">
					<p className="text-sm text-nova-text-muted mb-4">
						No cases yet. Generate sample data to populate this case list.
					</p>
					<button
						type="button"
						onClick={handleGenerate}
						disabled={populateStatus.kind === "running"}
						className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-pv-accent text-white hover:brightness-110 transition-all cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
					>
						{populateStatus.kind === "running" ? (
							<Icon
								icon={tablerLoader2}
								width="14"
								height="14"
								className="animate-spin"
							/>
						) : (
							<Icon icon={tablerSparkles} width="14" height="14" />
						)}
						{populateStatus.kind === "running"
							? "Generating..."
							: "Generate sample data"}
					</button>
					{populateStatus.kind === "error" && (
						<p className="mt-3 text-sm text-red-300">
							{populateStatus.message}
						</p>
					)}
				</div>
			</div>
		);
	}

	const rows = state.rows;

	return (
		<div className="p-6 max-w-3xl mx-auto">
			{heading}

			<div className="rounded-lg border border-pv-input-border overflow-hidden">
				<table className="w-full text-sm">
					<thead>
						<tr className="bg-pv-surface">
							{columns.map((col) => (
								<th
									key={`${col.header}-${col.field}`}
									className="text-left px-4 py-2.5 font-medium text-pv-accent-bright border-b border-pv-input-border"
								>
									{col.header}
								</th>
							))}
						</tr>
					</thead>
					<tbody>
						{rows.map((row, rIdx) => (
							<motion.tr
								key={row.case_id}
								initial={{ opacity: 0 }}
								animate={{ opacity: 1 }}
								transition={{ delay: rIdx * 0.04, duration: 0.2 }}
								onClick={() => handleRowClick()}
								className={`cursor-pointer hover:bg-pv-elevated ${
									rIdx % 2 === 0 ? "bg-pv-bg" : "bg-pv-surface/50"
								} transition-colors`}
							>
								{columns.map((col) => (
									<td
										key={`${col.header}-${col.field}`}
										className="px-4 py-2 text-nova-text-secondary border-b border-pv-input-border/50"
									>
										{caseRowDisplayValue(row, col.field)}
									</td>
								))}
							</motion.tr>
						))}
					</tbody>
				</table>
			</div>
		</div>
	);
}
