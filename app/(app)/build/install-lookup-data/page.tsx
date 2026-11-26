import Link from "next/link";
import { ManualLookupInstaller } from "@/components/builder/ManualLookupInstaller";
import { requireAuth } from "@/lib/auth-utils";
import { getCommCareSettings } from "@/lib/db/settings";

export default async function InstallLookupDataPage() {
	const session = await requireAuth();
	const connection = await getCommCareSettings(session.user.id);
	return (
		<main className="mx-auto w-full max-w-xl overflow-auto px-6 py-10">
			<h1 className="mb-5 text-2xl font-semibold">Install lookup data</h1>
			{connection.configured ? (
				<ManualLookupInstaller connection={connection} />
			) : (
				<p className="text-sm">
					Connect to CommCare HQ in{" "}
					<Link href="/settings" className="underline">
						Settings
					</Link>{" "}
					to choose the installation project space.
				</p>
			)}
		</main>
	);
}
