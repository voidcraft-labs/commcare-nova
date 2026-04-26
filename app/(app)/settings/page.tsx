/**
 * Settings page. Auth is enforced by the layout's `requireAuth`; the
 * session check below only narrows the type for TypeScript.
 */
import type { Metadata } from "next";
import { getSession } from "@/lib/auth-utils";
import { listAuthorizedClients } from "@/lib/db/oauth-consents";
import { getCommCareSettings } from "@/lib/db/settings";
import { CommCareSettings } from "./commcare-settings";
import { ConnectedApps } from "./connected-apps";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage() {
	const session = await getSession();
	if (!session) return null;

	const [initialSettings, initialAuthorizedClients] = await Promise.all([
		getCommCareSettings(session.user.id),
		listAuthorizedClients(session.user.id),
	]);

	return (
		<main className="max-w-2xl mx-auto px-6 py-12">
			<h1 className="text-2xl font-display font-semibold mb-8">Settings</h1>
			<div className="space-y-6">
				<CommCareSettings
					initial={initialSettings}
					userEmail={session.user.email}
				/>
				<ConnectedApps initial={initialAuthorizedClients} />
			</div>
		</main>
	);
}
