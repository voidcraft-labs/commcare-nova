"use client";
import { Icon } from "@iconify/react/offline";
import tablerLoader2 from "@iconify-icons/tabler/loader-2";
import tablerRefresh from "@iconify-icons/tabler/refresh";
import tablerSparkles from "@iconify-icons/tabler/sparkles";
import { motion } from "motion/react";
import { type ReactNode, useMemo, useState } from "react";
import { SearchInputForm } from "@/components/preview/shared/SearchInputForm";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
} from "@/components/shadcn/alert-dialog";
import { Button } from "@/components/shadcn/button";
import { useBlueprintDocApi } from "@/lib/doc/hooks/useBlueprintDoc";
import { useCaseTypes } from "@/lib/doc/hooks/useCaseTypes";
import { useModule as useModuleEntity } from "@/lib/doc/hooks/useEntity";
import { useFirstFormForModule } from "@/lib/doc/hooks/useFirstFormForModule";
import {
	evaluateColumnValue,
	pickBlueprintDoc,
} from "@/lib/preview/engine/caseDataBindingClient";
import type { PopulateSampleCasesResult } from "@/lib/preview/engine/caseDataBindingTypes";
import type { SearchInputValues } from "@/lib/preview/engine/runtimeBindings";
import type { PreviewScreen } from "@/lib/preview/engine/types";
import {
	useCases,
	usePopulateSampleCases,
	useResetSampleCases,
} from "@/lib/preview/hooks/useCaseDataBinding";
import { useLocation, useNavigate } from "@/lib/routing/hooks";
import { useAppId } from "@/lib/session/hooks";

/**
 * Shape `PopulateSampleCasesResult`'s typed non-ok arms into the
 * user-facing inline error string the empty-arm + populated-arm
 * surfaces both render. Both Generate and Reset map through the
 * same arms because both actions return the same result type from
 * the case-store; the only divergence is the leading verb in the
 * `validation-failure` / "Sign in to ..." sentences.
 */
function describePopulateError(
	result: Exclude<PopulateSampleCasesResult, { kind: "ok" }>,
	verb: "Generate" | "Reset",
): string {
	const verbLower = verb.toLowerCase();
	switch (result.kind) {
		case "unauthenticated":
			return `Sign in to ${verbLower} sample data.`;
		case "missing-case-type":
			return `Case type '${result.caseType}' is no longer in the blueprint. Refresh the page and try again.`;
		case "schema-not-synced":
			return `Case type '${result.caseType}' isn't ready yet. Try again in a moment.`;
		case "validation-failure": {
			/* AJV's `path` is the JSONB pointer (`/age`, or `""` for
			 * the document root); strip the leading slash for
			 * readability and substitute `<root>` for the empty path. */
			const lines = result.failures.map((f) => {
				const field = f.path === "" ? "<root>" : f.path.replace(/^\//, "");
				return `${field}: ${f.message}`;
			});
			const header =
				verb === "Generate"
					? `Generated sample data for case type '${result.caseType}' didn't match its schema:`
					: `Regenerated sample data for case type '${result.caseType}' didn't match its schema:`;
			return `${header}\n${lines.join("\n")}`;
		}
		case "error":
			return result.message;
	}
}

/**
 * Lifecycle status shared by the Generate (empty arm) and Reset
 * (populated arm) sample-data affordances. Both actions return the
 * same `PopulateSampleCasesResult` from the case-store, so both
 * surfaces drive the same three-state machine: `idle` (no action in
 * flight), `running` (action awaiting, button shows a spinner +
 * disables), and `error` (a non-ok arm or a wire-level throw, message
 * rendered inline below the affordance).
 */
export type SampleDataStatus =
	| { kind: "idle" }
	| { kind: "running" }
	| { kind: "error"; message: string };

/**
 * State model behind the Reset confirmation flow. Owns the status
 * machine + the dialog's controlled-open state so the reset behavior
 * is testable without mounting the screen — the rendered AlertDialog
 * is pure `f(state)` wiring (Playwright's surface), while the
 * status transitions + reload-on-success are the load-bearing
 * contract this hook isolates.
 *
 * Takes `reset` (the curried `useResetSampleCases` callback) and
 * `reload` (the `useCases` reload trigger) as args rather than
 * calling those hooks itself: confining the hook's responsibility to
 * the status machine keeps it independent of the Server Action
 * surface, so a test drives it with a fake `reset` + `reload` and no
 * action mock.
 */
export function useResetController(deps: {
	reset: () => Promise<PopulateSampleCasesResult>;
	reload: () => void;
}): {
	status: SampleDataStatus;
	confirmOpen: boolean;
	setConfirmOpen: (open: boolean) => void;
	confirmReset: () => Promise<void>;
} {
	const { reset, reload } = deps;
	const [status, setStatus] = useState<SampleDataStatus>({ kind: "idle" });

	/* Controlled-open state for the Reset confirmation. Base UI's
	 * `AlertDialog.Close` (wrapped by `AlertDialogCancel`) auto-
	 * dismisses, but `AlertDialogAction` is a plain Button with no
	 * dismiss wiring — controlling `open` is the only way to close
	 * the dialog the instant Reset is confirmed, so the user sees
	 * the trigger button's pending spinner immediately rather than
	 * a frozen dialog over a pending toolbar. */
	const [confirmOpen, setConfirmOpen] = useState(false);

	/* Confirmed-Reset handler. Closes the dialog before awaiting so
	 * the trigger button's pending spinner surfaces immediately —
	 * leaving the dialog open during the action would freeze the
	 * confirm button against a backdrop that already accepted the
	 * user's intent. Same `populate`-style fresh-per-render hook
	 * shape, same try/catch for wire failures. */
	const confirmReset = async () => {
		setConfirmOpen(false);
		setStatus({ kind: "running" });
		try {
			const result = await reset();
			if (result.kind === "ok") {
				setStatus({ kind: "idle" });
				reload();
				return;
			}
			setStatus({
				kind: "error",
				message: describePopulateError(result, "Reset"),
			});
		} catch {
			/* Wire-level failures (RSC serialization, transport) bypass
			 * the typed result arms; map to the same shape so the button
			 * never sticks on "Resetting...". */
			setStatus({
				kind: "error",
				message: "Could not reset sample data. Try again.",
			});
		}
	};

	return { status, confirmOpen, setConfirmOpen, confirmReset };
}

interface CaseListScreenProps {
	/** Passed from PreviewShell so the component stays valid while Activity hides it. */
	screen: Extract<PreviewScreen, { type: "caseList" }>;
}

/**
 * Case list screen. Subscribes to `useCases` against the module's
 * authored `caseListConfig` and renders one of `loading` / `empty` /
 * `rows` / `unauthenticated` / `error` arms. Empty case-type is a
 * button, not an error.
 *
 * The heading reads from `mod.name` — the module IS the case-list
 * title in v2 (no separate title slot). The visible columns are
 * those with `column.visibleInList ?? true`; the running-app sees
 * the same set the wire's short-detail emission carries. Each cell
 * routes through `evaluateColumnValue` so calc-arm columns surface
 * their `row.calculated[uuid]` value alongside non-calc kinds'
 * property reads.
 *
 * Sample-data affordances are arm-disjoint: the empty arm offers
 * Generate (populates the case type), and the populated arm offers
 * Reset (deletes + regenerates in one atomic transaction, gated
 * behind a confirmation dialog because the action discards every
 * row including any author-edited cases from running-app form
 * submissions).
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

	const mod = useModuleEntity(moduleUuid);
	const caseType = caseTypes.find((ct) => ct.name === mod?.caseType);
	const caseListConfig = mod?.caseListConfig;
	const columns = useMemo(
		() =>
			(caseListConfig?.columns ?? []).filter(
				(col) => col.visibleInList ?? true,
			),
		[caseListConfig?.columns],
	);

	// `pickBlueprintDoc` strips action methods + non-schema keys off the doc-store
	// state so the projection survives Next's RSC serializer. The action call
	// below threads the same projection through to the case-store's compiler
	// stack, which reads `caseTypes` for property data-type resolution.
	const blueprint = useMemo(
		() => pickBlueprintDoc(docApi.getState()),
		[docApi.getState],
	);

	// The per-input value bag the running-app search form mutates as
	// the user types. The form is fully controlled — the screen owns
	// the value reference, the form owns the local-typing buffer +
	// 300 ms debounce. A fresh-reference update from the form is the
	// trigger `useCases` keys off to re-fire its load effect.
	const [inputValues, setInputValues] = useState<SearchInputValues>(
		() => new Map(),
	);

	const { state, reload } = useCases({
		appId,
		caseType: caseType?.name,
		blueprint,
		caseListConfig,
		inputValues,
	});

	const populate = usePopulateSampleCases({
		appId,
		caseType: caseType?.name,
		blueprint: state.kind === "empty" ? blueprint : undefined,
	});

	/* Reset is callable only from the populated arm, but the hook
	 * call is unconditional so render order stays stable across the
	 * arm switch. The action callback no-ops with a typed `error`
	 * arm when `blueprint` is undefined — same shape as `populate`. */
	const reset = useResetSampleCases({
		appId,
		caseType: caseType?.name,
		blueprint,
	});

	/* The Reset confirmation's status machine + controlled-open state
	 * live in `useResetController` so the reset behavior is testable
	 * without mounting the screen; the rendered AlertDialog below is
	 * pure `f(state)` wiring driven entirely by what this returns. */
	const {
		status: resetStatus,
		confirmOpen: resetConfirmOpen,
		setConfirmOpen: setResetConfirmOpen,
		confirmReset,
	} = useResetController({ reset, reload });

	const [populateStatus, setPopulateStatus] = useState<SampleDataStatus>({
		kind: "idle",
	});

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
			setPopulateStatus({
				kind: "error",
				message: describePopulateError(result, "Generate"),
			});
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

	// Shell wrapper shared by every state arm. Hoisting the wrapper +
	// heading + form into one render path means each arm only owns its
	// body content — a future arm can't silently drop the form mount.
	// The screen gates on `searchInputs.length > 0` so an empty config
	// doesn't reserve the wrapper's margin; `SearchInputForm`
	// independently returns null for the same input, so the contract
	// is self-enforcing even if a future caller forgets the gate.
	const shell = (body: ReactNode) => (
		<div className="p-6 max-w-3xl mx-auto">
			<div className="flex items-center gap-2 mb-1">
				<h2 className="text-lg font-display font-semibold text-nova-text">
					{mod?.name ?? "Cases"}
				</h2>
			</div>
			<p className="text-sm text-nova-text-muted mb-4">
				Select a case to continue
			</p>
			{caseListConfig !== undefined &&
				caseListConfig.searchInputs.length > 0 && (
					<div className="mb-4">
						<SearchInputForm
							searchInputs={caseListConfig.searchInputs}
							caseType={caseType}
							value={inputValues}
							onChange={setInputValues}
						/>
					</div>
				)}
			{body}
		</div>
	);

	if (state.kind === "idle" || state.kind === "loading") {
		return shell(
			<div className="flex items-center justify-center py-12 text-nova-text-muted">
				{state.kind === "loading" ? (
					<Icon
						icon={tablerLoader2}
						width="20"
						height="20"
						className="animate-spin"
					/>
				) : null}
			</div>,
		);
	}

	if (state.kind === "unauthenticated") {
		return shell(
			<div className="rounded-lg border border-pv-input-border p-6 text-center text-nova-text-muted">
				Sign in to view case data.
			</div>,
		);
	}

	if (state.kind === "error") {
		return shell(
			<div className="rounded-lg border border-red-700/50 bg-red-950/20 p-6 text-center text-red-300">
				{state.message}
			</div>,
		);
	}

	if (state.kind === "empty") {
		return shell(
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
					<p className="mt-3 text-sm text-red-300 whitespace-pre-line">
						{populateStatus.message}
					</p>
				)}
			</div>,
		);
	}

	const rows = state.rows;
	const resetRunning = resetStatus.kind === "running";

	return shell(
		<>
			{/* Toolbar row above the table. Reset lives here (not in the
			 *  shell wrapper) because it's a populated-arm-only affordance
			 *  — the empty arm offers Generate instead, and the loading /
			 *  unauthenticated / error arms have no rows to reset. */}
			<div className="mb-3 flex justify-end">
				<AlertDialog open={resetConfirmOpen} onOpenChange={setResetConfirmOpen}>
					<AlertDialogTrigger
						render={
							<Button variant="outline" size="sm" disabled={resetRunning}>
								<Icon
									icon={resetRunning ? tablerLoader2 : tablerRefresh}
									width="14"
									height="14"
									className={resetRunning ? "animate-spin" : undefined}
								/>
								{resetRunning ? "Resetting..." : "Reset sample data"}
							</Button>
						}
					/>
					<AlertDialogContent>
						<AlertDialogHeader>
							<AlertDialogTitle>Reset sample data?</AlertDialogTitle>
							<AlertDialogDescription>
								This will delete every case in this case type and replace it
								with fresh sample data. Continue?
							</AlertDialogDescription>
						</AlertDialogHeader>
						<AlertDialogFooter>
							<AlertDialogCancel>Cancel</AlertDialogCancel>
							<AlertDialogAction variant="destructive" onClick={confirmReset}>
								Reset
							</AlertDialogAction>
						</AlertDialogFooter>
					</AlertDialogContent>
				</AlertDialog>
			</div>

			<div className="rounded-lg border border-pv-input-border overflow-hidden">
				<table className="w-full text-sm">
					<thead>
						<tr className="bg-pv-surface">
							{columns.map((col) => (
								<th
									key={col.uuid}
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
										key={col.uuid}
										className="px-4 py-2 text-nova-text-secondary border-b border-pv-input-border/50"
									>
										{evaluateColumnValue(col, row)}
									</td>
								))}
							</motion.tr>
						))}
					</tbody>
				</table>
			</div>

			{resetStatus.kind === "error" && (
				<p className="mt-3 text-sm text-red-300 whitespace-pre-line">
					{resetStatus.message}
				</p>
			)}
		</>,
	);
}
