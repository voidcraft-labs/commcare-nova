// Vellum has settled: the load failed, or Vellum is ready and its data
// sources have arrived (their `change` handlers revalidate the form
// synchronously).
() => {
	const vellum = window.proofVellumHost.jQuery("#formdesigner").vellum("get");
	const events = window.proofVellum.events;
	if (vellum.data.core.formLoadingFailed) return true;
	if (events.some((e) => e.name === "datasources:error")) return true;
	return (
		events.some((e) => e.name === "onReady") && vellum.datasources.isReady()
	);
};
