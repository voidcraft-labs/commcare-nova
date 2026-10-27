/**
 * DeviceHomeScreen: Android's home screen, as Preview running as Android
 * plays it.
 *
 * Android opens an app on its home screen, never inside a menu
 * (`activities/HomeButtons.java::buildButtonData`), and returns there after
 * a form whose after-submit destination is the app's home or a case list
 * with no forms. The buttons and their order come from
 * `lib/preview/deviceHome.ts`, the list App Tests' device home reads too.
 *
 * Start opens the module list, which is what `StandardHomeActivity::enterRootModule`
 * opens. Sync with server re-reads the worker's cases, as a submission's
 * announcement does, and records when it ran. Saved, Incomplete and Log out
 * of CommCare show because a worker sees them on a phone; Preview keeps no
 * form archive or resume and chooses its worker from Running as, so each is
 * disabled, its reason the line under it (`aria-describedby`).
 *
 * Labels are runtime messages in the worker's language; reasons are Nova's
 * own words, in English. Rendered only in the running Preview, never in
 * edit mode.
 */
"use client";
import { useId } from "react";
import { ContentFrame } from "@/components/builder/ContentFrame";
import { EditableTitle } from "@/components/builder/EditableTitle";
import {
	useBuilderLanguage,
	useLocalizedValues,
} from "@/components/builder/localization/BuilderLocalizationProvider";
import { useAppName } from "@/lib/doc/hooks/useAppName";
import { useAppSettings } from "@/lib/doc/hooks/useAppSettings";
import { useMaterializableCaseTypes } from "@/lib/doc/hooks/useCaseTypes";
import { makeTranslationUnitId } from "@/lib/domain";
import {
	type DeviceHomeButton,
	deviceHomeButtons,
} from "@/lib/preview/deviceHome";
import { invalidateCaseData } from "@/lib/preview/hooks/caseDataInvalidation";
import {
	runtimeDateLocale,
	runtimeMessage,
} from "@/lib/preview/runtimeMessages";
import {
	useAppId,
	useMarkPreviewDeviceSynced,
	usePreviewDeviceSyncedAt,
	useSetPreviewAtDeviceHome,
} from "@/lib/session/hooks";

/** A home-screen button: full width, one control height, on the preview
 *  palette like the running form's own actions. */
const HOME_BUTTON_CLS =
	"nova-focusable flex min-h-11 w-full touch-manipulation cursor-pointer items-center justify-center rounded-lg border border-pv-input-border bg-pv-surface px-4 py-2 text-sm font-medium text-nova-text transition-colors not-disabled:hover:border-pv-input-focus not-disabled:hover:text-pv-accent-bright disabled:cursor-not-allowed disabled:opacity-(--disabled-opacity)";

export function DeviceHomeScreen() {
	const canonicalAppName = useAppName();
	const localizedValues = useLocalizedValues();
	const appName =
		(localizedValues.get(makeTranslationUnitId("app", "name")) as
			| string
			| undefined) ?? canonicalAppName;
	const { language } = useBuilderLanguage();
	const appSettings = useAppSettings();
	const buttons = deviceHomeButtons(appSettings, language);

	return (
		<ContentFrame width="5xl" className="p-6 space-y-4">
			<div className="flex items-center gap-2">
				<EditableTitle value={appName} readOnly ariaLabel="Application name" />
			</div>
			<ul className="grid gap-3">
				{buttons.map((button) => (
					<li key={button.key}>
						<DeviceHomeAction button={button} />
					</li>
				))}
			</ul>
		</ContentFrame>
	);
}

function DeviceHomeAction({ button }: { readonly button: DeviceHomeButton }) {
	const reasonId = useId();
	const setAtDeviceHome = useSetPreviewAtDeviceHome();
	const appId = useAppId();
	const caseTypes = useMaterializableCaseTypes();
	const markSynced = useMarkPreviewDeviceSynced();
	const syncedAt = usePreviewDeviceSyncedAt();
	const { language } = useBuilderLanguage();

	if (!button.available) {
		return (
			<>
				<button
					type="button"
					disabled
					aria-describedby={reasonId}
					className={HOME_BUTTON_CLS}
				>
					{button.label}
				</button>
				<p id={reasonId} className="mt-1 px-1 text-xs text-nova-text-muted">
					{button.reason}
				</p>
			</>
		);
	}

	if (button.key === "deviceHomeSync") {
		const syncTime =
			syncedAt === undefined
				? undefined
				: new Intl.DateTimeFormat(runtimeDateLocale(language), {
						dateStyle: "medium",
						timeStyle: "short",
					}).format(new Date(syncedAt));
		return (
			<>
				<button
					type="button"
					aria-describedby={syncTime === undefined ? undefined : reasonId}
					onClick={() => {
						if (appId !== undefined)
							for (const caseType of caseTypes)
								invalidateCaseData(appId, caseType.name);
						markSynced(Date.now());
					}}
					className={HOME_BUTTON_CLS}
				>
					{button.label}
				</button>
				{syncTime !== undefined ? (
					<p
						id={reasonId}
						aria-live="polite"
						className="mt-1 px-1 text-xs text-nova-text-muted"
					>
						{runtimeMessage(language, "deviceHomeLastSync", {
							time: syncTime,
						})}
					</p>
				) : null}
			</>
		);
	}

	return (
		<button
			type="button"
			onClick={() => setAtDeviceHome(false)}
			className={HOME_BUTTON_CLS}
		>
			{button.label}
		</button>
	);
}
