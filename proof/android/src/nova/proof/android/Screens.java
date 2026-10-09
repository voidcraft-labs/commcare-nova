package nova.proof.android;

import android.content.Intent;

import org.commcare.CommCareApplication;
import org.commcare.activities.CommCareActivity;
import org.commcare.activities.EntityDetailActivity;
import org.commcare.activities.EntitySelectActivity;
import org.commcare.activities.FormEntryActivity;
import org.commcare.activities.MenuActivity;
import org.commcare.activities.PostRequestActivity;
import org.commcare.activities.QueryRequestActivity;
import org.commcare.activities.StandardHomeActivity;
import org.commcare.android.mocks.FormAndDataSyncerFake;
import org.commcare.engine.resource.AppInstallStatus;
import org.commcare.models.AndroidSessionWrapper;
import org.commcare.session.CommCareSession;
import org.commcare.session.SessionFrame;
import org.json.JSONArray;
import org.json.JSONObject;
import org.robolectric.Robolectric;
import org.robolectric.Shadows;
import org.robolectric.shadows.ShadowActivity;
import org.robolectric.shadows.ShadowLooper;

import java.lang.reflect.Field;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.List;

/**
 * What Android shows of an installed app: every screen its own home activity takes a worker through
 * (HomeScreenBaseActivity and its SessionNavigator), each built by Robolectric from the intent home started, as
 * the project's own tests build them (ActivityLaunchUtils).
 *
 * A walk is one session from the app's first menu. Each menu the session reaches is read (Menus), and every item
 * it offers is a walk of its own, so a session is walked down every path the app's own menus offer and no
 * further: an item a menu hides is reached by no walk. At a case list the first case is opened and confirmed
 * (Lists), and each action the list offers (a search behind the list) is a walk of its own too; a search is sent and answered (Queries), a claim posted and its sync run (Posts); a form is answered
 * to its end and saved, and home is handed its result, so what home starts after a form is part of the same
 * walk (Forms). A walk ends where home starts nothing, at a menu after a form, at a screen the walk does not
 * answer (named, with what it shows), or at its limits.
 *
 * Android applies a completed form's case blocks to the device's own case database as it saves the form
 * (FormRecord.updateAndProcessRecord), so each walk that saved a form starts the next on a device made again:
 * the worker's sandbox wiped by the app's own call and the restore applied again (Device.reset).
 */
final class Screens {
    private static final int MAX_STEPS = 24;
    private static final int MAX_FORMS = 3;
    private static final int MAX_WALKS = 60;
    static final String ROOT = "root";
    /** A walk's choice of a list's own action, by its place among the list's actions. */
    static final String ACTION = "@action:";

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
        Device.prefer(request.optJSONObject("preferences"));
        found.put("home", Home.read());
        Lists.searches = request.optJSONArray("searches");
        Queries.answer = request.has("queryAnswer") ? request.getString("queryAnswer") : null;
        Answers.table = request.optJSONObject("answers");
        Forms.views = request.optBoolean("views");
        Forms.typeRefused = request.optBoolean("typeRefused");
        JSONObject walks = new JSONObject();
        JSONArray commands = request.optJSONArray("commands");
        if (commands != null) {
            // The named commands alone, each set on a new session as the project's own tests set one
            // (ActivityLaunchUtils.addCommandToSession), for a request that asks about one form.
            for (int i = 0; i < commands.length(); i++) {
                String command = commands.getString(i);
                walks.put(command, guarded(command, new ArrayList<>(), null, Forms::read));
            }
        } else {
            Deque<List<String>> pending = new ArrayDeque<>();
            pending.add(new ArrayList<>());
            int count = 0;
            while (!pending.isEmpty()) {
                List<String> choices = pending.removeFirst();
                if (count++ >= MAX_WALKS) {
                    found.put("walksLeft", pending.size() + 1);
                    break;
                }
                walks.put(name(choices), guarded(null, choices, pending, Forms::read));
            }
        }
        found.put("walks", walks);
        if (request.has("saveIncomplete")) {
            // A form saved incomplete from the command, and the record Android keeps of it (its name among it).
            JSONObject saved = new JSONObject();
            Updates.saveIncomplete(request.getString("saveIncomplete"), saved);
            found.put("savedIncomplete", saved);
        }
        return found;
    }

    static String name(List<String> choices) {
        return choices.isEmpty() ? ROOT : String.join("/", choices);
    }

    /** What a walk does at the form home opens; true where home was handed the form's result. */
    interface FormStep {
        boolean at(Intent started, JSONObject step, ShadowActivity home) throws Exception;
    }

    private static JSONObject guarded(String command, List<String> choices, Deque<List<String>> pending,
                                      FormStep form) throws Exception {
        if (Device.dirty) {
            Device.reset();
        }
        Sensors.forget();
        try {
            return walk(command, choices, pending, form);
        } catch (Throwable raised) {
            // What the app itself raised on the way is what a worker meets there (a crash); the next walk
            // starts on a device made again.
            Device.dirty = true;
            JSONObject failed = new JSONObject();
            failed.put("raised", Reader.raised(raised));
            return failed;
        }
    }

    static JSONObject walk(String command, FormStep form) throws Exception {
        return walk(command, new ArrayList<>(), null, form);
    }

    /**
     * One session: from {@code command} where the request names one, else from the app's first menu, choosing
     * {@code choices} at the menus it meets in turn. Every item of the first menu past them is added to
     * {@code pending} as a walk of its own.
     */
    static JSONObject walk(String command, List<String> choices, Deque<List<String>> pending, FormStep form)
            throws Exception {
        AndroidSessionWrapper wrapper = CommCareApplication.instance().getCurrentSessionWrapper();
        wrapper.reset();
        StandardHomeActivity home = Robolectric.buildActivity(StandardHomeActivity.class, null).create().get();
        ShadowLooper.idleMainLooper();
        // Nothing is sent and no sync is run, as the project's own tests leave home (ActivityLaunchUtils).
        home.setFormAndDataSyncer(new FormAndDataSyncerFake());
        ShadowActivity shadow = Shadows.shadowOf(home);
        drain(shadow);
        if (command != null) {
            wrapper.getSession().setCommand(command);
        }
        home.getSessionNavigator().startNextSessionStep();
        ShadowLooper.idleMainLooper();

        JSONArray steps = new JSONArray();
        JSONObject found = new JSONObject();
        found.put("steps", steps);
        int depth = 0;
        int forms = 0;
        Lists.action = null;
        for (int count = 0; ; count++) {
            // What the last screen asked the device for is that screen's.
            deviceAsks(shadow, steps.length() == 0 ? found : steps.getJSONObject(steps.length() - 1));
            Intent started = shadow.getNextStartedActivity();
            drain(shadow);
            JSONObject step = new JSONObject();
            steps.put(step);
            if (started == null) {
                // Home started nothing: where the session stands and what home tells the worker.
                step.put("screen", "home");
                step.put("session", session(wrapper));
                step.put("alert", orNull(Views.alert(home)));
                break;
            }
            String target = started.getComponent().getClassName();
            step.put("screen", target.substring(target.lastIndexOf('.') + 1));
            step.put("session", session(wrapper));
            if (count >= MAX_STEPS) {
                step.put("walkEnded", "steps");
                break;
            }
            if (target.equals(MenuActivity.class.getName())) {
                if (forms == 0 && depth < choices.size()) {
                    String choice = choices.get(depth++);
                    // A menu this walk's own start already read: only what is chosen there, and whether the
                    // menu still offers it.
                    if (!Menus.choose(started, step, shadow, choice)) {
                        break;
                    }
                } else {
                    List<String> offered = Menus.read(started, step);
                    if (forms == 0 && pending != null) {
                        for (String item : offered) {
                            List<String> next = new ArrayList<>(choices);
                            next.add(item);
                            pending.add(next);
                        }
                    }
                    break;
                }
            } else if (target.equals(EntitySelectActivity.class.getName())) {
                // The walk's next choice may be one of this list's own actions (a search behind the list).
                boolean scripted = forms == 0 && depth < choices.size() && choices.get(depth).startsWith(ACTION);
                Lists.action = scripted ? Integer.valueOf(choices.get(depth++).substring(ACTION.length())) : null;
                boolean on = Lists.read(started, step, shadow);
                if (!scripted && forms == 0 && depth >= choices.size() && pending != null
                        && !String.join("/", choices).contains(ACTION)) {
                    // Each action the list offers is a walk of its own, where no action led here.
                    for (int index = 0; index < Lists.offered; index++) {
                        List<String> next = new ArrayList<>(choices);
                        next.add(ACTION + index);
                        pending.add(next);
                    }
                }
                if (!on) {
                    break;
                }
            } else if (target.equals(EntityDetailActivity.class.getName())) {
                if (!Lists.confirm(started, step, shadow)) {
                    break;
                }
            } else if (target.equals(QueryRequestActivity.class.getName())) {
                if (!Queries.read(started, step, shadow)) {
                    break;
                }
            } else if (target.equals(PostRequestActivity.class.getName())) {
                if (!Posts.read(started, step, shadow)) {
                    break;
                }
            } else if (target.equals(FormEntryActivity.class.getName())) {
                if (++forms > MAX_FORMS) {
                    step.put("walkEnded", "forms");
                    break;
                }
                if (!form.at(started, step, shadow)) {
                    break;
                }
            } else {
                break;
            }
        }
        return found;
    }

    /**
     * Takes, from what the app has started, each intent that asks the device for something and names no screen
     * of the app (a permission the app requests, which a device answers with a dialog of its own), into
     * {@code holder}'s {@code deviceAsked}; it stops at the first that names a screen. The device here grants
     * nothing.
     */
    static void deviceAsks(ShadowActivity shadow, JSONObject holder) throws Exception {
        Intent next;
        while ((next = shadow.peekNextStartedActivity()) != null && next.getComponent() == null) {
            shadow.getNextStartedActivity();
            JSONObject asked = new JSONObject();
            asked.put("action", orNull(next.getAction()));
            asked.put("data", orNull(next.getDataString()));
            String[] permissions = next.getStringArrayExtra("android.content.pm.extra.REQUEST_PERMISSIONS_NAMES");
            if (permissions != null) {
                asked.put("permissions", new JSONArray(java.util.Arrays.asList(permissions)));
            }
            if (!holder.has("deviceAsked")) {
                holder.put("deviceAsked", new JSONArray());
            }
            holder.getJSONArray("deviceAsked").put(asked);
        }
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
        found.put("command", orNull(session.getCommand()));
        String needed;
        try {
            needed = session.getNeededData(wrapper.getEvaluationContext());
        } catch (RuntimeException raised) {
            needed = "raised " + raised.getClass().getSimpleName();
        }
        found.put("needed", orNull(needed));
        if (SessionFrame.STATE_DATUM_VAL.equals(needed) || SessionFrame.STATE_DATUM_COMPUTED.equals(needed)
                || SessionFrame.STATE_QUERY_REQUEST.equals(needed)) {
            found.put("datum", orNull(session.getNeededDatum() == null ? null
                    : session.getNeededDatum().getDataId()));
        }
        return found;
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
