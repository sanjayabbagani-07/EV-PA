package com.growthos.jarvis;

import android.content.Context;
import android.os.Build;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

final class DeviceControlClient {
    interface EventSink {
        void emit(String event, String payload);
    }

    private final String backendUrl;
    private final Context context;
    private final EventSink sink;
    private final DeviceCredentialStore credentials;
    private final ExecutorService requests = Executors.newSingleThreadExecutor();
    private final AtomicBoolean pairingInFlight = new AtomicBoolean();
    private final AtomicBoolean statusInFlight = new AtomicBoolean();
    private final AtomicBoolean commandInFlight = new AtomicBoolean();

    DeviceControlClient(Context context, EventSink sink) {
        this.sink = sink;
        this.context = context.getApplicationContext();
        this.credentials = new DeviceCredentialStore(context);
        try {
            java.net.URI configured = new java.net.URI(BuildConfig.JARVIS_BACKEND_URL.trim());
            if (!"https".equalsIgnoreCase(configured.getScheme()) || configured.getHost() == null ||
                    configured.getRawUserInfo() != null || configured.getRawQuery() != null ||
                    configured.getRawFragment() != null ||
                    (configured.getRawPath() != null && !configured.getRawPath().isEmpty() && !"/".equals(configured.getRawPath()))) {
                throw new IllegalArgumentException("EV backend URL must be an HTTPS origin without credentials or a path.");
            }
            this.backendUrl = configured.toString().replaceAll("/+$", "");
        } catch (java.net.URISyntaxException error) {
            throw new IllegalArgumentException("EV backend URL is invalid.", error);
        }
    }

    void pair(String code) {
        if (code == null || !code.matches("[a-f0-9]{48}")) {
            emit("ev-android-pairing", result(false, "Enter a valid one-time EV pairing code."));
            return;
        }
        if (!pairingInFlight.compareAndSet(false, true)) {
            emit("ev-android-pairing", result(false, "An Android pairing request is already in progress."));
            return;
        }
        requests.execute(() -> {
            try {
                if (credentials.read() != null) {
                    emit("ev-android-pairing", result(false, "Disconnect this Android device before pairing it again."));
                    return;
                }
                JSONObject body = new JSONObject();
                body.put("code", code);
                body.put("name", deviceName());
                body.put("platform", "android");
                JSONObject response = request("POST", "/api/agent/device/pair", body, null);
                String token = response.optString("deviceToken", "");
                JSONObject device = response.optJSONObject("device");
                String deviceId = response.optString("deviceId", "");
                if (!token.matches("[a-f0-9]{64}") || device == null ||
                        !deviceId.matches("[0-9a-f-]{36}") || !deviceId.equals(device.optString("id")) ||
                        !"android".equals(device.optString("platform"))) {
                    emit("ev-android-pairing", result(false, "EV returned an invalid device credential."));
                    return;
                }
                credentials.save(token);
                JSONObject payload = new JSONObject();
                payload.put("ok", true);
                payload.put("device", device);
                emit("ev-android-pairing", payload.toString());
            } catch (Exception error) {
                emit("ev-android-pairing", result(false, safeMessage(error)));
            } finally {
                pairingInFlight.set(false);
            }
        });
    }

    void refreshStatus() {
        if (!statusInFlight.compareAndSet(false, true)) return;
        requests.execute(() -> {
            try {
                String token = credentials.read();
                if (token == null) {
                    emit("ev-android-device-status", noDeviceResult());
                    return;
                }
                JSONObject capabilities = new JSONObject();
                capabilities.put("accessibilityEnabled", EVAccessibilityService.isEnabled(context));
                capabilities.put("appDiscoveryAvailable", AndroidCommandExecutor.appDiscoveryAvailable(context));
                JSONObject response = request("POST", "/api/agent/device/status", capabilities, token);
                emit("ev-android-device-status", response.toString());
            } catch (Exception error) {
                emit("ev-android-device-status", result(false, deviceError(error)));
            } finally {
                statusInFlight.set(false);
            }
        });
    }

    void pollCommand() {
        if (!commandInFlight.compareAndSet(false, true)) return;
        requests.execute(() -> {
            try {
                String token = credentials.read();
                if (token == null) return;
                JSONObject response = request("GET", "/api/agent/device/commands/next", null, token);
                JSONObject command = response.optJSONObject("command");
                if (command == null) return;
                JSONObject result = AndroidCommandExecutor.execute(context, command);
                String commandId = command.optString("id", "");
                if (!commandId.matches("[0-9a-fA-F-]{36}")) {
                    emitCommandResult(command.optString("action", ""), false, false,
                            "INVALID_COMMAND_ID", "Android received an invalid command identifier.", null);
                    return;
                }
                JSONObject ack = request("POST", "/api/agent/device/commands/" + commandId + "/result", result, token);
                if (!ack.optBoolean("accepted")) {
                    emitCommandResult(command.optString("action", ""), false, false,
                            "RESULT_NOT_ACKNOWLEDGED", "The EV backend did not confirm the command result.", null);
                    return;
                }
                JSONObject error = result.optJSONObject("error");
                emitCommandResult(command.optString("action", ""), result.optBoolean("ok"),
                        result.optBoolean("verified"), error == null ? "" : error.optString("code", ""),
                        error == null ? "" : error.optString("message", ""), result.optString("verification", ""));
            } catch (Exception error) {
                emitCommandResult("", false, false, "DEVICE_REQUEST_FAILED", deviceError(error), null);
            } finally {
                commandInFlight.set(false);
            }
        });
    }

    void disconnect() {
        requests.execute(() -> {
            try {
                String token = credentials.read();
                if (token == null) {
                    emit("ev-android-device-status", noDeviceResult());
                    return;
                }
                JSONObject response = request("POST", "/api/agent/device/disconnect", new JSONObject(), token);
                if (!response.optBoolean("disconnected")) {
                    emit("ev-android-device-status", result(false, "EV did not confirm device revocation."));
                    return;
                }
                try {
                    credentials.clear();
                } catch (Exception clearError) {
                    emit("ev-android-device-status", result(false, "EV revoked this device, but its local credential could not be cleared. Clear EV app data before pairing again."));
                    return;
                }
                response.put("ok", true);
                emit("ev-android-device-status", response.toString());
            } catch (Exception error) {
                emit("ev-android-device-status", result(false, deviceError(error)));
            }
        });
    }

    void close() {
        requests.shutdownNow();
    }

    private JSONObject request(String method, String path, JSONObject body, String token) throws Exception {
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(backendUrl + path).openConnection();
            connection.setRequestMethod(method);
            connection.setConnectTimeout(10_000);
            connection.setReadTimeout(10_000);
            connection.setInstanceFollowRedirects(false);
            connection.setRequestProperty("Accept", "application/json");
            if (token != null) connection.setRequestProperty("Authorization", "Bearer " + token);
            if (body != null) {
                connection.setDoOutput(true);
                connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
                try (java.io.OutputStream output = connection.getOutputStream()) {
                    output.write(body.toString().getBytes(StandardCharsets.UTF_8));
                }
            }
            int status = connection.getResponseCode();
            InputStream stream = status >= 200 && status < 300 ? connection.getInputStream() : connection.getErrorStream();
            String content = readLimited(stream);
            JSONObject response = content.isEmpty() ? new JSONObject() : new JSONObject(content);
            if (status < 200 || status >= 300 || !response.optBoolean("ok")) {
                String message = response.optString("message", "The EV backend rejected the device request.");
                throw new RequestFailure(status, message);
            }
            return response;
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private static String readLimited(InputStream stream) throws Exception {
        if (stream == null) return "";
        try (InputStream input = stream; ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[2048];
            int total = 0;
            int count;
            while ((count = input.read(buffer)) != -1) {
                total += count;
                if (total > 64 * 1024) throw new RequestFailure(0, "The EV backend response was too large.");
                output.write(buffer, 0, count);
            }
            return output.toString(StandardCharsets.UTF_8.name());
        }
    }

    private static String deviceName() {
        String name = (Build.MANUFACTURER + " " + Build.MODEL)
                .replaceAll("[\\p{Cntrl}]", " ")
                .replaceAll("\\s+", " ")
                .trim();
        if (name.isEmpty()) name = "Android device";
        return name.substring(0, Math.min(60, name.length()));
    }

    private static String result(boolean ok, String message) {
        return "{\"ok\":" + ok + ",\"error\":" + !ok + ",\"message\":" + JSONObject.quote(message) + "}";
    }

    private static String noDeviceResult() {
        return "{\"ok\":true,\"paired\":false,\"message\":\"No Android device is paired.\"}";
    }

    private void emit(String event, String payload) {
        sink.emit(event, payload);
    }

    private void emitCommandResult(String action, boolean ok, boolean verified, String errorCode, String message, String verification) {
        try {
            JSONObject result = new JSONObject();
            result.put("ok", ok);
            result.put("action", action);
            result.put("verified", verified);
            if (!errorCode.isEmpty()) result.put("errorCode", errorCode);
            if (!message.isEmpty()) result.put("message", message);
            if (verification != null && !verification.isEmpty()) result.put("verification", verification);
            emit("ev-android-command-result", result.toString());
        } catch (Exception ignored) {
            emit("ev-android-command-result", "{\"ok\":false,\"verified\":false,\"errorCode\":\"RESULT_FORMAT_FAILED\",\"message\":\"Android command result unavailable.\"}");
        }
    }

    private String deviceError(Exception error) {
        if (error instanceof RequestFailure && ((RequestFailure) error).statusCode == 401) {
            try {
                credentials.clear();
                return "This Android device credential is no longer valid. Pair the phone again.";
            } catch (Exception clearError) {
                return "EV revoked this device, but its local credential could not be cleared. Clear EV app data before pairing again.";
            }
        }
        return safeMessage(error);
    }

    private static String safeMessage(Exception error) {
        if (error instanceof RequestFailure && error.getMessage() != null) return error.getMessage();
        return "Secure Android device request failed. Check the network and device credential storage.";
    }

    private static final class RequestFailure extends Exception {
        final int statusCode;
        RequestFailure(int statusCode, String message) { super(message); this.statusCode = statusCode; }
    }
}
