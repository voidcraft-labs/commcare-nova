package nova.proof.android;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import org.commcare.activities.FormEntryActivity;
import org.commcare.activities.components.FormEntryInstanceState;
import org.commcare.android.javarosa.IntentCallout;
import org.commcare.commcaresupportlibrary.identity.BiometricIdentifier;
import org.commcare.commcaresupportlibrary.identity.IdentityResponseBuilder;
import org.commcare.commcaresupportlibrary.identity.model.IdentificationMatch;
import org.commcare.commcaresupportlibrary.identity.model.MatchResult;
import org.commcare.commcaresupportlibrary.identity.model.MatchStrength;
import org.commcare.commcaresupportlibrary.identity.model.RegistrationResult;
import org.commcare.commcaresupportlibrary.identity.model.VerificationMatch;
import org.commcare.utils.RobolectricUtil;
import org.commcare.views.widgets.IntentWidget;
import org.commcare.views.widgets.QuestionWidget;
import org.json.JSONArray;
import org.json.JSONObject;
import org.robolectric.Robolectric;
import org.robolectric.Shadows;
import org.robolectric.android.controller.ActivityController;
import org.robolectric.shadows.ShadowActivity;
import org.robolectric.shadows.ShadowLooper;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Iterator;
import java.util.Map;

/** A controlled result-producing Android activity for the installed form.
 * The question's real button starts the action and FormEntryActivity receives
 * the result by request code, as it does when a different package returns. */
public final class AndroidAppAnswers {
    private static JSONObject scenarios;
    private static final Map<String,Integer> visits = new HashMap<>();

    static void start(JSONObject request) {
        scenarios = request;
        visits.clear();
    }

    static boolean has(QuestionWidget widget) {
        return scenarios != null && widget instanceof IntentWidget &&
                ((IntentWidget)widget).getIntentCallout() != null;
    }

    private static Button launchButton(View view) {
        if (view instanceof Button) return (Button)view;
        if (view instanceof ViewGroup) {
            ViewGroup group = (ViewGroup)view;
            for (int i = 0; i < group.getChildCount(); i++) {
                Button found = launchButton(group.getChildAt(i));
                if (found != null) return found;
            }
        }
        return null;
    }

    private static Intent result(Activity activity, JSONObject command) throws Exception {
        if (command.optBoolean("invalid")) return null;
        Intent result = new Intent();
        if (command.has("primary")) {
            String primary = command.isNull("primary") ? null : command.getString("primary");
            result.putExtra(IntentCallout.INTENT_RESULT_VALUE, primary);
        }
        JSONObject values = command.optJSONObject("named");
        Bundle named = new Bundle();
        if (values != null) {
            for (Iterator<String> it = values.keys(); it.hasNext();) {
                String key = it.next();
                if (values.isNull(key)) named.putString(key, null);
                else if (values.optJSONObject(key) != null) {
                    File file = new File(activity.getCacheDir(), "synthetic-meter-reading.txt");
                    String content = values.getJSONObject(key).getString("file");
                    Files.write(file.toPath(), content.getBytes(StandardCharsets.UTF_8));
                    named.putString(key, file.getAbsolutePath());
                } else named.putString(key, values.getString(key));
            }
        }
        if (command.optBoolean("bundle")) result.putExtra(IntentCallout.INTENT_RESULT_EXTRAS_BUNDLE, named);
        else result.putExtras(named);
        if (command.has("simprints")) {
            com.simprints.libsimprints.Registration registration = new com.simprints.libsimprints.Registration(command.getString("simprints"));
            registration.setTemplate(com.simprints.libsimprints.FingerIdentifier.RIGHT_THUMB, new byte[]{1});
            result.putExtra(com.simprints.libsimprints.Constants.SIMPRINTS_REGISTRATION, registration);
        }
        if (command.has("register")) {
            Map<BiometricIdentifier,byte[]> templates = new HashMap<>();
            templates.put(BiometricIdentifier.FACE, "synthetic".getBytes(StandardCharsets.UTF_8));
            result.putExtra(IdentityResponseBuilder.REGISTRATION, new RegistrationResult(command.getString("register"), templates));
        }
        if (command.has("verify")) result.putExtra(IdentityResponseBuilder.VERIFICATION, new VerificationMatch(
                command.getString("verify"), new MatchResult(80, MatchStrength.FOUR_STARS)));
        if (command.has("identify") || command.has("identifyKeys")) {
            ArrayList<IdentificationMatch> matches = new ArrayList<>();
            if (command.has("identify")) {
                matches.add(new IdentificationMatch("lower", new MatchResult(3, MatchStrength.ONE_STAR)));
                matches.add(new IdentificationMatch(command.getString("identify"), new MatchResult(95, MatchStrength.FIVE_STARS)));
            } else {
                JSONArray keys = command.getJSONArray("identifyKeys");
                for (int i = 0; i < keys.length(); i++) {
                    matches.add(new IdentificationMatch(keys.getString(i), new MatchResult(95, MatchStrength.FIVE_STARS)));
                }
            }
            result.putParcelableArrayListExtra(IdentityResponseBuilder.IDENTIFICATION, matches);
        }
        return result;
    }

    /** The synthetic external application. Read what actually reached the
     * recipient, construct the selected native parcel and finish the activity.
     * The form receives this activity's result with its original request code. */
    public static final class MeterActivity extends Activity {
        void complete(JSONObject command, JSONObject sample) throws Exception {
            Intent request = getIntent();
            sample.put("action", request.getAction());
            JSONObject sent = new JSONObject();
            Bundle extras = request.getExtras();
            if (extras != null) {
                for (String key : extras.keySet()) sent.put(key, extras.get(key));
            }
            sample.put("sent", sent);
            setResult(command.optBoolean("cancel") ? RESULT_CANCELED : RESULT_OK, result(this, command));
            finish();
        }
    }

    static boolean give(FormEntryActivity activity, QuestionWidget first, JSONObject entry) throws Exception {
        String name = first.getPrompt().getIndex().getReference().getNameLast();
        int visit = visits.getOrDefault(name, 0);
        visits.put(name, visit + 1);
        JSONArray rows = scenarios.optJSONArray(name);
        JSONArray commands = rows != null ? rows.optJSONArray(visit) : null;
        if (commands == null) return false;
        JSONArray samples = new JSONArray();
        entry.put("appReturns", samples);
        for (int i = 0; i < commands.length(); i++) {
            JSONObject command = commands.getJSONObject(i);
            IntentWidget app = null;
            for (QuestionWidget current : activity.getODKView().getWidgets()) {
                if (current instanceof IntentWidget && current.getPrompt().getIndex().equals(first.getPrompt().getIndex())) {
                    app = (IntentWidget)current;
                    break;
                }
            }
            if (app == null) throw new IllegalStateException("The invoking question moved during the return.");
            Button button = launchButton(app);
            if (button == null) throw new IllegalStateException("The Android app question has no launch button.");
            JSONObject sample = new JSONObject().put("before", Forms.data());
            sample.put("indexBefore", String.valueOf(FormEntryActivity.mFormController.getFormIndex().getReference()));
            samples.put(sample);
            ShadowActivity shadow = Shadows.shadowOf((Activity)activity);
            if (command.optBoolean("missingHandler")) {
                // Ask Robolectric to check Android's real package resolver for
                // this launch. No package handles the synthetic action.
                Shadows.shadowOf(activity.getApplication()).checkActivities(true);
                try {
                    button.performClick();
                    ShadowLooper.idleMainLooper();
                    sample.put("missingHandler", org.robolectric.shadows.ShadowToast.getTextOfLatestToast());
                    if (shadow.getNextStartedActivityForResult() != null)
                        throw new IllegalStateException("An uninstalled handler opened.");
                } finally {
                    Shadows.shadowOf(activity.getApplication()).checkActivities(false);
                }
                sample.put("after", Forms.data());
                continue;
            }
            button.performClick();
            ShadowLooper.idleMainLooper();
            ShadowActivity.IntentForResult opened = shadow.getNextStartedActivityForResult();
            if (opened == null) throw new IllegalStateException("The app question did not open its activity.");
            ActivityController<MeterActivity> provider = Robolectric.buildActivity(MeterActivity.class, new Intent(opened.intent));
            try {
                MeterActivity other = provider.setup().get();
                other.complete(command, sample);
                ShadowActivity completed = Shadows.shadowOf((Activity)other);
                if (command.optBoolean("raw")) {
                    sample.put("reportedSuccess", app.getIntentCallout().processResponse(completed.getResultIntent(),
                            app.getPrompt().getIndex().getReference(), new File(FormEntryInstanceState.getInstanceFolder())));
                    // This probe owns the raw invocation; close its suspended widget without repeating the writes.
                    shadow.receiveResult(opened.intent, Activity.RESULT_CANCELED, null);
                } else {
                    shadow.receiveResult(opened.intent, completed.getResultCode(), completed.getResultIntent());
                }
            } finally {
                provider.close();
            }
            RobolectricUtil.flushBackgroundThread(activity);
            ShadowLooper.idleMainLooper();
            sample.put("after", Forms.data());
            sample.put("indexAfter", String.valueOf(FormEntryActivity.mFormController.getFormIndex().getReference()));
            File file = new File(FormEntryInstanceState.getInstanceFolder(), "synthetic-meter-reading.txt");
            if (file.exists()) sample.put("copied", new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8));
        }
        return true;
    }
}
