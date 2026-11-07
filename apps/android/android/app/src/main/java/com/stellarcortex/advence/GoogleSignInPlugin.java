package com.stellarcortex.advence;

// Sign in with Google on Android (D-13, FR-GGL-02): Credential Manager with the operator's
// Web client ID as serverClientId. The ID token is sent to the server, which verifies it.
// Google services (FR-GGL-04): Google's authorization client asks for the service scopes in one
// consent and returns a server auth code, which the server exchanges for a refresh token.

import android.app.Activity;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.IntentSenderRequest;
import androidx.activity.result.contract.ActivityResultContracts;
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
import com.google.android.gms.auth.api.identity.AuthorizationRequest;
import com.google.android.gms.auth.api.identity.AuthorizationResult;
import com.google.android.gms.auth.api.identity.Identity;
import com.google.android.gms.common.api.Scope;
import com.google.android.libraries.identity.googleid.GetSignInWithGoogleOption;
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.Executors;
import org.json.JSONArray;

@CapacitorPlugin(name = "GoogleSignIn")
public class GoogleSignInPlugin extends Plugin {
    private ActivityResultLauncher<IntentSenderRequest> consent;
    private PluginCall pendingAuthorize;

    @Override
    public void load() {
        // Registered while the activity is being created, as the Activity Result API requires.
        consent = getActivity().registerForActivityResult(new ActivityResultContracts.StartIntentSenderForResult(), res -> {
            PluginCall call = pendingAuthorize;
            pendingAuthorize = null;
            if (call == null) return;
            if (res.getResultCode() != Activity.RESULT_OK || res.getData() == null) {
                call.reject("consent cancelled");
                return;
            }
            try {
                AuthorizationResult r = Identity.getAuthorizationClient(getActivity()).getAuthorizationResultFromIntent(res.getData());
                resolveCode(call, r);
            } catch (Exception e) {
                call.reject("consent failed");
            }
        });
    }

    private static void resolveCode(PluginCall call, AuthorizationResult r) {
        String code = r.getServerAuthCode();
        if (code == null) {
            call.reject("no server auth code");
            return;
        }
        JSObject ret = new JSObject();
        ret.put("serverAuthCode", code);
        call.resolve(ret);
    }

    @PluginMethod
    public void authorize(PluginCall call) {
        String clientId = call.getString("serverClientId", "");
        if (!clientId.endsWith(".apps.googleusercontent.com")) {
            call.reject("invalid client id");
            return;
        }
        List<Scope> scopes = new ArrayList<>();
        try {
            JSONArray a = call.getArray("scopes");
            for (int i = 0; i < a.length(); i++) {
                String sc = a.getString(i);
                if (!sc.startsWith("https://www.googleapis.com/auth/") && !sc.equals("openid") && !sc.equals("email")) {
                    call.reject("unexpected scope");
                    return;
                }
                scopes.add(new Scope(sc));
            }
        } catch (Exception e) {
            call.reject("invalid scopes");
            return;
        }
        // forceCodeForRefreshToken: Google issues a refresh token with the code.
        AuthorizationRequest req = AuthorizationRequest.builder().setRequestedScopes(scopes).requestOfflineAccess(clientId, true).build();
        Identity.getAuthorizationClient(getActivity()).authorize(req)
            .addOnSuccessListener(r -> {
                if (r.hasResolution() && r.getPendingIntent() != null) {
                    pendingAuthorize = call;
                    consent.launch(new IntentSenderRequest.Builder(r.getPendingIntent().getIntentSender()).build());
                } else resolveCode(call, r);
            })
            .addOnFailureListener(e -> call.reject("authorization failed"));
    }

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
