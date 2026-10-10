package nova.proof.android;

import android.content.Context;

import com.google.common.collect.Multimap;

import org.commcare.CommCareApplication;
import org.commcare.CommCareTestApplication;
import org.commcare.core.interfaces.HttpResponseProcessor;
import org.commcare.core.network.AuthInfo;
import org.commcare.core.network.HTTPMethod;
import org.commcare.core.network.ModernHttpRequester;
import org.commcare.android.database.app.models.UserKeyRecord;
import org.commcare.heartbeat.HeartbeatRequester;
import org.commcare.network.DataPullRequester;

import java.lang.invoke.MethodHandle;
import java.lang.invoke.MethodHandles;
import java.lang.invoke.MethodType;
import java.util.HashMap;
import java.util.List;

import okhttp3.MultipartBody;
import okhttp3.RequestBody;

/**
 * The project's own test application (CommCareTestApplication), with the app's own network where the device
 * has one (Peer).
 *
 * The test application answers every request the app makes from its own mocks (ModernHttpRequesterMock, and a
 * data pull read from a local reference). Where the reader is given a network, the app's own requester and data
 * pull run instead: each is CommCareApplication's own method, called on this application as CommCareApplication
 * would call it. The call is an invokespecial of CommCareApplication's method made from CommCareTestApplication
 * (whose superclass it is): made from this class, the JVM would select the method from this class's own
 * superclass, which is the test application's mock. So no line of the app's methods is copied here. Without a
 * network the test application's mocks answer, as in the project's own tests.
 */
public class ProofApplication extends CommCareTestApplication {
    private static final MethodHandle BUILD_HTTP_REQUESTER;
    private static final MethodHandle GET_DATA_PULL_REQUESTER;
    private static final MethodHandle GET_HEARTBEAT_REQUESTER;

    static {
        try {
            MethodHandles.Lookup lookup =
                    MethodHandles.privateLookupIn(CommCareTestApplication.class, MethodHandles.lookup());
            BUILD_HTTP_REQUESTER = lookup.findSpecial(CommCareApplication.class, "buildHttpRequester",
                    MethodType.methodType(ModernHttpRequester.class, Context.class, String.class, Multimap.class,
                            HashMap.class, RequestBody.class, List.class, HTTPMethod.class, AuthInfo.class,
                            HttpResponseProcessor.class, boolean.class),
                    CommCareTestApplication.class);
            GET_DATA_PULL_REQUESTER = lookup.findSpecial(CommCareApplication.class, "getDataPullRequester",
                    MethodType.methodType(DataPullRequester.class), CommCareTestApplication.class);
            GET_HEARTBEAT_REQUESTER = lookup.findSpecial(CommCareApplication.class, "getHeartbeatRequester",
                    MethodType.methodType(HeartbeatRequester.class), CommCareTestApplication.class);
        } catch (ReflectiveOperationException absent) {
            throw new ExceptionInInitializerError(absent);
        }
    }

    /**
     * The app's own HTTP configuration (applied as the application starts and as each app is seated: its
     * certificate transparency setting and, on this SDK, its own root certificate), then the network's proxy.
     */
    @Override
    public void customiseOkHttp() {
        super.customiseOkHttp();
        if (Peer.on()) {
            Peer.route();
        }
    }

    @Override
    public ModernHttpRequester buildHttpRequester(Context context, String url, Multimap<String, String> params,
                                                  HashMap headers, RequestBody requestBody,
                                                  List<MultipartBody.Part> parts, HTTPMethod method,
                                                  AuthInfo authInfo, HttpResponseProcessor responseProcessor,
                                                  boolean retry) {
        if (!Peer.on()) {
            return super.buildHttpRequester(context, url, params, headers, requestBody, parts, method, authInfo,
                    responseProcessor, retry);
        }
        try {
            return (ModernHttpRequester)BUILD_HTTP_REQUESTER.invoke(this, context, url, params, headers,
                    requestBody, parts, method, authInfo, responseProcessor, retry);
        } catch (RuntimeException | Error raised) {
            throw raised;
        } catch (Throwable raised) {
            throw new IllegalStateException(raised);
        }
    }

    @Override
    public DataPullRequester getDataPullRequester() {
        if (!Peer.on()) {
            return super.getDataPullRequester();
        }
        try {
            return (DataPullRequester)GET_DATA_PULL_REQUESTER.invoke(this);
        } catch (RuntimeException | Error raised) {
            throw raised;
        } catch (Throwable raised) {
            throw new IllegalStateException(raised);
        }
    }

    @Override
    public HeartbeatRequester getHeartbeatRequester() {
        if (!Peer.on()) {
            return super.getHeartbeatRequester();
        }
        try {
            return (HeartbeatRequester)GET_HEARTBEAT_REQUESTER.invoke(this);
        } catch (RuntimeException | Error raised) {
            throw raised;
        } catch (Throwable raised) {
            throw new IllegalStateException(raised);
        }
    }

    /**
     * The test application starts a worker's session by building the session's service itself, Robolectric
     * running no services (CommCareTestApplication.startUserSession, through Robolectric's ServiceController),
     * which Robolectric allows only on the main thread, where Android itself creates a service. The app's own
     * sign-in starts the session from its key record task's background thread (ManageKeyRecordTask
     * .doPostCalloutTask), so the test application's start is run on the main thread, as a service's creation
     * is, and the task waits for it as it waits for the service it binds.
     */
    @Override
    public void startUserSession(byte[] symmetricKey, UserKeyRecord record, boolean restoreSession) {
        if (android.os.Looper.myLooper() == android.os.Looper.getMainLooper()) {
            super.startUserSession(symmetricKey, record, restoreSession);
            return;
        }
        java.util.concurrent.FutureTask<Void> started = new java.util.concurrent.FutureTask<>(() -> {
            ProofApplication.super.startUserSession(symmetricKey, record, restoreSession);
            return null;
        });
        new android.os.Handler(android.os.Looper.getMainLooper()).post(started);
        try {
            started.get();
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("The worker's session did not start: the wait was interrupted.");
        } catch (java.util.concurrent.ExecutionException raised) {
            Throwable cause = raised.getCause();
            if (cause instanceof RuntimeException) {
                throw (RuntimeException)cause;
            }
            throw new IllegalStateException("The worker's session did not start.", cause);
        }
    }
}
