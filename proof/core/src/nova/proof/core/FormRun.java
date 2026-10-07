package nova.proof.core;

import org.commcare.core.process.XmlFormRecordProcessor;
import org.commcare.modern.session.SessionWrapper;
import org.commcare.suite.model.StackFrameStep;
import org.commcare.util.mocks.MockUserDataSandbox;
import org.javarosa.core.model.Constants;
import org.javarosa.core.model.FormDef;
import org.javarosa.core.model.FormIndex;
import org.javarosa.core.model.SelectChoice;
import org.javarosa.core.model.data.IAnswerData;
import org.javarosa.core.model.instance.TreeReference;
import org.javarosa.form.api.FormEntryCaption;
import org.javarosa.form.api.FormEntryController;
import org.javarosa.form.api.FormEntryModel;
import org.javarosa.form.api.FormEntryPrompt;
import org.javarosa.model.xform.XFormSerializingVisitor;
import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.NoSuchElementException;
import java.util.Set;
import java.util.concurrent.Callable;

/**
 * One form, opened and filled in as Web Apps runs it, then submitted.
 *
 * Opening follows Formplayer's FormSession: the form Core installed for the
 * session's xmlns, initialized as a new instance with the session's instance
 * initializer (so casedb, fixtures and the session instance are the runtime's)
 * and the session's language, walked with a FormEntryModel in linear repeat
 * mode. Each question is answered from the answer table through Formplayer's
 * answer conversion and FormEntryController.answerQuestion; a refused value is
 * recorded and the next one tried, at most three. Submitting is Formplayer's
 * FormSession.submitGetXml: postProcessInstance, then the instance serialized
 * with relevance respected. The result is applied to the user's case data by
 * Core's XmlFormRecordProcessor.process (Formplayer runs the same process()
 * with its database-backed parser factory, FormRecordProcessorHelper), and the
 * session finishes and pops its frame as Core's hosts do.
 */
final class FormRun {
    private static final int MAX_EVENTS = 50_000;

    private final SessionWrapper session;
    private final ProofEngine engine;
    private final MockUserDataSandbox sandbox;
    private final Answers answers;
    private final String locale;

    /** How the form ended: "submitted", or why it stopped before that. */
    String end;
    /** Whether a submitted form's step also records what Core's session does with the frame it is left. */
    boolean recordNext;

    /**
     * What Core's session needs for the frame a submission left it, as a host's
     * session loop reads it (CommCareSession.getNeededData): the datum or
     * command it asks for next, or, where it asks for nothing, the entry it
     * holds and the form that entry opens. A request asks for this
     * ("afterSubmit"), since it is what Formplayer's end of form navigation is
     * held against (proof/formplayer).
     */
    static JSONObject next(SessionWrapper session) {
        JSONObject next = new JSONObject();
        String needs = session.getNeededData(session.getEvaluationContext());
        next.put("needs", nullable(needs));
        next.put("command", nullable(session.getCommand()));
        next.put("form", needs == null ? nullable(session.getForm()) : JSONObject.NULL);
        return next;
    }

    FormRun(SessionWrapper session, ProofEngine engine, MockUserDataSandbox sandbox, Answers answers, String locale) {
        this.session = session;
        this.engine = engine;
        this.sandbox = sandbox;
        this.answers = answers;
        this.locale = locale;
    }

    JSONObject run(String xmlns) {
        JSONObject step = new JSONObject();
        step.put("screen", "form");
        step.put("xmlns", xmlns);
        FormDef form;
        try {
            form = engine.loadFormByXmlns(xmlns);
        } catch (NoSuchElementException e) {
            form = null;
        }
        if (form == null) {
            step.put("error", "Core has no installed form with this xmlns.");
            end = "form-missing";
            return step;
        }
        try {
            form.initialize(true, session.getIIF(), locale, false);
        } catch (RuntimeException e) {
            step.put("error", failure(e));
            end = "form-did-not-open";
            return step;
        }
        step.put("title", form.getTitle() == null ? JSONObject.NULL : form.getTitle());
        FormEntryModel model = new FormEntryModel(form, FormEntryModel.REPEAT_STRUCTURE_LINEAR);
        FormEntryController controller = new FormEntryController(model);
        JSONArray events = new JSONArray();
        step.put("events", events);
        try {
            if (!walk(model, controller, events)) {
                return step;
            }
            JSONArray unanswered = unansweredRequired(model, controller);
            if (unanswered.length() > 0) {
                step.put("unansweredRequired", unanswered);
                end = "incomplete";
                return step;
            }
            submit(form, step);
        } catch (RuntimeException e) {
            step.put("error", failure(e));
            end = "form-error";
        }
        return step;
    }

    /** Returns false when a question had no accepted value, which ends the session there. */
    private boolean walk(FormEntryModel model, FormEntryController controller, JSONArray events) {
        Map<String, Integer> repeatsAdded = new HashMap<>();
        controller.jumpToIndex(FormIndex.createBeginningOfFormIndex());
        int event = controller.stepToNextEvent();
        for (int count = 0; event != FormEntryController.EVENT_END_OF_FORM; count++) {
            if (count > MAX_EVENTS) {
                throw new IllegalStateException("The form produced more than " + MAX_EVENTS
                        + " entry events; the runner stopped walking it.");
            }
            switch (event) {
                case FormEntryController.EVENT_QUESTION: {
                    JSONObject question = question(model, controller);
                    events.put(question);
                    if (question.has("unanswerable")) {
                        end = "no-accepted-answer";
                        return false;
                    }
                    break;
                }
                case FormEntryController.EVENT_GROUP:
                case FormEntryController.EVENT_REPEAT: {
                    FormEntryCaption caption = model.getCaptionPrompt();
                    JSONObject group = new JSONObject();
                    group.put("event", event == FormEntryController.EVENT_GROUP ? "group" : "repeat");
                    group.put("path", caption.getIndex().getReference().toString(true));
                    group.put("text", text(caption::getQuestionText));
                    group.put("appearance", nullable(caption.getAppearanceHint()));
                    events.put(group);
                    break;
                }
                case FormEntryController.EVENT_PROMPT_NEW_REPEAT: {
                    TreeReference reference = model.getFormIndex().getReference();
                    String key = reference.genericizeAfter(reference.size() - 1).toString(true);
                    int added = repeatsAdded.getOrDefault(key, 0);
                    JSONObject prompt = new JSONObject();
                    prompt.put("event", "new-repeat");
                    prompt.put("path", key);
                    if (added < answers.repeatsToAdd()) {
                        controller.newRepeat();
                        repeatsAdded.put(key, added + 1);
                        prompt.put("added", true);
                    } else {
                        prompt.put("added", false);
                    }
                    events.put(prompt);
                    break;
                }
                case FormEntryController.EVENT_REPEAT_JUNCTURE: {
                    JSONObject juncture = new JSONObject();
                    juncture.put("event", "repeat-juncture");
                    juncture.put("path", model.getFormIndex().getReference().toString(true));
                    events.put(juncture);
                    break;
                }
                default: {
                    JSONObject other = new JSONObject();
                    other.put("event", "event-" + event);
                    events.put(other);
                }
            }
            event = controller.stepToNextEvent();
        }
        return true;
    }

    private JSONObject question(FormEntryModel model, FormEntryController controller) {
        FormEntryPrompt prompt = model.getQuestionPrompt();
        TreeReference reference = prompt.getIndex().getReference();
        String dataPath = reference.genericize().toString(false);
        JSONObject question = new JSONObject();
        question.put("event", "question");
        question.put("path", reference.toString(true));
        question.put("dataPath", dataPath);
        question.put("control", CoreNames.control(prompt.getControlType()));
        question.put("dataType", CoreNames.dataType(prompt.getDataType()));
        question.put("appearance", nullable(prompt.getAppearanceHint()));
        question.put("text", text(prompt::getQuestionText));
        question.put("hint", text(prompt::getHintText));
        question.put("help", text(prompt::getHelpText));
        question.put("image", text(prompt::getImageText));
        question.put("audio", text(prompt::getAudioText));
        question.put("required", prompt.isRequired());
        question.put("readOnly", prompt.isReadOnly());
        if (prompt.getControlType() == Constants.CONTROL_SELECT_ONE
                || prompt.getControlType() == Constants.CONTROL_SELECT_MULTI) {
            JSONArray choices = new JSONArray();
            for (SelectChoice choice : prompt.getSelectChoices()) {
                JSONObject c = new JSONObject();
                c.put("value", choice.getValue());
                c.put("text", text(() -> prompt.getSelectChoiceText(choice)));
                choices.put(c);
            }
            question.put("choices", choices);
        }

        if (prompt.isReadOnly()) {
            question.put("answer", "not answered: read-only");
            return question;
        }
        Answers.Choice choice = answers.valuesFor(prompt, dataPath);
        question.put("valuesFrom", choice.source);
        if (choice.values == null) {
            question.put("unanswerable", "The answer table has no entry for " + choice.source + ".");
            return question;
        }
        if (choice.values.isEmpty()) {
            question.put("answer", "not answered: the table gives this question no values");
            return question;
        }
        JSONArray attempts = new JSONArray();
        question.put("attempts", attempts);
        for (String value : choice.values.subList(0, Math.min(Answers.MAX_TRIES, choice.values.size()))) {
            JSONObject attempt = new JSONObject();
            attempt.put("value", value);
            attempts.put(attempt);
            IAnswerData data;
            try {
                data = Answers.answerData(prompt, value);
            } catch (RuntimeException e) {
                attempt.put("result", "unconvertible");
                attempt.put("message", e.getClass().getSimpleName() + ": " + e.getMessage());
                continue;
            }
            int code = controller.answerQuestion(prompt.getIndex(), data);
            attempt.put("result", CoreNames.answerResult(code));
            if (code == FormEntryController.ANSWER_CONSTRAINT_VIOLATED) {
                attempt.put("constraintText", text(prompt::getConstraintText));
            }
            if (code == FormEntryController.ANSWER_OK) {
                question.put("answer", data == null ? JSONObject.NULL : data.uncast().getString());
                return question;
            }
        }
        question.put("unanswerable", "Core refused every value the table gives this question.");
        return question;
    }

    /** Relevant required questions left without a value, which Web Apps does not let a form submit with. */
    private JSONArray unansweredRequired(FormEntryModel model, FormEntryController controller) {
        JSONArray missing = new JSONArray();
        controller.jumpToIndex(FormIndex.createBeginningOfFormIndex());
        int event = controller.stepToNextEvent();
        for (int count = 0; event != FormEntryController.EVENT_END_OF_FORM && count <= MAX_EVENTS; count++) {
            if (event == FormEntryController.EVENT_QUESTION) {
                FormEntryPrompt prompt = model.getQuestionPrompt();
                if (prompt.isRequired() && prompt.getAnswerValue() == null) {
                    missing.put(prompt.getIndex().getReference().toString(true));
                }
            }
            event = controller.stepToNextEvent();
        }
        return missing;
    }

    private void submit(FormDef form, JSONObject step) {
        byte[] submission;
        try {
            form.postProcessInstance();
            submission = new XFormSerializingVisitor(true).serializeInstance(form.getInstance());
        } catch (Exception e) {
            step.put("error", failure(e));
            end = "submission-not-serialized";
            return;
        }
        step.put("submission", new String(submission, StandardCharsets.UTF_8));
        try {
            XmlFormRecordProcessor.process(sandbox, new ByteArrayInputStream(submission));
        } catch (Exception e) {
            step.put("processing", failure(e));
            end = "submission-refused";
            return;
        }
        try {
            session.clearVolatiles();
            step.put("caseDb", CaseData.caseDb(session.getIIF()));
            session.clearVolatiles();
            boolean more = session.finishExecuteAndPop(session.getEvaluationContext());
            JSONObject stack = new JSONObject();
            stack.put("nextFrameReady", more);
            stack.put("steps", frameSteps(session));
            stack.put("pendingFrames", session.getFrameStack().size());
            if (recordNext && more) {
                stack.put("next", next(session));
            }
            step.put("stackAfterSubmit", stack);
        } catch (Exception e) {
            step.put("error", failure(e));
            end = "end-of-form-navigation-failed";
            return;
        }
        end = "submitted";
    }

    static JSONArray frameSteps(SessionWrapper session) {
        JSONArray steps = new JSONArray();
        for (StackFrameStep frameStep : session.getFrame().getSteps()) {
            JSONObject s = new JSONObject();
            s.put("type", frameStep.getType());
            s.put("id", nullable(frameStep.getId()));
            s.put("value", nullable(frameStep.getValue()));
            steps.put(s);
        }
        return steps;
    }

    /** An exception as the trace records it: its class, its message, and where it was constructed ({@link #site}). */
    static JSONObject failure(Throwable error) {
        JSONObject failure = new JSONObject();
        failure.put("class", error.getClass().getName());
        failure.put("message", String.valueOf(error.getMessage()));
        failure.put("site", site(error));
        return failure;
    }

    /**
     * Where an exception was constructed, as its class, method, file and line: the first frame of its stack that
     * is neither the Java platform's (a named module's, such as java.base's Integer.parseInt behind a
     * NumberFormatException, passed over for the frame that called it) nor in the exception's own class or a
     * superclass of it (a static factory, such as InvalidStructureException.readableInvalidStructureException,
     * takes its message from its caller). That frame is in Core's code, the runner's, or a library on Core's
     * classpath. Where it makes the message from a template of its own, it names that template; where it takes
     * the message from its caller in another way (kxml2's KXmlParser.exception, a rewrap such as
     * new XPathException(e.getMessage()), WrappedException), it names that helper or rewrap, one site for every
     * message it carries. Null where the stack holds no such frame.
     */
    static Object site(Throwable error) {
        Set<String> own = new HashSet<>();
        for (Class<?> type = error.getClass(); type != null; type = type.getSuperclass()) {
            own.add(type.getName());
        }
        for (StackTraceElement frame : error.getStackTrace()) {
            if (frame.getModuleName() == null && !own.contains(frame.getClassName())) {
                return frame.getClassName() + "." + frame.getMethodName()
                        + "(" + frame.getFileName() + ":" + frame.getLineNumber() + ")";
            }
        }
        return JSONObject.NULL;
    }

    static Object nullable(Object value) {
        return value == null ? JSONObject.NULL : value;
    }

    /** Text Core computes for display; a text Core cannot produce is recorded as its failure. */
    static Object text(Callable<String> source) {
        try {
            return nullable(source.call());
        } catch (Exception e) {
            JSONObject failed = new JSONObject();
            failed.put("failed", e.getClass().getSimpleName() + ": " + e.getMessage());
            return failed;
        }
    }
}
