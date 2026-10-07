package nova.proof.core;

import com.google.common.collect.Multimap;

import org.commcare.cases.entity.Entity;
import org.commcare.core.interfaces.MemoryVirtualDataInstanceStorage;
import org.commcare.modern.session.SessionWrapper;
import org.commcare.modern.util.Pair;
import org.commcare.session.SessionFrame;
import org.commcare.suite.model.Detail;
import org.commcare.suite.model.DetailField;
import org.commcare.suite.model.EntityDatum;
import org.commcare.suite.model.FormIdDatum;
import org.commcare.suite.model.MenuDisplayable;
import org.commcare.suite.model.SessionDatum;
import org.commcare.suite.model.Text;
import org.commcare.util.mocks.MockUserDataSandbox;
import org.commcare.util.screen.EntityDetailSubscreen;
import org.commcare.util.screen.EntityListSubscreen;
import org.commcare.util.screen.EntityScreen;
import org.commcare.util.screen.EntityScreenContext;
import org.commcare.util.screen.MenuScreen;
import org.commcare.util.screen.MultiSelectEntityScreen;
import org.commcare.util.screen.QueryScreen;
import org.commcare.util.screen.SyncScreen;
import org.javarosa.core.model.condition.EvaluationContext;
import org.javarosa.core.model.instance.ExternalDataInstance;
import org.javarosa.core.model.instance.TreeReference;
import org.javarosa.core.services.locale.Localization;
import org.javarosa.xpath.XPathParseTool;
import org.javarosa.xpath.expr.FunctionUtils;
import org.javarosa.xpath.expr.XPathExpression;
import org.json.JSONArray;
import org.json.JSONObject;

import java.io.InputStream;
import java.net.URL;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Base64;
import java.util.Deque;
import java.util.Hashtable;
import java.util.List;

/**
 * Scripted sessions over an admitted app, driven the way Formplayer drives Core
 * (formplayer session/MenuSession::getNextScreen and
 * services/MenuSessionRunnerService::getNextMenu): Core's own screens
 * (MenuScreen, EntityScreen, QueryScreen, SyncScreen) over a SessionWrapper,
 * whose instance initializer is Core's CommCareInstanceInitializer.
 *
 * A script is a list of runs; a run is the list of choices it makes, one per
 * screen that asks for one: {"command": id} at a menu, {"select": case id} or
 * {"selectMany": [case ids]} at a case list, {"search": {prompt: answer}} at a
 * search. Lists are chosen from by case id, never by row index. Screens that
 * ask nothing (a computed datum, an auto-selected case, a sync, an
 * auto-launched action) advance on their own and are traced.
 *
 * Without a script, one is derived: every command of every menu, depth first
 * in menu order, and at each case list the first case in Core's order. With a
 * script, each run replays it; a choice the screen cannot take is recorded as
 * an "unreplayable" step and ends that run.
 *
 * At a single-select list, the chosen case's detail is recorded as Web Apps
 * shows it before taking the case (caseDetail), and so is an auto-selected
 * case's.
 *
 * Every run starts from the request's case data and ends at a submitted form,
 * or where it stopped, which the run's "end" names.
 */
final class SessionOp {
    private static final int MAX_SCREENS = 400;
    private static final int MAX_SCRIPT_STEPS = 64;
    private static final int MAX_RUNS = 5000;

    private final Apps.App app;
    private final byte[] restore;
    private final Answers answers;
    private final String locale;
    private final Generated.Inputs inputs;
    /** "afterSubmit": each submitted form's step also records what Core's session needs next (FormRun.next). */
    private boolean afterSubmit;

    private SessionOp(Apps.App app, byte[] restore, Answers answers, String locale, Generated.Inputs inputs) {
        this.app = app;
        this.restore = restore;
        this.answers = answers;
        this.locale = locale;
        this.inputs = inputs;
    }

    /**
     * {"appHandle", "restoreBase64": the case database as restore XML,
     * "answerTable": proof/core/answers.json, "questionKinds"?: {data path: Nova
     * kind}, "locale"?, "clock": the instant now() reads, "script"?: [[step,
     * ...], ...]} gives {"locale", "clock", "profile", "derived", "runs":
     * [{"script", "trace", "end", "generated"}]}. "profile" is the app's
     * required version and properties as its admission read them.
     */
    static JSONObject run(JSONObject request, Apps apps) throws Exception {
        Apps.App app = apps.require(Ops.requireString(request, "appHandle"));
        apps.activate(app);
        byte[] restore = Base64.getDecoder().decode(Ops.requireString(request, "restoreBase64"));
        Answers answers = new Answers(Ops.requireObject(request, "answerTable"),
                request.optJSONObject("questionKinds"));
        String locale = request.optString("locale", Apps.profileLocale(app));
        if (!Arrays.asList(Localization.getGlobalLocalizerAdvanced().getAvailableLocales()).contains(locale)) {
            throw new RequestException("The app has no locale \"" + locale + "\"; its locales are "
                    + String.join(", ", Localization.getGlobalLocalizerAdvanced().getAvailableLocales()) + ".");
        }
        String clock = Ops.requireString(request, "clock");
        ProofClock.set(clock);
        Generated.Inputs inputs = Generated.Inputs.of(app, restore, request);
        SessionOp op = new SessionOp(app, restore, answers, locale, inputs);
        op.afterSubmit = request.optBoolean("afterSubmit", false);

        JSONArray runs = new JSONArray();
        JSONArray script = request.optJSONArray("script");
        if (script != null) {
            for (int i = 0; i < script.length(); i++) {
                JSONArray steps = script.optJSONArray(i);
                if (steps == null) {
                    throw new RequestException("Each run of the script is a list of steps; run " + i + " is not.");
                }
                List<JSONObject> list = new ArrayList<>();
                for (int j = 0; j < steps.length(); j++) {
                    list.add(steps.getJSONObject(j));
                }
                runs.put(op.execute(list, false).run);
            }
        } else {
            Deque<List<JSONObject>> pending = new ArrayDeque<>();
            pending.push(new ArrayList<>());
            while (!pending.isEmpty()) {
                if (runs.length() + pending.size() > MAX_RUNS) {
                    throw new IllegalStateException("The derived script grew past " + MAX_RUNS
                            + " runs; the runner stopped exploring this app.");
                }
                Execution execution = op.execute(pending.pop(), true);
                if (execution.branches != null) {
                    for (int i = execution.branches.size() - 1; i >= 0; i--) {
                        List<JSONObject> child = new ArrayList<>(execution.script);
                        JSONObject command = new JSONObject();
                        command.put("command", execution.branches.get(i));
                        child.add(command);
                        pending.push(child);
                    }
                } else {
                    runs.put(execution.run);
                }
            }
        }
        JSONObject result = new JSONObject();
        result.put("locale", locale);
        result.put("clock", clock);
        result.put("profile", app.profile);
        result.put("derived", script == null);
        result.put("runs", runs);
        return result;
    }

    /** One run, or (while deriving) a menu whose commands are the branches to explore next. */
    private static final class Execution {
        JSONObject run;
        List<String> branches;
        List<JSONObject> script;
    }

    private Execution execute(List<JSONObject> given, boolean derive) throws Exception {
        Localization.setLocale(locale);
        Generated.seedCoreRandomness();
        MockUserDataSandbox sandbox = CaseData.sandbox(app.engine.getPlatform(), restore);
        SessionWrapper session = new SessionWrapper(app.engine.getPlatform(), sandbox);
        ProofSessionUtils network = new ProofSessionUtils(restore, sandbox);
        Selections selections = new Selections();
        String username = sandbox.getLoggedInUser().getUsername();

        Execution execution = new Execution();
        List<JSONObject> script = new ArrayList<>();
        JSONArray trace = new JSONArray();
        String end = null;
        int cursor = 0;

        screens:
        for (int screens = 0; end == null; screens++) {
            if (screens > MAX_SCREENS) {
                end = "too-many-screens";
                break;
            }
            if (script.size() > MAX_SCRIPT_STEPS) {
                end = "too-deep";
                break;
            }
            String next;
            try {
                next = session.getNeededData(session.getEvaluationContext());
            } catch (RuntimeException e) {
                trace.put(errorStep("session", e));
                end = "error";
                break;
            }
            JSONObject step = new JSONObject();
            try {
                if (next == null) {
                    String command = session.getCommand();
                    if (command != null && session.isViewCommand(command)) {
                        step.put("screen", "view");
                        step.put("command", command);
                        trace.put(step);
                        end = "view";
                        break;
                    }
                    Text assertion = session.getCurrentEntry().getAssertions()
                            .getAssertionFailure(session.getEvaluationContext());
                    if (assertion != null) {
                        step.put("screen", "assertion");
                        step.put("text", FormRun.text(() -> assertion.evaluate(session.getEvaluationContext())));
                        trace.put(step);
                        end = "assertion-failed";
                        break;
                    }
                    if (cursor < given.size()) {
                        trace.put(unreplayable(given.get(cursor), "form"));
                        end = "unreplayable";
                        break;
                    }
                    String xmlns = session.getForm();
                    if (xmlns == null) {
                        // Navigation that ends without a form (a remote request, typically): Formplayer runs
                        // the entry's stack (MenuSessionRunnerService.executeAndRebuildSession).
                        step.put("screen", "no-form");
                        step.put("command", FormRun.nullable(command));
                        trace.put(step);
                        session.syncState();
                        boolean more = session.finishExecuteAndPop(session.getEvaluationContext());
                        session.clearVolatiles();
                        JSONObject stack = new JSONObject();
                        stack.put("nextFrameReady", more);
                        stack.put("steps", FormRun.frameSteps(session));
                        stack.put("pendingFrames", session.getFrameStack().size());
                        step.put("stackAfterEnd", stack);
                        end = "no-form";
                        break;
                    }
                    FormRun form = new FormRun(session, app.engine, sandbox, answers, locale);
                    form.recordNext = afterSubmit;
                    trace.put(form.run(xmlns));
                    end = form.end;
                    break;
                }
                switch (next) {
                    case SessionFrame.STATE_COMMAND_ID: {
                        MenuScreen menu = new MenuScreen();
                        menu.init(session);
                        step.put("screen", "menu");
                        step.put("root", session.getCommand() == null ? "root" : session.getCommand());
                        List<String> commands = new ArrayList<>();
                        JSONArray choices = new JSONArray();
                        for (MenuDisplayable choice : menu.getMenuDisplayables()) {
                            commands.add(choice.getCommandID());
                            JSONObject c = new JSONObject();
                            c.put("command", choice.getCommandID());
                            c.put("text", FormRun.text(() -> choice.getDisplayText(session
                                    .getEvaluationContextWithAccumulatedInstances(choice.getCommandID(),
                                            choice.getRawText()))));
                            c.put("image", FormRun.nullable(choice.getImageURI()));
                            c.put("audio", FormRun.nullable(choice.getAudioURI()));
                            choices.put(c);
                        }
                        step.put("choices", choices);
                        step.put("badges", badges(menu));
                        JSONArray hidden = new JSONArray();
                        for (MenuDisplayable choice : menu.getAllChoices()) {
                            if (!commands.contains(choice.getCommandID())) {
                                hidden.put(choice.getCommandID());
                            }
                        }
                        step.put("hidden", hidden);
                        trace.put(step);
                        if (cursor >= given.size()) {
                            if (commands.isEmpty()) {
                                end = "empty-menu";
                            } else if (derive) {
                                execution.branches = commands;
                                execution.script = script;
                                return execution;
                            } else {
                                end = "script-ended";
                            }
                            break screens;
                        }
                        JSONObject choice = given.get(cursor);
                        String command = choice.optString("command", null);
                        int index = command == null ? -1 : commands.indexOf(command);
                        if (index < 0) {
                            trace.put(unreplayable(choice, "menu"));
                            end = "unreplayable";
                            break screens;
                        }
                        cursor++;
                        script.add(choice);
                        step.put("chosen", command);
                        menu.handleInputAndUpdateSession(session, String.valueOf(index), false, null, true);
                        break;
                    }
                    case SessionFrame.STATE_DATUM_VAL:
                    case SessionFrame.STATE_MULTIPLE_DATUM_VAL: {
                        boolean many = SessionFrame.STATE_MULTIPLE_DATUM_VAL.equals(next);
                        EntityDatum datum = (EntityDatum)session.getNeededDatum();
                        EntityScreen screen = many
                                ? new MultiSelectEntityScreen(false, true, session, selections,
                                        new EntityScreenContext())
                                : new EntityScreen(false, true, session, new EntityScreenContext());
                        screen.init(session);
                        step.put("screen", many ? "multi-select-list" : "case-list");
                        step.put("datum", datum.getDataId());
                        step.put("detail", FormRun.nullable(datum.getShortDetail()));
                        step.put("title", FormRun.text(screen::getScreenTitle));
                        trace.put(step);
                        if (screen.shouldBeSkipped()) {
                            TreeReference only = screen.getReferences().firstElement();
                            JSONObject detail = caseDetail(screen, datum, only);
                            boolean advanced = screen.autoSelectEntities(session);
                            step.put("autoSelected", EntityScreen.getReturnValueFromSelection(only, datum,
                                    screen.getEvalContext()));
                            if (detail != null) {
                                step.put("caseDetail", detail);
                            }
                            if (!advanced) {
                                // A single case with a case detail: Web Apps shows the detail, and
                                // confirming it (empty input to EntityDetailSubscreen) selects the case.
                                step.put("confirmedDetail", true);
                                screen.handleInputAndUpdateSession(session, "", false, null, true);
                            }
                            break;
                        }
                        List<String> caseIds = rows(screen, datum, step);
                        if (screen.evalAndExecuteAutoLaunchAction("", session)) {
                            step.put("autoLaunched", true);
                            break;
                        }
                        JSONObject choice;
                        if (cursor < given.size()) {
                            choice = given.get(cursor);
                        } else if (caseIds.isEmpty()) {
                            end = "no-cases";
                            break screens;
                        } else if (derive) {
                            choice = new JSONObject();
                            if (many) {
                                choice.put("selectMany", new JSONArray(List.of(caseIds.get(0))));
                            } else {
                                choice.put("select", caseIds.get(0));
                            }
                        } else {
                            end = "script-ended";
                            break screens;
                        }
                        if (!many && choice.opt("select") instanceof String) {
                            TreeReference chosen = screen.resolveTreeReference(choice.getString("select"));
                            JSONObject detail = chosen == null ? null : caseDetail(screen, datum, chosen);
                            if (detail != null) {
                                step.put("caseDetail", detail);
                            }
                        }
                        if (!select(screen, session, choice, many)) {
                            trace.put(unreplayable(choice, step.getString("screen")));
                            end = "unreplayable";
                            break screens;
                        }
                        if (cursor < given.size()) {
                            cursor++;
                        }
                        script.add(choice);
                        step.put("chosen", choice);
                        break;
                    }
                    case SessionFrame.STATE_DATUM_COMPUTED: {
                        SessionDatum datum = session.getNeededDatum();
                        step.put("screen", "computed");
                        step.put("datum", datum.getDataId());
                        computeDatum(session);
                        JSONArray frame = FormRun.frameSteps(session);
                        step.put("step", frame.get(frame.length() - 1));
                        trace.put(step);
                        break;
                    }
                    case SessionFrame.STATE_QUERY_REQUEST: {
                        QueryScreen query = new QueryScreen(username, "", System.out, selections, network);
                        query.init(session);
                        step.put("screen", "search");
                        step.put("title", FormRun.text(query::getScreenTitle));
                        JSONArray prompts = new JSONArray();
                        String[] displays = query.getOptions();
                        int i = 0;
                        for (String key : query.getUserInputDisplays().keySet()) {
                            JSONObject prompt = new JSONObject();
                            prompt.put("key", key);
                            prompt.put("text", FormRun.nullable(i < displays.length ? displays[i] : null));
                            prompts.put(prompt);
                            i++;
                        }
                        step.put("prompts", prompts);
                        step.put("defaultSearch", query.doDefaultSearch());
                        trace.put(step);
                        JSONObject choice;
                        if (cursor < given.size()) {
                            choice = given.get(cursor);
                            if (!(choice.opt("search") instanceof JSONObject)) {
                                trace.put(unreplayable(choice, "search"));
                                end = "unreplayable";
                                break screens;
                            }
                            cursor++;
                        } else if (derive) {
                            choice = new JSONObject();
                            choice.put("search", new JSONObject());
                        } else {
                            end = "script-ended";
                            break screens;
                        }
                        script.add(choice);
                        step.put("chosen", choice);
                        if (!search(query, choice.getJSONObject("search"), network, username, step)) {
                            end = "search-failed";
                            break screens;
                        }
                        break;
                    }
                    case SessionFrame.STATE_SYNC_REQUEST: {
                        SyncScreen sync = new SyncScreen(username, "", System.out, network);
                        sync.init(session);
                        sync.handleInputAndUpdateSession(session, "", false, null, true);
                        step.put("screen", "sync");
                        step.put("requests", network.takeEvents());
                        trace.put(step);
                        break;
                    }
                    default: {
                        step.put("screen", "unexpected");
                        step.put("request", next);
                        trace.put(step);
                        end = "unexpected-frame-request";
                        break screens;
                    }
                }
            } catch (Exception e) {
                step.put("error", FormRun.failure(e));
                if (!step.has("screen")) {
                    step.put("screen", next == null ? "form" : next);
                }
                if (trace.length() == 0 || trace.get(trace.length() - 1) != step) {
                    trace.put(step);
                }
                end = "error";
            }
        }

        JSONObject run = new JSONObject();
        run.put("script", new JSONArray(script));
        run.put("trace", trace);
        run.put("end", end);
        run.put("generated", Generated.mark(run, inputs));
        execution.run = run;
        return execution;
    }

    /** Every row of the case list in Core's order, with each row's case id; returns the case ids. */
    static List<String> rows(EntityScreen screen, EntityDatum datum, JSONObject step) {
        List<String> caseIds = new ArrayList<>();
        if (!(screen.getCurrentScreen() instanceof EntityListSubscreen)) {
            step.put("showing", screen.getCurrentScreen() instanceof EntityDetailSubscreen ? "detail"
                    : String.valueOf(screen.getCurrentScreen()));
            return caseIds;
        }
        EntityListSubscreen list = (EntityListSubscreen)screen.getCurrentScreen();
        EvaluationContext context = screen.getEvalContext();
        describeList(list, screen.getShortDetail(), context, datum, caseIds, step);
        JSONArray actions = new JSONArray();
        if (list.getActions() != null) {
            list.getActions().forEach(action -> actions.put(FormRun.text(() ->
                    action.getDisplay().evaluate(context).getName())));
        }
        step.put("actions", actions);
        return caseIds;
    }

    /**
     * A list's headers, width hints and rows in Core's order. With a datum, each
     * row carries the case id selecting it returns, which is added to caseIds.
     */
    private static void describeList(EntityListSubscreen list, Detail detail, EvaluationContext context,
                                     EntityDatum datum, List<String> caseIds, JSONObject into) {
        Pair<String[], int[]> headers = EntityListSubscreen.getHeaders(detail, context, 0);
        into.put("headers", new JSONArray(headers.first));
        JSONArray headerWidths = new JSONArray();
        JSONArray templateWidths = new JSONArray();
        for (DetailField field : detail.getFields()) {
            headerWidths.put(FormRun.nullable(field.getHeaderWidthHint()));
            templateWidths.put(FormRun.nullable(field.getTemplateWidthHint()));
        }
        into.put("headerWidths", headerWidths);
        into.put("templateWidths", templateWidths);
        JSONArray rows = new JSONArray();
        for (Entity<TreeReference> entity : list.getEntities()) {
            JSONObject row = new JSONObject();
            if (datum != null) {
                String caseId = EntityScreen.getReturnValueFromSelection(entity.getElement(), datum, context);
                caseIds.add(caseId);
                row.put("caseId", caseId);
            }
            JSONArray fields = new JSONArray();
            JSONArray sorts = new JSONArray();
            for (int i = 0; i < entity.getNumFields(); i++) {
                fields.put(displayed(entity.getField(i)));
                sorts.put(FormRun.nullable(entity.getSortField(i)));
            }
            row.put("fields", fields);
            row.put("sortFields", sorts);
            rows.put(row);
        }
        into.put("rows", rows);
    }

    /** A detail value as the trace records it: its text, or the kind of object Core made (a graph, an image). */
    private static Object displayed(Object value) {
        if (value == null || value instanceof String) {
            return FormRun.nullable(value);
        }
        JSONObject other = new JSONObject();
        other.put("object", value.getClass().getSimpleName());
        return other;
    }

    /**
     * The case detail Web Apps shows for a case before it takes it from a
     * single-select list (HQ's cloudcare menus/views.js rowClick shows it
     * whenever the list has details; Formplayer builds it in
     * MenuController.getDetails through EntityDetailListResponse.processDetails):
     * each tab of the datum's long detail that its display conditions show, with
     * its title and either its non-empty fields' headers and values or, for a tab
     * over a nodeset, that list's rows. Null when the datum names no case detail;
     * "missing" when it names one the suite does not define.
     */
    static JSONObject caseDetail(EntityScreen screen, EntityDatum datum, TreeReference reference) {
        String id = datum.getLongDetail();
        if (id == null) {
            return null;
        }
        JSONObject detail = new JSONObject();
        detail.put("id", id);
        if (screen.getLongDetail() == null) {
            detail.put("missing", true);
            return detail;
        }
        EvaluationContext context = screen.getEvalContext();
        Detail[] tabs;
        try {
            tabs = screen.getLongDetailList(reference);
        } catch (RuntimeException e) {
            detail.put("error", FormRun.failure(e));
            return detail;
        }
        String[] titles = new String[tabs.length];
        JSONArray described = new JSONArray();
        for (int i = 0; i < tabs.length; i++) {
            Detail tab = tabs[i];
            Object title = FormRun.text(() -> tab.getTitle().getText().evaluate(context));
            titles[i] = title instanceof String ? (String)title : "";
            JSONObject t = new JSONObject();
            t.put("title", title);
            described.put(t);
        }
        EvaluationContext caseContext = new EvaluationContext(context, reference);
        for (int i = 0; i < tabs.length; i++) {
            JSONObject t = described.getJSONObject(i);
            try {
                if (tabs[i].getNodeset() == null) {
                    EntityDetailSubscreen fields = new EntityDetailSubscreen(i, tabs[i], caseContext, titles, false);
                    t.put("headers", new JSONArray(fields.getHeaders()));
                    JSONArray values = new JSONArray();
                    for (Object value : fields.getData()) {
                        values.put(displayed(value));
                    }
                    t.put("values", values);
                } else {
                    TreeReference nodeset = tabs[i].getNodeset().contextualize(reference);
                    EntityListSubscreen list = new EntityListSubscreen(tabs[i],
                            caseContext.expandReference(nodeset), caseContext, false, new EntityScreenContext());
                    describeList(list, tabs[i], caseContext, null, null, t);
                }
            } catch (Exception e) {
                t.put("error", FormRun.failure(e));
            }
        }
        detail.put("tabs", described);
        return detail;
    }

    /** Selects by case id through the screen's own input handling, as Formplayer passes a case id. */
    private static boolean select(EntityScreen screen, SessionWrapper session, JSONObject choice, boolean many)
            throws Exception {
        try {
            if (many) {
                JSONArray ids = choice.optJSONArray("selectMany");
                if (ids == null) {
                    return false;
                }
                String[] values = new String[ids.length()];
                for (int i = 0; i < values.length; i++) {
                    values[i] = ids.getString(i);
                }
                // MultiSelectEntityScreen.handleInputAndUpdateSession always answers false (Core's CLI host
                // moves on regardless); the selection took when the screen stored it.
                MultiSelectEntityScreen multiSelect = (MultiSelectEntityScreen)screen;
                multiSelect.handleInputAndUpdateSession(session, MultiSelectEntityScreen.USE_SELECTED_VALUES,
                        false, values, true);
                return multiSelect.getStorageReferenceId() != null;
            }
            String id = choice.optString("select", null);
            if (id == null) {
                return false;
            }
            return screen.handleInputAndUpdateSession(session, id, false, null, true);
        } catch (org.commcare.util.screen.CommCareSessionException e) {
            choice.put("refusal", e.getMessage());
            return false;
        }
    }

    /**
     * QueryScreen.handleInputAndUpdateSession's steps, with the prompt answers
     * given by key rather than as the CLI's comma-separated line.
     */
    private static boolean search(QueryScreen query, JSONObject given, ProofSessionUtils network, String username,
                                  JSONObject step) {
        Hashtable<String, String> answers = new Hashtable<>();
        for (String key : given.keySet()) {
            answers.put(key, given.getString(key));
        }
        query.answerPrompts(answers);
        URL url = query.getBaseUrl();
        Multimap<String, String> params = query.getQueryParams(false);
        step.put("url", url == null ? JSONObject.NULL : url.toString());
        step.put("params", ProofSessionUtils.params(params));
        JSONObject errors = new JSONObject();
        query.getErrors().forEach(errors::put);
        step.put("promptErrors", errors);
        InputStream response = network.makeQueryRequest(url, params, username, "");
        Pair<ExternalDataInstance, String> instance = query.processResponse(response, url, params);
        step.put("requests", network.takeEvents());
        if (instance.first == null) {
            step.put("error", FormRun.nullable(instance.second));
            return false;
        }
        query.updateSession(instance.first);
        return true;
    }

    /** Formplayer's MenuSession.computeDatum. */
    private static void computeDatum(SessionWrapper sessionWrapper) {
        SessionDatum datum = sessionWrapper.getNeededDatum();
        XPathExpression form;
        try {
            form = XPathParseTool.parseXPath(datum.getValue());
        } catch (org.javarosa.xpath.parser.XPathSyntaxException e) {
            e.printStackTrace();
            throw new RuntimeException(e.getMessage());
        }
        EvaluationContext ec = sessionWrapper.getEvaluationContext();
        if (datum instanceof FormIdDatum) {
            sessionWrapper.setXmlns(FunctionUtils.toString(form.eval(ec)));
            sessionWrapper.setEntityDatum("", "awful");
        } else {
            sessionWrapper.setEntityDatum(datum, FunctionUtils.toString(form.eval(ec)));
        }
    }

    private static Object badges(MenuScreen menu) {
        try {
            return new JSONArray(menu.getBadges());
        } catch (RuntimeException e) {
            JSONObject failed = new JSONObject();
            failed.put("failed", e.getClass().getSimpleName() + ": " + e.getMessage());
            return failed;
        }
    }

    private static JSONObject unreplayable(JSONObject choice, String screen) {
        JSONObject step = new JSONObject();
        step.put("screen", screen);
        step.put("unreplayable", choice);
        return step;
    }

    private static JSONObject errorStep(String screen, Exception e) {
        JSONObject step = new JSONObject();
        step.put("screen", screen);
        step.put("error", FormRun.failure(e));
        return step;
    }

    /**
     * The in-memory instance storage Core's CLI host uses, with keys a run can
     * repeat: Core's own names each stored selection with a random UUID
     * (MemoryVirtualDataInstanceStorage.write), which becomes the multi-select
     * datum's value in the session stack.
     */
    static final class Selections extends MemoryVirtualDataInstanceStorage {
        private int next = 1;

        @Override
        public String write(ExternalDataInstance dataInstance) {
            return write("selection-" + next++, dataInstance);
        }
    }
}
