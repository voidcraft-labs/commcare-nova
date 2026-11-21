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
import java.util.Base64;
import java.util.List;

/**
 * Core's network seam for Web Apps' screens (util/screen/SessionUtils).
 *
 * - A case search (QueryScreen) of a session whose request names
 *   "searchAnswers" is answered by the client (Runner.ask, callback "search",
 *   question {"url", "params"}): the status and the bytes HQ's own search view
 *   answered for those parameters (proof/observe/sessions.py::HqSearches), which
 *   Core reads whatever the status, as its own SessionUtils.makeQueryRequest
 *   hands Core the body of every answer. Without "searchAnswers" it is answered
 *   with every case of the requested case types (the request's case_type
 *   values) from the case data as it stands, and none of the search's filters
 *   is applied, so a search there finds what HQ's would not. Proofs 3 and 4
 *   name "searchAnswers"; the sessions that do not are the Core package's own
 *   tests and the Connect proofs' (proof/connect/conftest.py::_Paths), which
 *   refuse a session that sends a search.
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
    /** Whether the client answers each search with HQ's own answer (the request's "searchAnswers"). */
    private final boolean clientAnswers;
    private JSONArray events = new JSONArray();

    ProofSessionUtils(byte[] restore, UserSandbox sandbox, boolean clientAnswers) {
        this.restore = restore;
        this.sandbox = sandbox;
        this.clientAnswers = clientAnswers;
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
        if (clientAnswers) {
            return answeredByClient(event, url, requestData);
        }
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

    /**
     * HQ's answer to the search, as the client gives it: its status, and the body Core reads, whose cases are
     * counted where it is HQ's results document (an answer HQ refused is text). A question the client cannot
     * answer fails the request (Runner.ask), never a search answered by anything else.
     */
    private InputStream answeredByClient(JSONObject event, URL url, Multimap<String, String> requestData) {
        JSONObject question = new JSONObject();
        question.put("url", url == null ? JSONObject.NULL : url.toString());
        question.put("params", params(requestData));
        JSONObject answer = Runner.ask("search", question);
        int status = answer.getInt("status");
        byte[] body = Base64.getDecoder().decode(answer.getString("bodyBase64"));
        event.put("status", status);
        try {
            event.put("answered", CaseData.countCases(body));
        } catch (Exception e) {
            event.put("answered", JSONObject.NULL);
        }
        events.put(event);
        return new ByteArrayInputStream(body);
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
