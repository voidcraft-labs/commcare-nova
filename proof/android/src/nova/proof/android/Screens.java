package nova.proof.android;

import android.app.Activity;
import android.content.Intent;
import android.view.View;
import android.view.View.MeasureSpec;
import android.view.ViewGroup;
import android.widget.LinearLayout;
import android.widget.ListView;

import org.commcare.CommCareApplication;
import org.commcare.activities.CommCareActivity;
import org.commcare.activities.EntitySelectActivity;
import org.commcare.activities.FormEntryActivity;
import org.commcare.activities.StandardHomeActivity;
import org.commcare.adapters.EntityListAdapter;
import org.commcare.android.mocks.FormAndDataSyncerFake;
import org.commcare.dalvik.R;
import org.commcare.engine.resource.AppInstallStatus;
import org.commcare.models.AndroidSessionWrapper;
import org.commcare.session.CommCareSession;
import org.commcare.session.SessionFrame;
import org.commcare.suite.model.EntityDatum;
import org.commcare.suite.model.SessionDatum;
import org.commcare.util.DatumUtil;
import org.commcare.views.dialogs.DialogChoiceItem;
import org.commcare.views.dialogs.PaneledChoiceDialog;
import org.javarosa.core.model.instance.TreeReference;
import org.json.JSONArray;
import org.json.JSONObject;
import org.robolectric.Robolectric;
import org.robolectric.Shadows;
import org.robolectric.shadows.ShadowActivity;
import org.robolectric.shadows.ShadowListView;
import org.robolectric.shadows.ShadowLooper;

import java.lang.reflect.Field;
import java.lang.reflect.Method;

/**
 * What Android shows of an installed app: for each command the request names, the screens the app's own home
 * activity takes a worker through from that command (HomeScreenBaseActivity and its SessionNavigator), each
 * built by Robolectric from the intent home started, as the project's own tests build them
 * (ActivityLaunchUtils). At a case list the first case is chosen, by handing home the result the list would;
 * a walk ends at a form, at a screen the walk does not answer, or where home starts nothing.
 */
final class Screens {
    /** The width a row is measured at, so the widths Android gives its columns are comparable. */
    private static final int ROW_WIDTH = 1000;
    private static final int MAX_STEPS = 12;
    private static final int MAX_ROWS = 4;

    private Screens() {
    }

    static JSONObject read(JSONObject request) throws Exception {
        JSONObject found = new JSONObject();
        AppInstallStatus status = Device.install(request.getString("archive"));
        found.put("install", String.valueOf(status));
        if (status != AppInstallStatus.Installed) {
            return found;
        }
        // What the install alone left, before any worker logs in, and the profile as its readers give it: the
        // `profile` request's answer, so one device answers for both.
        found.put("areMMResourcesValidatedAfterInstall",
                CommCareApplication.instance().getCurrentApp().areMMResourcesValidated());
        Device.login();
        found.put("profile", Profile.read());
        if (request.has("restore")) {
            found.put("restore", Device.restore(request.getString("restore")));
        }
        JSONObject preferences = request.optJSONObject("preferences");
        if (preferences != null) {
            // A worker's own settings, written where Android's settings screen writes them.
            android.content.SharedPreferences.Editor editor =
                    CommCareApplication.instance().getCurrentApp().getAppPreferences().edit();
            JSONArray names = preferences.names();
            for (int i = 0; names != null && i < names.length(); i++) {
                editor.putString(names.getString(i), preferences.getString(names.getString(i)));
            }
            editor.commit();
        }
        JSONArray searches = request.optJSONArray("searches");
        Queries.answer = request.has("queryAnswer") ? request.getString("queryAnswer") : null;
        JSONObject walks = new JSONObject();
        JSONArray commands = request.optJSONArray("commands");
        if (commands == null) {
            // Every command the installed suite gives an entry, in a fixed order.
            commands = new JSONArray(new java.util.TreeSet<>(
                    CommCareApplication.instance().getCommCarePlatform().getCommandToEntryMap().keySet()));
        }
        for (int i = 0; i < commands.length(); i++) {
            String command = commands.getString(i);
            try {
                walks.put(command, walk(command, searches));
            } catch (Throwable raised) {
                JSONObject failed = new JSONObject();
                failed.put("raised", Reader.raised(raised));
                walks.put(command, failed);
            }
        }
        found.put("walks", walks);
        if (request.has("saveIncomplete")) {
            // A form saved incomplete from the command, and the record Android keeps of it (its name among it).
            JSONObject saved = new JSONObject();
            Updates.saveIncomplete(request.getString("saveIncomplete"), saved);
            found.put("savedIncomplete", saved);
        }
        if (request.has("saveComplete")) {
            // The same form saved complete, as its end saves it.
            JSONObject saved = new JSONObject();
            Updates.save(request.getString("saveComplete"), saved, true);
            found.put("savedComplete", saved);
        }
        return found;
    }

    /** What a walk does at the form home opens: read it (Forms), or something a request needs done there. */
    interface FormStep {
        void at(Intent started, JSONObject step, ShadowActivity home) throws Exception;
    }

    private static JSONObject walk(String command, JSONArray searches) throws Exception {
        return walk(command, searches, (started, step, home) -> Forms.read(started, step));
    }

    static JSONObject walk(String command, JSONArray searches, FormStep form) throws Exception {
        AndroidSessionWrapper wrapper = CommCareApplication.instance().getCurrentSessionWrapper();
        wrapper.reset();
        StandardHomeActivity home = Robolectric.buildActivity(StandardHomeActivity.class, null).create().get();
        ShadowLooper.idleMainLooper();
        home.setFormAndDataSyncer(new FormAndDataSyncerFake());
        ShadowActivity shadow = Shadows.shadowOf(home);
        drain(shadow);
        wrapper.getSession().setCommand(command);
        home.getSessionNavigator().startNextSessionStep();
        ShadowLooper.idleMainLooper();

        JSONArray steps = new JSONArray();
        JSONObject found = new JSONObject();
        found.put("steps", steps);
        for (int count = 0; count < MAX_STEPS; count++) {
            Intent started = shadow.getNextStartedActivity();
            drain(shadow);
            JSONObject step = new JSONObject();
            steps.put(step);
            if (started == null) {
                // Home started nothing: where the session stands and what home tells the worker.
                step.put("screen", "home");
                step.put("session", session(wrapper));
                JSONObject alert = Views.alert(home);
                step.put("alert", alert == null ? JSONObject.NULL : alert);
                break;
            }
            String target = started.getComponent().getClassName();
            step.put("screen", target.substring(target.lastIndexOf('.') + 1));
            step.put("session", session(wrapper));
            if (target.equals(EntitySelectActivity.class.getName())) {
                String chosen = list(started, step, searches);
                if (chosen == null) {
                    break;
                }
                shadow.receiveResult(started, Activity.RESULT_OK,
                        new Intent(started).putExtra(SessionFrame.STATE_DATUM_VAL, chosen));
                ShadowLooper.idleMainLooper();
            } else if (target.equals(FormEntryActivity.class.getName())) {
                form.at(started, step, shadow);
                break;
            } else if (target.equals(org.commcare.activities.QueryRequestActivity.class.getName())) {
                if (!Queries.read(started, step, shadow)) {
                    break;
                }
            } else {
                break;
            }
        }
        return found;
    }

    static void drain(ShadowActivity shadow) {
        while (shadow.getNextStartedActivity() != null) {
            // Each launch read once.
        }
        while (shadow.getNextStartedActivityForResult() != null) {
            // A launch for a result is in both queues.
        }
    }

    static JSONObject session(AndroidSessionWrapper wrapper) throws Exception {
        CommCareSession session = wrapper.getSession();
        JSONObject found = new JSONObject();
        found.put("command", session.getCommand() == null ? JSONObject.NULL : session.getCommand());
        String needed = session.getNeededData(wrapper.getEvaluationContext());
        found.put("needed", needed == null ? JSONObject.NULL : needed);
        return found;
    }

    /** The case list Android shows for the intent home started, and the id of its first case (null: none). */
    private static String list(Intent started, JSONObject step, JSONArray searches) throws Exception {
        EntitySelectActivity activity =
                Robolectric.buildActivity(EntitySelectActivity.class, started).setup().get();
        ShadowLooper.idleMainLooper();
        ListView listView = (ListView)((Activity)activity).findViewById(R.id.screen_entity_select_list);
        EntityListAdapter adapter = null;
        View rows = listView;
        if (listView != null && listView.getAdapter() instanceof EntityListAdapter) {
            adapter = (EntityListAdapter)listView.getAdapter();
            ShadowListView shadowList = Shadows.shadowOf(listView);
            shadowList.populateItems();
        } else {
            adapter = (EntityListAdapter)field(activity, "adapter");
        }
        if (adapter == null) {
            step.put("list", JSONObject.NULL);
            step.put("alert", orNull(Views.alert(activity)));
            return null;
        }
        JSONObject list = new JSONObject();
        step.put("list", list);

        // The Sort menu's choices, from the activity's own method.
        PaneledChoiceDialog dialog = new PaneledChoiceDialog(activity, "sort");
        Method sortOptions = EntitySelectActivity.class.getDeclaredMethod("getSortOptionsList",
                PaneledChoiceDialog.class);
        sortOptions.setAccessible(true);
        list.put("EntitySelectActivity.getSortOptionsList",
                Views.choices((DialogChoiceItem[])sortOptions.invoke(activity, dialog)));

        // The header row and the first rows, measured, so each column has the width Android gives it.
        LinearLayout header = (LinearLayout)field(activity, "header");
        JSONArray headers = new JSONArray();
        for (int i = 0; header != null && i < header.getChildCount(); i++) {
            headers.put(Views.describe(measured(header.getChildAt(i))));
        }
        list.put("header", headers);
        list.put("count", adapter.getCurrentCount());
        JSONArray shown = new JSONArray();
        for (int i = 0; i < Math.min(adapter.getCurrentCount(), MAX_ROWS); i++) {
            shown.put(Views.describe(measured(adapter.getView(i, null, (ViewGroup)rows))));
        }
        list.put("rows", shown);

        String chosen = null;
        if (adapter.getCurrentCount() > 0) {
            AndroidSessionWrapper wrapper = CommCareApplication.instance().getCurrentSessionWrapper();
            SessionDatum datum = wrapper.getSession().getNeededDatum();
            TreeReference first = adapter.getItem(0);
            chosen = DatumUtil.getReturnValueFromSelection(first, (EntityDatum)datum, activity.evalContext());
        }

        // What each search finds, by the first cell of each row it leaves.
        if (searches != null) {
            JSONObject results = new JSONObject();
            for (int i = 0; i < searches.length(); i++) {
                String term = searches.getString(i);
                adapter.filterByString(term);
                settle(adapter);
                JSONArray matched = new JSONArray();
                for (int row = 0; row < adapter.getCurrentCount(); row++) {
                    matched.put(firstText(adapter.getView(row, null, (ViewGroup)rows)));
                }
                results.put(term, matched);
            }
            adapter.filterByString("");
            settle(adapter);
            list.put("searches", results);
        }
        return chosen;
    }

    /**
     * Waits for the list's filter, which Android runs on a thread of its own (EntityFiltererBase.start), and for
     * the result it posts back to the main thread.
     */
    private static void settle(EntityListAdapter adapter) throws Exception {
        Object filterer = field(adapter, "entityFilterer");
        if (filterer != null) {
            Thread thread = (Thread)field(filterer, "thread");
            if (thread != null) {
                thread.join(60000);
            }
        }
        ShadowLooper.idleMainLooper();
    }

    private static String firstText(View view) throws Exception {
        JSONObject described = Views.describe(view);
        return firstText(described);
    }

    private static String firstText(JSONObject described) throws Exception {
        if (described.has("text")) {
            return described.getString("text");
        }
        JSONArray children = described.optJSONArray("children");
        for (int i = 0; children != null && i < children.length(); i++) {
            String text = firstText(children.getJSONObject(i));
            if (text != null) {
                return text;
            }
        }
        return null;
    }

    static View measured(View view) {
        view.measure(MeasureSpec.makeMeasureSpec(ROW_WIDTH, MeasureSpec.EXACTLY),
                MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED));
        view.layout(0, 0, view.getMeasuredWidth(), view.getMeasuredHeight());
        return view;
    }

    static Object field(Object owner, String name) throws Exception {
        for (Class<?> type = owner.getClass(); type != null; type = type.getSuperclass()) {
            try {
                Field field = type.getDeclaredField(name);
                field.setAccessible(true);
                return field.get(owner);
            } catch (NoSuchFieldException absent) {
                // A superclass may declare it.
            }
        }
        throw new NoSuchFieldException(owner.getClass().getName() + "." + name);
    }

    static Object orNull(Object value) {
        return value == null ? JSONObject.NULL : value;
    }

    static JSONObject alertOf(CommCareActivity<?> activity) throws Exception {
        return Views.alert(activity);
    }
}
