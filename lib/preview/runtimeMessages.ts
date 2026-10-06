import type { LanguageTag } from "@/lib/domain/localization";

/** Platform copy is separate from an app's authored translations. Keep this
 * small catalog client/worker safe; unsupported languages fall back honestly. */
const english = {
	home: "Home",
	breadcrumbPath: "Show breadcrumb path",
	pageNavigation: "Page navigation",
	formGettingReady: "This form is getting ready.",
	answersLocked: "Answers are locked while this submission finishes.",
	freshFormReady: "A fresh form entry is ready.",
	caseDataRefreshing: "Case data is refreshing. Your answers are still here.",
	selectedRecordLoading:
		"The selected record is loading. Answers will be available shortly.",
	formPreparing: "Nova is preparing this form. Your answers are still here.",
	repeatUpdating: "Answers are paused while this repeat updates.",

	cases: "Cases",
	case: "Case",
	thisCase: "this case",
	formCountOne: "{count} form",
	formCountMany: "{count} forms",
	selectedCase: "Selected: {name}",
	caseCountOne: "{count} case",
	caseCountMany: "{count} cases",
	groupCountOne: "{count} group",
	groupCountMany: "{count} groups",
	selectedCountOne: "{count} case selected",
	selectedCountMany: "{count} cases selected",
	filterResults: "Filter results",
	filterPage: "Filter this page",
	clearFilter: "Clear the filter",
	filteredCount: "{shown} of {total}",
	onThisPage: "{count} on this page",
	countShown: "{count} shown",
	casesInGroups: "{cases} in {groups}",
	resultRange: "{start}–{end} of {total}",
	showingResults: "Showing {count}",
	resultsFound: "{count} found",
	pageFilterScope:
		"This filter checks the {count} on this page. Go to another page to check more cases.",
	viewCaseDetails: "View details for {name}",
	continueWithCase: "Continue with {name}",
	chooseCase: "Choose {name}",
	removeCase: "Remove {name}",
	chooseCaseDetails: "To view details, select a case",
	chooseCaseContinue: "To continue, select a case",
	chooseCaseTask: "Choose what to do with this case",
	chooseCasesForm: "Choose the form to run for these cases",
	chooseCases: "Choose the cases this form should work with",
	chooseAllShown: "Choose all cases shown",
	reviewSelectedCases: "Review selected cases",
	selectedCases: "Selected cases",
	selectionOrder: "The form will work with these cases in this order",
	upToCases: "Up to {count}",
	selectionLimitOne: "You can choose up to {count} case",
	selectionLimitMany: "You can choose up to {count} cases",
	caseSelected: "{name} selected. {count} selected.",
	caseRemoved: "{name} removed. {count} selected.",
	selectionSkipped:
		"{count} selected. {skipped} not selected because the limit is {maximum}.",
	selectionUnavailable:
		"The selected cases are no longer available. Choose cases again.",
	selectionChanged:
		"Selected cases no longer available: {count}. Review the selection before continuing.",
	selectionCheckFailed: "The selected cases could not be checked. Try again.",
	chooseAtLeastOne: "Choose at least one case to continue",
	chooseFewerOne: "Choose {count} fewer case to continue",
	chooseFewerMany: "Choose {count} fewer cases to continue",
	groupSelection:
		"Choosing a group selects its first case. The rows beneath are there to read.",
	noValue: "No value",
	callPhone: "Call {number}",
	clearSearch: "Clear search",
	searchAgain: "Search again",
	previous: "Previous",
	resultsPages: "Results pages",
	loadingCases: "Loading cases…",
	loadingCase: "Loading this case",
	updatingCases: "Updating cases…",
	caseUnavailable: "This case is no longer available",
	chooseAnotherCase: "To choose another case, return to Results",
	caseLoadFailed: "This case didn't load",
	retryCase: "Try again to view this case",
	tryAgain: "Try again",
	signIn: "Sign in",
	signedOut: "You're signed out",
	signInCase: "To view this case, sign in again",
	signInCases: "To view these cases, sign in again",
	noPageFilterMatches: "No cases on this page match your filter",
	noFilterMatches: "No cases match your filter",
	retryPageFilter:
		"Clear the filter, try a different phrase, or check another page",
	retryFilter: "Clear the filter or try a different phrase",
	noCasesToShow: "No cases to show",
	retryResults: "Try searching again or change which cases appear in Results",
	noRelatedCases: "No related cases yet",
	chooseOtherParent: "Choose a different parent with related cases",
	createRelatedCase:
		"Choose a different parent, or create a related case for this one",
	noCasesYet: "No cases yet",
	createCase: "Create a case or add sample cases in Case data",
	askCreateCase: "Ask an app editor to create a case or add sample cases",
	noSearchMatches: "No cases match your search",
	retrySearch: "Check your spelling, clear a field, or try a broader search",
	retrySearchOrRegister:
		"Check your spelling, try a broader search, or register a new case",
	noTaskCases: "No cases available for this task",
	taskCasesUnavailable:
		"Existing cases do not meet this task's conditions. They may become available as work progresses.",
	casesLoadFailed: "This case list didn't load",
	retryCases: "Try again to view cases",
	countLoadFailed: "Nova couldn't check why no cases are showing",
	retryCount:
		"Try again to check whether cases need to be created or your availability settings are hiding them",
	noSearchCases: "No cases are available for this search",
	reviewSearchAvailability:
		"Try different Search information or review Cases available in Results",
	askReviewSearchAvailability:
		"Try different Search information or ask an app editor to review Cases available",
	changeSearch: "Change Search to see Results",
	changeSearchInformation: "Change the Search information to update Results",
	searchNeedsAttention: "Search needs attention",
	retrySearchInformation: "Change the Search information, then search again",
	caseSignedOut: "You're signed out, so this case's information isn't showing.",
	caseInformationFailed: "This case's information didn't load.",

	required: "This field is required",
	reviewHighlightedQuestion: "Review the highlighted question.",
	searchRequired: "Fill in this answer before searching.",
	invalid: "Invalid value",
	wholeNumber: "This question needs a whole number.",
	number: "This question needs a number.",
	integerRange:
		"The number needs to be between -2,147,483,648 and 2,147,483,647.",
	numberTooLarge: "The number is too large to save.",
	date: "“{value}” isn't a date. Pick one from the calendar.",
	time: "“{value}” isn't a time yet. Enter a clock time like 2:30 PM.",
	missingTime: "Enter a clock time: this question needs both.",
	missingDate: "Pick a date: this question needs both.",
	dateTime: "“{value}” isn't a date and time.",
	back: "Back",
	goBack: "Go back",
	backToResults: "Back to results",
	next: "Next",
	submit: "Submit",
	submitting: "Submitting",
	clear: "Clear",
	clearAnswers: "Clear answers",
	clearForm: "Clear form",
	startingFresh: "Starting fresh",
	clearing: "Clearing",
	continue: "Continue",
	checkingCases: "Checking cases",
	search: "Search",
	results: "Results",
	sections: "Sections",
	section: "Section {position} of {count}",
	questionPosition: "Question {position}.",
	sectionPosition: "Section {position}.",
	requiredLabel: "Required.",
	expand: "Expand",
	collapse: "Collapse",
	untitledGroup: "Untitled group",
	repeatPosition: "Repeat {position}.",
	repeat: "Repeat",
	instances: "{count} instances",
	instancePosition: "Instance {position}",
	remove: "Remove",
	entry: "entry",
	addEntry: "Add {label}",
	pickDate: "Pick a date",
	dateLabel: "Date",
	timeLabel: "Time",
	mapUnavailable:
		"The map isn't available here. You can enter coordinates manually below.",
	manualCoordinates: "Enter coordinates manually",
	latitude: "Latitude",
	longitude: "Longitude",
	clearLocation: "Clear location",
	addressSearch: "Search for an address",
	addressSearchPlaceholder: "Search for an address or place",
	addressSearching: "Searching",
	addressSearchMinimum:
		"You can type at least {count} characters to see places",
	addressNoResults: "No matching places",
	yourLocation: "Your location",
	locating: "Locating",
	locationGuidance:
		"You can search for an address, click the map to drop a pin, or use your location",
	locationUnavailable: "Location unavailable",
	locationPermissionDenied:
		"Your browser hasn't allowed location access. You can allow it in its settings or enter coordinates manually.",
	locationPositionUnavailable:
		"Your location is currently unavailable. You can try again or enter coordinates manually.",
	locationTimeout:
		"Getting your location timed out. You can try again or enter coordinates manually.",
	locationUnsupported:
		"This browser can't share your location. You can enter coordinates manually.",
	locationUnexpected:
		"Couldn't get your location. You can try again or enter coordinates manually.",
} as const;

export type RuntimeMessage = keyof typeof english;
const spanish: Record<RuntimeMessage, string> = {
	home: "Inicio",
	breadcrumbPath: "Mostrar la ruta de navegación",
	pageNavigation: "Navegación de páginas",
	formGettingReady: "El formulario se está preparando.",
	answersLocked: "Las respuestas están bloqueadas mientras termina el envío.",
	freshFormReady: "El formulario está listo para una nueva entrada.",
	caseDataRefreshing:
		"Los datos se están actualizando. Sus respuestas siguen aquí.",
	selectedRecordLoading:
		"El registro seleccionado se está cargando. Las respuestas estarán disponibles en breve.",
	formPreparing:
		"El formulario se está preparando. Sus respuestas siguen aquí.",
	repeatUpdating:
		"Las respuestas están en pausa mientras se actualiza esta repetición.",

	cases: "Registros",
	case: "Registro",
	thisCase: "este registro",
	formCountOne: "{count} formulario",
	formCountMany: "{count} formularios",
	selectedCase: "Seleccionado: {name}",
	caseCountOne: "{count} registro",
	caseCountMany: "{count} registros",
	groupCountOne: "{count} grupo",
	groupCountMany: "{count} grupos",
	selectedCountOne: "{count} registro seleccionado",
	selectedCountMany: "{count} registros seleccionados",
	filterResults: "Filtrar resultados",
	filterPage: "Filtrar esta página",
	clearFilter: "Borrar el filtro",
	filteredCount: "{shown} de {total}",
	onThisPage: "{count} en esta página",
	countShown: "{count} en pantalla",
	casesInGroups: "{cases} en {groups}",
	resultRange: "{start}–{end} de {total}",
	showingResults: "Mostrando {count}",
	resultsFound: "Resultados: {count}",
	pageFilterScope:
		"Este filtro busca en esta página ({count}). Puede ir a otra página para buscar más registros.",
	viewCaseDetails: "Ver detalles de {name}",
	continueWithCase: "Continuar con {name}",
	chooseCase: "Seleccionar {name}",
	removeCase: "Quitar {name}",
	chooseCaseDetails: "Puede seleccionar un registro para ver sus detalles",
	chooseCaseContinue: "Puede seleccionar un registro para continuar",
	chooseCaseTask: "¿Qué desea hacer con este registro?",
	chooseCasesForm: "Puede elegir el formulario para estos registros",
	chooseCases: "Puede elegir los registros para este formulario",
	chooseAllShown: "Seleccionar todos los registros mostrados",
	reviewSelectedCases: "Revisar los registros seleccionados",
	selectedCases: "Registros seleccionados",
	selectionOrder: "El formulario usará estos registros en este orden",
	upToCases: "Hasta {count}",
	selectionLimitOne: "Puede seleccionar hasta {count} registro",
	selectionLimitMany: "Puede seleccionar hasta {count} registros",
	caseSelected: "{name} seleccionado. Total: {count}.",
	caseRemoved: "{name} eliminado de la selección. Total: {count}.",
	selectionSkipped:
		"Seleccionados: {count}. Sin seleccionar: {skipped}, porque el límite es {maximum}.",
	selectionUnavailable:
		"Los registros seleccionados ya no están disponibles. Puede seleccionar otros registros.",
	selectionChanged:
		"Registros que ya no están disponibles: {count}. Puede revisar la selección antes de continuar.",
	selectionCheckFailed:
		"No se pudieron comprobar los registros seleccionados. Puede intentarlo de nuevo.",
	chooseAtLeastOne: "Puede seleccionar al menos un registro para continuar",
	chooseFewerOne:
		"Puede quitar {count} registro de la selección para continuar",
	chooseFewerMany:
		"Puede quitar {count} registros de la selección para continuar",
	groupSelection:
		"Al seleccionar un grupo, se elige su primer registro. Las filas siguientes son solo de consulta.",
	noValue: "Sin valor",
	callPhone: "Llamar al {number}",
	clearSearch: "Borrar búsqueda",
	searchAgain: "Buscar de nuevo",
	previous: "Anterior",
	resultsPages: "Páginas de resultados",
	loadingCases: "Cargando registros…",
	loadingCase: "Cargando este registro",
	updatingCases: "Actualizando registros…",
	caseUnavailable: "Este registro ya no está disponible",
	chooseAnotherCase: "Puede volver a los resultados para elegir otro registro",
	caseLoadFailed: "No se pudo cargar este registro",
	retryCase: "Puede intentarlo de nuevo para ver este registro",
	tryAgain: "Intentar de nuevo",
	signIn: "Iniciar sesión",
	signedOut: "La sesión ha terminado",
	signInCase: "Puede iniciar sesión de nuevo para ver este registro",
	signInCases: "Puede iniciar sesión de nuevo para ver estos registros",
	noPageFilterMatches: "Ningún registro de esta página coincide con el filtro",
	noFilterMatches: "Ningún registro coincide con el filtro",
	retryPageFilter:
		"Puede borrar el filtro, probar otra frase o consultar otra página",
	retryFilter: "Puede borrar el filtro o probar otra frase",
	noCasesToShow: "No hay registros para mostrar",
	retryResults:
		"Puede buscar de nuevo o cambiar los registros que aparecen en los resultados",
	noRelatedCases: "Aún no hay registros relacionados",
	chooseOtherParent:
		"Puede elegir otro registro principal que tenga registros relacionados",
	createRelatedCase:
		"Puede elegir otro registro principal o crear un registro relacionado con este",
	noCasesYet: "Aún no hay registros",
	createCase:
		"Puede crear un registro o añadir registros de ejemplo en los datos de registros",
	askCreateCase:
		"Puede pedir a un editor de la aplicación que cree un registro o añada registros de ejemplo",
	noSearchMatches: "Ningún registro coincide con la búsqueda",
	retrySearch:
		"Puede revisar la ortografía, borrar un campo o ampliar la búsqueda",
	retrySearchOrRegister:
		"Puede revisar la ortografía, ampliar la búsqueda o crear un nuevo registro",
	noTaskCases: "No hay registros disponibles para esta tarea",
	taskCasesUnavailable:
		"Los registros existentes no cumplen las condiciones de esta tarea. Pueden estar disponibles a medida que avance el trabajo.",
	casesLoadFailed: "No se pudo cargar la lista de registros",
	retryCases: "Puede intentarlo de nuevo para ver los registros",
	countLoadFailed: "No pude comprobar por qué no se muestran registros",
	retryCount:
		"Puede intentarlo de nuevo para comprobar si faltan registros o si las condiciones de disponibilidad los ocultan",
	noSearchCases: "No hay registros disponibles para esta búsqueda",
	reviewSearchAvailability:
		"Puede cambiar la búsqueda o revisar los registros disponibles en los resultados",
	askReviewSearchAvailability:
		"Puede cambiar la búsqueda o pedir a un editor de la aplicación que revise los registros disponibles",
	changeSearch: "Puede cambiar la búsqueda para ver resultados",
	changeSearchInformation:
		"Puede cambiar los datos de la búsqueda para actualizar los resultados",
	searchNeedsAttention: "La búsqueda necesita atención",
	retrySearchInformation:
		"Puede cambiar los datos de la búsqueda y buscar de nuevo",
	caseSignedOut:
		"La sesión ha terminado. Puede iniciar sesión para ver la información de este registro.",
	caseInformationFailed: "No se pudo cargar la información de este registro.",

	required: "Este campo es obligatorio",
	reviewHighlightedQuestion: "Revise la pregunta resaltada.",
	searchRequired: "Complete esta respuesta antes de buscar.",
	invalid: "Valor no válido",
	wholeNumber: "Esta pregunta necesita un número entero.",
	number: "Esta pregunta necesita un número.",
	integerRange: "El número debe estar entre -2,147,483,648 y 2,147,483,647.",
	numberTooLarge: "El número es demasiado grande para guardarlo.",
	date: "«{value}» no es una fecha. Elija una en el calendario.",
	time: "«{value}» no es una hora. Introduzca una hora como 14:30.",
	missingTime: "Introduzca una hora: esta pregunta necesita ambas.",
	missingDate: "Elija una fecha: esta pregunta necesita ambas.",
	dateTime: "«{value}» no es una fecha y hora.",
	back: "Atrás",
	goBack: "Volver",
	backToResults: "Volver a los resultados",
	next: "Siguiente",
	submit: "Enviar",
	submitting: "Enviando",
	clear: "Borrar",
	clearAnswers: "Borrar respuestas",
	clearForm: "Borrar formulario",
	startingFresh: "Empezando de nuevo",
	clearing: "Borrando",
	continue: "Continuar",
	checkingCases: "Comprobando registros",
	search: "Buscar",
	results: "Resultados",
	sections: "Secciones",
	section: "Sección {position} de {count}",
	questionPosition: "Pregunta {position}.",
	sectionPosition: "Sección {position}.",
	requiredLabel: "Obligatoria.",
	expand: "Expandir",
	collapse: "Contraer",
	untitledGroup: "Grupo sin título",
	repeatPosition: "Repetición {position}.",
	repeat: "Repetición",
	instances: "{count} repeticiones",
	instancePosition: "Repetición {position}",
	remove: "Quitar",
	entry: "entrada",
	addEntry: "Añadir {label}",
	pickDate: "Elegir una fecha",
	dateLabel: "Fecha",
	timeLabel: "Hora",
	mapUnavailable:
		"El mapa no está disponible aquí. Puede introducir las coordenadas manualmente abajo.",
	manualCoordinates: "Introducir coordenadas manualmente",
	latitude: "Latitud",
	longitude: "Longitud",
	clearLocation: "Borrar ubicación",
	addressSearch: "Buscar una dirección",
	addressSearchPlaceholder: "Buscar una dirección o un lugar",
	addressSearching: "Buscando",
	addressSearchMinimum: "Puedes buscar con al menos {count} caracteres",
	addressNoResults: "No hay lugares que coincidan",
	yourLocation: "Tu ubicación",
	locating: "Buscando ubicación",
	locationGuidance:
		"Puedes buscar una dirección, tocar el mapa para marcar un punto o usar tu ubicación",
	locationUnavailable: "Ubicación no disponible",
	locationPermissionDenied:
		"El navegador no dio permiso para compartir tu ubicación. Puedes permitirlo en su configuración o introducir las coordenadas manualmente.",
	locationPositionUnavailable:
		"Tu ubicación no está disponible ahora. Puedes intentarlo de nuevo o introducir las coordenadas manualmente.",
	locationTimeout:
		"Se agotó el tiempo para obtener tu ubicación. Puedes intentarlo de nuevo o introducir las coordenadas manualmente.",
	locationUnsupported:
		"Este navegador no puede compartir tu ubicación. Puedes introducir las coordenadas manualmente.",
	locationUnexpected:
		"No pude obtener tu ubicación. Puedes intentarlo de nuevo o introducir las coordenadas manualmente.",
};

export function runtimeLanguage(language: LanguageTag | null | undefined) {
	const base = language?.split("-")[0] ?? "eng";
	const catalogLanguage = base === "spa" ? "spa" : "eng";
	return { catalogLanguage, fallback: base !== catalogLanguage } as const;
}

/** Intl accepts the canonical language tag, including its regional suffix.
 * Calendar text uses the same bounded catalog as the other worker controls. */
export function runtimeDateLocale(language: LanguageTag | null | undefined) {
	return runtimeLanguage(language).fallback ? "eng" : (language ?? "eng");
}

export function runtimeMessage(
	language: LanguageTag | null | undefined,
	key: RuntimeMessage,
	values: Readonly<Record<string, string | number>> = {},
): string {
	let text: string =
		runtimeLanguage(language).catalogLanguage === "spa"
			? spanish[key]
			: english[key];
	for (const [name, value] of Object.entries(values))
		text = text.replaceAll(`{${name}}`, String(value));
	return text;
}
