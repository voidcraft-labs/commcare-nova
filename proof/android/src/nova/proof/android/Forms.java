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
import org.commcare.views.dialogs.AlertDialogFragment;
import org.commcare.views.dialogs.DialogChoiceItem;
import org.commcare.views.dialogs.PaneledChoiceDialog;
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

import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.util.HashMap;
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

    static FormEntryActivity open(Intent started) {
        FormEntryActivity activity =
                Robolectric.buildActivity(FormEntryActivity.class, started).create().start().resume().get();
        RobolectricUtil.flushBackgroundThread(activity);
        ShadowLooper.idleMainLooper();
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
            if (activity.isFinishing()) {
                ended = "finished";
                break;
            }
            JSONObject screen = screen(activity);
            screens.put(screen);
            String event = screen.getString("event");
            String now = event + " " + screen.getString("index");
            if (event.equals("END_OF_FORM")) {
                ended = "end";
                break;
            }
            if (event.equals("PROMPT_NEW_REPEAT")) {
                DialogChoiceItem[] choices = choices(activity);
                if (choices == null || choices.length < 3) {
                    ended = "repeat prompt without its dialog";
                    break;
                }
                String repeat = String.valueOf(FormEntryActivity.mFormController.getFormIndex().getReference()
                        .genericize());
                int rows = added.getOrDefault(repeat, 0);
                // The dialog's own choices: go back, add a row, leave the repeat.
                boolean add = rows < Answers.repeatsToAdd();
                added.put(repeat, rows + 1);
                screen.put("chose", choices[add ? 1 : 2].text);
                choices[add ? 1 : 2].listener.onClick(null);
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
            if (answer(activity, screen)) {
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
            RobolectricUtil.flushBackgroundThread(activity);
            ShadowLooper.idleMainLooper();
        }
        JSONObject saved = new JSONObject();
        form.put("saved", saved);
        ShadowActivity shadow = Shadows.shadowOf((Activity)activity);
        saved.put("finishing", activity.isFinishing());
        saved.put("alert", Screens.orNull(Views.alert(activity)));
        if (!activity.isFinishing()) {
            // The form is left as the worker's back button and "do not save" leave it, so home is where it was.
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
            found.put(entry);
        }
        return found;
    }

    private static JSONObject screen(FormEntryActivity activity) throws Exception {
        JSONObject found = new JSONObject();
        found.put("event", event(FormEntryActivity.mFormController.getEvent()));
        found.put("index", String.valueOf(FormEntryActivity.mFormController.getFormIndex().getReference()));
        found.put("questions", questions(activity));
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
                IAnswerData held;
                try {
                    held = widget.getAnswer();
                    question.put("answer", Screens.orNull(held == null ? null : held.getDisplayText()));
                } catch (RuntimeException raised) {
                    question.put("answerRaised", raised.getClass().getName());
                }
                questions.put(question);
            }
        }
        return questions;
    }

    /**
     * Gives each question on the screen its answer from the table, through the form's own controller: the first
     * value the form takes. True where any question was answered.
     */
    private static boolean answer(FormEntryActivity activity, JSONObject screen) throws Exception {
        QuestionsView view = activity.getODKView();
        if (view == null) {
            return false;
        }
        boolean answered = false;
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
            }
        }
        screen.put("answered", given);
        return answered;
    }

    /** The choices of the dialog the activity is showing, where it is a choice dialog. */
    private static DialogChoiceItem[] choices(FormEntryActivity activity) throws Exception {
        activity.getSupportFragmentManager().executePendingTransactions();
        AlertDialogFragment fragment = activity.getCurrentAlertDialog();
        Object dialog = null;
        if (fragment != null) {
            Field held = AlertDialogFragment.class.getDeclaredField("underlyingDialog");
            held.setAccessible(true);
            dialog = held.get(fragment);
        }
        if (!(dialog instanceof PaneledChoiceDialog)) {
            return null;
        }
        return (DialogChoiceItem[])Screens.field(dialog, "choiceItems");
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
