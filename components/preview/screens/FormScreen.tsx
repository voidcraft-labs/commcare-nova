"use client";
import { Icon } from "@iconify/react/offline";
import tablerLoader2 from "@iconify-icons/tabler/loader-2";
import tablerRefresh from "@iconify-icons/tabler/refresh";
import tablerSparkles from "@iconify-icons/tabler/sparkles";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ContentFrame } from "@/components/builder/ContentFrame";
import { useSampleData } from "@/components/builder/case-list-config/useSampleData";
import { FormTypeButton } from "@/components/builder/detail/FormDetail";
import { FormSettingsButton } from "@/components/builder/detail/formSettings/FormSettingsButton";
import { EditableTitle } from "@/components/builder/EditableTitle";
import { FieldInspectorSurface } from "@/components/builder/editor/FieldInspectorSurface";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { useCaseTypes } from "@/lib/doc/hooks/useCaseTypes";
import {
	useForm as useFormEntity,
	useModule as useModuleEntity,
} from "@/lib/doc/hooks/useEntity";
import { useHasFieldsInForm } from "@/lib/doc/hooks/useHasFieldsInForm";
import type { Uuid } from "@/lib/doc/types";
import {
	CASE_LOADING_FORM_TYPES,
	defaultPostSubmit,
	type FormType,
	POST_SUBMIT_DESTINATIONS,
} from "@/lib/domain";
import { unhandledKindMessage } from "@/lib/domain/predicate/errors";
import { submitFormAction } from "@/lib/preview/engine/caseDataBinding";
import { caseRowToFormPreload } from "@/lib/preview/engine/caseDataBindingClient";
import type { SubmissionResult } from "@/lib/preview/engine/caseDataBindingTypes";
import type { PreviewScreen } from "@/lib/preview/engine/types";
import { useCaseData, useCases } from "@/lib/preview/hooks/useCaseDataBinding";
import { useFormEngine } from "@/lib/preview/hooks/useFormEngine";
import { useLocation, useNavigate } from "@/lib/routing/hooks";
import {
	useAppId,
	useBuilderIsReady,
	useCanEdit,
	useEditMode,
} from "@/lib/session/hooks";
import { FormLayoutProvider } from "../form/FormLayoutContext";
import { FormRenderer } from "../form/FormRenderer";

/**
 * Failure arms of `SubmissionResult` — the complement of the success
 * set. Pulling the union as a type so `describeSubmitError`'s switch
 * stays exhaustive against any future arm added to the result type.
 * Success arms mirror `SubmissionMutation`'s `FormType` discriminator
 * (one per `FormType`); the handler short-circuits on those and routes
 * everything else through this failure shape. Keying the `Exclude` off
 * `FormType` itself (rather than the four literals inline) keeps the
 * partition aligned with the source-of-truth `FormType` union — a new
 * form type landing in `FORM_TYPES` re-narrows this type automatically.
 */
type SubmissionFailure = Exclude<SubmissionResult, { kind: FormType }>;

/**
 * Shape a `SubmissionResult` failure arm into the inline error string
 * rendered below the submit row. Mirrors `CaseListScreen`'s
 * `describePopulateError` shape — typed errors get readable text that
 * names the affected entity so the user can amend without parsing the
 * case-store's vocabulary. `case-properties-validation` renders the
 * per-field failure list one line per failure.
 */
function describeSubmitError(result: SubmissionFailure): string {
	switch (result.kind) {
		case "unauthenticated":
			return "Sign in to submit this form.";
		case "case-not-found":
			return "The case you were editing no longer exists. Refresh and try again.";
		case "case-properties-validation": {
			/* AJV's `path` is the JSONB pointer (`/age`, or `""` for the
			 * document root); strip the leading slash for readability and
			 * substitute `<root>` for the empty path — same shape
			 * `describePopulateError` uses so the two surfaces stay
			 * visually consistent. The header names `result.caseType` so
			 * registration forms with multi-case fan-out tell the user
			 * WHICH case type rejected (a child case's properties failing
			 * is otherwise indistinguishable from the primary's). */
			const lines = result.failures.map((f) => {
				const field = f.path === "" ? "<root>" : f.path.replace(/^\//, "");
				return `${field}: ${f.message}`;
			});
			return `Some fields on case type '${result.caseType}' didn't match its schema:\n${lines.join("\n")}`;
		}
		case "missing-case-type":
			return `Case type '${result.caseType}' is no longer in the blueprint. Refresh the page and try again.`;
		case "schema-not-synced":
			return `Case type '${result.caseType}' isn't ready yet. Try again in a moment.`;
		case "error":
			return result.message;
	}
}

/**
 * Submit lifecycle. Mirrors `CaseListScreen`'s `populateStatus` —
 * three arms covering idle, in-flight, and per-arm error. The error
 * arm carries the already-shaped user-facing string so the render
 * layer doesn't re-walk the failure shape.
 */
type SubmitStatus =
	| { kind: "idle" }
	| { kind: "running" }
	| { kind: "error"; message: string };

interface FormScreenProps {
	/** Passed from PreviewShell so the subtree stays valid while Activity hides it. Only `caseId` is consumed here. */
	screen: Extract<PreviewScreen, { type: "form" }>;
	/** BuilderLayout's back handler — also the fallback post-submit destination for `previous` forms. */
	onBack: () => void;
}

/**
 * Form screen. Activates the EngineController by URL-derived form
 * UUID. Case-data preload routes through `useCaseData`;
 * `caseRowToFormPreload` flattens the JSONB document into the
 * `Map<string, string>` the form engine consumes.
 */
export function FormScreen({ screen, onBack }: FormScreenProps) {
	const caseId = screen.caseId;
	const loc = useLocation();
	const navigate = useNavigate();
	const { inline } = useBlueprintMutations();
	const isReady = useBuilderIsReady();
	const mode = useEditMode();
	const appId = useAppId();
	/* A viewer may preview the running app but not WRITE case data (submit a
	 * form, generate sample cases) — those server actions are edit-gated, so
	 * disable their controls rather than let a viewer hit a server error.
	 * (Distinct from the `canEdit` below, which is preview-vs-edit MODE.) */
	const mayWriteCaseData = useCanEdit();
	const caseTypes = useCaseTypes();

	const formUuid = loc.kind === "form" ? loc.formUuid : undefined;
	const moduleUuid = loc.kind === "form" ? loc.moduleUuid : undefined;
	const selectedUuid = loc.kind === "form" ? loc.selectedUuid : undefined;

	const mod = useModuleEntity(moduleUuid);
	const form = useFormEntity(formUuid);

	/** Returns `false` for undefined `formUuid` so FormScreen can mount while the URL is parsing. */
	const hasFields = useHasFieldsInForm(formUuid);

	/* Direct preview of a case-loading form with no case in hand (jumped here
	 * from the structure tree, not walked through the case list): auto-bind
	 * the first available case so the form is usable. Nothing should block
	 * previewing the screen you're editing — same stance as the case list,
	 * which runs against real sample data rather than gating on navigation.
	 * The query stays idle (no caseType) unless we're actually auto-selecting. */
	const autoSelectCase =
		mode === "preview" &&
		form !== undefined &&
		CASE_LOADING_FORM_TYPES.has(form.type) &&
		!caseId;
	const autoCases = useCases({
		appId,
		caseType: autoSelectCase ? mod?.caseType : undefined,
	});
	const { generate: autoGenerate } = useSampleData({
		appId: appId ?? "",
		caseType: caseTypes.find((ct) => ct.name === mod?.caseType),
		onDone: autoCases.reload,
	});
	const autoRow =
		autoSelectCase && autoCases.state.kind === "rows"
			? autoCases.state.rows[0]
			: undefined;
	/** The case actually bound to this form: the nav-provided one, else the
	 *  first auto-selected case. Threaded to both preload and submit so a
	 *  directly-previewed case-loading form behaves exactly like one reached
	 *  through the case list. */
	const effectiveCaseId = caseId ?? autoRow?.case_id;

	const { state: caseDataState } = useCaseData({
		appId,
		caseType: mod?.caseType,
		caseId,
	});

	/** Preload from the explicitly-loaded case (nav path) or the
	 *  auto-selected row; every other arm leaves the form rendering against
	 *  defaults. */
	const caseData = useMemo(() => {
		if (caseDataState.kind === "row")
			return caseRowToFormPreload(caseDataState.row);
		if (autoRow) return caseRowToFormPreload(autoRow);
		return undefined;
	}, [caseDataState, autoRow]);

	const editable = isReady;

	const controller = useFormEngine(formUuid, caseData);

	const prevModeRef = useRef(mode);
	useEffect(() => {
		if (prevModeRef.current === "preview" && mode !== "preview") {
			controller.resetValidation();
		}
		prevModeRef.current = mode;
	}, [mode, controller]);

	const formBodyElRef = useRef<HTMLDivElement>(null);

	const formBodyRef = useCallback(
		(el: HTMLDivElement | null) => {
			formBodyElRef.current = el;
			if (!el || mode !== "preview") return;
			if (!selectedUuid) return;
			const raf = requestAnimationFrame(() => {
				const qEl = el.querySelector(`[data-field-uuid="${selectedUuid}"]`);
				const input = qEl?.querySelector(
					"input, select, textarea",
				) as HTMLElement | null;
				input?.focus();
			});
			return () => cancelAnimationFrame(raf);
		},
		[mode, selectedUuid],
	);

	/* Submit lifecycle + post-submit dispatch live above the early-
	 * return gates so the hooks run on every render — moving them
	 * below the conditional returns would violate the rules of hooks
	 * during the transient mount window when `form` resolves from
	 * undefined to defined. The `form?.` reads tolerate the undefined
	 * window; `dispatchPostSubmit` is only invoked from `handleSubmit`,
	 * which itself only fires when the test-mode submit row is mounted,
	 * which itself requires `form` to be defined. */
	const [submitStatus, setSubmitStatus] = useState<SubmitStatus>({
		kind: "idle",
	});

	const dispatchPostSubmit = useCallback((): void => {
		if (!form) return;
		const dest = form.postSubmit ?? defaultPostSubmit(form.type);
		switch (dest) {
			case "module":
			case "parent_module":
				if (moduleUuid) navigate.openModule(moduleUuid);
				return;
			case "root":
			case "app_home":
				navigate.goHome();
				return;
			case "previous":
				/* Return to whatever screen sent the user here. `onBack`
				 * reads from BuilderLayout, which holds the back-stack and
				 * falls through to the module home when the stack is
				 * empty. */
				onBack();
				return;
			default: {
				/* Exhaustive switch — a future `PostSubmitDestination`
				 * arm landing without a case here surfaces as the
				 * standard `unhandledKindMessage` shape rather than
				 * silently routing to `onBack()`. */
				const _exhaustive: never = dest;
				throw new Error(
					unhandledKindMessage({
						where: "preview.FormScreen.dispatchPostSubmit",
						family: "PostSubmitDestination",
						received: _exhaustive,
						knownKinds: [...POST_SUBMIT_DESTINATIONS],
					}),
				);
			}
		}
	}, [form, moduleUuid, navigate, onBack]);

	const handleSubmit = async (): Promise<void> => {
		/* Clear any prior error state up-front. Two reasons:
		 *
		 *   1. A stale server-error header from a previous submit would
		 *      otherwise stay visible while the user is on a *different*
		 *      failure path (validate-fail or appId-guard) whose actual
		 *      remediation surfaces in a different UI element (per-field
		 *      required indicators).
		 *   2. A second submit after a server error must replace, not
		 *      augment — the alert always reflects the latest attempt. */
		setSubmitStatus({ kind: "idle" });

		const valid = controller.validateAll();
		if (!valid) {
			const errorEl = formBodyElRef.current?.querySelector(
				'[data-invalid="true"]',
			);
			errorEl?.scrollIntoView({ behavior: "smooth", block: "center" });
			return;
		}

		/* `appId` is provided by the builder route; the test-mode submit
		 * button only mounts under a builder session, so a missing slot
		 * is an upstream contract failure. Guard explicitly so a
		 * stale-mount path surfaces a readable inline message rather
		 * than reaching the server action with `undefined`. */
		if (!appId) {
			setSubmitStatus({
				kind: "error",
				message:
					"This app isn't fully loaded yet. Wait a moment and try again.",
			});
			return;
		}

		setSubmitStatus({ kind: "running" });
		try {
			const mutation = controller.computeSubmissionMutation({
				caseId: effectiveCaseId,
				caseTypes,
			});
			const result = await submitFormAction(mutation, appId);
			if (
				result.kind === "registration" ||
				result.kind === "followup" ||
				result.kind === "close" ||
				result.kind === "survey"
			) {
				setSubmitStatus({ kind: "idle" });
				dispatchPostSubmit();
				return;
			}
			setSubmitStatus({
				kind: "error",
				message: describeSubmitError(result),
			});
		} catch {
			/* Wire-level failures (RSC serialization, transport rejects)
			 * and any invariant throw the action / engine surfaces collapse
			 * to one user-facing line. The throw's message body carries
			 * implementation jargon (compiler-bug invariants, framework
			 * stack traces) that doesn't belong on the user's screen, so
			 * we deliberately ignore it and emit the same generic line
			 * `CaseListScreen.handleGenerate` uses for its sibling case. */
			setSubmitStatus({
				kind: "error",
				message: "Could not submit form. Try again.",
			});
		}
	};

	/* Clear-form button: reset both the engine's per-field state AND the
	 * submit lifecycle. Leaving `submitStatus` carrying a stale error
	 * after the user clicks Clear contradicts the "start fresh" mental
	 * model — the form's reset must be visible across every surface. */
	const handleClear = useCallback((): void => {
		controller.reset();
		setSubmitStatus({ kind: "idle" });
	}, [controller]);

	if (!form || !formUuid) return null;

	/** A caseId-bound case-loading form (followup / close) hitting `unauthenticated` / `error` must surface the failure — the no-preload fallback would hide session expiry and transport failures behind a defaults-rendered form. `idle` / `loading` / `missing` fall through (the form renders against defaults during the load window; `missing` shares the "no row" semantic with the next guard). The form-type set comes from `CASE_LOADING_FORM_TYPES` so adding a third case-loading form type in `lib/domain/forms.ts` would extend this guard automatically. */
	if (mode === "preview" && CASE_LOADING_FORM_TYPES.has(form.type)) {
		if (caseDataState.kind === "unauthenticated") {
			return (
				<div className="flex flex-col items-center justify-center h-full gap-4 px-6">
					<div className="text-center space-y-2">
						<h3 className="text-sm font-medium text-nova-text">
							Sign in to load case data
						</h3>
						<p className="text-sm text-nova-text-muted max-w-xs">
							Your session expired while loading this case. Sign in again to
							continue.
						</p>
					</div>
				</div>
			);
		}
		if (caseDataState.kind === "error") {
			return (
				<div className="flex flex-col items-center justify-center h-full gap-4 px-6">
					<div className="text-center space-y-2">
						<h3 className="text-sm font-medium text-nova-text">
							Could not load case data
						</h3>
						<p className="text-sm text-nova-rose max-w-xs">
							{caseDataState.message}
						</p>
					</div>
				</div>
			);
		}
	}

	/* The form ALWAYS renders — flipping to preview keeps it in place and the
	 * case data loads IN; it is never swapped for a loading/empty interstitial
	 * (that multi-stage flash is the antithesis of the flipbook). The only
	 * thing a directly-previewed case-loading form gates on a bound case is
	 * the submit action — `computeSubmissionMutation` needs the caseId — so
	 * `caseMissing` drives the submit row below, not the whole screen. When
	 * the store is genuinely empty, the submit row offers the same Generate
	 * Sample Data affordance the case list uses, in place, so a case can be
	 * created and its data flips straight into the standing form. */
	const caseMissing =
		mode === "preview" &&
		CASE_LOADING_FORM_TYPES.has(form.type) &&
		effectiveCaseId === undefined;
	const noSampleCases = caseMissing && autoCases.state.kind === "empty";

	const canEdit = mode === "edit" && editable;

	const formBody = (
		<>
			{/* `data-form-header` is queried by `InlineTextEditor` as the clamp floor for the floating label toolbar — preserve the attribute if this block is refactored. */}
			<div
				data-form-header
				className="px-6 pt-5 pb-4 border-b border-pv-input-border"
			>
				<div className="flex items-center gap-2">
					<FormTypeButton
						moduleUuid={(moduleUuid ?? "") as Uuid}
						formUuid={(formUuid ?? "") as Uuid}
						editable={canEdit}
					/>
					{canEdit ? (
						<EditableTitle
							value={form.name}
							/* Forward the gated dispatch's outcome — a refused rename
							 * keeps the editor open with the draft and surfaces the
							 * finding inline; the saved checkmark only fires on a
							 * committed rename. */
							onSave={(name) =>
								formUuid ? inline.updateForm(formUuid, { name }) : undefined
							}
						/>
					) : (
						<EditableTitle value={form.name} readOnly />
					)}
					{canEdit && (
						<FormSettingsButton
							moduleUuid={(moduleUuid ?? "") as Uuid}
							formUuid={(formUuid ?? "") as Uuid}
						/>
					)}
				</div>
			</div>

			{/* Unified `pt-4` for flipbook parity: edit-mode `insertion(0)` row + live-mode `pt-6` both land the first field at Y = 40px so toggling modes never shifts reading position. Bottom symmetric via `insertion(N+1)` in edit / last field's `mb-6` in live. */}
			<div ref={formBodyRef} className="flex-1 pt-4">
				{hasFields ? (
					<FormRenderer parentEntityId={formUuid} />
				) : (
					<div className="text-center text-nova-text-muted py-8">
						This form has no fields.
					</div>
				)}
			</div>

			{/* Hidden in design mode where it's non-functional. The form above
			 *  always renders; this row adapts to whether a case is bound. */}
			{mode === "preview" && (
				<div className="border-t border-pv-input-border bg-pv-surface">
					{noSampleCases ? (
						/* No case to load into this case-loading form — offer to
						 *  generate sample data right here, so the standing form's
						 *  fields fill in once a case exists rather than bouncing
						 *  the user away to make one. */
						<div className="flex items-center gap-3 px-6 py-3">
							<span className="flex-1 min-w-0 text-xs text-nova-text-muted">
								This form opens an existing case — generate sample data to try
								it.
							</span>
							<button
								type="button"
								onClick={autoGenerate.run}
								disabled={
									autoGenerate.status.kind === "running" || !mayWriteCaseData
								}
								className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-pv-accent text-white not-disabled:hover:brightness-110 transition-all cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
							>
								<Icon
									icon={
										autoGenerate.status.kind === "running"
											? tablerLoader2
											: tablerSparkles
									}
									width="14"
									height="14"
									className={
										autoGenerate.status.kind === "running"
											? "animate-spin"
											: undefined
									}
								/>
								{autoGenerate.status.kind === "running"
									? "Generating…"
									: "Generate Sample Data"}
							</button>
						</div>
					) : (
						<div className="flex items-center justify-between px-6 py-3">
							<button
								type="button"
								onClick={handleSubmit}
								disabled={
									submitStatus.kind === "running" ||
									caseMissing ||
									!mayWriteCaseData
								}
								className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-pv-accent text-white not-disabled:hover:brightness-110 transition-all cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
							>
								{submitStatus.kind === "running" && (
									<Icon
										icon={tablerLoader2}
										width="14"
										height="14"
										className="animate-spin"
									/>
								)}
								{submitStatus.kind === "running" ? "Submitting..." : "Submit"}
							</button>
							<button
								type="button"
								onClick={handleClear}
								disabled={submitStatus.kind === "running"}
								className="inline-flex items-center gap-1.5 px-3 py-2 text-sm text-nova-text-muted not-disabled:hover:text-nova-text not-disabled:hover:bg-white/5 transition-colors cursor-pointer rounded-lg disabled:opacity-40 disabled:cursor-not-allowed disabled:not-disabled:hover:bg-transparent"
							>
								<Icon icon={tablerRefresh} width="14" height="14" />
								Clear form
							</button>
						</div>
					)}
					{/* Inline error sits BELOW the submit row so the user's
					 *  amend-then-resubmit loop keeps the action affordance
					 *  steady in place — the row doesn't reflow when an error
					 *  appears or clears. `whitespace-pre-line` honors the
					 *  per-field newline list `describeSubmitError` emits for
					 *  the validation-failure arm. */}
					{submitStatus.kind === "error" && (
						<p
							role="alert"
							className="px-6 pb-3 text-sm text-nova-rose whitespace-pre-line"
						>
							{submitStatus.message}
						</p>
					)}
					{noSampleCases && autoGenerate.status.kind === "error" && (
						<p
							role="alert"
							className="px-6 pb-3 text-sm text-nova-rose whitespace-pre-line"
						>
							{autoGenerate.status.message}
						</p>
					)}
				</div>
			)}
		</>
	);

	return (
		<div className="h-full">
			<ContentFrame width="5xl" className="flex flex-col h-full">
				{/* FormLayoutProvider owns the group/repeat collapse set, shared across edit and live modes so a folded group stays folded when the user flips. */}
				<FormLayoutProvider>{formBody}</FormLayoutProvider>
			</ContentFrame>
			{/* Selected-field editor — claims the right rail (portals out, so
			    it adds no layout here). Renders only in edit mode with a
			    selection; releases the rail on deselect or when Activity hides
			    this screen. */}
			<FieldInspectorSurface />
		</div>
	);
}
