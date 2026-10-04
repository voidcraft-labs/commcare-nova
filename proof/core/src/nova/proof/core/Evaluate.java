package nova.proof.core;

import org.commcare.modern.session.SessionWrapper;
import org.commcare.session.SessionFrame;
import org.commcare.suite.model.EntityDatum;
import org.commcare.util.CommCarePlatform;
import org.commcare.util.engine.CommCareConfigEngine;
import org.commcare.util.mocks.MockUserDataSandbox;
import org.commcare.util.screen.EntityScreen;
import org.commcare.util.screen.EntityScreenContext;
import org.commcare.util.screen.MultiSelectEntityScreen;
import org.javarosa.core.model.FormDef;
import org.javarosa.core.model.FormIndex;
import org.javarosa.core.model.data.IAnswerData;
import org.javarosa.core.model.instance.DataInstance;
import org.javarosa.core.model.instance.TreeReference;
import org.javarosa.core.services.locale.Localization;
import org.javarosa.core.services.storage.StorageManager;
import org.javarosa.form.api.FormEntryController;
import org.javarosa.form.api.FormEntryModel;
import org.javarosa.form.api.FormEntryPrompt;
import org.javarosa.model.xform.DataModelSerializer;
import org.javarosa.xform.util.XFormUtils;
import org.javarosa.xpath.XPathNodeset;
import org.javarosa.xpath.XPathParseTool;
import org.javarosa.xpath.expr.FunctionUtils;
import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.Date;
import java.util.HashMap;
import java.util.Map;
import java.util.NoSuchElementException;

/**
 * Opens one form, or one case list, with the session and case data a request
 * gives, and reports what Core computes there: expression values, constraint
 * verdicts, instance contents, and a case list's rows in Core's order. It is how
 * an intent check asks Core a question with a fixed expected answer.
 *
 * The form is the one an admitted app installed for an xmlns, or a form given
 * by its bytes and parsed as Core's XFormInstaller parses one. The session is a
 * SessionWrapper over the request's case data, holding the command and datums
 * the request names, so the session instance, casedb and fixtures are served by
 * Core's CommCareInstanceInitializer as they are at runtime. Answers are entered
 * in form order through FormEntryController.answerQuestion; constraint checks
 * use FormEntryController.checkQuestionConstraint, which checks without
 * committing. An answer or a check may give "@clock:today" or "@clock:now" for
 * the request's clock (Answers.resolve).
 */
final class Evaluate {
    private static final int MAX_EVENTS = 50_000;

    private Evaluate() {
    }

    static JSONObject run(JSONObject request, Apps apps) throws Exception {
        String handle = request.optString("appHandle", null);
        Apps.App app = handle == null ? null : apps.require(handle);
        CommCarePlatform platform;
        if (app != null) {
            apps.activate(app);
            platform = app.engine.getPlatform();
        } else {
            platform = new CommCarePlatform(CommCareConfigEngine.MAJOR_VERSION, CommCareConfigEngine.MINOR_VERSION,
                    CommCareConfigEngine.MINIMAL_VERSION, new StorageManager(new ProofEngine.Storages()));
        }
        ProofClock.set(Ops.requireString(request, "clock"));
        Generated.seedCoreRandomness();
        byte[] restore = Base64.getDecoder().decode(Ops.requireString(request, "restoreBase64"));
        MockUserDataSandbox sandbox = CaseData.sandbox(app == null ? null : platform, restore);
        SessionWrapper session = new SessionWrapper(platform, sandbox);
        JSONObject frame = request.optJSONObject("session");
        if (frame != null) {
            String command = frame.optString("command", null);
            if (command != null) {
                session.setCommand(command);
            }
            JSONObject data = frame.optJSONObject("data");
            if (data != null) {
                for (String key : Generated.sortedKeys(data)) {
                    session.setDatum(SessionFrame.STATE_DATUM_VAL, key, data.getString(key));
                }
            }
        }
        String locale = request.optString("locale", null);
        if (app != null) {
            if (locale != null) {
                Localization.setLocale(locale);
            } else {
                locale = Localization.getCurrentLocale();
            }
        }

        JSONObject result = new JSONObject();
        JSONObject caseList = request.optJSONObject("caseList");
        if (caseList != null) {
            result.put("caseList", caseList(session, caseList));
        } else {
            form(request, app, session, locale, result);
        }
        result.put("generated", Generated.mark(result, Generated.Inputs.of(app, restore, request)));
        result.put("clock", request.getString("clock"));
        return result;
    }

    private static void form(JSONObject request, Apps.App app, SessionWrapper session, String locale,
                             JSONObject result) throws Exception {
        FormDef form;
        String xmlns = request.optString("xmlns", null);
        if (xmlns != null) {
            if (app == null) {
                throw new RequestException("An evaluate request naming a form by xmlns needs the appHandle of the"
                        + " app that installed it.");
            }
            try {
                form = app.engine.loadFormByXmlns(xmlns);
            } catch (NoSuchElementException e) {
                form = null;
            }
            if (form == null) {
                throw new RequestException("App " + app.handle + " installed no form with xmlns " + xmlns + ".");
            }
        } else {
            byte[] bytes = Base64.getDecoder().decode(Ops.requireString(request, "formBase64"));
            form = XFormUtils.getFormRaw(new InputStreamReader(new ByteArrayInputStream(bytes), "UTF-8"));
        }
        form.initialize(true, session.getIIF(), locale, false);
        FormEntryModel model = new FormEntryModel(form, FormEntryModel.REPEAT_STRUCTURE_LINEAR);
        FormEntryController controller = new FormEntryController(model);

        result.put("answers", answer(model, controller, request.optJSONArray("answers"),
                request.optJSONObject("repeats")));
        result.put("constraints", constraints(model, controller, request.optJSONArray("constraintChecks")));

        JSONArray values = new JSONArray();
        JSONArray expressions = request.optJSONArray("expressions");
        if (expressions != null) {
            for (int i = 0; i < expressions.length(); i++) {
                String expression = expressions.getString(i);
                JSONObject value = new JSONObject();
                value.put("expression", expression);
                try {
                    Object raw = XPathParseTool.parseXPath(expression).eval(form.getEvaluationContext());
                    describe(raw, value);
                } catch (Exception e) {
                    value.put("error", FormRun.failure(e));
                }
                values.put(value);
            }
        }
        result.put("values", values);

        JSONObject instances = new JSONObject();
        JSONArray names = request.optJSONArray("instances");
        if (names != null) {
            for (int i = 0; i < names.length(); i++) {
                String name = names.getString(i);
                DataInstance instance = "main".equals(name) ? form.getMainInstance() : form.getNonMainInstance(name);
                if (instance == null) {
                    JSONObject missing = new JSONObject();
                    missing.put("missing", "The form declares no instance \"" + name + "\".");
                    instances.put(name, missing);
                    continue;
                }
                try {
                    ByteArrayOutputStream out = new ByteArrayOutputStream();
                    new DataModelSerializer(out, session.getIIF()).serialize(instance, null);
                    instances.put(name, out.toString(StandardCharsets.UTF_8));
                } catch (Exception e) {
                    instances.put(name, FormRun.failure(e));
                }
            }
        }
        result.put("instance", instances);
    }

    /** Enters each given answer at its question, walking the form in order; repeats are added as asked. */
    private static JSONArray answer(FormEntryModel model, FormEntryController controller, JSONArray answers,
                                    JSONObject repeats) {
        JSONArray results = new JSONArray();
        Map<String, String> byPath = new HashMap<>();
        if (answers != null) {
            for (int i = 0; i < answers.length(); i++) {
                JSONObject answer = answers.getJSONObject(i);
                byPath.put(answer.getString("path"), Answers.resolve(answer.getString("value")));
            }
        }
        Map<String, Integer> repeatsAdded = new HashMap<>();
        controller.jumpToIndex(FormIndex.createBeginningOfFormIndex());
        int event = controller.stepToNextEvent();
        for (int count = 0; event != FormEntryController.EVENT_END_OF_FORM && count <= MAX_EVENTS; count++) {
            if (event == FormEntryController.EVENT_PROMPT_NEW_REPEAT && repeats != null) {
                TreeReference reference = model.getFormIndex().getReference();
                String generic = reference.genericize().toString(false);
                String key = reference.genericizeAfter(reference.size() - 1).toString(true);
                int added = repeatsAdded.getOrDefault(key, 0);
                if (added < repeats.optInt(generic, 0)) {
                    controller.newRepeat();
                    repeatsAdded.put(key, added + 1);
                }
            } else if (event == FormEntryController.EVENT_QUESTION) {
                FormEntryPrompt prompt = model.getQuestionPrompt();
                TreeReference reference = prompt.getIndex().getReference();
                String path = reference.toString(true);
                String value = byPath.containsKey(path) ? byPath.get(path)
                        : byPath.get(reference.genericize().toString(false));
                if (value != null) {
                    JSONObject result = new JSONObject();
                    result.put("path", path);
                    result.put("value", value);
                    try {
                        IAnswerData data = Answers.answerData(prompt, value);
                        int code = controller.answerQuestion(prompt.getIndex(), data);
                        result.put("result", CoreNames.answerResult(code));
                        if (code == FormEntryController.ANSWER_CONSTRAINT_VIOLATED) {
                            result.put("constraintText", FormRun.text(prompt::getConstraintText));
                        }
                    } catch (RuntimeException e) {
                        result.put("result", "unconvertible");
                        result.put("message", e.getClass().getSimpleName() + ": " + e.getMessage());
                    }
                    results.put(result);
                }
            }
            event = controller.stepToNextEvent();
        }
        return results;
    }

    private static JSONArray constraints(FormEntryModel model, FormEntryController controller, JSONArray checks) {
        JSONArray results = new JSONArray();
        if (checks == null) {
            return results;
        }
        for (int i = 0; i < checks.length(); i++) {
            JSONObject check = checks.getJSONObject(i);
            String wanted = check.getString("path");
            String value = Answers.resolve(check.getString("value"));
            JSONObject result = new JSONObject();
            result.put("path", wanted);
            result.put("value", value);
            FormEntryPrompt prompt = find(model, controller, wanted);
            if (prompt == null) {
                result.put("result", "no-question");
            } else {
                try {
                    IAnswerData data = Answers.answerData(prompt, value);
                    int code = controller.checkQuestionConstraint(prompt.getIndex(), data);
                    result.put("result", CoreNames.answerResult(code));
                    if (code == FormEntryController.ANSWER_CONSTRAINT_VIOLATED) {
                        result.put("constraintText", FormRun.text(() -> prompt.getConstraintText(data)));
                    }
                } catch (RuntimeException e) {
                    result.put("result", "unconvertible");
                    result.put("message", e.getClass().getSimpleName() + ": " + e.getMessage());
                }
            }
            results.put(result);
        }
        return results;
    }

    /** The relevant question at a path (with or without repeat positions), or null. */
    private static FormEntryPrompt find(FormEntryModel model, FormEntryController controller, String wanted) {
        controller.jumpToIndex(FormIndex.createBeginningOfFormIndex());
        int event = controller.stepToNextEvent();
        for (int count = 0; event != FormEntryController.EVENT_END_OF_FORM && count <= MAX_EVENTS; count++) {
            if (event == FormEntryController.EVENT_QUESTION) {
                FormEntryPrompt prompt = model.getQuestionPrompt();
                TreeReference reference = prompt.getIndex().getReference();
                if (wanted.equals(reference.toString(true)) || wanted.equals(reference.genericize().toString(false))) {
                    return prompt;
                }
            }
            event = controller.stepToNextEvent();
        }
        return null;
    }

    static void describe(Object raw, JSONObject value) {
        if (raw instanceof XPathNodeset) {
            XPathNodeset nodeset = (XPathNodeset)raw;
            value.put("type", "nodeset");
            value.put("size", nodeset.size());
            value.put("value", nodeset.size() == 0 ? "" : FunctionUtils.toString(FunctionUtils.unpack(raw)));
        } else if (raw instanceof Boolean) {
            value.put("type", "boolean");
            value.put("value", FunctionUtils.toString(raw));
        } else if (raw instanceof Double) {
            value.put("type", "number");
            value.put("value", FunctionUtils.toString(raw));
        } else if (raw instanceof Date) {
            value.put("type", "date");
            value.put("value", FunctionUtils.toString(raw));
        } else {
            value.put("type", raw == null ? "null" : raw instanceof String ? "string" : raw.getClass().getSimpleName());
            value.put("value", raw == null ? JSONObject.NULL : FunctionUtils.toString(raw));
        }
    }

    /** The case list the session needs next, with Core's rows in Core's order for the given search and sort. */
    private static JSONObject caseList(SessionWrapper session, JSONObject request) throws Exception {
        JSONObject list = new JSONObject();
        String needed = session.getNeededData(session.getEvaluationContext());
        if (!SessionFrame.STATE_DATUM_VAL.equals(needed) && !SessionFrame.STATE_MULTIPLE_DATUM_VAL.equals(needed)) {
            throw new RequestException("The session as given needs \"" + needed + "\" next, not a case"
                    + " list; name the command (and datums) that lead to the list.");
        }
        EntityScreenContext context = new EntityScreenContext(0, request.optString("searchText", null),
                request.optInt("sortIndex", 0), 0, null, null, request.optBoolean("fuzzy", false));
        EntityDatum datum = (EntityDatum)session.getNeededDatum();
        EntityScreen screen = SessionFrame.STATE_MULTIPLE_DATUM_VAL.equals(needed)
                ? new MultiSelectEntityScreen(false, true, session, new SessionOp.Selections(), context)
                : new EntityScreen(false, true, session, context);
        screen.init(session);
        list.put("datum", datum.getDataId());
        list.put("detail", FormRun.nullable(datum.getShortDetail()));
        list.put("title", FormRun.text(screen::getScreenTitle));
        list.put("autoSelect", screen.shouldBeSkipped());
        SessionOp.rows(screen, datum, list);
        return list;
    }
}
