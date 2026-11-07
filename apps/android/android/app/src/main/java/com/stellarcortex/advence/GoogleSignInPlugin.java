package com.stellarcortex.advence;

// Sign in with Google on Android (D-13, FR-GGL-02): Credential Manager with the operator's
// Web client ID as serverClientId. The ID token is sent to the server, which verifies it.

import androidx.credentials.Credential;
import androidx.credentials.CredentialManager;
import androidx.credentials.CredentialManagerCallback;
import androidx.credentials.CustomCredential;
import androidx.credentials.GetCredentialRequest;
import androidx.credentials.GetCredentialResponse;
import androidx.credentials.exceptions.GetCredentialException;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.android.libraries.identity.googleid.GetSignInWithGoogleOption;
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential;
import java.util.concurrent.Executors;

@CapacitorPlugin(name = "GoogleSignIn")
public class GoogleSignInPlugin extends Plugin {
    @PluginMethod
    public void signIn(PluginCall call) {
        String clientId = call.getString("serverClientId", "");
        if (!clientId.endsWith(".apps.googleusercontent.com")) {
            call.reject("invalid client id");
            return;
        }
        GetSignInWithGoogleOption opt = new GetSignInWithGoogleOption.Builder(clientId).build();
        GetCredentialRequest req = new GetCredentialRequest.Builder().addCredentialOption(opt).build();
        CredentialManager cm = CredentialManager.create(getContext());
        cm.getCredentialAsync(getActivity(), req, null, Executors.newSingleThreadExecutor(),
            new CredentialManagerCallback<GetCredentialResponse, GetCredentialException>() {
                @Override public void onResult(GetCredentialResponse resp) {
                    Credential c = resp.getCredential();
                    if (c instanceof CustomCredential && GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL.equals(c.getType())) {
                        JSObject ret = new JSObject();
                        ret.put("idToken", GoogleIdTokenCredential.createFrom(c.getData()).getIdToken());
                        call.resolve(ret);
                    } else call.reject("unexpected credential");
                }
                @Override public void onError(GetCredentialException e) {
                    call.reject("sign-in cancelled or failed");
                }
            });
    }
}
