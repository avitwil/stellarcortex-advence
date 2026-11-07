package com.stellarcortex.advence;

// Device key storage (NFR-SEC-02): values are encrypted with an AES-256-GCM key that lives
// in the Android Keystore and never leaves it.

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.Arrays;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

@CapacitorPlugin(name = "SecureStore")
public class SecureStorePlugin extends Plugin {
    private static final String ALIAS = "advence-secure-store";
    private static final String PREFS = "advence-secure-store";

    private SecretKey key() throws Exception {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
        ks.load(null);
        if (ks.containsAlias(ALIAS)) return ((KeyStore.SecretKeyEntry) ks.getEntry(ALIAS, null)).getSecretKey();
        KeyGenerator kg = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        kg.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .build());
        return kg.generateKey();
    }

    private SharedPreferences prefs() {
        return getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    @PluginMethod
    public void set(PluginCall call) {
        try {
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.ENCRYPT_MODE, key());
            byte[] ct = c.doFinal(call.getString("value", "").getBytes(StandardCharsets.UTF_8));
            byte[] iv = c.getIV();
            byte[] all = new byte[iv.length + ct.length];
            System.arraycopy(iv, 0, all, 0, iv.length);
            System.arraycopy(ct, 0, all, iv.length, ct.length);
            prefs().edit().putString(call.getString("key", ""), Base64.encodeToString(all, Base64.NO_WRAP)).apply();
            call.resolve();
        } catch (Exception e) {
            call.reject("secure store failed");
        }
    }

    @PluginMethod
    public void get(PluginCall call) {
        JSObject ret = new JSObject();
        try {
            String v = prefs().getString(call.getString("key", ""), null);
            if (v != null) {
                byte[] all = Base64.decode(v, Base64.NO_WRAP);
                Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
                c.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, Arrays.copyOfRange(all, 0, 12)));
                ret.put("value", new String(c.doFinal(Arrays.copyOfRange(all, 12, all.length)), StandardCharsets.UTF_8));
            }
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("secure store failed");
        }
    }

    @PluginMethod
    public void remove(PluginCall call) {
        prefs().edit().remove(call.getString("key", "")).apply();
        call.resolve();
    }
}
