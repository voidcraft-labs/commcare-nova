package nova.proof.core;

import com.google.common.collect.Multimap;

import org.commcare.core.interfaces.UserSandbox;
import org.commcare.core.process.CommCareInstanceInitializer;
import org.commcare.core.parse.ParseUtils;
import org.commcare.modern.session.SessionWrapper;
import org.commcare.suite.model.PostRequest;
import org.commcare.util.CommCarePlatform;
import org.commcare.util.screen.SessionUtils;
import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.io.PrintStream;
import java.net.URL;
import java.util.ArrayList;
import java.util.List;

/**
 * Core's network seam for Web Apps' screens (util/screen/SessionUtils), answered
 * from the session's own case data instead of HQ.
 *
 * - A case search (QueryScreen) is answered with every case of the requested case
 *   types (the request's case_type values) from the case data as it stands. The
 *   runner does not evaluate the search's filters: what they mean is HQ's
 *   compiler's business.
 * - A post (SyncScreen: the case claim) is recorded and answered 201, which is
 *   what makes Core follow it with a sync.
 * - A sync (restoreUserToSandbox) is answered with the same restore the session
 *   started from, and recorded.
 *
 * Each call is appended to the events of the screen that made it.
 */
final class ProofSessionUtils extends SessionUtils {
    private final byte[] restore;
    private final UserSandbox sandbox;
    private JSONArray events = new JSONArray();

    ProofSessionUtils(byte[] restore, UserSandbox sandbox) {
        this.restore = restore;
        this.sandbox = sandbox;
    }

    /** Starts a fresh event list for the next screen and returns the previous one. */
    JSONArray takeEvents() {
        JSONArray taken = events;
        events = new JSONArray();
        return taken;
    }

    @Override
    public InputStream makeQueryRequest(URL url, Multimap<String, String> requestData, String username,
                                        String password) {
        JSONObject event = new JSONObject();
        event.put("kind", "search");
        event.put("url", url == null ? JSONObject.NULL : url.toString());
        event.put("params", params(requestData));
        List<String> caseTypes = new ArrayList<>(requestData.get("case_type"));
        event.put("caseTypes", new JSONArray(caseTypes));
        try {
            String caseDb = CaseData.caseDb(new CommCareInstanceInitializer(sandbox));
            byte[] results = CaseData.searchResults(caseDb, caseTypes);
            event.put("answered", CaseData.countCases(results));
            events.put(event);
            return new ByteArrayInputStream(results);
        } catch (Exception e) {
            event.put("error", e.getClass().getName() + ": " + e.getMessage());
            events.put(event);
            return null;
        }
    }

    @Override
    public int doPostRequest(PostRequest syncPost, SessionWrapper session, String username, String password,
                             PrintStream printStream) {
        JSONObject event = new JSONObject();
        event.put("kind", "post");
        event.put("url", syncPost.getUrl() == null ? JSONObject.NULL : syncPost.getUrl().toString());
        event.put("params", params(syncPost.getEvaluatedParams(session.getEvaluationContext(), false)));
        event.put("status", 201);
        events.put(event);
        return 201;
    }

    @Override
    public void restoreUserToSandbox(UserSandbox sandbox, SessionWrapper session, CommCarePlatform platform,
                                     String username, String password, PrintStream printStream) {
        JSONObject event = new JSONObject();
        event.put("kind", "sync");
        try {
            ParseUtils.parseIntoSandbox(new ByteArrayInputStream(restore), sandbox, false);
            CaseData.logInFirstUser(sandbox);
            event.put("restored", true);
        } catch (Exception e) {
            event.put("restored", false);
            event.put("error", e.getClass().getName() + ": " + e.getMessage());
        }
        events.put(event);
        if (session != null) {
            session.clearVolatiles();
        }
    }

    static JSONObject params(Multimap<String, String> params) {
        JSONObject out = new JSONObject();
        List<String> keys = new ArrayList<>(params.keySet());
        keys.sort(String::compareTo);
        for (String key : keys) {
            out.put(key, new JSONArray(new ArrayList<>(params.get(key))));
        }
        return out;
    }
}
