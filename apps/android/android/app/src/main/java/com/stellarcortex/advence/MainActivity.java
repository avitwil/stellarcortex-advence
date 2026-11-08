package com.stellarcortex.advence;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(PinnedHttpPlugin.class);
        registerPlugin(SecureStorePlugin.class);
        registerPlugin(GoogleSignInPlugin.class);
        registerPlugin(PushPlugin.class);
        registerPlugin(AppUpdatePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
