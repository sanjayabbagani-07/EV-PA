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
import java.util.ArrayList;
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
    private static final Pattern CONSEQUENTIAL_LABEL = Pattern.compile(
            "\\b(send|reply|publish|post|comment|delete|remove|erase|unfollow|pay|purchase|buy|checkout|submit|confirm|share)\\b",
            Pattern.CASE_INSENSITIVE);
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
                        ? AndroidCommandExecutor.success(new JSONObject(), "Android accepted the accessibility back action; the resulting screen was not verified.", false)
                        : AndroidCommandExecutor.failure("BACK_UNAVAILABLE", "Android could not navigate back from the current screen.");
            case "tap_element":
                return tapElement(args);
            case "type_text":
                return typeText(args);
            case "scroll":
                return scroll(args);
            case "get_visible_state":
                return getVisibleState();
            case "search_in_app":
                return searchInApp(args);
            default:
                return AndroidCommandExecutor.failure("UNSUPPORTED_ACTION", "This accessibility action is not supported.");
        }
    }

    private JSONObject searchInApp(JSONObject args) {
        String fieldTarget = args.optString("field_target", "").trim();
        String query = args.optString("query", "");
        String submitTarget = args.optString("submit_target", "").trim();
        String submitMatchBy = args.optString("submit_match_by", "");
        if (fieldTarget.isEmpty() || query.isEmpty() || submitTarget.isEmpty() ||
                fieldTarget.length() > 120 || query.length() > 200 || submitTarget.length() > 120 ||
                !("text".equals(submitMatchBy) || "content_description".equals(submitMatchBy))) {
            return AndroidCommandExecutor.failure("INVALID_SEARCH", "Provide a supported search field, query, and visible submit control.");
        }
        AccessibilityNodeInfo root = getRootInActiveWindow();
        if (root == null) return AndroidCommandExecutor.failure("NO_ACTIVE_WINDOW", "No accessible Android app window is available.");
        ArrayList<AccessibilityNodeInfo> fields = findMatchingNodes(root, fieldTarget, "any", true, false);
        if (fields.isEmpty()) {
            return AndroidCommandExecutor.failure("SEARCH_FIELD_NOT_FOUND", "No matching ordinary editable search field was found.");
        }
        if (fields.size() > 1) return AndroidCommandExecutor.failure("SEARCH_FIELD_AMBIGUOUS", "More than one editable field matched; provide a more specific accessible label.");
        AccessibilityNodeInfo field = fields.get(0);
        ArrayList<AccessibilityNodeInfo> submits = findMatchingNodes(root, submitTarget, submitMatchBy, false, true);
        if (submits.isEmpty()) return AndroidCommandExecutor.failure("SEARCH_SUBMIT_NOT_FOUND", "No matching accessible search submit control was found.");
        if (submits.size() > 1) return AndroidCommandExecutor.failure("SEARCH_SUBMIT_AMBIGUOUS", "More than one submit control matched; provide its exact accessible label.");
        AccessibilityNodeInfo submit = submits.get(0);
        if (AndroidCommandExecutor.isSensitiveTarget(readNodeLabel(submit))) {
            return AndroidCommandExecutor.failure("SENSITIVE_TARGET", "EV will not activate a credential or payment control as a search submit action.");
        }

        Bundle bundle = new Bundle();
        bundle.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, query);
        if (!field.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, bundle)) {
            return AndroidCommandExecutor.failure("SEARCH_INPUT_FAILED", "Android did not accept the search query.");
        }
        CharSequence entered = field.getText();
        if (entered == null || !query.contentEquals(entered)) {
            return AndroidCommandExecutor.failure("SEARCH_INPUT_UNVERIFIED", "Android accepted text entry, but the search query could not be verified in the field.");
        }

        root = getRootInActiveWindow();
        if (root == null) return AndroidCommandExecutor.failure("NO_ACTIVE_WINDOW", "The app window changed before EV could submit the search.");
        submits = findMatchingNodes(root, submitTarget, submitMatchBy, false, true);
        if (submits.isEmpty()) return AndroidCommandExecutor.failure("SEARCH_SUBMIT_NOT_FOUND", "The search submit control changed before EV could activate it.");
        if (submits.size() > 1) return AndroidCommandExecutor.failure("SEARCH_SUBMIT_AMBIGUOUS", "More than one submit control matched after entering the query.");
        submit = submits.get(0);
        AccessibilityNodeInfo clickable = findClickableAncestor(submit);
        String clickableLabel = clickable == null ? "" : readNodeLabel(clickable);
        String submitLabels = readNodeLabel(submit) + " " + clickableLabel;
        if (AndroidCommandExecutor.isSensitiveTarget(submitLabels)) {
            return AndroidCommandExecutor.failure("SENSITIVE_TARGET", "EV will not activate a credential or payment control as a search submit action.");
        }
        if (isConsequentialLabel(clickableLabel)) {
            return AndroidCommandExecutor.failure("UNEXPECTED_SEARCH_SUBMIT", "The search control is nested in a consequential action; EV did not activate it.");
        }
        if (clickable == null || !clickable.isEnabled() || !clickable.performAction(AccessibilityNodeInfo.ACTION_CLICK)) {
            return AndroidCommandExecutor.failure("SEARCH_SUBMIT_FAILED", "Android did not accept the accessible search submit action.");
        }
        JSONObject data = new JSONObject();
        try {
            data.put("fieldTarget", fieldTarget);
            data.put("submitTarget", submitTarget);
            data.put("queryEntered", true);
            data.put("searchSubmitted", true);
        } catch (Exception ignored) {
            return AndroidCommandExecutor.failure("RESULT_FORMAT_FAILED", "Android could not format the search result.");
        }
        return AndroidCommandExecutor.success(data, "The accessible field contained the requested query and the submit control accepted ACTION_CLICK; result loading was not verified.", false);
    }

    private JSONObject tapElement(JSONObject args) {
        String target = args.optString("target", "").trim();
        String matchBy = args.optString("match_by", "");
        if (target.isEmpty() || target.length() > 120 || !("text".equals(matchBy) || "content_description".equals(matchBy))) {
            return AndroidCommandExecutor.failure("INVALID_TARGET", "Provide a visible text or content description to tap.");
        }
        AccessibilityNodeInfo root = getRootInActiveWindow();
        if (root == null) return AndroidCommandExecutor.failure("NO_ACTIVE_WINDOW", "No accessible Android app window is available.");
        ArrayList<AccessibilityNodeInfo> matches = findMatchingNodes(root, target, matchBy, false, false);
        if (matches.isEmpty()) return AndroidCommandExecutor.failure("ELEMENT_NOT_FOUND", "No visible accessible element matched that target.");
        ArrayList<AccessibilityNodeInfo> clickTargets = new ArrayList<>();
        for (AccessibilityNodeInfo match : matches) {
            AccessibilityNodeInfo clickable = findClickableAncestor(match);
            if (clickable == null) continue;
            boolean alreadyPresent = false;
            for (AccessibilityNodeInfo existing : clickTargets) {
                if (existing.equals(clickable)) {
                    alreadyPresent = true;
                    break;
                }
            }
            if (!alreadyPresent) clickTargets.add(clickable);
        }
        if (clickTargets.size() > 1) return AndroidCommandExecutor.failure("ELEMENT_AMBIGUOUS", "More than one clickable accessible element matched; use a more specific label.");
        if (clickTargets.isEmpty()) return AndroidCommandExecutor.failure("TAP_FAILED", "The matching accessible element has no clickable control.");
        AccessibilityNodeInfo clickable = clickTargets.get(0);
        String clickLabel = readNodeLabel(clickable);
        if (AndroidCommandExecutor.isSensitiveTarget(readNodeLabel(matches.get(0)) + " " + clickLabel)) {
            return AndroidCommandExecutor.failure("SENSITIVE_TARGET", "EV will not tap sensitive credential or payment controls.");
        }
        if (isConsequentialLabel(clickLabel) && !isConsequentialLabel(target)) {
            return AndroidCommandExecutor.failure("CONSEQUENTIAL_TARGET_MISMATCH", "The clickable control has a consequential label different from the approved target. Review that exact control before retrying.");
        }
        if (!clickable.isEnabled() || !clickable.performAction(AccessibilityNodeInfo.ACTION_CLICK)) {
            return AndroidCommandExecutor.failure("TAP_FAILED", "Android did not accept the accessible tap action.");
        }
        JSONObject data = new JSONObject();
        try {
            data.put("target", target);
            data.put("actionInitiated", true);
        } catch (Exception ignored) {
            return AndroidCommandExecutor.failure("RESULT_FORMAT_FAILED", "Android could not format the tap result.");
        }
        return AndroidCommandExecutor.success(data, "The matched accessible element accepted ACTION_CLICK; the resulting app state was not verified.", false);
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
        ArrayList<AccessibilityNodeInfo> fields = findMatchingNodes(root, target, "any", true, false);
        if (fields.isEmpty()) {
            return AndroidCommandExecutor.failure("TEXT_FIELD_NOT_FOUND", "No matching ordinary editable text field was found.");
        }
        if (fields.size() > 1) return AndroidCommandExecutor.failure("TEXT_FIELD_AMBIGUOUS", "More than one editable field matched; provide a more specific accessible label.");
        AccessibilityNodeInfo field = fields.get(0);
        if (!field.isEditable() || field.isPassword()) return AndroidCommandExecutor.failure("TEXT_FIELD_NOT_FOUND", "No matching ordinary editable text field was found.");
        Bundle bundle = new Bundle();
        bundle.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text);
        if (!field.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, bundle)) {
            return AndroidCommandExecutor.failure("TYPE_TEXT_FAILED", "Android did not accept text entry in that field.");
        }
        CharSequence entered = field.getText();
        if (entered == null || !text.contentEquals(entered)) {
            return AndroidCommandExecutor.failure("TYPE_TEXT_UNVERIFIED", "Android accepted text entry, but the resulting field value could not be verified.");
        }
        JSONObject data = new JSONObject();
        try {
            data.put("target", target);
            data.put("textEntered", true);
        } catch (Exception ignored) {
            return AndroidCommandExecutor.failure("RESULT_FORMAT_FAILED", "Android could not format the text entry result.");
        }
        return AndroidCommandExecutor.success(data, "The field contained the requested text after ACTION_SET_TEXT; the value is not returned or logged.");
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
        else if ("left".equals(direction)) action = AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_LEFT.getId();
        else action = AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_RIGHT.getId();
        if (!scrollable.performAction(action)) return AndroidCommandExecutor.failure("SCROLL_FAILED", "Android did not accept the scroll action.");
        JSONObject data = new JSONObject();
        try {
            data.put("direction", direction);
            data.put("actionInitiated", true);
        } catch (Exception ignored) {
            return AndroidCommandExecutor.failure("RESULT_FORMAT_FAILED", "Android could not format the scroll result.");
        }
        return AndroidCommandExecutor.success(data, "The accessible scroll container accepted the requested scroll action; the resulting viewport was not verified.", false);
    }

    private JSONObject getVisibleState() {
        AccessibilityNodeInfo root = getRootInActiveWindow();
        if (root == null) return AndroidCommandExecutor.failure("NO_ACTIVE_WINDOW", "No accessible Android app window is available.");
        JSONArray labels = new JSONArray();
        JSONArray editableFields = new JSONArray();
        ArrayDeque<AccessibilityNodeInfo> pending = new ArrayDeque<>();
        pending.add(root);
        int visited = 0;
        while (!pending.isEmpty() && visited++ < 250 && (labels.length() < 30 || editableFields.length() < 20)) {
            AccessibilityNodeInfo node = pending.removeFirst();
            if (node == null || !node.isVisibleToUser()) continue;
            if (node.isEditable() && !node.isPassword()) {
                addSafeEditableField(editableFields, node);
            } else if (!node.isPassword()) {
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
            data.put("editableFields", editableFields);
            data.put("editableValuesIncluded", false);
        } catch (Exception ignored) {
            return AndroidCommandExecutor.failure("RESULT_FORMAT_FAILED", "Android could not format the visible interface state.");
        }
        return AndroidCommandExecutor.success(data, "Read visible accessible labels on explicit request; editable values were excluded.");
    }

    private static ArrayList<AccessibilityNodeInfo> findMatchingNodes(
            AccessibilityNodeInfo root, String target, String matchBy, boolean editableOnly, boolean exactMatch) {
        ArrayList<AccessibilityNodeInfo> matches = new ArrayList<>();
        ArrayDeque<AccessibilityNodeInfo> pending = new ArrayDeque<>();
        pending.add(root);
        String query = target.trim().replaceAll("\\s+", " ").toLowerCase(Locale.ROOT);
        int visited = 0;
        while (!pending.isEmpty() && visited++ < 250) {
            AccessibilityNodeInfo node = pending.removeFirst();
            if (node == null || !node.isVisibleToUser()) continue;
            if ((!editableOnly || node.isEditable()) && !node.isPassword()) {
                String label;
                if (node.isEditable()) {
                    label = text(node.getHintText()) + " " + text(node.getContentDescription());
                } else if ("text".equals(matchBy)) {
                    label = text(node.getText());
                } else if ("content_description".equals(matchBy)) {
                    label = text(node.getContentDescription());
                } else {
                    label = text(node.getHintText()) + " " + text(node.getContentDescription()) + " " + text(node.getText());
                }
                String normalizedLabel = label.trim().replaceAll("\\s+", " ").toLowerCase(Locale.ROOT);
                if (exactMatch ? normalizedLabel.equals(query) : normalizedLabel.contains(query)) matches.add(node);
            }
            for (int i = 0; i < node.getChildCount() && pending.size() < 250; i++) {
                AccessibilityNodeInfo child = node.getChild(i);
                if (child != null) pending.addLast(child);
            }
        }
        return matches;
    }

    private static AccessibilityNodeInfo findClickableAncestor(AccessibilityNodeInfo node) {
        AccessibilityNodeInfo clickable = node;
        while (clickable != null && !clickable.isClickable()) clickable = clickable.getParent();
        return clickable;
    }

    private static boolean isConsequentialLabel(String value) {
        return CONSEQUENTIAL_LABEL.matcher(value == null ? "" : value).find();
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

    private static void addSafeEditableField(JSONArray fields, AccessibilityNodeInfo node) {
        if (fields.length() >= 20 || node.isPassword()) return;
        String hint = safeFieldLabel(node.getHintText());
        if (hint.isEmpty()) return;
        JSONObject field = new JSONObject();
        try {
            field.put("hint", hint);
            field.put("editable", true);
            fields.put(field);
        } catch (Exception ignored) {
            // A malformed optional field is omitted; no user-entered value is read.
        }
    }

    private static String safeFieldLabel(CharSequence raw) {
        String label = raw == null ? "" : raw.toString().trim();
        if (label.length() > 120 || SENSITIVE_CONTENT.matcher(label).find() || LONG_NUMBER.matcher(label).find()) return "";
        return label;
    }
}
