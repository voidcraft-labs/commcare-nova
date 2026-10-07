package nova.proof.android;

import android.content.Intent;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.TextView;

import com.google.common.collect.Multimap;

import org.commcare.activities.QueryRequestActivity;
import org.commcare.android.mocks.ModernHttpRequesterMock;
import org.commcare.dalvik.R;
import org.commcare.session.RemoteQuerySessionManager;
import org.commcare.utils.RobolectricUtil;
import org.json.JSONArray;
import org.json.JSONObject;
import org.robolectric.Robolectric;
import org.robolectric.Shadows;
import org.robolectric.shadows.ShadowLooper;

import java.util.Hashtable;
import java.util.Map;
import java.util.TreeMap;

/**
 * What Android's search screen does with the search home opened: its prompts, and, where the request names an
 * answer ({@code queryAnswer}), what the screen sends once every free-text prompt holds it and the worker
 * presses Search (QueryRequestActivity.makeQueryRequest), the errors Core's query manager holds for the prompts
 * at that moment, and what the screen shows when the server answers 400, as HQ answers a query it refuses.
 */
final class Queries {
    /** Set by the reader for the request it is answering; null where the request names none. */
    static String answer;

    private Queries() {
    }

    static void read(Intent started, JSONObject step) throws Exception {
        QueryRequestActivity activity =
                Robolectric.buildActivity(QueryRequestActivity.class, started).setup().get();
        ShadowLooper.idleMainLooper();
        JSONObject query = new JSONObject();
        step.put("query", query);
        RemoteQuerySessionManager manager =
                (RemoteQuerySessionManager)Screens.field(activity, "remoteQuerySessionManager");
        if (manager == null) {
            query.put("opened", false);
            return;
        }
        query.put("opened", true);
        query.put("url", String.valueOf(manager.getBaseUrl()));
        Object controller = Screens.field(activity, "mRequestUiController");
        @SuppressWarnings("unchecked")
        Hashtable<String, View> boxes = (Hashtable<String, View>)Screens.field(controller, "promptsBoxes");
        JSONObject prompts = new JSONObject();
        for (Map.Entry<String, View> box : new TreeMap<>(boxes).entrySet()) {
            prompts.put(box.getKey(), box.getValue().getClass().getSimpleName());
        }
        query.put("prompts", prompts);
        if (answer == null) {
            return;
        }
        for (View box : boxes.values()) {
            if (box instanceof EditText) {
                ((EditText)box).setText(answer);
            }
        }
        ShadowLooper.idleMainLooper();
        query.put("answer", answer);
        query.put("RemoteQuerySessionManager.getErrors", strings(manager.getErrors()));
        query.put("RemoteQuerySessionManager.getRawQueryParams", params(manager.getRawQueryParams(false)));

        ModernHttpRequesterMock.setResponseCodes(new Integer[]{400});
        ModernHttpRequesterMock.setExpectedUrls(new String[0]);
        ModernHttpRequesterMock.setRequestPayloads(new String[0]);
        Button search = (Button)((android.app.Activity)activity).findViewById(R.id.request_button);
        search.performClick();
        RobolectricUtil.flushBackgroundThread(activity);
        ShadowLooper.idleMainLooper();
        TextView error = (TextView)((android.app.Activity)activity).findViewById(R.id.error_message);
        JSONObject after = new JSONObject();
        after.put("errorShown", error.getVisibility() == View.VISIBLE);
        after.put("errorText", String.valueOf(error.getText()));
        after.put("finishing", activity.isFinishing());
        after.put("resultCode", Shadows.shadowOf(activity).getResultCode());
        query.put("afterServerAnswers400", after);
    }

    private static JSONObject strings(Hashtable<String, String> table) throws Exception {
        JSONObject found = new JSONObject();
        for (Map.Entry<String, String> entry : new TreeMap<>(table).entrySet()) {
            found.put(entry.getKey(), entry.getValue());
        }
        return found;
    }

    private static JSONObject params(Multimap<String, String> params) throws Exception {
        JSONObject found = new JSONObject();
        for (String key : new java.util.TreeSet<>(params.keySet())) {
            found.put(key, new JSONArray(params.get(key)));
        }
        return found;
    }
}
