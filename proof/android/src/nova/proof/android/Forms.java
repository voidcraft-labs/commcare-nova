package nova.proof.android;

import android.content.Intent;

import org.commcare.activities.FormEntryActivity;
import org.commcare.activities.components.FormEntryInstanceState;
import org.commcare.utils.RobolectricUtil;
import org.commcare.views.QuestionsView;
import org.commcare.views.widgets.QuestionWidget;
import org.commcare.views.widgets.StringWidget;
import org.javarosa.form.api.FormEntryController;
import org.json.JSONArray;
import org.json.JSONObject;
import org.robolectric.Robolectric;
import org.robolectric.shadows.ShadowLooper;

import java.lang.reflect.Method;

/**
 * What Android's form entry shows of the form home opened: its title as FormEntryActivity gives it, the name it
 * would save the form under, and each screen FormEntryActivityUIController.showNextView moves to, with the
 * questions on it and any dialog it raises (the "add another?" dialog of a repeat among them).
 */
final class Forms {
    private static final int MAX_SCREENS = 40;

    private Forms() {
    }

    static void read(Intent started, JSONObject step) throws Exception {
        FormEntryActivity activity =
                Robolectric.buildActivity(FormEntryActivity.class, started).create().start().resume().get();
        RobolectricUtil.flushBackgroundThread(activity);
        ShadowLooper.idleMainLooper();
        JSONObject form = new JSONObject();
        step.put("form", form);
        if (FormEntryActivity.mFormController == null) {
            form.put("loaded", false);
            form.put("alert", Screens.orNull(Views.alert(activity)));
            return;
        }
        form.put("loaded", true);
        Method header = FormEntryActivity.class.getDeclaredMethod("getHeaderString");
        header.setAccessible(true);
        form.put("FormEntryActivity.getHeaderString", String.valueOf(header.invoke(activity)));
        form.put("title", String.valueOf(activity.getTitle()));
        FormEntryInstanceState state = (FormEntryInstanceState)Screens.field(activity, "instanceState");
        form.put("FormEntryInstanceState.getDefaultFormTitle", state.getDefaultFormTitle(-1));
        form.put("languages", new JSONArray(FormEntryActivity.mFormController.getLanguages() == null
                ? new String[0] : FormEntryActivity.mFormController.getLanguages()));

        Object controller = Screens.field(activity, "uiController");
        Method next = controller.getClass().getDeclaredMethod("showNextView");
        next.setAccessible(true);
        JSONArray screens = new JSONArray();
        form.put("screens", screens);
        String before = null;
        for (int count = 0; count < MAX_SCREENS; count++) {
            JSONObject screen = screen(activity);
            screens.put(screen);
            String now = screen.toString();
            if (now.equals(before) || screen.getString("event").equals("END_OF_FORM")
                    || !screen.isNull("alert")) {
                break;
            }
            before = now;
            answer(activity);
            next.invoke(controller);
            ShadowLooper.idleMainLooper();
        }
    }

    private static JSONObject screen(FormEntryActivity activity) throws Exception {
        JSONObject found = new JSONObject();
        found.put("event", event(FormEntryActivity.mFormController.getEvent()));
        found.put("index", String.valueOf(FormEntryActivity.mFormController.getFormIndex().getReference()));
        JSONArray questions = new JSONArray();
        QuestionsView view = activity.getODKView();
        if (view != null) {
            for (QuestionWidget widget : view.getWidgets()) {
                JSONObject question = new JSONObject();
                question.put("widget", widget.getClass().getSimpleName());
                question.put("text", String.valueOf(widget.getPrompt().getLongText()));
                question.put("reference", String.valueOf(widget.getPrompt().getIndex().getReference()));
                questions.put(question);
            }
        }
        found.put("questions", questions);
        found.put("alert", Screens.orNull(Views.alert(activity)));
        return found;
    }

    /** Gives each free-text question on the screen an answer, so a required one lets the walk go on. */
    private static void answer(FormEntryActivity activity) {
        QuestionsView view = activity.getODKView();
        if (view == null) {
            return;
        }
        for (QuestionWidget widget : view.getWidgets()) {
            if (widget instanceof StringWidget && widget.getAnswer() == null) {
                ((StringWidget)widget).setAnswer("1");
            }
        }
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
