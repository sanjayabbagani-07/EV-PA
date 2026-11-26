package com.growthos.jarvis;

import android.content.Context;
import android.content.Intent;
import android.content.pm.ResolveInfo;
import android.net.Uri;

import org.json.JSONArray;
import org.json.JSONObject;

import java.net.URI;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

final class AndroidCommandExecutor {
    private static final int MAX_APPS = 40;
    private static final java.util.regex.Pattern SENSITIVE_TARGET = java.util.regex.Pattern.compile(
            "\\b(password|passcode|passwd|pin|otp|code|verification|one[- ]time|2fa|mfa|cvv|cvc|card number|payment|security code|ssn)\\b",
            java.util.regex.Pattern.CASE_INSENSITIVE);
    private static final java.util.regex.Pattern SENSITIVE_VALUE = java.util.regex.Pattern.compile(
            "^(?:\\d{4,8}|(?:\\d[ -]?){13,19})$");
    private static final java.util.regex.Pattern SEARCH_SUBMIT_TARGET = java.util.regex.Pattern.compile(
            "^(search|find|go|शोध|ढूँढ|వెతు|శోధ)$",
            java.util.regex.Pattern.CASE_INSENSITIVE);

    private AndroidCommandExecutor() {}

    static JSONObject execute(Context context, JSONObject command) {
        String action = command == null ? "" : command.optString("action", "");
        JSONObject args = command == null ? null : command.optJSONObject("arguments");
        if (args == null) return failure("INVALID_COMMAND", "The Android command arguments were invalid.");
        try {
            switch (action) {
                case "list_apps":
                    if (!hasOnlyKeys(args)) return failure("INVALID_ARGUMENTS", "Application listing does not accept arguments.");
                    return listApps(context);
                case "open_app":
                    if (!hasOnlyKeys(args, "app_name") || !args.has("app_name")) return failure("INVALID_ARGUMENTS", "Provide only an application name.");
                    return openApp(context, args.optString("app_name", ""));
                case "open_url":
                    if (!hasOnlyKeys(args, "url") || !args.has("url")) return failure("INVALID_ARGUMENTS", "Provide only a URL.");
                    return openUrl(context, args.optString("url", ""));
                case "go_back":
                    if (!hasOnlyKeys(args)) return failure("INVALID_ARGUMENTS", "Back navigation does not accept arguments.");
                    return EVAccessibilityService.performAction("go_back", args);
                case "tap_element":
                    if (!hasOnlyKeys(args, "target", "match_by") || !args.has("target") || !args.has("match_by")) return failure("INVALID_ARGUMENTS", "Provide an accessible target and match type.");
                    return EVAccessibilityService.performAction("tap_element", args);
                case "type_text":
                    if (!hasOnlyKeys(args, "target", "text") || !args.has("target") || !args.has("text")) return failure("INVALID_ARGUMENTS", "Provide an ordinary text field target and text.");
                    if (args.optString("target").length() > 120 || args.optString("text").isEmpty() || args.optString("text").length() > 500) {
                        return failure("INVALID_ARGUMENTS", "The text target or value is outside the allowed length.");
                    }
                    if (isSensitiveTarget(args.optString("text")) || SENSITIVE_VALUE.matcher(args.optString("text").trim()).matches()) {
                        return failure("SENSITIVE_TARGET", "EV will not enter passwords, verification codes, payment data, or other sensitive values.");
                    }
                    return EVAccessibilityService.performAction("type_text", args);
                case "scroll":
                    if (!hasOnlyKeys(args, "direction", "target") || !args.has("direction")) return failure("INVALID_ARGUMENTS", "Provide a scroll direction and optional container.");
                    return EVAccessibilityService.performAction("scroll", args);
                case "get_visible_state":
                    if (!hasOnlyKeys(args)) return failure("INVALID_ARGUMENTS", "Visible state inspection does not accept arguments.");
                    return EVAccessibilityService.performAction("get_visible_state", args);
                case "search_in_app":
                    if (!hasOnlyKeys(args, "field_target", "query", "submit_target", "submit_match_by") ||
                            !args.has("field_target") || !args.has("query") ||
                            !args.has("submit_target") || !args.has("submit_match_by")) {
                        return failure("INVALID_ARGUMENTS", "Provide a search field, query, and accessible submit control.");
                    }
                    if (args.optString("field_target").length() > 120 || args.optString("query").isEmpty() ||
                            args.optString("query").length() > 200 || args.optString("submit_target").length() > 120) {
                        return failure("INVALID_ARGUMENTS", "The search field, query, or submit target is outside the allowed length.");
                    }
                    if (isSensitiveTarget(args.optString("field_target")) ||
                            isSensitiveTarget(args.optString("query")) ||
                            SENSITIVE_VALUE.matcher(args.optString("query").trim()).matches()) {
                        return failure("SENSITIVE_TARGET", "EV will not submit passwords, verification codes, payment data, or other sensitive values.");
                    }
                    if (!SEARCH_SUBMIT_TARGET.matcher(args.optString("submit_target").trim()).matches()) {
                        return failure("UNSUPPORTED_SEARCH_SUBMIT", "The submit control must be clearly labelled Search, Find, or Go.");
                    }
                    return EVAccessibilityService.performAction("search_in_app", args);
                default:
                    return failure("UNSUPPORTED_ACTION", "This Android action is not supported.");
            }
        } catch (Exception error) {
            return failure("ANDROID_ACTION_FAILED", "Android could not complete the requested action.");
        }
    }

    static boolean appDiscoveryAvailable(Context context) {
        return context.getPackageManager() != null;
    }

    private static JSONObject listApps(Context context) {
        Map<String, String> apps = launchableApps(context);
        JSONArray items = new JSONArray();
        int count = 0;
        for (Map.Entry<String, String> entry : apps.entrySet()) {
            if (count++ >= MAX_APPS) break;
            JSONObject item = new JSONObject();
            try {
                item.put("name", entry.getValue());
                item.put("packageName", entry.getKey());
                items.put(item);
            } catch (Exception ignored) {
                return failure("APP_DISCOVERY_FAILED", "Android returned an invalid application entry.");
            }
        }
        JSONObject data = new JSONObject();
        try {
            data.put("apps", items);
            data.put("truncated", apps.size() > MAX_APPS);
            data.put("count", items.length());
        } catch (Exception error) {
            return failure("APP_DISCOVERY_FAILED", "Could not format the Android application list.");
        }
        return success(data, "Queried launchable application labels and package identifiers.");
    }

    private static JSONObject openApp(Context context, String requested) {
        String query = requested.trim();
        if (query.isEmpty() || query.length() > 100) return failure("INVALID_APP_NAME", "Provide a valid installed application name or package id.");
        Map<String, String> apps = launchableApps(context);
        List<String> exact = new ArrayList<>();
        for (Map.Entry<String, String> entry : apps.entrySet()) {
            if (entry.getKey().equalsIgnoreCase(query) || entry.getValue().equalsIgnoreCase(query)) exact.add(entry.getKey());
        }
        List<String> matches = exact;
        if (matches.isEmpty()) {
            matches = new ArrayList<>();
            String lower = query.toLowerCase(Locale.ROOT);
            for (Map.Entry<String, String> entry : apps.entrySet()) {
                if (entry.getKey().toLowerCase(Locale.ROOT).contains(lower) ||
                        entry.getValue().toLowerCase(Locale.ROOT).contains(lower)) matches.add(entry.getKey());
            }
        }
        if (matches.isEmpty()) return failure("APP_NOT_FOUND", "No launchable installed app matched that name.");
        if (matches.size() > 1) {
            JSONObject data = new JSONObject();
            JSONArray candidates = new JSONArray();
            for (String packageName : matches.subList(0, Math.min(matches.size(), 10))) {
                JSONObject candidate = new JSONObject();
                try {
                    candidate.put("name", apps.get(packageName));
                    candidate.put("packageName", packageName);
                    candidates.put(candidate);
                } catch (Exception ignored) {
                    return failure("APP_LOOKUP_FAILED", "Android could not format the matching applications.");
                }
            }
            try { data.put("candidates", candidates); }
            catch (Exception error) { return failure("APP_LOOKUP_FAILED", "Android could not format the matching applications."); }
            return failure("APP_AMBIGUOUS", "More than one installed app matched; specify its exact name or package id.", data);
        }

        String packageName = matches.get(0);
        Intent launch = context.getPackageManager().getLaunchIntentForPackage(packageName);
        if (launch == null || launch.resolveActivity(context.getPackageManager()) == null) {
            return failure("APP_UNAVAILABLE", "Android could not resolve a launch activity for that application.");
        }
        try {
            launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            context.startActivity(launch);
        } catch (Exception error) {
            return failure("APP_LAUNCH_FAILED", "Android refused to start that application.");
        }
        JSONObject data = new JSONObject();
        try {
            data.put("app", apps.get(packageName));
            data.put("packageName", packageName);
            data.put("launchInitiated", true);
        } catch (Exception error) {
            return failure("APP_LAUNCH_FAILED", "Android started the app but could not format its result.");
        }
        return success(data, "Android accepted the resolved application launch intent; destination screen readiness was not verified.", false);
    }

    private static JSONObject openUrl(Context context, String value) {
        try {
            URI parsed = new URI(value.trim());
            String scheme = parsed.getScheme();
            if (scheme == null || (!scheme.equalsIgnoreCase("http") && !scheme.equalsIgnoreCase("https")) ||
                    parsed.getHost() == null || parsed.getUserInfo() != null) {
                return failure("UNSUPPORTED_URL", "Only valid HTTP and HTTPS URLs without embedded credentials are supported.");
            }
            Uri uri = Uri.parse(parsed.toASCIIString());
            Intent intent = new Intent(Intent.ACTION_VIEW, uri);
            if (intent.resolveActivity(context.getPackageManager()) == null) {
                return failure("NO_URL_HANDLER", "No installed Android application can open this URL.");
            }
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            context.startActivity(intent);
            JSONObject data = new JSONObject();
            data.put("url", uri.toString());
            data.put("launchInitiated", true);
            return success(data, "Android accepted the URL intent; page load was not independently verified.", false);
        } catch (java.net.URISyntaxException error) {
            return failure("UNSUPPORTED_URL", "The URL is malformed or unsupported.");
        } catch (Exception error) {
            return failure("URL_LAUNCH_FAILED", "Android could not open that URL.");
        }
    }

    private static Map<String, String> launchableApps(Context context) {
        Intent launcher = new Intent(Intent.ACTION_MAIN);
        launcher.addCategory(Intent.CATEGORY_LAUNCHER);
        List<ResolveInfo> resolved = context.getPackageManager().queryIntentActivities(launcher, 0);
        Map<String, String> apps = new LinkedHashMap<>();
        for (ResolveInfo item : resolved) {
            if (item.activityInfo == null || item.activityInfo.packageName == null) continue;
            String packageName = item.activityInfo.packageName;
            CharSequence label = item.loadLabel(context.getPackageManager());
            apps.put(packageName, label == null ? packageName : label.toString());
        }
        List<Map.Entry<String, String>> sorted = new ArrayList<>(apps.entrySet());
        sorted.sort((a, b) -> a.getValue().compareToIgnoreCase(b.getValue()));
        apps.clear();
        for (Map.Entry<String, String> entry : sorted) apps.put(entry.getKey(), entry.getValue());
        return apps;
    }

    private static boolean hasOnlyKeys(JSONObject object, String... allowed) {
        for (java.util.Iterator<String> keys = object.keys(); keys.hasNext();) {
            String key = keys.next();
            boolean accepted = false;
            for (String name : allowed) if (name.equals(key)) accepted = true;
            if (!accepted) return false;
        }
        return true;
    }

    static boolean isSensitiveTarget(String target) {
        return SENSITIVE_TARGET.matcher(target == null ? "" : target).find();
    }

    static JSONObject success(JSONObject data, String verification) {
        return success(data, verification, true);
    }

    static JSONObject success(JSONObject data, String verification, boolean verified) {
        JSONObject result = new JSONObject();
        try {
            result.put("ok", true);
            result.put("data", data == null ? JSONObject.NULL : data);
            result.put("verified", verified);
            result.put("verification", verification);
        } catch (Exception ignored) {
            return failure("RESULT_FORMAT_FAILED", "Android could not format the action result.");
        }
        return result;
    }

    static JSONObject failure(String code, String message) {
        return failure(code, message, null);
    }

    private static JSONObject failure(String code, String message, JSONObject data) {
        JSONObject error = new JSONObject();
        JSONObject result = new JSONObject();
        try {
            error.put("code", code);
            error.put("message", message);
            result.put("ok", false);
            result.put("error", error);
            result.put("verified", false);
            if (data != null) result.put("data", data);
        } catch (Exception ignored) {
            return new JSONObject();
        }
        return result;
    }
}
