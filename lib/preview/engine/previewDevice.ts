// lib/preview/engine/previewDevice.ts
//
// The device Preview runs on: an engine input beside the resolved identity,
// never part of it. The identity is the worker; the device is where the
// worker is, and it supplies the session context values the platform's
// runtime supplies (`deviceid`, `appversion`, `drift`, `window_width`,
// `applanguage`). A platform change rebuilds through the navigation reset
// rather than through identity equality, so `samePreviewIdentity` never
// compares a device.
//
// The browser builds one from the session store (`usePreviewDevice()`), and
// passes it to the engine and, as plain JSON, to every Server Action that
// reads session values; the server parses it here (`previewDeviceInput`) and
// binds the same values, so the SQL session bindings, the Search session and
// the form's `commcaresession` cannot answer two ways. A journey or a check
// with no browser window builds one with `serverPreviewDevice`.
//
// Like `lib/preview/platform.ts`, this file may choose by platform: its input
// parse, `serverPreviewDevice` and `withNavigationWidth` are per platform.

import { z } from "zod";
import type { SessionContextField } from "@/lib/domain/expression";
import {
	type AppLocalization,
	effectiveAppLocalization,
	type LanguageTag,
	resolveAppLanguage,
} from "@/lib/domain/localization";
import { PLATFORMS, type Platform } from "@/lib/domain/platforms";
import {
	ANDROID_DEVICE_ID_PREFIX,
	androidAppVersion,
	effectivePreviewPlatform,
	WEB_APPS_APPVERSION,
	WEB_APPS_DEVICE_ID,
} from "../platform";

export interface PreviewDevice {
	readonly platform: Platform;
	/** The UUID part of Android's `deviceid`; ignored on Web Apps. */
	readonly androidDeviceId: string;
	/** `window.innerWidth` when the caller built the navigation read, Web Apps
	 *  only; the session context holds it as `String(windowWidth)`. */
	readonly windowWidth?: number;
	/** The worker language's CommCare wire code (`localization.wireCodes`). */
	readonly appLanguage: string;
}

/** The window width a server-side journey or check reads on Web Apps, where
 *  there is no browser window to measure. */
export const APP_TEST_WINDOW_WIDTH = 1280;

const PREVIEW_DEVICE_SHAPE_MESSAGE =
	"Preview sent the device it runs on in a shape it cannot read. It expects a platform, a device id, a language code and, in Web Apps, a window width. Check the caller that builds the device from the session store.";

const previewDeviceSchema = z
	.strictObject({
		platform: z.enum(PLATFORMS),
		androidDeviceId: z.uuid(),
		appLanguage: z.string().min(1).max(32),
		windowWidth: z.number().int().min(1).max(100_000).optional(),
	})
	.refine(
		(device) =>
			device.windowWidth === undefined || device.platform === "web-apps",
	);

/** Parse a device a client sent. Refuses, with one sentence naming what it
 *  expects, anything but a plain object holding a declared-platform name, a
 *  UUID device id, a language code of 1 to 32 characters and, on Web Apps
 *  only, an integer window width from 1 to 100,000. */
export function previewDeviceInput(value: unknown): PreviewDevice {
	const parsed = previewDeviceSchema.safeParse(value);
	if (!parsed.success) throw new Error(PREVIEW_DEVICE_SHAPE_MESSAGE);
	const { platform, androidDeviceId, appLanguage, windowWidth } = parsed.data;
	return {
		platform,
		androidDeviceId,
		appLanguage,
		...(windowWidth !== undefined && { windowWidth }),
	};
}

/** The session context values this device supplies. Web Apps: `deviceid`
 *  `Formplayer`, Formplayer's `appversion`, `drift` `0`, `window_width` when
 *  the navigation measured one, and the language. Android: `commcare_` and
 *  the install's UUID, Android's `appversion`, `drift` `0`, no `window_width`
 *  (Core's `SessionInstanceBuilder.addData` skips a null), and the language. */
export function previewDeviceContext(
	device: PreviewDevice,
): Partial<Record<SessionContextField, string>> {
	if (device.platform === "android") {
		return {
			deviceid: `${ANDROID_DEVICE_ID_PREFIX}${device.androidDeviceId}`,
			appversion: androidAppVersion(),
			drift: "0",
			applanguage: device.appLanguage,
		};
	}
	return {
		deviceid: WEB_APPS_DEVICE_ID,
		appversion: WEB_APPS_APPVERSION,
		drift: "0",
		...(device.windowWidth !== undefined && {
			window_width: String(device.windowWidth),
		}),
		applanguage: device.appLanguage,
	};
}

/** `window.innerWidth`, or `undefined` where there is no window (the server,
 *  a test). */
export function currentWindowWidth(): number | undefined {
	if (typeof window === "undefined") return undefined;
	const width = Math.round(window.innerWidth);
	return Number.isInteger(width) && width >= 1 && width <= 100_000
		? width
		: undefined;
}

/** The device with the window's width read now, on Web Apps; unchanged on
 *  Android. A width read at render would be the last render's, so each
 *  navigation read calls this at the moment it is made. */
export function withNavigationWidth(device: PreviewDevice): PreviewDevice {
	if (device.platform !== "web-apps") return device;
	const windowWidth = currentWindowWidth();
	if (windowWidth === undefined) {
		const { windowWidth: _stale, ...rest } = device;
		return rest;
	}
	return { ...device, windowWidth };
}

/** The device of a journey or a check with no browser window: the given
 *  install id (a fresh one when absent) and, on Web Apps,
 *  {@link APP_TEST_WINDOW_WIDTH}. */
export function serverPreviewDevice(input: {
	readonly platform: Platform;
	readonly appLanguage: string;
	readonly androidDeviceId?: string;
}): PreviewDevice {
	return {
		platform: input.platform,
		androidDeviceId: input.androidDeviceId ?? crypto.randomUUID(),
		appLanguage: input.appLanguage,
		...(input.platform === "web-apps" && {
			windowWidth: APP_TEST_WINDOW_WIDTH,
		}),
	};
}

/** The CommCare wire code of a worker language, falling back to the app's
 *  default language as every snapshot read does (`resolveAppLanguage`). */
export function previewAppLanguage(
	localization: AppLocalization | undefined,
	language: LanguageTag | null | undefined,
): string {
	const effective = effectiveAppLocalization(localization);
	const tag = resolveAppLanguage(localization, language);
	const code = Object.hasOwn(effective.wireCodes, tag)
		? effective.wireCodes[tag]
		: undefined;
	if (code === undefined) {
		throw new Error(
			`The app's language ${tag} has no CommCare code. Every language in the app's order holds one (localization.wireCodes); check the document's localization.`,
		);
	}
	return code;
}

/** The device an engine built without one runs on: the platform an app that
 *  runs on both plays by default, with a fresh install id and no window. */
export function defaultPreviewDevice(
	localization: AppLocalization | undefined,
	language: LanguageTag | null | undefined,
): PreviewDevice {
	return {
		platform: effectivePreviewPlatform(PLATFORMS, undefined),
		androidDeviceId: crypto.randomUUID(),
		appLanguage: previewAppLanguage(localization, language),
	};
}

/** Whether two devices supply the same values: the platform, the install id,
 *  the language and the window width. */
export function samePreviewDevice(a: PreviewDevice, b: PreviewDevice): boolean {
	return (
		a.platform === b.platform &&
		a.androidDeviceId === b.androidDeviceId &&
		a.appLanguage === b.appLanguage &&
		a.windowWidth === b.windowWidth
	);
}

/** A request identity for the device's platform, install and language; the
 *  window width is read per request and is no part of it. */
export function previewDeviceKey(device: PreviewDevice): string {
	return `${device.platform}\u0000${device.androidDeviceId}\u0000${device.appLanguage}`;
}
