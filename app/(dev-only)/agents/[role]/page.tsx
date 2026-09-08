import { notFound } from "next/navigation";
import { connection } from "next/server";
import {
	ANATOMY_ROLE_IDS,
	AppInspectionRefusal,
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
	let appProblem: string | null = null;
	let app: Awaited<ReturnType<typeof readAppInput>> = null;
	if (search.app) {
		try {
			app = await readAppInput(search.app);
		} catch (error) {
			if (!(error instanceof AppInspectionRefusal)) throw error;
			appProblem = error.message;
		}
	}
	const inputs: CompositionInputs = {
		...(app !== null && { app }),
		...(search.session && {
			session: (await readDesignSession(search.session)) ?? undefined,
		}),
	};

	const baselineSpec = composition.moments[0];
	const [moment, baseline] = await Promise.all([
		composition.compose(momentSpec.id, inputs),
		baselineSpec !== undefined && baselineSpec.id !== momentSpec.id
			? composition.compose(baselineSpec.id, inputs)
			: null,
	]);
	const weighed = await weigh(moment);
	const diff = baseline === null ? null : diffMoments(baseline, moment);

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
				appId:
					inputs.app?.appId ??
					(appProblem === null ? null : (search.app ?? null)),
				appName: inputs.app?.appName ?? null,
				appProblem,
				sessionId: inputs.session?.designSessionId ?? null,
				sessionAppName: inputs.session?.appName ?? null,
			}}
		/>
	);
}
