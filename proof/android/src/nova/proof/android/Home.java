package nova.proof.android;

import org.commcare.CommCareApplication;
import org.commcare.activities.StandardHomeActivity;
import org.json.JSONArray;
import org.json.JSONObject;
import org.robolectric.Robolectric;
import org.robolectric.shadows.ShadowLooper;

import java.lang.reflect.Method;
import java.util.List;

/**
 * What Android's home screen offers of the installed app: the buttons its own controller leaves out
 * (StandardHomeActivityUIController.getHiddenButtons: Saved Forms, Incomplete Forms, the training and Connect
 * tiles), and the title it shows.
 */
final class Home {
    private Home() {
    }

    static JSONObject read() throws Exception {
        CommCareApplication.instance().getCurrentSessionWrapper().reset();
        StandardHomeActivity home = Robolectric.buildActivity(StandardHomeActivity.class, null).create().get();
        ShadowLooper.idleMainLooper();
        Object controller = Screens.field(home, "uiController");
        Method hidden = controller.getClass().getDeclaredMethod("getHiddenButtons");
        hidden.setAccessible(true);
        JSONObject found = new JSONObject();
        found.put("StandardHomeActivityUIController.getHiddenButtons",
                new JSONArray(new java.util.TreeSet<>((List<?>)hidden.invoke(controller))));
        found.put("title", Screens.orNull(home.getSupportActionBar() == null
                || home.getSupportActionBar().getTitle() == null ? null
                : String.valueOf(home.getSupportActionBar().getTitle())));
        return found;
    }
}
