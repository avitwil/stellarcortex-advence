package com.stellarcortex.advence;

// App updates (D-24, FR-CLI-05). The app reads the signed release manifest from the update feed
// fixed at build time; the UI checks its Ed25519 signature against the release key pinned in
// this build (NFR-SEC-10). This plugin then downloads the APK it names, checks the SHA-256 and
// size here in native code, and only then hands it to the system installer, which also requires
// the same signing certificate as the installed app.

import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.util.Base64;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.security.MessageDigest;
import java.util.Collections;
import java.util.concurrent.TimeUnit;
import java.util.regex.Pattern;
import okhttp3.ConnectionSpec;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;

@CapacitorPlugin(name = "AppUpdate")
public class AppUpdatePlugin extends Plugin {
    private static final Pattern NAME = Pattern.compile("^[A-Za-z0-9._-]{1,200}\\.apk$");
    private static final Pattern HEX64 = Pattern.compile("^[0-9a-f]{64}$");
    private static final long MAX_SMALL = 256 * 1024;
    private static final long MAX_APK = 512L * 1024 * 1024;
    private final OkHttpClient http = new OkHttpClient.Builder()
        .connectionSpecs(Collections.singletonList(ConnectionSpec.MODERN_TLS))
        .followRedirects(false)
        .followSslRedirects(false)
        .callTimeout(10, TimeUnit.MINUTES)
        .build();

    private static String feed() {
        return BuildConfig.ADVENCE_FEED_URL.replaceAll("/+$", "");
    }

    @PluginMethod
    public void info(PluginCall call) {
        JSObject r = new JSObject();
        r.put("feedUrl", feed());
        r.put("releaseKeys", BuildConfig.ADVENCE_RELEASE_KEYS);
        r.put("versionCode", BuildConfig.VERSION_CODE);
        r.put("versionName", BuildConfig.VERSION_NAME);
        call.resolve(r);
    }

    /** Fetches manifest.json or manifest.json.sig from this build's feed only. */
    @PluginMethod
    public void fetchManifest(PluginCall call) {
        String which = call.getString("file", "");
        if (!feed().startsWith("https://") || !("manifest.json".equals(which) || "manifest.json.sig".equals(which))) {
            call.reject("not allowed");
            return;
        }
        execute(() -> {
            try (Response res = http.newCall(new Request.Builder().url(feed() + "/android/" + which).build()).execute()) {
                if (!res.isSuccessful() || res.body() == null) throw new Exception("feed returned " + res.code());
                byte[] b = readLimited(res.body().byteStream(), MAX_SMALL);
                JSObject r = new JSObject();
                r.put("base64", Base64.encodeToString(b, Base64.NO_WRAP));
                call.resolve(r);
            } catch (Exception e) {
                call.reject(e.getMessage());
            }
        });
    }

    /** Downloads the APK named in the verified manifest, checks hash and size, then opens the installer. */
    @PluginMethod
    public void install(PluginCall call) {
        String name = call.getString("name", "");
        String sha256 = call.getString("sha256", "");
        Long size = call.getLong("size");
        if (!feed().startsWith("https://") || !NAME.matcher(name).matches() || !HEX64.matcher(sha256).matches() || size == null || size < 1 || size > MAX_APK) {
            call.reject("invalid update");
            return;
        }
        if (Build.VERSION.SDK_INT >= 26 && !getContext().getPackageManager().canRequestPackageInstalls()) {
            Intent s = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + getContext().getPackageName()));
            s.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(s);
            call.reject("install permission needed", "permission_needed");
            return;
        }
        execute(() -> {
            File dir = new File(getContext().getCacheDir(), "updates");
            File out = new File(dir, name);
            try {
                dir.mkdirs();
                for (File old : dir.listFiles() == null ? new File[0] : dir.listFiles()) old.delete();
                MessageDigest md = MessageDigest.getInstance("SHA-256");
                long total = 0;
                try (Response res = http.newCall(new Request.Builder().url(feed() + "/android/" + Uri.encode(name)).build()).execute()) {
                    if (!res.isSuccessful() || res.body() == null) throw new Exception("feed returned " + res.code());
                    try (InputStream in = res.body().byteStream(); OutputStream os = new FileOutputStream(out)) {
                        byte[] buf = new byte[64 * 1024];
                        int n;
                        while ((n = in.read(buf)) > 0) {
                            total += n;
                            if (total > size) throw new Exception("download is larger than the signed size");
                            md.update(buf, 0, n);
                            os.write(buf, 0, n);
                        }
                    }
                }
                StringBuilder hex = new StringBuilder();
                for (byte b : md.digest()) hex.append(String.format("%02x", b));
                if (total != size || !hex.toString().equals(sha256)) throw new Exception("the APK does not match the signed release");
                Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", out);
                Intent i = new Intent(Intent.ACTION_VIEW);
                i.setDataAndType(uri, "application/vnd.android.package-archive");
                i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(i);
                call.resolve();
            } catch (Exception e) {
                out.delete();
                call.reject(e.getMessage(), "bad_hash");
            }
        });
    }

    private static byte[] readLimited(InputStream in, long max) throws Exception {
        java.io.ByteArrayOutputStream bo = new java.io.ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0) {
            if (bo.size() + n > max) throw new Exception("response too large");
            bo.write(buf, 0, n);
        }
        return bo.toByteArray();
    }
}
