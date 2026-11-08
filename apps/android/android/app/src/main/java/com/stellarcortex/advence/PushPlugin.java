package com.stellarcortex.advence;

import android.Manifest;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.net.URI;
import java.util.List;
import org.unifiedpush.android.connector.UnifiedPush;

/**
 * Registers this device with the user's UnifiedPush distributor (the ntfy app, D-18) and
 * returns the endpoint for the server. Only an endpoint on the configured push server is
 * handed back; the server checks the same.
 */
@CapacitorPlugin(
    name = "Push",
    permissions = { @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS }) }
)
public class PushPlugin extends Plugin {
    private static final long TIMEOUT_MS = 30_000;

    @PluginMethod
    public void register(PluginCall call) {
        if (Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") != PermissionState.GRANTED) {
            requestPermissionForAlias("notifications", call, "afterPermission");
            return;
        }
        doRegister(call);
    }

    @PermissionCallback
    private void afterPermission(PluginCall call) {
        doRegister(call);
    }

    private void doRegister(PluginCall call) {
        String server = call.getString("pushServer");
        if (server == null) {
            call.reject("push server missing", "invalid_request");
            return;
        }
        List<String> distributors = UnifiedPush.getDistributors(getContext());
        if (distributors.isEmpty()) {
            call.reject("no UnifiedPush distributor installed", "no_distributor");
            return;
        }
        Handler main = new Handler(Looper.getMainLooper());
        final boolean[] done = { false };
        Runnable timeout = () -> {
            if (done[0]) return;
            done[0] = true;
            AdvencePushService.listener = null;
            call.reject("the push app did not answer", "push_timeout");
        };
        AdvencePushService.listener = new AdvencePushService.EndpointListener() {
            @Override
            public void onEndpoint(String url) {
                main.post(() -> {
                    if (done[0]) return;
                    done[0] = true;
                    main.removeCallbacks(timeout);
                    AdvencePushService.listener = null;
                    if (!sameOrigin(url, server)) {
                        call.reject("the push app uses another server", "endpoint_not_on_push_server");
                        return;
                    }
                    JSObject r = new JSObject();
                    r.put("endpoint", url);
                    call.resolve(r);
                });
            }

            @Override
            public void onFailed(String reason) {
                main.post(() -> {
                    if (done[0]) return;
                    done[0] = true;
                    main.removeCallbacks(timeout);
                    AdvencePushService.listener = null;
                    call.reject("registration failed: " + reason, "push_failed");
                });
            }
        };
        main.postDelayed(timeout, TIMEOUT_MS);
        UnifiedPush.tryUseCurrentOrDefaultDistributor(getActivity(), ok -> {
            if (!ok) {
                // No default chosen: use the only (or first) installed distributor.
                UnifiedPush.saveDistributor(getContext(), distributors.get(0));
            }
            UnifiedPush.register(getContext(), "default", getContext().getString(R.string.app_name), null);
            return kotlin.Unit.INSTANCE;
        });
    }

    static boolean sameOrigin(String a, String b) {
        try {
            URI x = new URI(a);
            URI y = new URI(b);
            return x.getScheme().equalsIgnoreCase(y.getScheme()) && x.getHost().equalsIgnoreCase(y.getHost()) && port(x) == port(y);
        } catch (Exception e) {
            return false;
        }
    }

    private static int port(URI u) {
        if (u.getPort() != -1) return u.getPort();
        return "https".equalsIgnoreCase(u.getScheme()) ? 443 : 80;
    }
}
