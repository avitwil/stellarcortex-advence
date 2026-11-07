package com.stellarcortex.advence;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import org.unifiedpush.android.connector.FailedReason;
import org.unifiedpush.android.connector.PushService;
import org.unifiedpush.android.connector.data.PushEndpoint;
import org.unifiedpush.android.connector.data.PushMessage;

/**
 * UnifiedPush receiver (D-18). The server only sends "wake up + id", never content, so the
 * notification says that a Bot replied and opening it shows the chat.
 */
public class AdvencePushService extends PushService {
    static final String PREFS = "advence.push";
    static final String CHANNEL = "bot-replies";

    interface EndpointListener {
        void onEndpoint(String url);
        void onFailed(String reason);
    }

    static volatile EndpointListener listener;

    @Override
    public void onNewEndpoint(@NonNull PushEndpoint endpoint, @NonNull String instance) {
        getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString("endpoint", endpoint.getUrl()).apply();
        EndpointListener l = listener;
        if (l != null) l.onEndpoint(endpoint.getUrl());
    }

    @Override
    public void onMessage(@NonNull PushMessage message, @NonNull String instance) {
        showNotification(this);
    }

    @Override
    public void onRegistrationFailed(@NonNull FailedReason reason, @NonNull String instance) {
        EndpointListener l = listener;
        if (l != null) l.onFailed(reason.name());
    }

    @Override
    public void onUnregistered(@NonNull String instance) {
        getSharedPreferences(PREFS, MODE_PRIVATE).edit().remove("endpoint").apply();
    }

    static String savedEndpoint(Context c) {
        SharedPreferences p = c.getSharedPreferences(PREFS, MODE_PRIVATE);
        return p.getString("endpoint", null);
    }

    static void showNotification(Context c) {
        NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 26 && nm.getNotificationChannel(CHANNEL) == null) {
            nm.createNotificationChannel(new NotificationChannel(CHANNEL, c.getString(R.string.push_channel), NotificationManager.IMPORTANCE_DEFAULT));
        }
        Intent open = new Intent(c, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pi = PendingIntent.getActivity(c, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        NotificationCompat.Builder b = new NotificationCompat.Builder(c, CHANNEL)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(c.getString(R.string.app_name))
            .setContentText(c.getString(R.string.push_new_reply))
            .setContentIntent(pi)
            .setAutoCancel(true)
            .setOnlyAlertOnce(true)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE);
        try {
            NotificationManagerCompat.from(c).notify(1, b.build());
        } catch (SecurityException e) {
            // Notifications not permitted (Android 13+ permission denied): nothing to show.
        }
    }
}
