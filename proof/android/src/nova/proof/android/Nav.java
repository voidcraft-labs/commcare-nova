package nova.proof.android;

import android.content.Intent;

import org.commcare.CommCareApplication;
import org.commcare.activities.CommCareVerificationActivity;
import org.commcare.activities.DispatchActivity;
import org.commcare.activities.FormEntryActivity;
import org.commcare.activities.StandardHomeActivity;
import org.commcare.android.mocks.FormAndDataSyncerFake;
import org.commcare.commcaresupportlibrary.CommCareLauncher;
import org.commcare.engine.resource.AppInstallStatus;
import org.json.JSONArray;
import org.json.JSONObject;
import org.robolectric.Shadows;
import org.robolectric.android.controller.ActivityController;
import org.robolectric.shadows.ShadowActivity;
import org.robolectric.shadows.ShadowLooper;

import java.util.ArrayList;
import java.util.List;

/**
 * Where Android takes a worker: the {@code nav} request. Each navigation is one session on the installed app,
 * read with the walk's own loop (Screens.follow), and recorded under {@code navs}:
 *
 * <ul>
 * <li>{@code command:<id>}, for each of {@code commands}: the session started from the command, as the
 * {@code app} request's commands are (Screens.walk), its form completed and home handed the result, and each
 * screen home then starts.</li>
 * <li>{@code path:<ids joined by />}, for each of {@code paths}: the items chosen from the app's first menu as a
 * worker taps them (Menus.choose), a list on the way answered with its first case, and the screen reached read as
 * a command's is.</li>
 * <li>{@code endpoint:<id>}, for each of {@code endpoints} ({@code {id, arguments?, complete?}}): the intent
 * CommCare's own launcher sends (CommCareLauncher.launchCommCareForAppId: the action
 * {@code org.commcare.dalvik.action.CommCareSession}, the installed app's id, the entry point's id and its
 * arguments as a list) handed to DispatchActivity, each activity it starts followed until it starts
 * StandardHomeActivity ({@code dispatched}), the media check a first open asks for run and its result handed
 * back. Home is built from the intent the dispatcher handed it ({@code handedHome}), which runs the entry
 * point's stack as it is created (HomeScreenBaseActivity.processSessionEndpoint), and what home then starts is
 * read ({@code landed}): a case list answered and the screen after it read, and a form opened and left, or
 * completed where the entry point carries {@code "complete": true}.</li>
 * </ul>
 *
 * A step records its {@code screen} (home, MenuActivity, EntitySelectActivity, FormEntryActivity), the session
 * frame ({@code session.command}, and {@code session.needed} where home starts no screen), a menu's id and the
 * items its MenuAdapter lists, and a form's header (FormEntryActivity.getHeaderString) and title.
 */
final class Nav {
    /** Activities the dispatcher may start before home; a chain longer than this never reaches home. */
    private static final int MAX_DISPATCHED = 10;

    private Nav() {
    }

    static JSONObject read(JSONObject request) throws Exception {
        JSONObject found = new JSONObject();
        AppInstallStatus status = Device.install(request.getString("archive"));
        found.put("install", String.valueOf(status));
        if (status != AppInstallStatus.Installed) {
            return found;
        }
        if (request.has("worker")) {
            Device.serve(request.getJSONObject("worker"));
        }
        if (Device.served()) {
            String signedIn = Device.signIn();
            found.put("signIn", signedIn);
            if (!signedIn.startsWith("Success(")) {
                found.put("navs", new JSONObject());
                return found;
            }
        } else {
            Device.login();
            if (request.has("restore")) {
                found.put("restore", Device.restore(request.getString("restore")));
            }
        }
        Answers.table = request.optJSONObject("answers");
        Queries.answer = null;
        Lists.searches = null;
        JSONObject navs = new JSONObject();
        JSONArray commands = request.optJSONArray("commands");
        for (int i = 0; commands != null && i < commands.length(); i++) {
            String command = commands.getString(i);
            String name = "command:" + command;
            navs.put(name, Screens.guarded(name, command, new ArrayList<>(), null, Forms::read));
        }
        JSONArray paths = request.optJSONArray("paths");
        for (int i = 0; paths != null && i < paths.length(); i++) {
            JSONArray ids = paths.getJSONArray(i);
            List<String> choices = new ArrayList<>();
            for (int j = 0; j < ids.length(); j++) {
                choices.add(ids.getString(j));
            }
            String name = "path:" + String.join("/", choices);
            navs.put(name, Screens.guarded(name, null, choices, null, Forms::read));
        }
        JSONArray endpoints = request.optJSONArray("endpoints");
        for (int i = 0; endpoints != null && i < endpoints.length(); i++) {
            JSONObject endpoint = endpoints.getJSONObject(i);
            String name = "endpoint:" + endpoint.getString("id");
            navs.put(name, Screens.guarded(name, () -> launched(endpoint)));
        }
        found.put("navs", navs);
        return found;
    }

    /** The intent CommCare's own launcher sends for {@code endpoint} (CommCareLauncher.launchCommCareForAppId). */
    private static Intent launch(JSONObject endpoint) throws Exception {
        Intent intent = new Intent("org.commcare.dalvik.action.CommCareSession");
        // The launcher's action resolves to the dispatcher on a device (the manifest's intent filter).
        intent.setClass(CommCareApplication.instance(), DispatchActivity.class);
        intent.putExtra(CommCareLauncher.SESSION_ENDPOINT_APP_ID,
                CommCareApplication.instance().getCurrentApp().getUniqueId());
        intent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_NEW_TASK);
        intent.putExtra(DispatchActivity.SESSION_ENDPOINT_ID, endpoint.getString("id"));
        ArrayList<String> arguments = new ArrayList<>();
        JSONArray given = endpoint.optJSONArray("arguments");
        for (int i = 0; given != null && i < given.length(); i++) {
            arguments.add(given.getString(i));
        }
        intent.putStringArrayListExtra(DispatchActivity.SESSION_ENDPOINT_ARGUMENTS_LIST, arguments);
        return intent;
    }

    private static JSONObject launched(JSONObject endpoint) throws Exception {
        try {
            return dispatched(endpoint);
        } finally {
            Opened.end();
        }
    }

    private static JSONObject dispatched(JSONObject endpoint) throws Exception {
        JSONObject found = new JSONObject();
        JSONArray chain = new JSONArray();
        found.put("dispatched", chain);
        CommCareApplication.instance().getCurrentSessionWrapper().reset();
        ActivityController<DispatchActivity> dispatchController =
                Opened.build(DispatchActivity.class, launch(endpoint)).setup();
        DispatchActivity dispatch = dispatchController.get();
        ShadowLooper.idleMainLooper();
        Device.settle();
        ShadowActivity dispatcher = Shadows.shadowOf(dispatch);
        chain.put("DispatchActivity");
        Intent home = null;
        for (int count = 0; home == null; count++) {
            Intent started = dispatcher.getNextStartedActivity();
            if (started == null || started.getComponent() == null) {
                break;
            }
            String target = started.getComponent().getClassName();
            chain.put(target.substring(target.lastIndexOf('.') + 1));
            if (count >= MAX_DISPATCHED) {
                throw new Screens.WalkNeverEnds("Android's dispatcher started " + count + " activities without"
                        + " reaching home (" + chain + "); the reader cannot say where the entry point leads.");
            }
            if (target.equals(StandardHomeActivity.class.getName())) {
                home = started;
            } else if (target.equals(CommCareVerificationActivity.class.getName())) {
                // The media check a first open asks for, run, and its result handed back to the dispatcher.
                dispatchController.pause().stop();
                CommCareVerificationActivity verification =
                        Opened.build(CommCareVerificationActivity.class, started).setup().get();
                ShadowLooper.idleMainLooper();
                Device.settle();
                ShadowActivity verified = Shadows.shadowOf(verification);
                if (!verification.isFinishing()) {
                    // The verifier still has something to show: leave the worker there, rather than handing
                    // back a result an unfinished activity has never returned.
                    break;
                }
                dispatcher.receiveResult(started, verified.getResultCode(), verified.getResultIntent());
                // A real device resumes the dispatcher after the verifier finishes. Its onResume decides
                // what to launch next; receiving a result alone does not run that lifecycle callback.
                dispatchController.restart().start().resume().visible();
                ShadowLooper.idleMainLooper();
                Device.settle();
            } else {
                // Any other screen is where the dispatcher leaves the worker: the chain ends there.
                break;
            }
        }
        if (home == null) {
            return found;
        }
        JSONObject handed = new JSONObject();
        handed.put("endpoint", Screens.orNull(home.getStringExtra(DispatchActivity.SESSION_ENDPOINT_ID)));
        handed.put("arguments", Screens.orNull(home.getStringArrayListExtra(
                DispatchActivity.SESSION_ENDPOINT_ARGUMENTS_LIST) == null ? null : new JSONArray(
                home.getStringArrayListExtra(DispatchActivity.SESSION_ENDPOINT_ARGUMENTS_LIST))));
        found.put("handedHome", handed);
        // Home built from the dispatcher's intent runs the entry point's stack as it is created, and starts the
        // session's next step.
        StandardHomeActivity screen = Opened.build(StandardHomeActivity.class, home).create().get();
        ShadowLooper.idleMainLooper();
        if (!Device.served()) {
            screen.setFormAndDataSyncer(new FormAndDataSyncerFake());
        }
        JSONObject landed = new JSONObject();
        landed.put("steps", new JSONArray());
        found.put("landed", landed);
        boolean complete = endpoint.optBoolean("complete");
        Screens.follow(screen, Shadows.shadowOf(screen), endpoint.getString("id"), new ArrayList<>(), 0, null,
                complete ? Forms::read : Nav::opened, landed);
        return found;
    }

    /** A form an entry point opened, left as it opened: whether it loaded, its header and title, and any alert. */
    private static boolean opened(Intent started, JSONObject step, ShadowActivity home) throws Exception {
        FormEntryActivity activity = Forms.open(started);
        JSONObject form = new JSONObject();
        step.put("form", form);
        boolean loaded = FormEntryActivity.mFormController != null;
        form.put("loaded", loaded);
        form.put("alert", Screens.orNull(Views.alert(activity)));
        if (loaded) {
            Forms.describe(activity, started, form);
        }
        return false;
    }
}
