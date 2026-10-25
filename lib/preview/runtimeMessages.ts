import type { LanguageTag } from "@/lib/domain/localization";
import type {
	RefusingAnswerType,
	SetvalueRefusalDetails,
} from "./engine/answerCast";
import type {
	PreviewDataRefusalStage,
	PreviewDataRefusalSubject,
} from "./engine/dataRefusal";

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
	refusalPreloadTitle: "This form can't open for {caseName}",
	refusalPreloadBody:
		"{caseName}'s {property} is “{value}”, which isn't {type}, so CommCare won't open this form for it. You can choose another record.",
	refusalStartingValueTitle: "This form can't open yet",
	refusalStartingValueBody:
		"The starting value of “{question}” works out to “{value}”, which isn't {type}, so CommCare won't open the form. You can change the question's starting value so it gives {type}.",
	refusalRepeatInsert:
		"A new {repeat} can't be added: the starting value of “{question}” works out to “{value}”, which isn't {type}. You can change the question's starting value so it gives {type}.",
	chooseAnotherRecord: "Choose another record",
	backToList: "Back to the list",
	answerTypeDate: "a date",
	answerTypeTime: "a time",
	answerTypeDatetime: "a date and time",
	answerTypeInt: "a whole number",
	answerTypeDecimal: "a number",
	answerTypeGeopoint: "a location",
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
	locationGuidance:
		"You can search for an address or click the map to drop a pin",
	hereColumnsWaiting:
		"Columns that use your location stay blank until your browser shares it.",
	hereColumnsRefused:
		"Your browser isn't sharing your location, so columns that use it stay blank. You can allow location for this site in your browser's settings.",
	hereColumnsUnavailable:
		"Your browser couldn't find your location, so columns that use it stay blank. You can try again.",
	hereColumnsUnsupported:
		"This browser can't share your location, so columns that use it stay blank.",
	shareYourLocation: "Share your location",
	searchResultsRefusalTitle: "This form opens after a search",
	searchResultsRefusalBody:
		"This form reads what the search found. You can run the search, then choose the case again.",
	goToSearch: "Go to Search",
	searchResultsInvalidTitle: "The search before this form can't run",
	searchResultsLoading: "Nova is loading what the search found for this form.",
	searchResultsLoadFailed:
		"What the search found didn't load. You can try again.",
	searchDeviceCasesLoadFailed:
		"Nova couldn't load the cases on this device that the search reads. Try again to run the search.",
	searchResultsCap:
		"This search found {count} cases. CommCare's search sends a device the first 500, so this form reads 500 of them here too.",
	dataRefusalFormTitle: "This form stops here on a phone",
	dataRefusalLinksTitle: "This form's next step stops on a phone",
	dataRefusalMenuTitle: "This menu doesn't open on a phone",
	dataRefusalSearchTitle: "This search doesn't open on a phone",
	dataRefusalSubjectForm: "This form reads",
	dataRefusalSubjectLinks: "This form's links read",
	dataRefusalSubjectMenu: "This menu reads",
	dataRefusalPlacesPersona:
		"{subject} a place, and {worker} is assigned nowhere, so a phone stops here. You can give {worker} a place under Users and personas in App setup.",
	dataRefusalPlacesMe:
		"{subject} a place, and you're assigned nowhere, so a phone stops here. You can preview as a persona who has a place.",
	dataRefusalOwnerPlacePersona:
		"This form moves the case to {worker}'s place, and {worker} is assigned nowhere, so the case has no owner to move to and a phone stops here. You can give {worker} a place under Users and personas in App setup.",
	dataRefusalOwnerPlaceMe:
		"This form moves the case to your place, and you're assigned nowhere, so the case has no owner to move to and a phone stops here. You can preview as a persona who has a place.",
	dataRefusalTable:
		"{subject} “{table}”, which has no rows, so a phone stops here. You can add rows to “{table}” in Project data.",
	dataRefusalChoices:
		"“{question}” gets its choices from “{table}”, which has no rows, so a phone won't open it. You can add rows to “{table}” in Project data.",
	dataRefusalSearchChoices:
		"Search field “{input}” gets its choices from “{table}”, which has no rows, so a phone won't open this search. You can add rows to “{table}” in Project data.",
	dataRefusalSearchAnswers:
		"{subject} a search answer that was left blank, so a phone stops here. You can search again with that answer filled in.",
	dataRefusalOther:
		"{subject} a value a phone doesn't have at this point, so a phone stops here.",
	thisQuestion: "this question",
	thisSearchField: "this field",

	// ── Preview per platform ─────────────────────────────────────────
	// Android's home screen (`activities/HomeButtons.java`, strings `home.*`).
	deviceHomeStart: "Start",
	deviceHomeSaved: "Saved",
	deviceHomeIncomplete: "Incomplete",
	deviceHomeSync: "Sync with server",
	deviceHomeLastSync: "You last synced with the server: {time}",
	deviceHomeLogOut: "Log out of CommCare",
	// Web Apps' notice after a case list with no forms
	// ("Redirecting after sync").
	formlessReturned: "Synced and back at the app's first screen",
	// Android's form screens (`form.entry.finish.button`, `repeat.dialog.*`).
	finish: "Finish",
	repeatGoBack: "Go back",
	repeatAddNew: "Add a new {label}?",
	repeatAddAnother: "Add another {label}?",
	repeatDoNotAdd: "Do not add",
	repeatDoNotAddFinish: "Do not add, I'm finished",
	// Help, in each runtime's button and dialog.
	showHelp: "Show help",
	close: "Close",
	ok: "OK",
	// Android's location question (`R.string.get_location` and its siblings).
	recordLocation: "Record location",
	replaceLocation: "Replace location",
	findingLocation: "Finding location",
	locationAccuracy: "Location accuracy: {meters} m",
	cancelLocation: "Cancel",
	locationCaptureCancelled: "Location capture cancelled",
	latitudeLine: "Latitude: {dms}",
	longitudeLine: "Longitude: {dms}",
	altitudeLine: "Altitude: {m}m",
	accuracyLine: "Accuracy: {m}m",
	// Android's barcode question.
	scanBarcode: "Scan",
	// Android's capture widgets (`R.string.capture_image` and its siblings).
	takePicture: "Take picture",
	chooseImage: "Choose image",
	removeImage: "Remove image",
	recordSound: "Record sound",
	startRecording: "Start recording",
	stopRecording: "Stop recording",
	recordVideo: "Record video",
	chooseVideo: "Choose video",
	// Android's completion of a form opened for a case the phone lacks: Core
	// refuses to process it (`CaseXmlParser.java::loadCase`) and posts
	// "Problem with your App" (`notification.processing.badstructure.*`).
	formNotProcessedTitle: "CommCare couldn't save this form",
	formNotProcessedDetail:
		"The phone doesn't have the case this form changes, so the phone couldn't save the form. A worker sees “Problem with your App”.",
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
	refusalPreloadTitle: "Este formulario no se puede abrir para {caseName}",
	refusalPreloadBody:
		"El valor de {property} de {caseName} es «{value}», que no es {type}, así que CommCare no abrirá este formulario para ese registro. Puede elegir otro registro.",
	refusalStartingValueTitle: "Este formulario aún no se puede abrir",
	refusalStartingValueBody:
		"El valor inicial de «{question}» da «{value}», que no es {type}, así que CommCare no abrirá el formulario. Puede cambiar el valor inicial de la pregunta para que dé {type}.",
	refusalRepeatInsert:
		"No se puede añadir otra entrada de «{repeat}»: el valor inicial de «{question}» da «{value}», que no es {type}. Puede cambiar el valor inicial de la pregunta para que dé {type}.",
	chooseAnotherRecord: "Elegir otro registro",
	backToList: "Volver a la lista",
	answerTypeDate: "una fecha",
	answerTypeTime: "una hora",
	answerTypeDatetime: "una fecha y hora",
	answerTypeInt: "un número entero",
	answerTypeDecimal: "un número",
	answerTypeGeopoint: "una ubicación",
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
	locationGuidance:
		"Puedes buscar una dirección o tocar el mapa para marcar un punto",
	hereColumnsWaiting:
		"Las columnas que usan tu ubicación quedan en blanco hasta que el navegador la comparta.",
	hereColumnsRefused:
		"El navegador no está compartiendo tu ubicación, así que las columnas que la usan quedan en blanco. Puedes permitir la ubicación para este sitio en la configuración del navegador.",
	hereColumnsUnavailable:
		"El navegador no pudo encontrar tu ubicación, así que las columnas que la usan quedan en blanco. Puedes intentarlo de nuevo.",
	hereColumnsUnsupported:
		"Este navegador no puede compartir tu ubicación, así que las columnas que la usan quedan en blanco.",
	shareYourLocation: "Compartir tu ubicación",
	searchResultsRefusalTitle: "Este formulario se abre después de una búsqueda",
	searchResultsRefusalBody:
		"Este formulario lee lo que encontró la búsqueda. Puedes hacer la búsqueda y luego elegir el registro de nuevo.",
	goToSearch: "Ir a la búsqueda",
	searchResultsInvalidTitle:
		"La búsqueda anterior a este formulario no se puede hacer",
	searchResultsLoading:
		"Nova está cargando lo que encontró la búsqueda para este formulario.",
	searchResultsLoadFailed:
		"Lo que encontró la búsqueda no se cargó. Puedes intentarlo de nuevo.",
	searchDeviceCasesLoadFailed:
		"Nova no pudo cargar los registros de este dispositivo que lee la búsqueda. Inténtalo de nuevo para hacer la búsqueda.",
	searchResultsCap:
		"Esta búsqueda encontró {count} registros. La búsqueda de CommCare envía al dispositivo los primeros 500, así que este formulario también lee 500 de ellos aquí.",
	dataRefusalFormTitle: "Este formulario se detiene aquí en un teléfono",
	dataRefusalLinksTitle:
		"El siguiente paso de este formulario se detiene en un teléfono",
	dataRefusalMenuTitle: "Este menú no se abre en un teléfono",
	dataRefusalSearchTitle: "Esta búsqueda no se abre en un teléfono",
	dataRefusalSubjectForm: "Este formulario lee",
	dataRefusalSubjectLinks: "Los enlaces de este formulario leen",
	dataRefusalSubjectMenu: "Este menú lee",
	dataRefusalPlacesPersona:
		"{subject} un lugar, y {worker} no tiene ningún lugar asignado, así que un teléfono se detiene aquí. Puede darle un lugar a {worker} en Usuarios y personas, en la configuración de la app.",
	dataRefusalPlacesMe:
		"{subject} un lugar, y usted no tiene ningún lugar asignado, así que un teléfono se detiene aquí. Puede ver la vista previa como una persona que tenga un lugar.",
	dataRefusalOwnerPlacePersona:
		"Este formulario mueve el caso al lugar de {worker}, y {worker} no tiene ningún lugar asignado, así que el caso no tiene a qué propietario moverse y un teléfono se detiene aquí. Puede darle un lugar a {worker} en Usuarios y personas, en la configuración de la app.",
	dataRefusalOwnerPlaceMe:
		"Este formulario mueve el caso a su lugar, y usted no tiene ningún lugar asignado, así que el caso no tiene a qué propietario moverse y un teléfono se detiene aquí. Puede ver la vista previa como una persona que tenga un lugar.",
	dataRefusalTable:
		"{subject} «{table}», que no tiene filas, así que un teléfono se detiene aquí. Puede añadir filas a «{table}» en los datos del proyecto.",
	dataRefusalChoices:
		"«{question}» toma sus opciones de «{table}», que no tiene filas, así que un teléfono no la abrirá. Puede añadir filas a «{table}» en los datos del proyecto.",
	dataRefusalSearchChoices:
		"El campo de búsqueda «{input}» toma sus opciones de «{table}», que no tiene filas, así que un teléfono no abrirá esta búsqueda. Puede añadir filas a «{table}» en los datos del proyecto.",
	dataRefusalSearchAnswers:
		"{subject} una respuesta de búsqueda que quedó en blanco, así que un teléfono se detiene aquí. Puede buscar de nuevo con esa respuesta.",
	dataRefusalOther:
		"{subject} un valor que un teléfono no tiene en este punto, así que un teléfono se detiene aquí.",
	thisQuestion: "esta pregunta",
	thisSearchField: "este campo",

	deviceHomeStart: "Iniciar",
	deviceHomeSaved: "Guardados",
	deviceHomeIncomplete: "Incompletos",
	deviceHomeSync: "Sincronizar con el servidor",
	deviceHomeLastSync: "Última sincronización con el servidor: {time}",
	deviceHomeLogOut: "Cerrar sesión en CommCare",
	formlessReturned: "Sincronizado y de vuelta en la primera pantalla",
	finish: "Terminar",
	repeatGoBack: "Volver",
	repeatAddNew: "¿Agregar un nuevo {label}?",
	repeatAddAnother: "¿Agregar otro {label}?",
	repeatDoNotAdd: "No agregar",
	repeatDoNotAddFinish: "No agregar, terminé",
	showHelp: "Mostrar ayuda",
	close: "Cerrar",
	ok: "Aceptar",
	recordLocation: "Registrar ubicación",
	replaceLocation: "Reemplazar ubicación",
	findingLocation: "Buscando ubicación",
	locationAccuracy: "Precisión de la ubicación: {meters} m",
	cancelLocation: "Cancelar",
	locationCaptureCancelled: "Captura de ubicación cancelada",
	latitudeLine: "Latitud: {dms}",
	longitudeLine: "Longitud: {dms}",
	altitudeLine: "Altitud: {m}m",
	accuracyLine: "Precisión: {m}m",
	scanBarcode: "Escanear",
	takePicture: "Tomar foto",
	chooseImage: "Elegir imagen",
	removeImage: "Quitar imagen",
	recordSound: "Grabar sonido",
	startRecording: "Empezar a grabar",
	stopRecording: "Detener la grabación",
	recordVideo: "Grabar video",
	chooseVideo: "Elegir video",
	formNotProcessedTitle: "CommCare no pudo guardar este formulario",
	formNotProcessedDetail:
		"El teléfono no tiene el caso que cambia este formulario, así que no pudo guardarlo. Quien trabaja ve “Problem with your App”.",
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

/** A refused value as refusal copy quotes it: 60 characters at most, a
 * longer one shortened with "…" inside the quotes. */
export function refusalValueText(value: string): string {
	const characters = [...value];
	return characters.length > 60
		? `${characters.slice(0, 59).join("")}…`
		: value;
}

const ANSWER_TYPE_PHRASE: Readonly<Record<RefusingAnswerType, RuntimeMessage>> =
	{
		date: "answerTypeDate",
		time: "answerTypeTime",
		datetime: "answerTypeDatetime",
		int: "answerTypeInt",
		decimal: "answerTypeDecimal",
		geopoint: "answerTypeGeopoint",
	};

/** The names a refusal's copy reads, resolved by the surface showing it. */
export interface RefusalCopyNames {
	/** A preload's case: its `case_name`. */
	readonly caseName?: string;
	/** A preload's property label. */
	readonly property?: string;
	/** The question's label. */
	readonly question?: string;
	/** A repeat insert's repeat label. */
	readonly repeat?: string;
}

/** The copy for a refused setvalue: a heading for the two causes that stop
 * the form, and the body every surface shows. */
export function refusalCopy(
	language: LanguageTag | null | undefined,
	details: SetvalueRefusalDetails,
	names: RefusalCopyNames,
): { readonly title?: string; readonly body: string } {
	const values = {
		value: refusalValueText(details.value),
		type: runtimeMessage(language, ANSWER_TYPE_PHRASE[details.answerType]),
		caseName: names.caseName ?? runtimeMessage(language, "case"),
		property: names.property ?? details.property ?? "",
		question: names.question ?? details.path,
		repeat: names.repeat ?? runtimeMessage(language, "entry"),
	};
	switch (details.cause) {
		case "preload":
			return {
				title: runtimeMessage(language, "refusalPreloadTitle", values),
				body: runtimeMessage(language, "refusalPreloadBody", values),
			};
		case "starting-value":
			return {
				title: runtimeMessage(language, "refusalStartingValueTitle", values),
				body: runtimeMessage(language, "refusalStartingValueBody", values),
			};
		case "repeat-insert":
			return { body: runtimeMessage(language, "refusalRepeatInsert", values) };
	}
}

/** Where a data refusal stops the running app. */
export type DataRefusalSurface = PreviewDataRefusalStage | "menu" | "search";

/** The names a data refusal's copy reads, resolved by the surface showing it. */
export interface DataRefusalCopyNames {
	/** The persona previewing; absent when previewing as oneself. */
	readonly worker?: string;
	/** The question whose choices come from the table. */
	readonly question?: string;
	/** The Search prompt whose choices come from the table. */
	readonly input?: string;
}

const DATA_REFUSAL_TITLE: Readonly<Record<DataRefusalSurface, RuntimeMessage>> =
	{
		form: "dataRefusalFormTitle",
		links: "dataRefusalLinksTitle",
		menu: "dataRefusalMenuTitle",
		search: "dataRefusalSearchTitle",
	};

const DATA_REFUSAL_SUBJECT: Readonly<
	Record<DataRefusalSurface, RuntimeMessage>
> = {
	form: "dataRefusalSubjectForm",
	links: "dataRefusalSubjectLinks",
	menu: "dataRefusalSubjectMenu",
	/* A Search screen reads nothing but its choices that can refuse; the
	 * menu's wording stands for any other read there. */
	search: "dataRefusalSubjectMenu",
};

/**
 * The copy for data a device holds none of: what a phone does there and
 * what to change. Never a fault's wording: the app is right, the data is
 * empty.
 */
export function dataRefusalCopy(
	language: LanguageTag | null | undefined,
	surface: DataRefusalSurface,
	subject: PreviewDataRefusalSubject,
	names: DataRefusalCopyNames = {},
): { readonly title: string; readonly body: string } {
	const title = runtimeMessage(language, DATA_REFUSAL_TITLE[surface]);
	const lead = runtimeMessage(language, DATA_REFUSAL_SUBJECT[surface]);
	const body = (key: RuntimeMessage, values: Record<string, string> = {}) =>
		runtimeMessage(language, key, { subject: lead, ...values });
	switch (subject.kind) {
		case "places":
			return {
				title,
				body:
					names.worker === undefined
						? body("dataRefusalPlacesMe")
						: body("dataRefusalPlacesPersona", { worker: names.worker }),
			};
		case "owner-place":
			return {
				title,
				body:
					names.worker === undefined
						? body("dataRefusalOwnerPlaceMe")
						: body("dataRefusalOwnerPlacePersona", { worker: names.worker }),
			};
		case "table":
			return {
				title,
				body: body("dataRefusalTable", { table: subject.tableName }),
			};
		case "choices":
			return {
				title,
				body:
					surface === "search"
						? body("dataRefusalSearchChoices", {
								table: subject.tableName,
								input:
									names.input ?? runtimeMessage(language, "thisSearchField"),
							})
						: body("dataRefusalChoices", {
								table: subject.tableName,
								question:
									names.question ?? runtimeMessage(language, "thisQuestion"),
							}),
			};
		case "search-answers":
			return { title, body: body("dataRefusalSearchAnswers") };
		case "other":
			return { title, body: body("dataRefusalOther") };
	}
}
