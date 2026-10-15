"use server";

/**
 * The browser's dismissals of migration notices, each for the signed-in
 * member alone.
 *
 * Every argument is plain JSON on purpose. A `Map`, `Set`, or `File` in a
 * Server Action argument makes React encode the call as multipart, which
 * the WAF in front of Nova rejects outright.
 */

import { getSession } from "@/lib/auth-utils";
import { AppAccessError, resolveAppScope } from "@/lib/db/appAccess";
import { dismissAppNotice, dismissKeyReaderNotices } from "./store";

/**
 * Dismiss one of an app's notices. Resolves `view` on the app first, so any
 * member, a viewer included, dismisses for themselves, and a notice id of
 * another app dismisses nothing. `dismissed` is false where the caller cannot
 * view the app or the app holds no such notice.
 */
export async function dismissAppNoticeAction(args: {
	readonly appId: string;
	readonly noticeId: string;
}): Promise<{ readonly dismissed: boolean }> {
	const session = await getSession();
	if (session === null) return { dismissed: false };
	try {
		await resolveAppScope(args.appId, session.user.id, "view");
	} catch (error) {
		if (error instanceof AppAccessError) return { dismissed: false };
		throw error;
	}
	return {
		dismissed: await dismissAppNotice({
			appId: args.appId,
			noticeId: args.noticeId,
			userId: session.user.id,
		}),
	};
}

/** Dismiss the home page's saved-key line for the signed-in member. */
export async function dismissKeyReaderNoticesAction(): Promise<{
	readonly dismissed: boolean;
}> {
	const session = await getSession();
	if (session === null) return { dismissed: false };
	await dismissKeyReaderNotices({ userId: session.user.id });
	return { dismissed: true };
}
