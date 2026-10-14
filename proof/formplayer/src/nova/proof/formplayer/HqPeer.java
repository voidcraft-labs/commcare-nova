package nova.proof.formplayer;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicLong;

/**
 * The address Formplayer knows as CommCare HQ (commcarehq.host): a loopback
 * HTTP server that answers nothing itself.
 *
 * Every request Formplayer makes of HQ (a session's user details, an app's
 * archive, a restore, a submission, a case search, a case claim) is written to
 * the client as one protocol line and held until the client answers it, so the
 * harness answers each with HQ's own code or with the bytes it names, and
 * records every one. A request the client does not answer within the wait the
 * runner was started with is answered 504, which Formplayer reports as it
 * reports HQ timing out.
 */
final class HqPeer {
    private final Runner runner;
    private final HttpServer server;
    private final long waitMillis;
    private final AtomicLong calls = new AtomicLong();
    private final Map<Long, CompletableFuture<JSONObject>> waiting = new ConcurrentHashMap<>();

    HqPeer(Runner runner, long waitMillis) throws IOException {
        this.runner = runner;
        this.waitMillis = waitMillis;
        this.server = HttpServer.create(new InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 64);
        this.server.createContext("/", this::handle);
        this.server.setExecutor(Executors.newCachedThreadPool(task -> {
            Thread thread = new Thread(task, "proof-hq-peer");
            thread.setDaemon(true);
            return thread;
        }));
    }

    void start() {
        server.start();
    }

    String origin() {
        return "http://127.0.0.1:" + server.getAddress().getPort();
    }

    /** The client's answer to one held request. */
    void answer(long call, JSONObject answer) {
        CompletableFuture<JSONObject> held = waiting.get(call);
        if (held == null) {
            throw new RequestException("The client answered HQ request " + call + ", which the runner is not"
                    + " holding: it was answered already, or it timed out.");
        }
        held.complete(answer);
    }

    private void handle(HttpExchange exchange) throws IOException {
        long call = calls.incrementAndGet();
        byte[] status = null;
        try {
            byte[] body = exchange.getRequestBody().readAllBytes();
            JSONObject request = new JSONObject();
            request.put("method", exchange.getRequestMethod());
            request.put("path", exchange.getRequestURI().getRawPath());
            String query = exchange.getRequestURI().getRawQuery();
            request.put("query", query == null ? "" : query);
            JSONArray headers = new JSONArray();
            List<String> names = new ArrayList<>(exchange.getRequestHeaders().keySet());
            names.sort(String::compareTo);
            for (String name : names) {
                for (String value : exchange.getRequestHeaders().get(name)) {
                    headers.put(new JSONArray().put(name).put(value));
                }
            }
            request.put("headers", headers);
            request.put("bodyBase64", Base64.getEncoder().encodeToString(body));
            CompletableFuture<JSONObject> held = new CompletableFuture<>();
            waiting.put(call, held);
            runner.askHq(call, request);
            JSONObject answer;
            try {
                answer = held.get(waitMillis, TimeUnit.MILLISECONDS);
            } catch (TimeoutException e) {
                answer = new JSONObject().put("status", 504).put("bodyBase64", "");
            } catch (InterruptedException | ExecutionException e) {
                throw new IOException(e);
            } finally {
                waiting.remove(call);
            }
            byte[] answerBody = Base64.getDecoder().decode(answer.optString("bodyBase64", ""));
            JSONArray answerHeaders = answer.optJSONArray("headers");
            if (answerHeaders != null) {
                for (int i = 0; i < answerHeaders.length(); i++) {
                    JSONArray pair = answerHeaders.getJSONArray(i);
                    exchange.getResponseHeaders().add(pair.getString(0), pair.getString(1));
                }
            }
            int code = answer.getInt("status");
            boolean bodiless = code == 204 || code == 304 || (code >= 100 && code < 200);
            exchange.sendResponseHeaders(code, bodiless ? -1 : (answerBody.length == 0 ? -1 : answerBody.length));
            if (!bodiless && answerBody.length > 0) {
                try (OutputStream out = exchange.getResponseBody()) {
                    out.write(answerBody);
                }
            }
        } finally {
            exchange.close();
        }
    }
}
