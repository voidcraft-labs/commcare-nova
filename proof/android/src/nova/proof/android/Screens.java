package nova.proof.android;

import android.content.Intent;
import android.content.SharedPreferences;

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
import org.commcare.preferences.MainConfigurablePreferences;
import org.commcare.session.CommCareSession;
import org.commcare.session.SessionFrame;
import org.javarosa.core.services.locale.Localization;
import org.json.JSONArray;
import org.json.JSONObject;
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
 * further: an item a menu hides is reached by no walk. A case list is read where the walk reaches it, and each
 * case it lists is a walk of its own that opens it and confirms it (Lists), as each action the list offers (a
 * search behind the list) is: every case of a list, in the list's order, as every reader's walk opens them
 * (proof/observe/walks.py, cases_opened), each walk named by the case it chose (CASE). A search is sent and
 * answered (Queries), a claim posted and its sync run (Posts); a form is answered to its end and saved, and home
 * is handed its result, so what home starts after a form is part of the same walk (Forms), and a list it reaches
 * there is answered with the walk's own case where it lists it, else its first. A walk ends where home starts
 * nothing, at a menu after a form, at a screen the walk does not answer (named, with what it shows), or, once it
 * has followed MAX_FORMS forms, at a form it has already opened.
 *
 * The app is walked in the language it starts in, and then again in each other language the request names (the
 * languages the app holds but its first, proof/observe/walks.py, chosen): each such walk chooses its language
 * first on home's own Change Language dialog (Languages), as a worker chooses one, and is named by it
 * (LANGUAGE), and each language's walks are its own, down what its menus and lists offer in it. Once they
 * have run, the language and the worker's setting for it are put back as the app started, for what the
 * request reads after its walks.
 *
 * A screen is read once where the device is the same: the walk that ends at a menu or a list reads it, and each
 * walk that goes on from there opens the same screen and records only what it chooses (Menus.choose, Lists);
 * the walk that ends its choices with a case reads the case's detail, and a walk that goes on from the case
 * confirms it without reading it again. Each walk's screens end with it, as Android ends the screens a worker
 * has left (Opened).
 *
 * Android applies a completed form's case blocks to the device's own case database as it saves the form
 * (FormRecord.updateAndProcessRecord), so each walk that saved a form starts the next on a device made again:
 * the worker's sandbox wiped by the app's own call and the restore applied again (Device.reset).
 */
final class Screens {
    /**
     * The steps a walk may take before the reader gives up on it as one that never ends: no walk of the corpus
     * comes near it (a form's loop ends at MAX_FORMS), so reaching it is the reader's failure, never a record.
     */
    private static final int MAX_STEPS = 200;
    /**
     * The forms a walk follows into before a form it has already opened ends it: home may start the same form
     * again after it (a form's end that returns to its own list), and every walk of the corpus that reaches the
     * bound is such a loop. A form the walk has not opened yet is followed whatever the count, so no form of a
     * chain is left unread.
     */
    private static final int MAX_FORMS = 3;
    static final String ROOT = "root";
    /** A walk's choice of a list's own action, by its place among the list's actions. */
    static final String ACTION = "@action:";
    /** A walk's choice of a case at a list, by the value a tap on its row hands the session. */
    static final String CASE = "@case:";
    /** A walk's choice of a language on home's Change Language dialog, made before anything else. */
    static final String LANGUAGE = "@language:";

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
        if (request.has("worker")) {
            Device.serve(request.getJSONObject("worker"));
        }
        Sensors.place(request);
        if (request.has("clock")) {
            ProofClock.set(request.getString("clock"));
        }
        if (Device.served()) {
            // The worker signs in as on their phone, which asks HQ for their key record and their data.
            String signedIn = Device.signIn();
            found.put("signIn", signedIn);
            found.put("profile", Profile.read());
            if (!signedIn.startsWith("Success(")) {
                // A worker who cannot sign in stays at the sign-in screen and reaches no menu.
                found.put("walks", new JSONObject());
                return found;
            }
        } else {
            Device.login();
            found.put("profile", Profile.read());
            if (request.has("restore")) {
                found.put("restore", Device.restore(request.getString("restore")));
            }
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
                walks.put(command, guarded(command, command, new ArrayList<>(), null, Forms::read));
            }
        } else {
            // The walks in the language the app starts in, then each other language's (the request's), each
            // language's own: its menus and lists are read in it, so what it offers is what is walked.
            List<List<String>> starts = new ArrayList<>();
            starts.add(new ArrayList<>());
            JSONArray languages = request.optJSONArray("languages");
            for (int i = 0; languages != null && i < languages.length(); i++) {
                List<String> start = new ArrayList<>();
                start.add(LANGUAGE + languages.getString(i));
                starts.add(start);
            }
            String startLocale = Localization.getCurrentLocale();
            SharedPreferences settings = CommCareApplication.instance().getCurrentApp().getAppPreferences();
            String startSetting = settings.getString(MainConfigurablePreferences.PREFS_LOCALE_KEY, null);
            try {
                for (List<String> start : starts) {
                    Deque<List<String>> pending = new ArrayDeque<>();
                    pending.add(start);
                    // Every path the app's own menus offer, however many: a menu offers finitely many items, a
                    // list finitely many cases, and a walk goes down one level a choice.
                    while (!pending.isEmpty()) {
                        List<String> choices = pending.removeFirst();
                        walks.put(name(choices), guarded(name(choices), null, choices, pending, Forms::read));
                    }
                }
            } finally {
                if (starts.size() > 1) {
                    // What the request reads after its walks is read as the app started: the language and the
                    // worker's setting for it are put back as they stood. The picker cannot do it for every
                    // app: one whose profile names no locale starts in "default" (finding 39), which the picker
                    // does not offer (ChangeLocaleUtil.getLocaleCodes), so they are set as the picker's own
                    // choice sets them (Localization.setLocale, MainConfigurablePreferences.setCurrentLocale).
                    Localization.setLocale(startLocale);
                    SharedPreferences.Editor setting = settings.edit();
                    if (startSetting == null) {
                        setting.remove(MainConfigurablePreferences.PREFS_LOCALE_KEY);
                    } else {
                        setting.putString(MainConfigurablePreferences.PREFS_LOCALE_KEY, startSetting);
                    }
                    setting.commit();
                }
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

    /** A walk the reader followed past MAX_STEPS: the reader cannot answer the request, so it raises. */
    static final class WalkNeverEnds extends RuntimeException {
        WalkNeverEnds(String message) {
            super(message);
        }
    }

    static String name(List<String> choices) {
        return choices.isEmpty() ? ROOT : String.join("/", choices);
    }

    /** What a walk does at the form home opens; true where home was handed the form's result. */
    interface FormStep {
        boolean at(Intent started, JSONObject step, ShadowActivity home) throws Exception;
    }

    private static JSONObject guarded(String name, String command, List<String> choices,
                                      Deque<List<String>> pending, FormStep form) throws Exception {
        Device.settle();
        if (Device.dirty) {
            // The device made again, signed in again where HQ stands before any walk.
            Peer.base(name);
            Device.reset();
            // What the sign-in set running (its log submission) ends in the sign-in's place.
            Device.settle();
        }
        // HQ meets each walk as the served state stood once the worker signed in: a walk is one worker's session,
        // and nothing an earlier walk sent HQ is there for it.
        Peer.run(name);
        Sensors.forget();
        try {
            return walk(command, choices, pending, form);
        } catch (WalkNeverEnds reader) {
            // The reader's own failure, never the app's: no record holds it.
            throw reader;
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
        try {
            return walked(command, choices, pending, form);
        } finally {
            // The walk's screens end with it, as Android ends the screens a worker has left.
            Opened.end();
        }
    }

    private static JSONObject walked(String command, List<String> choices, Deque<List<String>> pending,
                                     FormStep form) throws Exception {
        AndroidSessionWrapper wrapper = CommCareApplication.instance().getCurrentSessionWrapper();
        wrapper.reset();
        StandardHomeActivity home = Opened.build(StandardHomeActivity.class, null).create().get();
        ShadowLooper.idleMainLooper();
        if (!Device.served()) {
            // With no server, nothing is sent and no sync is run, as the project's own tests leave home
            // (ActivityLaunchUtils). A device served by HQ keeps home's own, which sends each form it completes.
            home.setFormAndDataSyncer(new FormAndDataSyncerFake());
        }
        ShadowActivity shadow = Shadows.shadowOf(home);
        drain(shadow);
        JSONArray steps = new JSONArray();
        JSONObject found = new JSONObject();
        int depth = 0;
        if (!choices.isEmpty() && choices.get(0).startsWith(LANGUAGE)) {
            // The worker chooses the walk's language first, on home's own dialog.
            JSONObject language = Languages.choose(home, choices.get(0).substring(LANGUAGE.length()));
            found.put("language", language);
            depth = 1;
            if (language.optBoolean("unoffered")) {
                found.put("steps", steps);
                return found;
            }
            drain(shadow);
        }
        if (command != null) {
            wrapper.getSession().setCommand(command);
        }
        home.getSessionNavigator().startNextSessionStep();
        ShadowLooper.idleMainLooper();

        found.put("steps", steps);
        int forms = 0;
        // The case the walk chose at its first list, which a list a form leads to is answered with where it
        // lists it.
        String own = null;
        java.util.Set<String> opened = new java.util.HashSet<>();
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
                throw new WalkNeverEnds("A walk took " + count + " steps without ending, repeating a form"
                        + " or leaving the app's screens (" + name(choices) + ", now at " + step + "); the reader"
                        + " cannot say where it leads.");
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
                // The walk's next choice may be one of this list's own actions (a search behind the list), or one
                // of its cases.
                boolean scripted = forms == 0 && depth < choices.size() && choices.get(depth).startsWith(ACTION);
                boolean named = forms == 0 && depth < choices.size() && choices.get(depth).startsWith(CASE);
                // A walk from the app's first menu with nothing left to choose reads the list and ends there:
                // each case it lists and each action it offers is a walk of its own.
                boolean ending = command == null && forms == 0 && depth >= choices.size();
                Lists.action = scripted ? Integer.valueOf(choices.get(depth++).substring(ACTION.length())) : null;
                Lists.choice = named ? choices.get(depth++).substring(CASE.length()) : null;
                if (named) {
                    own = Lists.choice;
                }
                // A list a form leads to is answered with the walk's own case where it lists it.
                Lists.preferred = scripted || named || ending ? null : own;
                Lists.branch = ending;
                // A list the walk chooses at is one its own start read (the walk that ended there): only what is
                // chosen there. The case's detail is read by the walk that ends its choices with the case, and
                // only confirmed by the walks that go on from it.
                Lists.passing = scripted || named;
                Lists.confirming = named && depth < choices.size();
                boolean on = Lists.read(started, step, shadow);
                if (ending && pending != null) {
                    for (String listed : Lists.cases) {
                        List<String> next = new ArrayList<>(choices);
                        next.add(CASE + listed);
                        pending.add(next);
                    }
                    if (!String.join("/", choices).contains(ACTION)) {
                        // Each action the list offers is a walk of its own, where no action led here.
                        for (int index = 0; index < Lists.offered; index++) {
                            List<String> next = new ArrayList<>(choices);
                            next.add(ACTION + index);
                            pending.add(next);
                        }
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
                String opening = String.valueOf(wrapper.getSession().getCommand());
                if (forms >= MAX_FORMS && opened.contains(opening)) {
                    step.put("walkEnded", "forms");
                    break;
                }
                forms++;
                opened.add(opening);
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
    /** The last permission request a screen made of the device, which a worker's answer goes back to. */
    static Intent permissionRequest;

    static void deviceAsks(ShadowActivity shadow, JSONObject holder) throws Exception {
        Intent next;
        while ((next = shadow.peekNextStartedActivity()) != null && next.getComponent() == null) {
            shadow.getNextStartedActivity();
            if (next.getStringArrayExtra(Sensors.REQUESTED) != null) {
                permissionRequest = next;
            }
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
