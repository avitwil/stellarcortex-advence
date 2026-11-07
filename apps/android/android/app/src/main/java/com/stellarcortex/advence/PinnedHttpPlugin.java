package com.stellarcortex.advence;

// Pinned HTTPS + WebSocket for all server traffic (NFR-SEC-01, DL-016). The WebView never
// talks to the server directly. A connection is accepted only when the server's
// SubjectPublicKeyInfo SHA-256 equals the pin from the pairing QR/link. TLS 1.3 only;
// Conscrypt provides TLS 1.3 on Android 9.

import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.IOException;
import java.security.MessageDigest;
import java.security.Provider;
import java.security.cert.CertificateException;
import java.security.cert.X509Certificate;
import java.util.Collections;
import java.util.Iterator;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;
import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;
import okhttp3.Call;
import okhttp3.Callback;
import okhttp3.ConnectionSpec;
import okhttp3.Headers;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import okhttp3.TlsVersion;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import org.conscrypt.Conscrypt;

@CapacitorPlugin(name = "PinnedHttp")
public class PinnedHttpPlugin extends Plugin {
    private static final MediaType JSON = MediaType.get("application/json; charset=utf-8");
    private final Map<String, String> pins = new ConcurrentHashMap<>();
    private final Map<String, OkHttpClient> clients = new ConcurrentHashMap<>();
    private final Map<String, WebSocket> sockets = new ConcurrentHashMap<>();
    private static final Provider CONSCRYPT = Conscrypt.newProvider();

    static String spkiPin(X509Certificate cert) throws Exception {
        byte[] d = MessageDigest.getInstance("SHA-256").digest(cert.getPublicKey().getEncoded());
        return Base64.encodeToString(d, Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
    }

    static String hostOnly(String hostPort) {
        if (hostPort.startsWith("[")) return hostPort.substring(1, hostPort.indexOf(']')).toLowerCase();
        int i = hostPort.lastIndexOf(':');
        return (i > 0 ? hostPort.substring(0, i) : hostPort).toLowerCase();
    }

    @PluginMethod
    public void trust(PluginCall call) {
        String host = call.getString("host", "");
        String pin = call.getString("pin", "");
        if (!pin.matches("^[A-Za-z0-9_-]{43}$") || host.isEmpty()) {
            call.reject("invalid pin");
            return;
        }
        String h = hostOnly(host);
        String old = pins.put(h, pin);
        if (old != null && !old.equals(pin)) clients.remove(h);
        call.resolve();
    }

    private OkHttpClient clientFor(String host) throws Exception {
        final String pin = pins.get(host);
        if (pin == null) throw new IOException("untrusted_host");
        OkHttpClient c = clients.get(host);
        if (c != null) return c;
        X509TrustManager tm = new X509TrustManager() {
            @Override public void checkClientTrusted(X509Certificate[] chain, String authType) throws CertificateException { throw new CertificateException("client auth not supported"); }
            @Override public void checkServerTrusted(X509Certificate[] chain, String authType) throws CertificateException {
                try {
                    if (chain == null || chain.length == 0 || !MessageDigest.isEqual(spkiPin(chain[0]).getBytes(), pin.getBytes())) throw new CertificateException("pin_mismatch");
                } catch (CertificateException e) { throw e; } catch (Exception e) { throw new CertificateException(e); }
            }
            @Override public X509Certificate[] getAcceptedIssuers() { return new X509Certificate[0]; }
        };
        SSLContext ctx = SSLContext.getInstance("TLSv1.3", CONSCRYPT);
        ctx.init(null, new TrustManager[] { tm }, null);
        ConnectionSpec spec = new ConnectionSpec.Builder(ConnectionSpec.RESTRICTED_TLS).tlsVersions(TlsVersion.TLS_1_3).build();
        c = new OkHttpClient.Builder()
            .sslSocketFactory(ctx.getSocketFactory(), tm)
            // The pinned key is the server identity, so the hostname need not appear in the certificate.
            .hostnameVerifier((hostname, session) -> hostname.equalsIgnoreCase(host))
            .connectionSpecs(Collections.singletonList(spec))
            .followRedirects(false)
            .followSslRedirects(false)
            .pingInterval(20, TimeUnit.SECONDS)
            .callTimeout(90, TimeUnit.SECONDS)
            .build();
        clients.put(host, c);
        return c;
    }

    @PluginMethod
    public void request(PluginCall call) {
        try {
            String url = call.getString("url", "");
            if (!url.startsWith("https://")) throw new IOException("https only");
            okhttp3.HttpUrl u = okhttp3.HttpUrl.get(url);
            OkHttpClient c = clientFor(u.host().toLowerCase());
            Headers.Builder hb = new Headers.Builder();
            JSObject hs = call.getObject("headers", new JSObject());
            Iterator<String> it = hs.keys();
            while (it.hasNext()) { String k = it.next(); hb.add(k, hs.getString(k)); }
            String method = call.getString("method", "GET");
            String body = call.getString("body");
            RequestBody rb = body == null ? (method.equals("GET") ? null : RequestBody.create(new byte[0], null)) : RequestBody.create(body, JSON);
            Request req = new Request.Builder().url(u).headers(hb.build()).method(method, rb).build();
            c.newCall(req).enqueue(new Callback() {
                @Override public void onFailure(Call cl, IOException e) {
                    String m = e.getMessage() != null && e.getMessage().contains("pin_mismatch") ? "pin_mismatch" : "network_error";
                    call.reject(m);
                }
                @Override public void onResponse(Call cl, Response r) throws IOException {
                    JSObject ret = new JSObject();
                    ret.put("status", r.code());
                    ret.put("body", r.body() != null ? r.body().string() : "");
                    r.close();
                    call.resolve(ret);
                }
            });
        } catch (Exception e) {
            call.reject(e.getMessage() != null ? e.getMessage() : "error");
        }
    }

    private void emit(String id, String kind, String data, int code) {
        JSObject e = new JSObject();
        e.put("id", id);
        e.put("kind", kind);
        if (data != null) e.put("data", data);
        if (code != 0) e.put("code", code);
        notifyListeners("wsEvent", e);
    }

    @PluginMethod
    public void wsOpen(PluginCall call) {
        final String id = call.getString("id", "");
        try {
            String url = call.getString("url", "");
            if (!url.startsWith("wss://")) throw new IOException("wss only");
            okhttp3.HttpUrl u = okhttp3.HttpUrl.get(url.replaceFirst("^wss://", "https://"));
            OkHttpClient c = clientFor(u.host().toLowerCase());
            WebSocket ws = c.newWebSocket(new Request.Builder().url(u).build(), new WebSocketListener() {
                @Override public void onOpen(WebSocket w, Response r) { emit(id, "open", null, 0); }
                @Override public void onMessage(WebSocket w, String text) { emit(id, "message", text, 0); }
                @Override public void onClosing(WebSocket w, int code, String reason) { w.close(code, null); }
                @Override public void onClosed(WebSocket w, int code, String reason) { sockets.remove(id); emit(id, "close", null, code); }
                @Override public void onFailure(WebSocket w, Throwable t, Response r) { sockets.remove(id); emit(id, "close", null, 1006); }
            });
            sockets.put(id, ws);
            call.resolve();
        } catch (Exception e) {
            emit(id, "close", null, 1006);
            call.reject(e.getMessage() != null ? e.getMessage() : "error");
        }
    }

    @PluginMethod
    public void wsSend(PluginCall call) {
        WebSocket ws = sockets.get(call.getString("id", ""));
        if (ws != null) ws.send(call.getString("data", ""));
        call.resolve();
    }

    @PluginMethod
    public void wsClose(PluginCall call) {
        WebSocket ws = sockets.remove(call.getString("id", ""));
        if (ws != null) ws.close(1000, null);
        call.resolve();
    }
}
