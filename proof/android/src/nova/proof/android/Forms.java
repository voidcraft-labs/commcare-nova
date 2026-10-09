package nova.proof.android;

import android.app.Activity;
import android.content.Intent;
import android.view.View;

import org.commcare.CommCareApplication;
import org.commcare.activities.FormEntryActivity;
import org.commcare.activities.components.FormEntryInstanceState;
import org.commcare.activities.components.FormNavigationController;
import org.commcare.android.database.user.models.FormRecord;
import org.commcare.dalvik.R;
import org.commcare.utils.RobolectricUtil;
import org.commcare.views.QuestionsView;
import org.commcare.views.widgets.QuestionWidget;
import org.javarosa.core.model.data.IAnswerData;
import org.javarosa.form.api.FormEntryController;
import org.javarosa.form.api.FormEntryPrompt;
import org.json.JSONArray;
import org.json.JSONObject;
import org.robolectric.Robolectric;
import org.robolectric.Shadows;
import org.robolectric.shadows.ShadowActivity;
import org.robolectric.shadows.ShadowLooper;

import java.lang.reflect.Method;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * What Android's form entry does with the form home opened, from its first screen to its save.
 *
 * Its header and title as FormEntryActivity gives them and the name it would save the form under; then each
 * screen FormEntryActivityUIController.showNextView moves to, with the questions on it as its own widgets show
 * them. Each question is answered from the lane's answer table (Answers): the answer is given to the form's
 * own controller, the first of the table's values the form's constraints take, and the screen is drawn again
 * from the form, so each widget shows the answer and it is the widget's own reading of it that the next step
 * saves (FormEntryActivity.saveAnswersForCurrentScreen). A repeat's "add another?" dialog is answered by its
 * own choices: a row is added while the table asks for one, then the dialog's last choice leaves the repeat.
 *
 * At the form's end the worker's finish button is pressed (triggerUserFormComplete) and the form is saved by the
 * app's own save task, which applies its case blocks to the device as it does (FormRecord
 * .updateAndProcessRecord): what the record is called and holds and the cases the device then holds are read,
 * and home is handed the result. A walk that cannot
 * leave a screen (a required question the table has no answer for, a constraint none of its values meets, an
 * alert) ends there, with what the screen shows.
 */
final class Forms {
    private static final int MAX_SCREENS = 80;

    private Forms() {
    }

    /** The second, on the device's own clock, in which the last form was opened; none since the device was made. */
    static long openedIn = -1;

    /**
     * Opens the form home started. Android keeps a form's answers in a file named by the form's own file and
     * the second it was opened in (FormEntryInstanceState.initFormRecordPath), so two forms whose files share a
     * name (forms-0.xml of two menus) opened in one second would share one file, the second saved over the
     * first. A worker opens no two forms in a second; the reader waits for the next where it would.
     */
    static FormEntryActivity open(Intent started) throws InterruptedException {
        if (System.currentTimeMillis() / 1000 == openedIn) {
            Thread.sleep(1000 - System.currentTimeMillis() % 1000 + 5);
        }
        openedIn = System.currentTimeMillis() / 1000;
        // Shown in its window as a device shows it: a widget that keeps its answer outside the form (a media
        // question's file) reads it back from the form only once its view is shown (MediaWidget
        // .onVisibilityChanged), so a screen drawn again in a window never shown would save the question empty.
        FormEntryActivity activity = Robolectric.buildActivity(FormEntryActivity.class, started)
                .create().start().resume().visible().get();
        // The activity loads its form on a task (FormLoaderTask) it may start from a message the main looper runs
        // only as it idles, after the first wait for the current task has passed: one wait read the form as never
        // loaded on a loaded runner, and the walk then saved fewer forms. Settled as a save is.
        settle(activity);
        return activity;
    }

    static boolean read(Intent started, JSONObject step, ShadowActivity home) throws Exception {
        FormEntryActivity activity = open(started);
        JSONObject form = new JSONObject();
        step.put("form", form);
        if (FormEntryActivity.mFormController == null) {
            form.put("loaded", false);
            form.put("alert", Screens.orNull(Views.alert(activity)));
            return false;
        }
        form.put("loaded", true);
        describe(activity, started, form);
        // The cases the device holds as the form opens, to say whether a form it then refuses left any mark.
        String casesBefore = Cases.read().toString();
        // What the form asks the device for as it opens (the location permission, for a form that captures
        // one).
        Screens.deviceAsks(home, form);
        // The worker allows what the form asked for, and the device gives the fix it polls for.
        Sensors.allow(activity, form);

        Object controller = Screens.field(activity, "uiController");
        Method next = controller.getClass().getDeclaredMethod("showNextView");
        next.setAccessible(true);
        Method refresh = controller.getClass().getDeclaredMethod("refreshCurrentView", boolean.class);
        refresh.setAccessible(true);
        JSONArray screens = new JSONArray();
        form.put("screens", screens);
        Map<String, Integer> added = new HashMap<>();
        String before = null;
        String ended = "screens";
        for (int count = 0; count < MAX_SCREENS; count++) {
            settle(activity);
            if (activity.isFinishing()) {
                // The form ended itself: a form with no question left to show is saved without a finish
                // button (FormEntryActivityUIController.showNextView), as is one a repeat's dialog ended.
                ended = "finished";
                break;
            }
            JSONObject screen = screen(activity);
            screens.put(screen);
            String event = screen.getString("event");
            String now = event + " " + screen.getString("index");
            if (event.equals("END_OF_FORM")) {
                // At its end and not saved: what holds it is on the screen.
                ended = "end unsaved";
                break;
            }
            if (event.equals("PROMPT_NEW_REPEAT")) {
                // The dialog Android shows at a repeat: go back, add a row, leave the repeat, each a button of
                // its own (HorizontalPaneledChoiceDialog), pressed as a worker presses it.
                android.widget.Button[] choices = choices();
                if (choices == null) {
                    ended = "repeat prompt without its dialog";
                    break;
                }
                JSONArray offered = new JSONArray();
                for (android.widget.Button choice : choices) {
                    offered.put(String.valueOf(choice.getText()));
                }
                screen.put("choices", offered);
                String repeat = String.valueOf(FormEntryActivity.mFormController.getFormIndex().getReference()
                        .genericize());
                int rows = added.getOrDefault(repeat, 0);
                boolean add = rows < Answers.repeatsToAdd();
                added.put(repeat, rows + 1);
                screen.put("chose", String.valueOf(choices[add ? 1 : 2].getText()));
                choices[add ? 1 : 2].performClick();
                RobolectricUtil.flushBackgroundThread(activity);
                ShadowLooper.idleMainLooper();
                before = null;
                continue;
            }
            if (!screen.isNull("alert")) {
                ended = "alert";
                break;
            }
            if (now.equals(before)) {
                screen.put("held", true);
                ended = "held";
                break;
            }
            before = now;
            int outcome = answer(activity, screen);
            if (outcome == ADVANCED) {
                // The screen's own capture moved the form on; the next turn reads where it went.
                before = null;
                continue;
            }
            if (outcome == ANSWERED) {
                refresh.invoke(controller, false);
                ShadowLooper.idleMainLooper();
                screen.put("shown", questions(activity));
            }
            if (done(activity)) {
                // The form's last screen: Android shows the worker its finish button there, and never a screen
                // of the form's end.
                ended = "end";
                break;
            }
            next.invoke(controller);
            RobolectricUtil.flushBackgroundThread(activity);
            ShadowLooper.idleMainLooper();
        }
        form.put("ended", ended);
        if (ended.equals("end") && !activity.isFinishing()) {
            // The worker's finish button, which the form shows at its end.
            View finish = ((Activity)activity).findViewById(R.id.nav_btn_finish);
            form.put("finishShown", finish != null && finish.getVisibility() == View.VISIBLE);
            if (finish != null) {
                finish.performClick();
            }
            settle(activity);
            if (views && !activity.isFinishing() && activity.getODKView() != null) {
                // What the screen shows where Android did not take the finish (a message for an answer).
                form.put("afterFinish", Views.describe(activity.getODKView()));
            }
        }
        JSONObject saved = new JSONObject();
        form.put("saved", saved);
        ShadowActivity shadow = Shadows.shadowOf((Activity)activity);
        saved.put("finishing", activity.isFinishing());
        saved.put("alert", Screens.orNull(Views.alert(activity)));
        if (!activity.isFinishing()) {
            // The device did not save the form. Whether anything of it was applied all the same: Android
            // processes a form's case blocks in one transaction (FormRecord.updateAndProcessRecord), so the
            // device should hold the cases it held as the form opened. The form is left as the worker's back
            // button and "do not save" leave it, so home is where it was.
            Device.dirty = true;
            saved.put("records", records());
            JSONArray held = Cases.read();
            saved.put("cases", held);
            saved.put("casesAsTheFormOpened", held.toString().equals(casesBefore));
            return false;
        }
        saved.put("resultCode", shadow.getResultCode());
        // The save applied the form's case blocks to the device (FormRecord.updateAndProcessRecord): the form's
        // record and the cases the device now holds, read before home is handed the result.
        Device.dirty = true;
        saved.put("records", records());
        saved.put("cases", Cases.read());
        home.receiveResult(started, shadow.getResultCode(), shadow.getResultIntent());
        ShadowLooper.idleMainLooper();
        return shadow.getResultCode() == Activity.RESULT_OK;
    }

    /**
     * Whether the screen is the form's last for the worker, as the app's own navigation bar decides when it
     * shows the finish button (FormNavigationUI.updateNavigationCues: FormNavigationController
     * .calculateNavigationStatus, isFormDone).
     */
    private static boolean done(FormEntryActivity activity) {
        return FormNavigationController.calculateNavigationStatus(FormEntryActivity.mFormController,
                activity.getODKView()).isFormDone();
    }

    /** The form's header, its title and the name a completed save carries. */
    static void describe(FormEntryActivity activity, Intent started, JSONObject form) throws Exception {
        Method header = FormEntryActivity.class.getDeclaredMethod("getHeaderString");
        header.setAccessible(true);
        form.put("FormEntryActivity.getHeaderString", String.valueOf(header.invoke(activity)));
        form.put("title", String.valueOf(activity.getTitle()));
        FormEntryInstanceState state = (FormEntryInstanceState)Screens.field(activity, "instanceState");
        // The form's own title, and the name form entry asks a completed save to carry: what it passes its save
        // task (FormEntryActivity.triggerUserFormComplete), for the record the intent names.
        form.put("formTitle", String.valueOf(FormEntryActivity.mFormController.getFormTitle()));
        form.put("FormEntryInstanceState.getDefaultFormTitle", Screens.orNull(state.getDefaultFormTitle(
                started.getIntExtra(FormEntryActivity.KEY_FORM_RECORD_ID, -1))));
        form.put("languages", new JSONArray(FormEntryActivity.mFormController.getLanguages() == null
                ? new String[0] : FormEntryActivity.mFormController.getLanguages()));
    }

    /** Every form record the device holds: its status and name, and whether the app still holds its form. */
    static JSONArray records() throws Exception {
        JSONArray found = new JSONArray();
        for (FormRecord record : CommCareApplication.instance().getUserStorage(FormRecord.class)) {
            JSONObject entry = new JSONObject();
            entry.put("status", record.getStatus());
            entry.put("FormRecord.getDisplayName", Screens.orNull(record.getDisplayName()));
            entry.put("AndroidCommCarePlatform.getFormDefId", CommCareApplication.instance().getCommCarePlatform()
                    .getFormDefId(record.getFormNamespace()) == -1 ? "none" : "held");
            String location = metaLocation(record);
            if (location != null) {
                entry.put("metaLocation", location);
            }
            found.put(entry);
        }
        return found;
    }

    /** The OpenRosa meta block's namespace, which holds the location a form's poll of the sensor writes. */
    private static final String META = "http://openrosa.org/jr/xforms";

    /**
     * The location the saved form holds in its meta block (what PollSensorAction wrote from the device's fix),
     * read from the record's own instance file as Android saved it (encrypted under the record's key); null
     * where the record holds no file or the form no location.
     */
    static String metaLocation(FormRecord record) throws Exception {
        if (record.getFilePath() == null || !new java.io.File(record.getFilePath()).isFile()) {
            return null;
        }
        javax.xml.parsers.DocumentBuilderFactory factory = javax.xml.parsers.DocumentBuilderFactory.newInstance();
        factory.setNamespaceAware(true);
        org.w3c.dom.Document instance;
        try (java.io.InputStream saved = org.commcare.models.encryption.EncryptionIO.getFileInputStream(
                record.getFilePath(), new javax.crypto.spec.SecretKeySpec(record.getAesKey(), "AES"))) {
            instance = factory.newDocumentBuilder().parse(saved);
        }
        // HQ's build writes the location into the meta block in its own namespace (xform.py::XForm._add_meta_2).
        org.w3c.dom.NodeList metas = instance.getElementsByTagNameNS(META, "meta");
        for (int i = 0; i < metas.getLength(); i++) {
            org.w3c.dom.NodeList found = ((org.w3c.dom.Element)metas.item(i)).getElementsByTagNameNS("*", "location");
            if (found.getLength() > 0) {
                return found.item(0).getTextContent();
            }
        }
        return null;
    }

    /** Set by the reader where a request asks for each screen's views as Android laid them out. */
    static boolean views;

    private static JSONObject screen(FormEntryActivity activity) throws Exception {
        JSONObject found = new JSONObject();
        found.put("event", event(FormEntryActivity.mFormController.getEvent()));
        found.put("index", String.valueOf(FormEntryActivity.mFormController.getFormIndex().getReference()));
        found.put("questions", questions(activity));
        if (views && activity.getODKView() != null) {
            // The whole screen as Android built it: each question's widget with its label, hint and media, and
            // a group's header above them.
            found.put("view", Views.describe(activity.getODKView()));
        }
        found.put("alert", Screens.orNull(Views.alert(activity)));
        return found;
    }

    private static JSONArray questions(FormEntryActivity activity) throws Exception {
        JSONArray questions = new JSONArray();
        QuestionsView view = activity.getODKView();
        if (view != null) {
            for (QuestionWidget widget : view.getWidgets()) {
                JSONObject question = new JSONObject();
                question.put("widget", widget.getClass().getSimpleName());
                question.put("text", String.valueOf(widget.getPrompt().getLongText()));
                question.put("reference", String.valueOf(widget.getPrompt().getIndex().getReference()));
                question.put("required", widget.getPrompt().isRequired());
                // The widget's own reading of the answer the form holds. Where the form holds none, a date or
                // time widget shows the device's present moment, which no record may hold.
                if (widget.getPrompt().getAnswerValue() == null) {
                    question.put("answer", JSONObject.NULL);
                } else {
                    try {
                        IAnswerData held = widget.getAnswer();
                        question.put("answer",
                                Screens.orNull(held == null ? null : Captures.recorded(held.getDisplayText())));
                    } catch (RuntimeException raised) {
                        question.put("answerRaised", raised.getClass().getName());
                    }
                }
                questions.put(question);
            }
        }
        return questions;
    }

    /** What answering a screen did: nothing, gave an answer, or moved the form to another screen itself. */
    private static final int UNANSWERED = 0;
    private static final int ANSWERED = 1;
    private static final int ADVANCED = 2;
    /** A refused value typed into its box, which the worker's next step asks the form to take. */
    private static final int TYPED = 3;
    /** Set by the reader where a request asks the walk to type a value the form refused (``typeRefused``). */
    static boolean typeRefused;

    /**
     * Gives each question on the screen its answer from the table, through the form's own controller: the first
     * value the form takes; a capture question its file, through its own screen (Captures).
     */
    private static int answer(FormEntryActivity activity, JSONObject screen) throws Exception {
        QuestionsView view = activity.getODKView();
        if (view == null) {
            return UNANSWERED;
        }
        boolean answered = false;
        boolean typed = false;
        JSONArray given = new JSONArray();
        for (QuestionWidget widget : view.getWidgets()) {
            FormEntryPrompt prompt = widget.getPrompt();
            JSONObject entry = new JSONObject();
            entry.put("reference", String.valueOf(prompt.getIndex().getReference()));
            given.put(entry);
            if (prompt.isReadOnly()) {
                entry.put("given", JSONObject.NULL);
                continue;
            }
            if (Captures.kind(widget) != null) {
                // A capture question takes a file the worker gives through the question's own screen, never a
                // value written into the form.
                String index = String.valueOf(FormEntryActivity.mFormController.getFormIndex());
                answered |= Captures.give(activity, widget, entry);
                if (!index.equals(String.valueOf(FormEntryActivity.mFormController.getFormIndex()))) {
                    // Android went on to the next screen itself (a signature taken on a screen of one question).
                    entry.put("advanced", true);
                    screen.put("answered", given);
                    return ADVANCED;
                }
                continue;
            }
            Object taken = JSONObject.NULL;
            JSONArray refused = new JSONArray();
            for (String value : Answers.valuesFor(prompt)) {
                int status;
                try {
                    status = FormEntryActivity.mFormController.answerQuestion(prompt.getIndex(),
                            Answers.answerData(prompt, value));
                } catch (RuntimeException raised) {
                    refused.put(value + ": " + raised.getClass().getSimpleName());
                    continue;
                }
                if (status == FormEntryController.ANSWER_OK) {
                    taken = value;
                    answered = true;
                    break;
                }
                refused.put(value + ": " + (status == FormEntryController.ANSWER_CONSTRAINT_VIOLATED
                        ? "constraint" : status == FormEntryController.ANSWER_REQUIRED_BUT_EMPTY
                        ? "required" : "status " + status));
            }
            entry.put("given", taken);
            if (refused.length() > 0) {
                entry.put("refused", refused);
                List<String> values = Answers.valuesFor(prompt);
                if (typeRefused && taken == JSONObject.NULL && !values.isEmpty()
                        && widget instanceof org.commcare.views.widgets.StringWidget
                        && refused.toString().contains(": constraint")) {
                    // The worker types the value the form refused into the question's own box and goes on, so
                    // Android itself checks it and shows the form's message for it.
                    ((org.commcare.views.widgets.StringWidget)widget).setAnswer(values.get(0));
                    entry.put("typed", values.get(0));
                    typed = true;
                }
            }
        }
        screen.put("answered", given);
        return typed ? TYPED : answered ? ANSWERED : UNANSWERED;
    }

    /**
     * Waits for what the activity started on its own threads (its save task among them) and for what that posts
     * back to the main thread, until nothing is left running.
     */
    private static void settle(FormEntryActivity activity) {
        for (int turn = 0; turn < 8; turn++) {
            RobolectricUtil.flushBackgroundThread(activity);
            ShadowLooper.idleMainLooper();
        }
    }

    /** The three buttons of the choice dialog Android is showing, or null where it shows none. */
    private static android.widget.Button[] choices() {
        android.app.Dialog shown = org.robolectric.shadows.ShadowDialog.getLatestDialog();
        if (shown == null || !shown.isShowing()) {
            return null;
        }
        android.widget.Button[] found = {
                (android.widget.Button)shown.findViewById(R.id.choice_dialog_panel_1),
                (android.widget.Button)shown.findViewById(R.id.choice_dialog_panel_2),
                (android.widget.Button)shown.findViewById(R.id.choice_dialog_panel_3),
        };
        for (android.widget.Button button : found) {
            if (button == null) {
                return null;
            }
        }
        return found;
    }

    private static String event(int event) {
        switch (event) {
            case FormEntryController.EVENT_BEGINNING_OF_FORM:
                return "BEGINNING_OF_FORM";
            case FormEntryController.EVENT_END_OF_FORM:
                return "END_OF_FORM";
            case FormEntryController.EVENT_PROMPT_NEW_REPEAT:
                return "PROMPT_NEW_REPEAT";
            case FormEntryController.EVENT_QUESTION:
                return "QUESTION";
            case FormEntryController.EVENT_GROUP:
                return "GROUP";
            case FormEntryController.EVENT_REPEAT:
                return "REPEAT";
            case FormEntryController.EVENT_REPEAT_JUNCTURE:
                return "REPEAT_JUNCTURE";
            default:
                return "EVENT_" + event;
        }
    }
}
