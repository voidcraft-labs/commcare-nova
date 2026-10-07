package nova.proof.android;

import androidx.test.ext.junit.runners.AndroidJUnit4;

import org.commcare.CommCareApplication;
import org.commcare.CommCareTestApplication;
import org.commcare.engine.resource.AppInstallStatus;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.annotation.Config;

import java.io.File;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;

/**
 * The Android reader: one request, answered by commcare-android's own classes on a fresh device.
 *
 * It is a JUnit class because that is how Robolectric gives a test a device: its runner builds the application
 * (CommCareTestApplication, as the project's own tests name it) in a sandbox for the one test method, and tears
 * it down after. The request is the JSON file the system property {@code nova.proof.android.request} names, and
 * the answer is written to the file {@code nova.proof.android.response} names: {@code {"ok": <what Android
 * read>}}, or {@code {"error": {...}}} with what was raised. The test itself always passes, so a caller reads
 * the answer rather than the runner's verdict, and an answer that was never written is the harness's failure.
 *
 * Requests ({@code op}):
 * <ul>
 * <li>{@code profile}: install {@code archive}; the install status, and what each profile reader gives.</li>
 * <li>{@code installs}: install each of {@code archives} in turn on one device; each status and the apps the
 * device then holds.</li>
 * <li>{@code app}: install {@code archive}, apply {@code restore}, and read the screens {@code screens} names
 * (Screens).</li>
 * <li>{@code update}: install {@code archive}, then update the device to {@code update} (Updates).</li>
 * </ul>
 */
@Config(application = CommCareTestApplication.class)
@RunWith(AndroidJUnit4.class)
public class Reader {
    static final String REQUEST = "nova.proof.android.request";
    static final String RESPONSE = "nova.proof.android.response";

    @Test
    public void read() throws Exception {
        ((CommCareTestApplication)CommCareApplication.instance()).initWorkManager();
        JSONObject response = new JSONObject();
        try {
            ProofClock.requireInstalled();
            JSONObject request = new JSONObject(text(System.getProperty(REQUEST)));
            response.put("ok", answer(request));
        } catch (Throwable raised) {
            response.put("error", raised(raised));
        }
        Files.write(new File(System.getProperty(RESPONSE)).toPath(),
                response.toString().getBytes(StandardCharsets.UTF_8));
    }

    private static JSONObject answer(JSONObject request) throws Exception {
        String op = request.getString("op");
        switch (op) {
            case "profile":
                return profile(request);
            case "installs":
                return installs(request);
            case "app":
                return Screens.read(request);
            case "update":
                return Updates.read(request);
            default:
                throw new IllegalArgumentException("The Android reader has no request named " + op + ".");
        }
    }

    private static JSONObject profile(JSONObject request) throws Exception {
        JSONObject found = new JSONObject();
        AppInstallStatus status = Device.install(request.getString("archive"));
        found.put("install", String.valueOf(status));
        if (status == AppInstallStatus.Installed) {
            // Before any worker logs in: what the install alone left.
            found.put("areMMResourcesValidatedAfterInstall",
                    CommCareApplication.instance().getCurrentApp().areMMResourcesValidated());
            Device.login();
            found.put("profile", Profile.read());
        }
        return found;
    }

    private static JSONObject installs(JSONObject request) throws Exception {
        JSONArray archives = request.getJSONArray("archives");
        JSONArray statuses = new JSONArray();
        for (int i = 0; i < archives.length(); i++) {
            JSONObject step = new JSONObject();
            step.put("install", String.valueOf(Device.install(archives.getString(i))));
            step.put("installedApps", Profile.installed());
            statuses.put(step);
        }
        JSONObject found = new JSONObject();
        found.put("installs", statuses);
        return found;
    }

    static String text(String path) throws Exception {
        return new String(Files.readAllBytes(new File(path).toPath()), StandardCharsets.UTF_8);
    }

    static JSONObject raised(Throwable raised) throws Exception {
        StringWriter stack = new StringWriter();
        raised.printStackTrace(new PrintWriter(stack));
        JSONObject found = new JSONObject();
        found.put("class", raised.getClass().getName());
        found.put("message", String.valueOf(raised.getMessage()));
        found.put("stack", stack.toString());
        return found;
    }
}
