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
	/** Passed from PreviewShell so the component stays valid while Activity hides it. */
	screen: Extract<PreviewScreen, { type: "caseList" }>;
}

/**
 * Case list screen. Subscribes to `useCases({appId, caseType})`
 * and renders one of `loading` / `empty` / `rows` /
 * `unauthenticated` / `error` arms. Empty case-type is a button,
 * not an error.
 */
export function CaseListScreen({ screen: _screen }: CaseListScreenProps) {
	const loc = useLocation();
	const navigate = useNavigate();
	const caseTypes = useCaseTypes();
	const appId = useAppId();
	const docApi = useBlueprintDocApi();

	const moduleUuid = loc.kind === "cases" ? loc.moduleUuid : undefined;

	/** The case list always opens into the module's first form (the case-loading form). */
	const firstForm = useFirstFormForModule(moduleUuid);
	const firstFormUuid = firstForm?.uuid;
	const firstFormName = firstForm?.name;

	const mod = useModuleEntity(moduleUuid);
	const caseType = caseTypes.find((ct) => ct.name === mod?.caseType);
	const columns = mod?.caseListColumns ?? [];

	const { state, reload } = useCases({
		appId,
		caseType: caseType?.name,
	});

	/** `pickBlueprintDoc` projects the doc-store state to a Server-Action-serializable shape (action methods would reject at the RSC boundary). `getState()` doesn't subscribe. */
	const populate = usePopulateSampleCases({
		appId,
		caseType: caseType?.name,
		blueprint:
			state.kind === "empty" ? pickBlueprintDoc(docApi.getState()) : undefined,
	});

	const [populateStatus, setPopulateStatus] = useState<
		{ kind: "idle" } | { kind: "running" } | { kind: "error"; message: string }
	>({ kind: "idle" });

	/* NOT wrapped in `useCallback` — `populate` is fresh per render
	 * (see `usePopulateSampleCases`), so memoization would be empty. */
	const handleGenerate = async () => {
		setPopulateStatus({ kind: "running" });
		try {
			const result = await populate();
			if (result.kind === "ok") {
				setPopulateStatus({ kind: "idle" });
				reload();
				return;
			}
			let message: string;
			switch (result.kind) {
				case "unauthenticated":
					message = "Sign in to generate sample data.";
					break;
				case "missing-case-type":
					message = `Case type '${result.caseType}' is no longer in the blueprint. Refresh the page and try again.`;
					break;
				case "schema-not-synced":
					message = `Case type '${result.caseType}' isn't ready yet. Try again in a moment.`;
					break;
				case "validation-failure": {
					/* AJV's `path` is the JSONB pointer (`/age`, or
					 * `""` for the document root); strip the leading
					 * slash for readability and substitute `<root>`
					 * for the empty path. */
					const lines = result.failures.map((f) => {
						const field = f.path === "" ? "<root>" : f.path.replace(/^\//, "");
						return `${field}: ${f.message}`;
					});
					message = `Generated sample data for case type '${result.caseType}' didn't match its schema:\n${lines.join("\n")}`;
					break;
				}
				case "error":
					message = result.message;
					break;
			}
			setPopulateStatus({ kind: "error", message });
		} catch {
			/* Wire-level failures (RSC serialization, transport)
			 * bypass the typed result arms; map to the same shape
			 * so the button never sticks on "Generating...". */
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

	/** The form URL schema has no caseId slot today — the case-list-to-form transition lands the user on the form without a bound case. `FormScreen`'s "no cases available" empty state handles followup forms reached this way. */
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
