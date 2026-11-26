package com.growthos.jarvis;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.AccessibilityServiceInfo;
import android.content.Context;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayDeque;
import java.util.Locale;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.FutureTask;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.regex.Pattern;

public final class EVAccessibilityService extends AccessibilityService {
    private static final Pattern SENSITIVE_CONTENT = Pattern.compile(
            "\\b(password|passcode|passwd|pin|otp|code|verification|one[- ]time|2fa|mfa|cvv|cvc|card number|payment|security code|ssn)\\b",
            Pattern.CASE_INSENSITIVE);
    private static final Pattern LONG_NUMBER = Pattern.compile("(?:\\d[ -]?){8,}");
    private static volatile EVAccessibilityService activeService;
    private final Handler commandHandler = new Handler(Looper.getMainLooper());
    private DeviceControlClient deviceControlClient;
    private long lastStatusAt;
    private final Runnable commandPoll = new Runnable() {
        @Override public void run() {
            if (deviceControlClient == null) return;
            deviceControlClient.pollCommand();
            if (SystemClock.elapsedRealtime() - lastStatusAt >= 60_000L) {
                lastStatusAt = SystemClock.elapsedRealtime();
                deviceControlClient.refreshStatus();
            }
            commandHandler.postDelayed(this, 1_500L);
        }
    };

    public static boolean isEnabled(Context context) {
        return activeService != null;
    }

    static JSONObject performAction(String action, JSONObject arguments) {
        EVAccessibilityService service = activeService;
        if (service == null) return AndroidCommandExecutor.failure("ACCESSIBILITY_REQUIRED", "Enable EV Accessibility Service manually in Android Settings before using UI interaction.");
        FutureTask<JSONObject> task = new FutureTask<>(() -> service.performOnMainThread(action, arguments));
        service.commandHandler.post(task);
        try {
            return task.get(8, TimeUnit.SECONDS);
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            return AndroidCommandExecutor.failure("ACTION_INTERRUPTED", "The Android UI action was interrupted.");
        } catch (TimeoutException error) {
            task.cancel(true);
            return AndroidCommandExecutor.failure("ACCESSIBILITY_TIMEOUT", "The Android accessibility action timed out.");
        } catch (ExecutionException error) {
            return AndroidCommandExecutor.failure("ACCESSIBILITY_FAILED", "Android could not complete the accessibility action.");
        }
    }

    @Override protected void onServiceConnected() {
        super.onServiceConnected();
        activeService = this;
        AccessibilityServiceInfo info = getServiceInfo();
        if (info != null) {
            info.eventTypes = AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED | AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED;
            info.feedbackType = AccessibilityServiceInfo.FEEDBACK_GENERIC;
            info.flags = 0;
            info.notificationTimeout = 100;
            setServiceInfo(info);
        }
        try {
            deviceControlClient = new DeviceControlClient(this, (event, payload) -> { });
            lastStatusAt = 0;
            commandHandler.removeCallbacks(commandPoll);
            commandHandler.post(commandPoll);
        } catch (IllegalArgumentException ignored) {
            deviceControlClient = null;
        }
    }

    @Override public void onAccessibilityEvent(AccessibilityEvent event) {
        // Events are intentionally not inspected or retained. UI state is read only for an explicit tool request.
    }

    @Override public void onInterrupt() { }

    @Override public boolean onUnbind(android.content.Intent intent) {
        stopCommandPolling();
        return super.onUnbind(intent);
    }

    @Override public void onDestroy() {
        stopCommandPolling();
        if (activeService == this) activeService = null;
        super.onDestroy();
    }

    private void stopCommandPolling() {
        commandHandler.removeCallbacksAndMessages(null);
        if (deviceControlClient != null) {
            deviceControlClient.close();
            deviceControlClient = null;
        }
        if (activeService == this) activeService = null;
    }

    private JSONObject performOnMainThread(String action, JSONObject args) {
        if (AndroidCommandExecutor.isSensitiveTarget(args.optString("target", ""))) {
            return AndroidCommandExecutor.failure("SENSITIVE_TARGET", "EV will not interact with password, verification, payment, or other sensitive fields.");
        }
        switch (action) {
            case "go_back":
                return performGlobalAction(GLOBAL_ACTION_BACK)
                        ? AndroidCommandExecutor.success(new JSONObject(), "Android accepted the accessibility back action.")
                        : AndroidCommandExecutor.failure("BACK_UNAVAILABLE", "Android could not navigate back from the current screen.");
            case "tap_element":
                return tapElement(args);
            case "type_text":
                return typeText(args);
            case "scroll":
                return scroll(args);
            case "get_visible_state":
                return getVisibleState();
            default:
                return AndroidCommandExecutor.failure("UNSUPPORTED_ACTION", "This accessibility action is not supported.");
        }
    }

    private JSONObject tapElement(JSONObject args) {
        String target = args.optString("target", "").trim();
        String matchBy = args.optString("match_by", "");
        if (target.isEmpty() || target.length() > 120 || !("text".equals(matchBy) || "content_description".equals(matchBy))) {
            return AndroidCommandExecutor.failure("INVALID_TARGET", "Provide a visible text or content description to tap.");
        }
        AccessibilityNodeInfo root = getRootInActiveWindow();
        if (root == null) return AndroidCommandExecutor.failure("NO_ACTIVE_WINDOW", "No accessible Android app window is available.");
        AccessibilityNodeInfo node = findNode(root, target, matchBy, false);
        if (node == null) return AndroidCommandExecutor.failure("ELEMENT_NOT_FOUND", "No visible accessible element matched that target.");
        if (node.isPassword() || AndroidCommandExecutor.isSensitiveTarget(readNodeLabel(node))) {
            return AndroidCommandExecutor.failure("SENSITIVE_TARGET", "EV will not tap sensitive credential or payment controls.");
        }
        AccessibilityNodeInfo clickable = node;
        while (clickable != null && !clickable.isClickable()) clickable = clickable.getParent();
        if (clickable == null || !clickable.isEnabled() || !clickable.performAction(AccessibilityNodeInfo.ACTION_CLICK)) {
            return AndroidCommandExecutor.failure("TAP_FAILED", "Android did not accept the accessible tap action.");
        }
        JSONObject data = new JSONObject();
        try {
            data.put("target", target);
            data.put("actionInitiated", true);
        } catch (Exception ignored) {
            return AndroidCommandExecutor.failure("RESULT_FORMAT_FAILED", "Android could not format the tap result.");
        }
        return AndroidCommandExecutor.success(data, "The matched accessible element accepted ACTION_CLICK.");
    }

    private JSONObject typeText(JSONObject args) {
        String target = args.optString("target", "").trim();
        String text = args.optString("text", "");
        if (target.isEmpty() || target.length() > 120 || text.isEmpty() || text.length() > 500) {
            return AndroidCommandExecutor.failure("INVALID_TEXT_REQUEST", "Provide a supported ordinary text field and a value up to 500 characters.");
        }
        if (AndroidCommandExecutor.isSensitiveTarget(target)) {
            return AndroidCommandExecutor.failure("SENSITIVE_TARGET", "EV will not type into password, verification, payment, or other sensitive fields.");
        }
        AccessibilityNodeInfo root = getRootInActiveWindow();
        if (root == null) return AndroidCommandExecutor.failure("NO_ACTIVE_WINDOW", "No accessible Android app window is available.");
        AccessibilityNodeInfo field = findNode(root, target, "any", true);
        if (field == null || !field.isEditable() || field.isPassword()) {
            return AndroidCommandExecutor.failure("TEXT_FIELD_NOT_FOUND", "No matching ordinary editable text field was found.");
        }
        Bundle bundle = new Bundle();
        bundle.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text);
        if (!field.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, bundle)) {
            return AndroidCommandExecutor.failure("TYPE_TEXT_FAILED", "Android did not accept text entry in that field.");
        }
        JSONObject data = new JSONObject();
        try {
            data.put("target", target);
            data.put("textEntered", true);
        } catch (Exception ignored) {
            return AndroidCommandExecutor.failure("RESULT_FORMAT_FAILED", "Android could not format the text entry result.");
        }
        return AndroidCommandExecutor.success(data, "Android accepted ACTION_SET_TEXT; the entered value is not returned or logged.");
    }

    private JSONObject scroll(JSONObject args) {
        String direction = args.optString("direction", "");
        String target = args.optString("target", "").trim();
        if (!("up".equals(direction) || "down".equals(direction) || "left".equals(direction) || "right".equals(direction)) || target.length() > 120) {
            return AndroidCommandExecutor.failure("INVALID_SCROLL", "Use up, down, left, or right and an optional accessible container.");
        }
        AccessibilityNodeInfo root = getRootInActiveWindow();
        if (root == null) return AndroidCommandExecutor.failure("NO_ACTIVE_WINDOW", "No accessible Android app window is available.");
        AccessibilityNodeInfo scrollable = findScrollable(root, target);
        if (scrollable == null) return AndroidCommandExecutor.failure("SCROLL_CONTAINER_NOT_FOUND", "No matching accessible scroll container was found.");
        int action;
        if ("up".equals(direction)) action = AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD;
        else if ("down".equals(direction)) action = AccessibilityNodeInfo.ACTION_SCROLL_FORWARD;
        else if ("left".equals(direction)) action = AccessibilityNodeInfo.ACTION_SCROLL_LEFT;
        else action = AccessibilityNodeInfo.ACTION_SCROLL_RIGHT;
        if (!scrollable.performAction(action)) return AndroidCommandExecutor.failure("SCROLL_FAILED", "Android did not accept the scroll action.");
        JSONObject data = new JSONObject();
        try {
            data.put("direction", direction);
            data.put("actionInitiated", true);
        } catch (Exception ignored) {
            return AndroidCommandExecutor.failure("RESULT_FORMAT_FAILED", "Android could not format the scroll result.");
        }
        return AndroidCommandExecutor.success(data, "The accessible scroll container accepted the requested scroll action.");
    }

    private JSONObject getVisibleState() {
        AccessibilityNodeInfo root = getRootInActiveWindow();
        if (root == null) return AndroidCommandExecutor.failure("NO_ACTIVE_WINDOW", "No accessible Android app window is available.");
        JSONArray labels = new JSONArray();
        ArrayDeque<AccessibilityNodeInfo> pending = new ArrayDeque<>();
        pending.add(root);
        int visited = 0;
        while (!pending.isEmpty() && visited++ < 250 && labels.length() < 30) {
            AccessibilityNodeInfo node = pending.removeFirst();
            if (node == null || !node.isVisibleToUser()) continue;
            if (!node.isEditable() && !node.isPassword()) {
                addSafeLabel(labels, node.getText());
                addSafeLabel(labels, node.getContentDescription());
            }
            for (int i = 0; i < node.getChildCount() && pending.size() < 250; i++) {
                AccessibilityNodeInfo child = node.getChild(i);
                if (child != null) pending.addLast(child);
            }
        }
        JSONObject data = new JSONObject();
        try {
            CharSequence packageName = root.getPackageName();
            data.put("packageName", packageName == null ? "" : packageName.toString());
            data.put("visibleLabels", labels);
            data.put("editableValuesIncluded", false);
        } catch (Exception ignored) {
            return AndroidCommandExecutor.failure("RESULT_FORMAT_FAILED", "Android could not format the visible interface state.");
        }
        return AndroidCommandExecutor.success(data, "Read visible accessible labels on explicit request; editable values were excluded.");
    }

    private static AccessibilityNodeInfo findNode(AccessibilityNodeInfo root, String target, String matchBy, boolean editableOnly) {
        ArrayDeque<AccessibilityNodeInfo> pending = new ArrayDeque<>();
        pending.add(root);
        String query = target.toLowerCase(Locale.ROOT);
        int visited = 0;
        while (!pending.isEmpty() && visited++ < 250) {
            AccessibilityNodeInfo node = pending.removeFirst();
            if (node == null || !node.isVisibleToUser()) continue;
            if (!editableOnly || node.isEditable()) {
                if (node.isPassword()) continue;
                String label;
                if (node.isEditable()) {
                    label = "content_description".equals(matchBy)
                            ? text(node.getContentDescription())
                            : text(node.getHintText());
                } else if ("text".equals(matchBy)) {
                    label = text(node.getText());
                } else if ("content_description".equals(matchBy)) {
                    label = text(node.getContentDescription());
                } else {
                    label = text(node.getHintText()) + " " + text(node.getContentDescription()) + " " + text(node.getText());
                }
                if (label.toLowerCase(Locale.ROOT).contains(query)) return node;
            }
            for (int i = 0; i < node.getChildCount() && pending.size() < 250; i++) {
                AccessibilityNodeInfo child = node.getChild(i);
                if (child != null) pending.addLast(child);
            }
        }
        return null;
    }

    private static AccessibilityNodeInfo findScrollable(AccessibilityNodeInfo root, String target) {
        ArrayDeque<AccessibilityNodeInfo> pending = new ArrayDeque<>();
        pending.add(root);
        int visited = 0;
        while (!pending.isEmpty() && visited++ < 250) {
            AccessibilityNodeInfo node = pending.removeFirst();
            if (node == null || !node.isVisibleToUser()) continue;
            boolean labelMatches = target.isEmpty() || readNodeLabel(node).toLowerCase(Locale.ROOT).contains(target.toLowerCase(Locale.ROOT));
            if (node.isScrollable() && labelMatches) return node;
            for (int i = 0; i < node.getChildCount() && pending.size() < 250; i++) {
                AccessibilityNodeInfo child = node.getChild(i);
                if (child != null) pending.addLast(child);
            }
        }
        return null;
    }

    private static String readNodeLabel(AccessibilityNodeInfo node) {
        String nodeText = node.isEditable() || node.isPassword() ? "" : text(node.getText());
        return nodeText + " " + text(node.getContentDescription()) + " " + text(node.getHintText());
    }

    private static String text(CharSequence value) {
        return value == null ? "" : value.toString();
    }

    private static void addSafeLabel(JSONArray labels, CharSequence raw) {
        String label = raw == null ? "" : raw.toString().trim();
        if (label.isEmpty() || label.length() > 120 || SENSITIVE_CONTENT.matcher(label).find() || LONG_NUMBER.matcher(label).find()) return;
        labels.put(label);
    }
}
