import { notFound } from "next/navigation";
import { connection } from "next/server";
import {
	ANATOMY_ROLE_IDS,
	COMPOSITIONS,
	type CompositionInputs,
	diffMoments,
	isAnatomyRoleId,
	lifecyclesFor,
	listDesignSessions,
	listLocalApps,
	modelLabel,
	providerOptionsFor,
	ROLE_FACTS,
	readAppInput,
	readDesignSession,
	weigh,
} from "@/lib/agent/anatomy";
import { RolePage } from "../_components/RolePage";

export const dynamic = "force-dynamic";

interface Search {
	moment?: string;
	app?: string;
	session?: string;
}

function first(value: string | string[] | undefined): string | undefined {
	return Array.isArray(value) ? value[0] : value;
}

export default async function AgentRolePage({
	params,
	searchParams,
}: {
	params: Promise<{ role: string }>;
	searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
	const { role } = await params;
	if (!isAnatomyRoleId(role)) notFound();
	const raw = await searchParams;
	const search: Search = {
		moment: first(raw.moment),
		app: first(raw.app),
		session: first(raw.session),
	};
	const composition = COMPOSITIONS[role];
	const facts = ROLE_FACTS[role];
	const momentSpec =
		composition.moments.find((spec) => spec.id === search.moment) ??
		composition.moments[0];
	if (momentSpec === undefined) notFound();

	/* Local reads happen only on request, never during a static build. */
	await connection();
	const [apps, sessions] = await Promise.all([
		listLocalApps(),
		listDesignSessions(),
	]);
	const inputs: CompositionInputs = {
		...(search.app && { app: (await readAppInput(search.app)) ?? undefined }),
		...(search.session && {
			session: (await readDesignSession(search.session)) ?? undefined,
		}),
	};

	const moment = await composition.compose(momentSpec.id, inputs);
	const weighed = await weigh(moment);
	const baselineSpec = composition.moments[0];
	const diff =
		baselineSpec !== undefined && baselineSpec.id !== momentSpec.id
			? diffMoments(await composition.compose(baselineSpec.id, inputs), moment)
			: null;

	return (
		<RolePage
			facts={facts}
			roles={ANATOMY_ROLE_IDS.map((id) => ({
				id,
				title: ROLE_FACTS[id].title,
			}))}
			modelLabel={facts.modelId === null ? null : modelLabel(facts.modelId)}
			lifecycles={lifecyclesFor(role).map((lifecycle) => lifecycle.title)}
			moments={composition.moments}
			momentId={momentSpec.id}
			weighed={weighed}
			diff={diff}
			providerOptions={providerOptionsFor(role)}
			sources={{
				apps,
				sessions,
				appId: inputs.app?.appId ?? null,
				appName: inputs.app?.appName ?? null,
				sessionId: inputs.session?.designSessionId ?? null,
				sessionAppName: inputs.session?.appName ?? null,
			}}
		/>
	);
}
