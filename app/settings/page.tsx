/**
 * Settings page — user preferences and integrations.
 *
 * Server Component that reads the user's current CommCare HQ config
 * and passes it to the client component for interactive editing.
 * Auth is handled by the settings layout (requireAuth).
 */
import { getSession } from "@/lib/auth-utils";
import { getCommCareSettings } from "@/lib/db/settings";
import { CommCareSettings } from "./commcare-settings";

export default async function SettingsPage() {
	const session = await getSession();
	/* Layout gate guarantees a session, but satisfy TypeScript. */
	const initialSettings = session
		? await getCommCareSettings(session.user.id)
		: { configured: false, username: "", domain: null };

	return (
		<main className="max-w-2xl mx-auto px-6 py-12">
			<h1 className="text-2xl font-display font-semibold mb-8">Settings</h1>
			<CommCareSettings
				initial={initialSettings}
				userEmail={session?.user.email ?? ""}
			/>
		</main>
	);
}
