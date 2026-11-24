window.kalkiAssistantState = window.kalkiAssistantState || "idle";
window.kalkiVoiceState = window.kalkiVoiceState || { active: false, listening: false, processing: false, status: "" };
function publishKalkiAssistantState(state) {
    window.kalkiAssistantState = state;
    window.dispatchEvent(new CustomEvent("kalki:assistant-state", { detail: { state } }));
    if (state === "solving") window.ensureKalkiEffects?.();
}

document.addEventListener("DOMContentLoaded", () => {
    const chatBox = document.getElementById("chat");
    const messageInput = document.getElementById("msg");
    const sendButton = document.getElementById("send");
    const clearButton = document.getElementById("clear-btn");
    const micButton = document.getElementById("mic-btn");
    const settingsToggle = document.getElementById("settings-toggle");
    const voiceSettings = document.getElementById("voice-settings");
    const apiKeyInput = document.getElementById("gemini-api-key");
    const apiKeyStatus = document.getElementById("gemini-key-status");
    const apiKeySettings = document.getElementById("gemini-api-settings");
    const saveApiKeyButton = document.getElementById("save-api-key");
    const clearApiKeyButton = document.getElementById("clear-api-key");
    const ttsAutoRead = document.getElementById("tts-auto-read");
    const ttsStopButton = document.getElementById("tts-stop-button");
    const ttsStatus = document.getElementById("tts-status");
    const ttsVoiceSelect = document.getElementById("tts-voice-select");
    const ttsVoiceHelp = document.getElementById("tts-voice-help");
    const voiceInputLanguage = document.getElementById("voice-input-language");
    const voiceModeStatus = document.getElementById("voice-mode-status");
    const desktopPairCodeInput = document.getElementById("desktop-pair-code");
    const desktopPairButton = document.getElementById("desktop-pair-button");
    const desktopUnpairButton = document.getElementById("desktop-unpair-button");
    const desktopAgentStatus = document.getElementById("desktop-agent-status");
    if (sendButton) sendButton.addEventListener("click", sendMessage);
    const MEMORY_KEY = "ev_pa_chat_memory";
    const ARCHIVE_KEY = "ev_conversation_archive_v1";
    const TTS_AUTO_READ_KEY = "kalki.tts.autoRead";
    const TTS_VOICE_KEY = "kalki.tts.voiceURI";
    const VOICE_INPUT_LANGUAGE_KEY = "kalki.voice.inputLanguage";
    const VOICE_STOP_PHRASES = new Set([
        "stop", "stop voice", "stop voice chat", "stop voice mode", "stop listening", "stop talking", "end voice chat", "end conversation", "voice off", "turn off voice", "turn off voice chat", "pause voice", "pause voice chat", "cancel voice", "cancel voice chat", "quit voice", "quit voice chat", "goodbye", "that's all", "that's enough",
        "aapu", "aapeyi", "aapey", "aapandi", "voice aapu", "voice aapeyi", "voice aapey", "voice aapandi", "chaalu", "chalu",
        "ఆపు", "ఆపేయి", "ఆపండి", "చాలు", "వాయిస్ ఆపు", "వాయిస్ ఆపేయి", "వాయిస్ ఆపండి", "మాట్లాడటం ఆపు", "మాట్లాడడం ఆపండి", "వినడం ఆపు", "వినడం ఆపండి"
    ]);
    const DESKTOP_AGENT_URL = "http://127.0.0.1:43187";
    let desktopSessionToken = null;
    let activeUtterance = null;
    let activeSpeakButton = null;
    let voiceConversationActive = false;
    let voiceTurnPending = false;
    let recognitionStarting = false;
    let voiceRestartTimer = null;
    const API_KEY_STORAGE = "ev_api_key";
    // PUT YOUR REAL RENDER URL HERE (copy it from the top of your Render service page, no trailing slash).
    const EV_BACKEND_BASE = "https://ev-pa-backend.onrender.com";
    const BACKEND_HEALTH_URL = `${EV_BACKEND_BASE}/api/health`;
    const BACKEND_COMMAND_URL = `${EV_BACKEND_BASE}/api/command`;
    const INTERACTION_URL = `${EV_BACKEND_BASE}/api/interaction/analyze`;
    const BACKEND_CHAT_URL = `${EV_BACKEND_BASE}/api/chat`;
    let voiceErrorStreak = 0;
    function addressName() { return String(conversationPreferences().name || "").trim().slice(0, 40) || "Boss"; }
    // Voice mode switches itself off after this many ms with no speech while the mic is open.
    const VOICE_IDLE_TIMEOUT_MS = 8000;
    let voiceIdleTimer = null;
    function clearVoiceIdleTimer() { window.clearTimeout(voiceIdleTimer); voiceIdleTimer = null; }
    function armVoiceIdleTimer() {
        // Starts once per silent stretch: Chrome restarting the mic does NOT reset the countdown.
        if (voiceIdleTimer || !voiceConversationActive) return;
        voiceIdleTimer = window.setTimeout(() => {
            voiceIdleTimer = null;
            if (!voiceConversationActive || voiceTurnPending || window.speechSynthesis?.speaking) return;
            stopVoiceConversation(false, `No speech for ${VOICE_IDLE_TIMEOUT_MS / 1000} seconds, so I stopped listening. Tap the mic to talk again.`);
        }, VOICE_IDLE_TIMEOUT_MS);
    }

    // ---------------- "Hey EV" wake word (web, foreground only) ----------------
    // A browser can only listen while this page is open and on screen. It cannot listen from the
    // background or with the tab closed; that needs the Android app. Same storage key as Settings.
    const WAKE_KEY = "kalki.wakeEnabled";
    // Say it as two letters: "Hey E V" (heard as ev / e v / e.v. / e-v / ee vee). The name-like "Eve" / "Evie" is NOT accepted.
    const WAKE_PHRASE = /(?:^|[\s,.!?])(?:hey|hay|hai|hi|ok|okay|హే|హాయ్)[\s,.!?]+(?:e[\s'’.\-]*v|ee[\s'’.\-]*vee?|evee|ఈవీ|ఈవి|ఎవి)(?=$|[\s,.:;!?-])[\s,.:;!?-]*(.*)$/i;
    const WAKE_NEAR_MISS = /(?:^|[\s,.!?])(?:hey|hay|hai|hi|ok|okay)[\s,.!?]+(?:eve|evie|eeve|eva)(?=$|[\s,.:;!?-])/i;
    let wakeRecognition = null;
    let wakeEnabled = false;
    let wakeRunning = false;
    let wakeRestartTimer = null;
    let wakeFireTimer = null;
    let wakePendingCommand = "";
    function conversationPreferences() { try { return Object.assign({}, JSON.parse(localStorage.getItem("kalki.preferences") || "{}"), JSON.parse(localStorage.getItem("kalki.conversation") || "{}")); } catch (_) { return {}; } }
    async function analyzeInteraction(text) {
        try { const prefs = conversationPreferences(); const r = await fetch(INTERACTION_URL, {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({text, messages:readMemory().slice(-12), profile:{displayName:prefs.name||"", language:prefs.language||"auto", responseStyle:prefs.style||"short"}, preferences:{askFollowUps:prefs.followUps !== false}})}); return r.ok ? await r.json() : null; } catch (_) { return null; }
    }

    async function sendBackendCommand(text) {
        const response = await fetch(BACKEND_COMMAND_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text })
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data.ok) {
            throw new Error(data.message || "Backend command bridge unavailable.");
        }
        return data.result || {};
    }

    async function checkBackendStatus() {
        try {
            await fetch(BACKEND_HEALTH_URL, { cache: "no-store" });
        } catch (_) {
            // Keep connection diagnostics out of the conversation surface.
        }
    }

    // Fallback models: first one busy ayithe next model try avutundi
    const MODEL_NAMES = [
        "gemini-3.6-flash",
        "gemini-3.5-flash",
        "gemini-3.1-flash-lite"
    ];

    let recognition = null;
    let isListening = false;

    function readMemory() {
        try {
            return JSON.parse(localStorage.getItem(MEMORY_KEY) || "[]");
        } catch (error) {
            return [];
        }
    }

    function saveMemory(memory) {
        localStorage.setItem(
            MEMORY_KEY,
            JSON.stringify(memory.slice(-30))
        );
    }

    function addToMemory(sender, text, type) {
        const memory = readMemory();
        memory.push({ sender, text, type });
        saveMemory(memory);
    }

    function showMessage(sender, text, type, save = true) {
        if (!chatBox) return;

        const message = document.createElement("div");
        message.className = type === "user" ? "msg user" : "msg";

        const senderElement = document.createElement("strong");
        const displaySender = sender === "J.A.R.V.I.S" ? "EV" : sender;
        senderElement.textContent = `${displaySender}: `;

        message.appendChild(senderElement);
        message.appendChild(document.createTextNode(text));
        const canSpeak = type === "ai" && sender !== "SYSTEM" && sender !== "YOU";
        let speakButton = null;
        if (canSpeak) {
            speakButton = document.createElement("button");
            speakButton.type = "button";
            speakButton.className = "speak-button";
            speakButton.textContent = "🔊 Read aloud";
            speakButton.setAttribute("aria-label", `Read ${displaySender}'s reply aloud`);
            speakButton.setAttribute("aria-pressed", "false");
            speakButton.addEventListener("click", () => {
                if (activeSpeakButton === speakButton && window.speechSynthesis?.speaking) stopSpeaking();
                else speak(text, speakButton);
            });
            message.appendChild(speakButton);
        }

        chatBox.appendChild(message);
        document.body.classList.toggle("has-conversation", chatBox.children.length > 0);
        chatBox.scrollTop = chatBox.scrollHeight;

        if (save) addToMemory(sender, text, type);
        if (save && canSpeak && (ttsAutoRead?.checked || voiceConversationActive)) speak(text, speakButton);
    }

    function loadSavedChat() {
        const memory = readMemory();
        const transientStatus = new Set([
            "System online. AI brain ready.",
            "Secure backend and WhatsApp bridge online. Explicit commands only.",
            "Backend online. WhatsApp bridge is not connected.",
            "Backend connection unavailable. Local AI mode active."
        ]);
        memory.forEach((item) => {
            if (transientStatus.has(String(item.text || "").trim())) return;
            const sender = item.sender === "J.A.R.V.I.S" ? "EV" : item.sender;
            showMessage(sender || "EV", item.text || "", item.type || "ai", false);
        });
    }

    function getApiKey() {
        try { return (localStorage.getItem(API_KEY_STORAGE) || "").trim(); }
        catch (_) { return ""; }
    }

    function setApiKeyStatus(message, state = "") {
        if (!apiKeyStatus) return;
        apiKeyStatus.textContent = message;
        apiKeyStatus.classList.toggle("is-saved", state === "saved");
        apiKeyStatus.classList.toggle("is-error", state === "error");
    }

    function refreshApiKeyStatus() {
        if (apiKeyInput) apiKeyInput.value = ""; // Never place a saved secret back into the visible field.
        setApiKeyStatus(getApiKey()
            ? "Key saved locally · not verified with Google."
            : "No key saved on this device.", getApiKey() ? "saved" : "");
    }

    function saveApiKey() {
        const value = apiKeyInput?.value.trim() || "";
        if (!value) {
            setApiKeyStatus("Enter your Gemini API key first. Nothing was saved.", "error");
            apiKeyInput?.focus();
            return;
        }
        // Shape check only. This neither contacts Google nor authenticates the key.
        const plausibleGeminiKey = /^(?:AIza[A-Za-z0-9_-]{20,96}|AQ\.[A-Za-z0-9_-]{20,96})$/.test(value);
        if (!plausibleGeminiKey) {
            setApiKeyStatus("Use a standard AIza… key or an AI Studio authorization key starting AQ. This local format check does not verify the key with Google. Nothing was saved.", "error");
            apiKeyInput?.focus();
            return;
        }
        try {
            localStorage.setItem(API_KEY_STORAGE, value);
            if (apiKeyInput) apiKeyInput.value = "";
            setApiKeyStatus("Key saved locally · format looks plausible only; Google has not verified it.", "saved");
        } catch (_) {
            setApiKeyStatus("Could not save in this browser. Check device storage settings and try again.", "error");
        }
    }

    function clearApiKey() {
        try { localStorage.removeItem(API_KEY_STORAGE); }
        catch (_) { setApiKeyStatus("Could not clear browser-local storage.", "error"); return; }
        if (apiKeyInput) apiKeyInput.value = "";
        setApiKeyStatus("Saved key cleared from this browser/device.");
    }

    function openApiKeySettings() {
        if (voiceSettings) voiceSettings.hidden = false;
        if (settingsToggle) settingsToggle.setAttribute("aria-expanded", "true");
        document.body.classList.add("menu-open");
        setApiKeyStatus("A Gemini API key is required for AI chat replies. Add it here to continue.", "error");
        window.setTimeout(() => {
            apiKeySettings?.scrollIntoView({ behavior: "smooth", block: "center" });
            apiKeyInput?.focus({ preventScroll: true });
        }, 180);
    }

    

async function askGemini(interaction = null) {
    const messages = readMemory()
        .filter(item => item.type === "user" || item.type === "ai")
        .slice(-20)
        .map(item => ({
            role: item.type === "user" ? "user" : "model",
            text: String(item.text || "").trim()
        }))
        .filter(item => item.text);

    if (!messages.length) {
        throw new Error("No conversation messages available.");
    }

    // Render's free plan puts the server to sleep. "Failed to fetch" usually means it is still waking up,
    // so ping /api/health and retry a couple of times before giving up.
    const chatPrefs = conversationPreferences();
    let response = null;
    const waits = [0, 5000, 10000];
    for (let attempt = 0; attempt < waits.length; attempt++) {
        if (waits[attempt]) {
            if (attempt === 1) showMessage("SYSTEM", "Waking up EV's server… this can take up to a minute.", "ai", false);
            await new Promise((resolve) => window.setTimeout(resolve, waits[attempt]));
        }
        try {
            response = await fetch(BACKEND_CHAT_URL, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    messages,
                    profile: { name: String(chatPrefs.name || "").trim(), language: chatPrefs.language || "auto", style: chatPrefs.style || "short" },
                    context: { voice: voiceConversationActive, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }
                }),
                signal: AbortSignal.timeout(40000)
            });
            break;
        } catch (_) {
            fetch(BACKEND_HEALTH_URL, { cache: "no-store" }).catch(() => {});
        }
    }
    if (!response) {
        throw new Error(`Can't reach the EV backend at ${EV_BACKEND_BASE}. Check that the URL is your real Render URL, that the service is Live, and that ALLOWED_ORIGIN matches this site's address.`);
    }

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
        throw new Error(data.message || "EV backend chat failed.");
    }

    if (!data.reply || typeof data.reply !== "string") {
        throw new Error("EV received an empty AI response.");
    }

    return data.reply.trim();
}
    
    function resetSpeakButton() {
        if (activeSpeakButton?.isConnected) {
            activeSpeakButton.textContent = "🔊 Read aloud";
            activeSpeakButton.setAttribute("aria-pressed", "false");
        }
        activeSpeakButton = null;
        activeUtterance = null;
    }

    function stopSpeaking(resumeVoice = true) {
        if ("speechSynthesis" in window) window.speechSynthesis.cancel();
        resetSpeakButton();
        if (resumeVoice && voiceConversationActive) scheduleVoiceListening(350);
    }

    function speak(text, button = null) {
        if (!("speechSynthesis" in window) || !("SpeechSynthesisUtterance" in window)) {
            if (ttsStatus) ttsStatus.textContent = "Text-to-speech is not supported by this browser.";
            if (voiceConversationActive) scheduleVoiceListening(500);
            return;
        }
        stopSpeaking(false);
        clearVoiceIdleTimer();
        if (voiceConversationActive && isListening && recognition) {
            try { recognition.stop(); } catch (_) { /* Already stopped by the browser. */ }
        }
        const utterance = new SpeechSynthesisUtterance(String(text).replace(/\bEV\b/g, "E V")); // read the name as two letters
        const voices = window.speechSynthesis.getVoices();
        const selectedVoice = getSelectedTtsVoice(voices);
        if (selectedVoice) {
            utterance.voice = selectedVoice;
            utterance.lang = selectedVoice.lang || "en-IN";
        } else {
            const hasTeluguScript = Array.from(String(text)).some((character) => {
                const codePoint = character.codePointAt(0) || 0;
                return codePoint >= 0x0C00 && codePoint <= 0x0C7F;
            });
            utterance.lang = hasTeluguScript ? "te-IN" : "en-IN";
        }
        utterance.rate = 0.96;
        activeUtterance = utterance;
        activeSpeakButton = button;
        if (button) {
            button.textContent = "⏹ Stop";
            button.setAttribute("aria-pressed", "true");
        }
        utterance.onend = () => {
            if (activeUtterance !== utterance) return;
            resetSpeakButton();
            if (voiceConversationActive) scheduleVoiceListening(550);
        };
        utterance.onerror = () => {
            if (activeUtterance !== utterance) return;
            resetSpeakButton();
            if (voiceConversationActive) scheduleVoiceListening(700);
        };
        window.speechSynthesis.speak(utterance);
    }

    // Skill router: no background actions. A skill runs only after an explicit command.
    const SKILL_REGISTRY = {
        whatsapp: { name: "WhatsApp", keywords: /\bwhatsapp|message|reply|chat\b/i },
        youtube: { name: "YouTube", keywords: /\b(youtube|video)\b/i },
        search: { name: "Web Search", keywords: /\b(search|google|web|news|weather)\b/i },
        email: { name: "Email", keywords: /\b(email|mail|gmail|outlook)\b/i },
        calendar: { name: "Calendar", keywords: /\b(calendar|schedule|meeting|event)\b/i },
        tasks: { name: "Tasks and Reminders", keywords: /\b(task|reminder|todo)\b/i },
        drive: { name: "Cloud Files", keywords: /\b(drive|file|folder|upload|download)\b/i },
        documents: { name: "Documents", keywords: /\b(pdf|word|docx|excel|xlsx|spreadsheet|powerpoint|pptx)\b/i },
        travel: { name: "Travel", keywords: /\b(flight|hotel|travel|trip)\b/i },
        places: { name: "Places and Restaurants", keywords: /\b(restaurant|place|shop|directions)\b/i },
        prices: { name: "Price Comparison", keywords: /\b(price|cost|cheap|compare|buy)\b/i },
        media: { name: "Image and Media", keywords: /\b(image|photo|picture|edit)\b/i },
        automation: { name: "Multi-step Automation", keywords: /\b(automate|automation|workflow)\b/i },
        memory: { name: "Personal Memory", keywords: /\b(remember|memory|save this)\b/i }
    };

    function detectSkill(text) {
        return Object.entries(SKILL_REGISTRY)
            .find(([, skill]) => skill.keywords.test(text))?.[0] || null;
    }
    function normalizeVoiceStopPhrase(text) {
        return String(text || "").normalize("NFC").toLowerCase()
            .replace(/^\s*(?:kalki|కల్కి)[,\s]*/i, "")
            .replace(/[.,!?;:…]+/g, " ")
            .replace(/\s+/g, " ").trim()
            .replace(/\s+(?:please|now)$/i, "").trim();
    }
    function detectEverydayTool(text) {
        if (/\b(time|what time|samayam)\b/i.test(text)) return "time";
        if (/\b(weather|temperature|varsham)\b/i.test(text)) return "weather";
        if (/\b(timer|countdown|alarm)\b/i.test(text)) return "timer";
        if (/\b(dice|roll|coin|flip|head|tail)\b/i.test(text)) return "dice";
        if (/\b(joke|funny)\b/i.test(text)) return "joke";
        if (/\b(motivat|inspire|quote)\b/i.test(text)) return "motivation";
        if (/\b(tech news|ai news)\b/i.test(text)) return "techNews";
        if (/\b(translate|telugu lo)\b/i.test(text)) return "translate";
        if (/\b(currency|convert|exchange rate|rupees?|inr|dollar)\b/i.test(text)) return "currency";
        if (/\b(meaning|define|dictionary)\b/i.test(text)) return "meaning";
        if (/\b(password)\b/i.test(text)) return "password";
        if (/\b(wikipedia|wiki)\b/i.test(text)) return "wikipedia";
        if (/\b(open|launch)\s+(youtube|yt)\b/i.test(text)) return "openYouTube";
        if (/\b(open|launch)\s+google\b/i.test(text)) return "openGoogle";
        if (/\b(youtube)\b.*\b(song|search|play)\b/i.test(text)) return "youtubeSearch";
        if (/\b(bitcoin|btc)\b/i.test(text)) return "bitcoin";
        return null;
    }

    // Normalize common English–Telugu (and Telugu transliteration) phrases before routing.
    function normalizeCommand(text) {
        return text.trim()
            .replace(/\b(chey|cheyyi|cheyyandi|kavali)\b/gi, "do")
            .replace(/\b(teruvu|open\s+chey|open\s+cheyyi)\b/gi, "open")
            .replace(/\b(pampu|pampinch(u|andi)?|send\s+chey)\b/gi, "send")
            .replace(/\b(cheppu|chepp(u|andi)?|teliyajey)\b/gi, "tell me")
            .replace(/\b(latest)\s+AI\s+(news|vishayalu)\b/gi, "search latest AI news")
            .replace(/\s+/g, " ").trim();
    }

    function isExplicitAction(text) {
        return /\b(open|launch|start|send|reply|message|tell|search|find|create|add|schedule|show|read|do)\b/i.test(text)
            || /చెప్పు|పంపు|చూడు|వెతుకు|తెరువు|చేయి|చెయ్/i.test(text);
    }

    function openWhatsApp() {
        // Non-HTTP scheme is handled by the Android wrapper and cannot send a message.
        const whatsappUrl = "whatsapp://send";
        showMessage("J.A.R.V.I.S", "Opening WhatsApp. No message was sent.", "ai");
        window.location.href = whatsappUrl;
    }
    function handleLocalCommand(text) {
        const command = normalizeCommand(text);
        if (/\b(open|launch|start)\s+(the\s+)?whatsapp\b/i.test(command)
            || /\bwhatsapp\s+(open|launch|start)\b/i.test(command)) {
            if (voiceConversationActive) stopVoiceConversation(true, "Voice chat stopped while opening WhatsApp.");
            openWhatsApp();
            return true;
        }
        return false;
    }

    function setDesktopAgentStatus(message, state = "") {
        if (!desktopAgentStatus) return;
        desktopAgentStatus.textContent = message;
        desktopAgentStatus.classList.toggle("is-saved", state === "connected");
        desktopAgentStatus.classList.toggle("is-error", state === "error");
    }

    function openVoiceSettingsPanel() {
        if (voiceSettings) voiceSettings.hidden = false;
        if (settingsToggle) settingsToggle.setAttribute("aria-expanded", "true");
        document.body.classList.add("menu-open");
    }

    async function pairDesktopAgent() {
        const code = desktopPairCodeInput?.value.trim() || "";
        if (code.length !== 8 || Array.from(code).some((character) => character < "0" || character > "9")) {
            setDesktopAgentStatus("Enter the 8-digit one-time code shown in the desktop agent terminal.", "error");
            desktopPairCodeInput?.focus();
            return;
        }
        if (!window.isSecureContext) {
            setDesktopAgentStatus("Open EV over HTTPS on the same computer as the agent.", "error");
            return;
        }
        setDesktopAgentStatus("Connecting to the local desktop agent…");
        try {
            const response = await fetch(`${DESKTOP_AGENT_URL}/v1/pair`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ code })
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok || !data.ok || !data.token) throw new Error(data.message || "Pairing failed.");
            desktopSessionToken = data.token;
            if (desktopPairCodeInput) desktopPairCodeInput.value = "";
            setDesktopAgentStatus("Paired for this browser session. Each desktop action still needs approval.", "connected");
            refreshPendingDesktopApprovals(true);
        } catch (error) {
            const message = error?.message && error.message !== "Failed to fetch"
                ? error.message
                : "Could not reach the agent. Start it on this computer, allow local-network access, and try again.";
            setDesktopAgentStatus(message, "error");
        }
    }

    function refreshPendingDesktopApprovals(connected) {
        chatBox?.querySelectorAll('.desktop-action-card[data-desktop-state="pending"]').forEach((card) => {
            const approve = card.querySelector(".desktop-approve-button");
            const status = card.querySelector(".desktop-action-status");
            if (approve) approve.disabled = !connected;
            if (status) status.textContent = connected
                ? "Nothing happens until you approve."
                : "Pair the desktop in Settings before approving.";
        });
    }

    function detectDesktopAction(text) {
        const normalized = normalizeCommand(text).replace(/[.!?]+$/g, "").trim();
        const names = "calculator|calc|notes|notepad|text editor|browser|web browser";
        const forward = normalized.match(new RegExp(`^(?:please\\s+)?(?:open|launch|start)\\s+(?:the\\s+)?(${names})(?:\\s+please)?$`, "i"));
        const reverse = normalized.match(new RegExp(`^(${names})\\s+(?:open|launch|start)$`, "i"));
        const requested = (forward?.[1] || reverse?.[1] || "").toLowerCase();
        if (!requested) return null;
        if (requested === "calculator" || requested === "calc") return { id: "calculator", label: "Calculator" };
        if (requested === "notes" || requested === "notepad" || requested === "text editor") return { id: "notes", label: "the text editor" };
        return { id: "browser", label: "a blank tab in your default browser" };
    }

    async function executeDesktopAction(action) {
        if (!desktopSessionToken) throw new Error("Pair this desktop in Settings first.");
        const response = await fetch(`${DESKTOP_AGENT_URL}/v1/command`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${desktopSessionToken}`
            },
            body: JSON.stringify({ action })
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data.ok) {
            if (response.status === 401) {
                desktopSessionToken = null;
                setDesktopAgentStatus("This browser lost its pairing. Restart the agent to create a fresh code.", "error");
                refreshPendingDesktopApprovals(false);
            }
            throw new Error(data.message || "Desktop action was not completed.");
        }
        return data.message || "Desktop action completed.";
    }

    function showDesktopApprovalCard(action) {
        if (!chatBox) return;
        const card = document.createElement("div");
        card.className = "msg desktop-action-card";
        card.dataset.desktopState = "pending";
        const title = document.createElement("strong");
        title.textContent = "EV desktop action";
        const copy = document.createElement("p");
        copy.textContent = `Open ${action.label} on the paired computer?`;
        const status = document.createElement("p");
        status.className = "desktop-action-status";
        status.textContent = desktopSessionToken ? "Nothing happens until you approve." : "Pair the desktop in Settings before approving.";
        const actions = document.createElement("div");
        actions.className = "desktop-action-buttons";
        const approve = document.createElement("button");
        approve.type = "button";
        approve.className = "desktop-approve-button";
        approve.textContent = "Approve & open";
        approve.disabled = !desktopSessionToken;
        const cancel = document.createElement("button");
        cancel.type = "button";
        cancel.className = "desktop-cancel-button";
        cancel.textContent = "Cancel";
        actions.append(approve, cancel);
        card.append(title, copy, status, actions);
        if (!desktopSessionToken) {
            const settingsButton = document.createElement("button");
            settingsButton.type = "button";
            settingsButton.className = "desktop-settings-button";
            settingsButton.textContent = "Open Settings to pair";
            settingsButton.addEventListener("click", openVoiceSettingsPanel);
            card.appendChild(settingsButton);
        }
        cancel.addEventListener("click", () => { card.dataset.desktopState = "cancelled"; status.textContent = "Cancelled. Nothing was opened."; actions.remove(); });
        approve.addEventListener("click", async () => {
            approve.disabled = true;
            cancel.disabled = true;
            status.textContent = "Waiting for the local agent…";
            try {
                const result = await executeDesktopAction(action.id);
                card.dataset.desktopState = "completed";
                status.textContent = result;
            } catch (error) {
                status.textContent = error.message || "Desktop action failed. Nothing else was attempted.";
            }
        });
        chatBox.appendChild(card);
        document.body.classList.add("has-conversation");
        chatBox.scrollTop = chatBox.scrollHeight;
    }

    async function sendMessage() {
        if (!messageInput || !sendButton) return;

        const userText = messageInput.value.trim();
        if (!userText) return;
        if (voiceConversationActive) {
            voiceTurnPending = true;
            clearVoiceIdleTimer();
            if (isListening && recognition) {
                try { recognition.stop(); } catch (_) { /* Recognition may already have ended. */ }
            }
        }

        showMessage("YOU", userText, "user");
        messageInput.value = "";

        const commandText = normalizeCommand(userText);
        const spokenControl = normalizeVoiceStopPhrase(userText);
        if (voiceConversationActive && VOICE_STOP_PHRASES.has(spokenControl)) {
            stopVoiceConversation(true);
            showMessage("EV", "Voice conversation stopped.", "ai");
            if (!ttsAutoRead?.checked) speak("Voice conversation stopped.");
            return;
        }
        const desktopAction = detectDesktopAction(commandText);
        if (desktopAction) {
            showDesktopApprovalCard(desktopAction);
            if (voiceConversationActive) {
                showMessage("EV", "I paused voice listening. Please approve this desktop action on screen before it opens.", "ai");
                stopVoiceConversation(true, "Waiting for your on-screen approval.");
            }
            return;
        }
        const everydayTool = detectEverydayTool(commandText);
        const requestedSkill = detectSkill(commandText);
        if ((everydayTool || requestedSkill) && isExplicitAction(commandText)) {
            if (requestedSkill === "whatsapp" && handleLocalCommand(commandText)) return;
            try {
                const result = await sendBackendCommand(commandText);
                showMessage("EV", result.message || "Command received.", "ai");
                if (result.url && result.executed && (result.tool === "openYouTube" || result.tool === "openGoogle" || result.tool === "youtubeSearch" || result.tool === "wikipedia")) window.open(result.url, "_blank", "noopener");
                if (result.notify && result.seconds) {
                    window.setTimeout(() => { const text = "⏰ Timer complete!"; showMessage("EV", text, "ai"); if (!ttsAutoRead?.checked && !voiceConversationActive) speak(text); if (window.Notification && Notification.permission === "granted") new Notification("EV", { body: text }); }, result.seconds * 1000);
                    if (window.Notification && Notification.permission === "default") Notification.requestPermission().catch(() => {});
                } else if (result.speak && !ttsAutoRead?.checked && !voiceConversationActive) speak(result.message || "Done");
            } catch (error) {
                console.error("EV backend bridge error:", error);
                showMessage("SYSTEM", "Backend command bridge unavailable. Nothing was executed.", "ai");
                if (voiceConversationActive) stopVoiceConversation(true, "Voice chat paused because the backend failed. Tap the mic to retry.");
            } finally {
                finishVoiceTurn();
            }
            return;
        }

        if (handleLocalCommand(userText)) {
            finishVoiceTurn();
            return;
        }
        messageInput.disabled = true;
        sendButton.disabled = true;
        sendButton.textContent = "...";
        publishKalkiAssistantState("solving");

        try {
            const interaction = await analyzeInteraction(userText);
            if (interaction?.clarification?.question) { showMessage("EV", interaction.clarification.question, "ai"); return; }
            const reply = await askGemini(interaction);
            showMessage("EV", reply, "ai");
        } catch (error) {
            console.error("EV AI Error:", error);
            showMessage("SYSTEM", error.message, "ai");
            if (voiceConversationActive) stopVoiceConversation(true, "Voice chat paused because EV could not answer. Tap the mic to retry.");
        } finally {
            publishKalkiAssistantState("idle");
            messageInput.disabled = false;
            sendButton.disabled = false;
            sendButton.textContent = "SEND";
            finishVoiceTurn();
            if (!voiceConversationActive) messageInput.focus();
        }
    }

    function clearChat() {
        stopSpeaking();
        localStorage.removeItem(MEMORY_KEY);
        if (chatBox) chatBox.replaceChildren();
        document.body.classList.remove("has-conversation");
        if (messageInput) messageInput.value = "";
    }

async function startNewConversation() {
    const newChatButton = document.getElementById("new-chat-btn");
    const transcript = readMemory()
        .filter(item =>
            (item.type === "user" || item.type === "ai") &&
            String(item.text || "").trim()
        )
        .slice(-30);

    if (!transcript.length) {
        clearChat();
        return;
    }

    if (newChatButton) newChatButton.disabled = true;

    if (voiceConversationActive) {
        stopVoiceConversation(false, "Saving the previous conversation...");
    } else {
        stopSpeaking(false);
    }

    showMessage("SYSTEM", "EV is summarizing this conversation before starting a new one...", "ai", false);

    try {
        const messages = transcript.map(item => ({
            role: item.type === "user" ? "user" : "model",
            text: String(item.text || "").trim()
        }));

        messages.push({
            role: "user",
            text: "Create a concise but useful memory summary of the conversation above. Preserve important facts, decisions, preferences, unfinished tasks, and next steps. Do not invent details. Return only the summary."
        });

        const response = await fetch(BACKEND_CHAT_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                messages,
                profile: { name: "", language: "auto", style: "short" },
                context: {
                    task: "conversation_summary",
                    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone
                }
            }),
            signal: AbortSignal.timeout(40000)
        });

        const data = await response.json().catch(() => ({}));

        if (!response.ok || typeof data.reply !== "string" || !data.reply.trim()) {
            throw new Error(data.message || "EV could not create the conversation summary.");
        }

        const archive = JSON.parse(localStorage.getItem(ARCHIVE_KEY) || "[]");

        archive.push({
            summary: data.reply.trim(),
            savedAt: new Date().toISOString(),
            messageCount: transcript.length
        });

        localStorage.setItem(ARCHIVE_KEY, JSON.stringify(archive.slice(-25)));

        clearChat();
        showMessage("SYSTEM", "Previous conversation summarized and saved. EV is ready for a fresh conversation.", "ai", false);

    } catch (error) {
        console.error("[EV conversation archive]", error);
        showMessage("SYSTEM", "I couldn't save the summary. Your previous conversation is still here. Please try again.", "ai", false);
    } finally {
        if (newChatButton) newChatButton.disabled = false;
    }
}
    
    function setVoiceModeStatus(message, active = voiceConversationActive) {
        const voiceState = {
            active: Boolean(active),
            listening: Boolean(active && isListening && !voiceTurnPending),
            processing: Boolean(active && voiceTurnPending),
            status: String(message || "")
        };
        window.kalkiVoiceState = voiceState;
        window.dispatchEvent(new CustomEvent("kalki:voice-state", { detail: voiceState }));
        if (active) window.ensureKalkiEffects?.();
        if (voiceModeStatus) {
            voiceModeStatus.textContent = message;
            voiceModeStatus.classList.toggle("is-active", active);
        }
        if (micButton) {
            micButton.textContent = active ? "⏹" : "🎙";
            micButton.setAttribute("aria-label", active ? "Stop voice conversation" : "Start voice conversation");
            micButton.setAttribute("title", active ? "Stop voice conversation" : "Start voice conversation");
            micButton.setAttribute("aria-pressed", String(active));
            micButton.classList.toggle("is-voice-active", active);
        }
    }

    function scheduleVoiceListening(delay = 500) {
        window.clearTimeout(voiceRestartTimer);
        if (!voiceConversationActive || voiceTurnPending || document.hidden) return;
        voiceRestartTimer = window.setTimeout(beginVoiceListening, delay);
    }

    function beginVoiceListening() {
        if (!voiceConversationActive || !recognition || isListening || recognitionStarting || voiceTurnPending || document.hidden) return;
        if (window.speechSynthesis?.speaking || window.speechSynthesis?.pending) {
            scheduleVoiceListening(450);
            return;
        }
        if (voiceInputLanguage && recognition.lang !== voiceInputLanguage.value) recognition.lang = voiceInputLanguage.value;
        recognitionStarting = true;
        try {
            recognition.start();
        } catch (_) {
            recognitionStarting = false;
            stopVoiceConversation(false, "Could not start the microphone. Check permission, then tap the mic to retry.");
        }
    }

    function finishVoiceTurn() {
        voiceTurnPending = false;
        if (!voiceConversationActive) return;
        if (window.speechSynthesis?.speaking || window.speechSynthesis?.pending) return;
        scheduleVoiceListening(550);
    }

    function startVoiceConversation() {
        if (!recognition) {
            setVoiceModeStatus("Voice input is not supported in this browser. Try Chrome or Edge.", false);
            return;
        }
        if (voiceConversationActive) return;
        pauseWake();
        stopSpeaking(false);
        voiceErrorStreak = 0;
        voiceConversationActive = true;
        voiceTurnPending = false;
        if ("speechSynthesis" in window && "SpeechSynthesisUtterance" in window) {
            setVoiceModeStatus("Voice chat is on. Listening after the greeting…", true);
            speak(`EV online. I’m listening, ${addressName()}.`, null);
        } else {
            setVoiceModeStatus("Voice chat is on. Speak after the microphone starts.", true);
            beginVoiceListening();
        }
    }

    function stopVoiceConversation(keepSpeech = false, statusMessage = "Voice conversation stopped.") {
        const recognitionMayBeActive = isListening || recognitionStarting;
        voiceConversationActive = false;
        voiceTurnPending = false;
        recognitionStarting = false;
        window.clearTimeout(voiceRestartTimer);
        clearVoiceIdleTimer();
        if (recognition && recognitionMayBeActive) {
            try { recognition.stop(); } catch (_) { /* Already stopped by the browser. */ }
        }
        if (!keepSpeech) stopSpeaking(false);
        setVoiceModeStatus(statusMessage, false);
        if (wakeEnabled) scheduleWakeListening(900);
    }

    function toggleVoice() {
        if (voiceConversationActive) stopVoiceConversation();
        else startVoiceConversation();
    }

    function setupVoice() {
        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SpeechRecognition) {
            setVoiceModeStatus("Voice chat needs a browser with speech recognition, such as Chrome or Edge.", false);
            return;
        }

        recognition = new SpeechRecognition();
        recognition.lang = voiceInputLanguage?.value || "en-IN";
        recognition.continuous = false;
        recognition.interimResults = true; // interim results prove you are still talking, so the 8s timer never cuts a long sentence

        recognition.onstart = () => {
            recognitionStarting = false;
            isListening = true;
            if (!voiceConversationActive) {
                try { recognition.stop(); } catch (_) { /* Stop a late start after the user has exited voice mode. */ }
                return;
            }
            armVoiceIdleTimer();
            setVoiceModeStatus(`Listening… speak naturally. Stops after ${VOICE_IDLE_TIMEOUT_MS / 1000}s of silence.`, true);
        };

        recognition.onspeechstart = () => { clearVoiceIdleTimer(); };

        recognition.onresult = (event) => {
            clearVoiceIdleTimer(); // any result (even interim) means speech is happening
            const text = Array.from(event.results || [])
                .filter((result) => result.isFinal)
                .map((result) => result[0]?.transcript || "")
                .join(" ").trim();
            if (!text || !messageInput || !voiceConversationActive) return;
            voiceErrorStreak = 0;
            messageInput.value = text;
            voiceTurnPending = true;
            setVoiceModeStatus("Heard you. EV is thinking…", true);
            sendMessage();
        };

        recognition.onerror = (event) => {
            recognitionStarting = false;
            isListening = false;
            const code = event?.error || "unknown";
            if (code === "not-allowed" || code === "service-not-allowed" || code === "audio-capture") {
                stopVoiceConversation(false, "Microphone unavailable. Check the browser permission and tap the mic to retry.");
                return;
            }
            if (voiceConversationActive) {
                if (code !== "no-speech") voiceErrorStreak += 1;
                if (code === "network" || code === "language-not-supported") {
                    stopVoiceConversation(false, "This browser can't reach its speech service (Brave and some browsers block it). Use Chrome or Edge, then tap the mic.");
                    return;
                }
                if (voiceErrorStreak >= 3) {
                    stopVoiceConversation(false, code === "no-speech" ? "I didn’t hear anything, so I stopped listening. Tap the mic when you're ready." : "Voice input keeps failing, so I stopped. Tap the mic to retry.");
                    return;
                }
                setVoiceModeStatus(code === "no-speech" ? "I didn’t hear anything. Listening again…" : "Voice input paused briefly. Trying again…", true);
                scheduleVoiceListening(850);
            }
        };

        recognition.onend = () => {
            recognitionStarting = false;
            isListening = false;
            if (!voiceConversationActive || voiceTurnPending || window.speechSynthesis?.speaking) return;
            setVoiceModeStatus("Listening again…", true);
            scheduleVoiceListening(500);
        };

        document.addEventListener("visibilitychange", () => {
            if (document.hidden && voiceConversationActive) {
                stopVoiceConversation(false, "Voice chat stopped because EV is in the background.");
            }
        });
        window.addEventListener("pagehide", () => {
            if (voiceConversationActive) stopVoiceConversation(false, "Voice chat stopped.");
        });
    }

    function updateWakeButton() {
        const button = document.getElementById("wake-btn");
        if (!button) return;
        button.textContent = wakeEnabled ? "👂 “Hey EV” is on" : "👂 Turn on “Hey EV”";
        button.setAttribute("aria-pressed", String(wakeEnabled));
    }

    function scheduleWakeListening(delay = 500) {
        window.clearTimeout(wakeRestartTimer);
        if (!wakeEnabled) return;
        wakeRestartTimer = window.setTimeout(beginWakeListening, delay);
    }

    function beginWakeListening() {
        if (!wakeEnabled || !wakeRecognition || wakeRunning || voiceConversationActive || document.hidden) return;
        if (window.speechSynthesis?.speaking || window.speechSynthesis?.pending) {
            scheduleWakeListening(600); // don't listen while EV is talking, so it can't wake itself
            return;
        }
        try {
            wakeRecognition.start();
        } catch (_) { /* already started */ }
    }

    function pauseWake() {
        window.clearTimeout(wakeRestartTimer);
        window.clearTimeout(wakeFireTimer);
        wakeFireTimer = null;
        wakePendingCommand = "";
        if (wakeRecognition && wakeRunning) {
            try { wakeRecognition.abort(); } catch (_) { /* already stopped */ }
        }
        wakeRunning = false;
    }

    function setWakeEnabled(on, message = "") {
        wakeEnabled = Boolean(on);
        try { localStorage.setItem(WAKE_KEY, String(wakeEnabled)); } catch (_) { /* storage blocked */ }
        updateWakeButton();
        if (wakeEnabled) {
            if (!wakeRecognition) {
                wakeEnabled = false;
                updateWakeButton();
                setVoiceModeStatus("Wake word needs Chrome or Edge.", false);
                return;
            }
            if (!voiceConversationActive) beginWakeListening(); // called from a tap so the mic permission prompt can show
        } else {
            pauseWake();
            if (!voiceConversationActive) setVoiceModeStatus(message || "“Hey EV” is off. Tap 🎙 to talk.", false);
        }
    }

    function startVoiceFromWake(command) {
        if (!recognition || voiceConversationActive) return;
        stopSpeaking(false);
        voiceErrorStreak = 0;
        voiceConversationActive = true;
        voiceTurnPending = false;
        if (command) {
            // "Hey EV what's the time": the command was said in the same breath
            setVoiceModeStatus("Heard “Hey EV”. Working on it…", true);
            messageInput.value = command;
            voiceTurnPending = true;
            sendMessage();
            return;
        }
        setVoiceModeStatus("Yes? I'm listening…", true);
        if ("speechSynthesis" in window && "SpeechSynthesisUtterance" in window) speak(`Yes, ${addressName()}?`, null);
        else beginVoiceListening();
    }

    function fireWake() {
        window.clearTimeout(wakeFireTimer);
        wakeFireTimer = null;
        if (!wakeEnabled || voiceConversationActive) return;
        const command = wakePendingCommand.trim();
        pauseWake();
        startVoiceFromWake(command.length >= 2 ? command : "");
    }

    function setupWake() {
        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        const button = document.getElementById("wake-btn");
        if (button) button.addEventListener("click", () => setWakeEnabled(!wakeEnabled));
        if (!SpeechRecognition) {
            if (button) { button.disabled = true; button.textContent = "👂 “Hey EV” needs Chrome or Edge"; }
            return;
        }

        wakeRecognition = new SpeechRecognition();
        wakeRecognition.lang = "en-IN";
        wakeRecognition.continuous = true;
        wakeRecognition.interimResults = true;

        wakeRecognition.onstart = () => {
            wakeRunning = true;
            if (!wakeEnabled || voiceConversationActive) { try { wakeRecognition.abort(); } catch (_) { /* late start */ } return; }
            setVoiceModeStatus("Say “Hey EV” any time. Keep this tab open and on screen.", false);
        };

        wakeRecognition.onresult = (event) => {
            if (!wakeEnabled || voiceConversationActive || !event.results?.length) return;
            const latest = event.results[event.results.length - 1];
            const transcript = String(latest?.[0]?.transcript || "");
            const match = WAKE_PHRASE.exec(transcript);
            if (!match) {
                if (latest.isFinal && WAKE_NEAR_MISS.test(transcript)) {
                    setVoiceModeStatus("Heard “" + transcript.trim().slice(0, 40) + "”. Say it as two letters: “Hey E V”.", false);
                }
                return;
            }
            wakePendingCommand = String(match[1] || "");
            window.clearTimeout(wakeFireTimer);
            // Wait a moment for the rest of the sentence, unless the recogniser already finished it.
            if (latest.isFinal) fireWake();
            else wakeFireTimer = window.setTimeout(fireWake, 1100);
        };

        wakeRecognition.onerror = (event) => {
            wakeRunning = false;
            const code = event?.error || "unknown";
            if (code === "not-allowed" || code === "service-not-allowed" || code === "audio-capture") {
                setWakeEnabled(false, "Microphone blocked, so “Hey EV” is off. Allow the mic for this site, then tap 👂.");
            } else if (code === "network" || code === "language-not-supported") {
                setWakeEnabled(false, "This browser can't reach its speech service (Brave and some browsers block it). Use Chrome or Edge.");
            }
            // no-speech / aborted are normal; onend restarts the listener
        };

        wakeRecognition.onend = () => {
            wakeRunning = false;
            if (wakeEnabled && !voiceConversationActive && !wakeFireTimer) scheduleWakeListening(400);
        };

        document.addEventListener("visibilitychange", () => {
            if (document.hidden) pauseWake();
            else if (wakeEnabled && !voiceConversationActive) scheduleWakeListening(500);
        });
        window.addEventListener("pagehide", pauseWake);

        let saved = false;
        try { saved = localStorage.getItem(WAKE_KEY) === "true"; } catch (_) { /* storage blocked */ }
        wakeEnabled = saved;
        updateWakeButton();
        if (wakeEnabled) scheduleWakeListening(800); // if the browser needs a tap first, onerror turns it off cleanly
    }

    function installAndroidSharePreview() {
        const preview = document.getElementById("kalki-share-preview");
        const summary = document.getElementById("share-summary");
        const files = document.getElementById("share-files");
        const dismiss = document.getElementById("share-dismiss");
        if (!preview) return;
        let shared = null;
        function clearPreview() { shared = null; preview.hidden = true; if (files) files.replaceChildren(); }
        dismiss?.addEventListener("click", clearPreview);
        document.querySelectorAll("[data-share-action]").forEach((button) => button.addEventListener("click", () => {
            if (!shared) return;
            const action = button.dataset.shareAction;
            const subject = shared.title ? `\nTitle: ${shared.title}` : "";
            const body = shared.text ? `\nContent: ${shared.text}` : "\nContent: Shared file content is available for review in the originating app.";
            if (messageInput) { messageInput.value = `${action} this shared content.${subject}${body}\n\n[Draft — review and press Send to approve]`; messageInput.focus(); }
            showMessage("EV", `${action} draft prepared. Review it in the composer; no action was sent or executed.`, "ai");
        }));
        window.addEventListener("kalki-share", (event) => {
            shared = event.detail || {};
            const type = shared.mimeType || "shared content";
            const text = shared.text ? shared.text : `Received ${type}`;
            if (summary) summary.textContent = text;
            if (files) {
                files.replaceChildren(...(Array.isArray(shared.files) ? shared.files.map((file) => {
                    const row = document.createElement("div");
                    row.textContent = `📎 ${file.name || "Shared item"} · ${file.mimeType || type}`;
                    return row;
                }) : []));
            }
            preview.hidden = false;
            preview.scrollIntoView({ behavior: "smooth", block: "nearest" });
        });
    }

    function voiceOptionValue(voice) {
        return voice.voiceURI || `${voice.name}::${voice.lang}`;
    }

    function getSelectedTtsVoice(voices) {
        const selected = ttsVoiceSelect?.value || "auto";
        if (selected === "auto") return null;
        return voices.find((voice) => voiceOptionValue(voice) === selected) || null;
    }

    function populateTtsVoiceOptions() {
        if (!ttsVoiceSelect) return;
        if (!("speechSynthesis" in window)) {
            const option = document.createElement("option");
            option.value = "auto";
            option.textContent = "Browser default voice";
            ttsVoiceSelect.replaceChildren(option);
            ttsVoiceSelect.value = "auto";
            return;
        }

        const voices = window.speechSynthesis.getVoices();
        let saved = "";
        try { saved = localStorage.getItem(TTS_VOICE_KEY) || ""; } catch (_) { /* Use a session-only choice. */ }
        const previous = ttsVoiceSelect.value;
        const autoOption = document.createElement("option");
        autoOption.value = "auto";
        autoOption.textContent = "Automatic by reply language";
        const options = [autoOption, ...voices.map((voice) => {
            const option = document.createElement("option");
            option.value = voiceOptionValue(voice);
            option.textContent = `${voice.name} · ${voice.lang || "device voice"}`;
            return option;
        })];
        ttsVoiceSelect.replaceChildren(...options);
        if (saved === "auto") {
            ttsVoiceSelect.value = "auto";
            if (ttsVoiceHelp) ttsVoiceHelp.textContent = "EV will follow the browser’s language-based voice choice.";
            return;
        }

        const chosen = voices.find((voice) => voiceOptionValue(voice) === saved)
            || voices.find((voice) => voiceOptionValue(voice) === previous)
            || voices.find((voice) => voice.lang?.toLowerCase() === (voiceInputLanguage?.value || "en-IN").toLowerCase())
            || voices.find((voice) => voice.lang?.toLowerCase().startsWith("en-in"))
            || voices.find((voice) => voice.default)
            || voices[0];
        if (chosen) {
            ttsVoiceSelect.value = voiceOptionValue(chosen);
            try { localStorage.setItem(TTS_VOICE_KEY, ttsVoiceSelect.value); } catch (_) { /* Keep this choice for this page only. */ }
            if (ttsVoiceHelp) ttsVoiceHelp.textContent = `EV will keep using ${chosen.name} (${chosen.lang}) on this device. Choose a Telugu voice if available for Telugu pronunciation.`;
        } else {
            ttsVoiceSelect.value = "auto";
            if (ttsVoiceHelp) ttsVoiceHelp.textContent = "No device voice list is available yet; EV will use your browser’s default voice.";
        }
    }

    function initializeVoiceControls() {
        if (voiceInputLanguage) {
            let savedLanguage = "en-IN";
            try { savedLanguage = localStorage.getItem(VOICE_INPUT_LANGUAGE_KEY) || savedLanguage; } catch (_) { /* Keep default. */ }
            if (!["en-IN", "te-IN"].includes(savedLanguage)) savedLanguage = "en-IN";
            voiceInputLanguage.value = savedLanguage;
            voiceInputLanguage.addEventListener("change", () => {
                const language = voiceInputLanguage.value === "te-IN" ? "te-IN" : "en-IN";
                try { localStorage.setItem(VOICE_INPUT_LANGUAGE_KEY, language); } catch (_) { /* Session-only preference. */ }
                if (recognition) recognition.lang = language;
                if (voiceConversationActive) {
                    if (isListening && recognition) recognition.stop();
                    else scheduleVoiceListening(150);
                }
            });
        }
        ttsVoiceSelect?.addEventListener("change", () => {
            try { localStorage.setItem(TTS_VOICE_KEY, ttsVoiceSelect.value); } catch (_) { /* Use this page's selection only. */ }
            const voice = getSelectedTtsVoice(window.speechSynthesis?.getVoices?.() || []);
            if (ttsVoiceHelp) ttsVoiceHelp.textContent = voice
                ? `EV will keep using ${voice.name} (${voice.lang}) on this device.`
                : "EV will follow the browser’s language-based voice choice.";
        });
        if ("speechSynthesis" in window) {
            populateTtsVoiceOptions();
            window.speechSynthesis.onvoiceschanged = populateTtsVoiceOptions;
        } else {
            populateTtsVoiceOptions();
        }
    }

    if (ttsAutoRead) {
        try { ttsAutoRead.checked = localStorage.getItem(TTS_AUTO_READ_KEY) === "true"; }
        catch (_) { ttsAutoRead.checked = false; }
        if (ttsStatus) ttsStatus.textContent = ttsAutoRead.checked
            ? "Text replies will be read aloud automatically. Voice chat always speaks while active."
            : "Text chat stays quiet unless you tap Read aloud. Voice chat speaks while active.";
        ttsAutoRead.addEventListener("change", () => {
            try { localStorage.setItem(TTS_AUTO_READ_KEY, String(ttsAutoRead.checked)); }
            catch (_) { /* The per-message speaker remains available if storage is disabled. */ }
            if (ttsStatus) ttsStatus.textContent = ttsAutoRead.checked
                ? "Text replies will be read aloud automatically. Voice chat always speaks while active."
                : "Text chat stays quiet unless you tap Read aloud. Voice chat speaks while active.";
        });
    }
    ttsStopButton?.addEventListener("click", () => {
        stopSpeaking();
        if (ttsStatus) ttsStatus.textContent = "Speech stopped.";
    });
    if (!("speechSynthesis" in window) && ttsStatus) {
        ttsStatus.textContent = "This browser does not provide text-to-speech.";
    }
    desktopPairButton?.addEventListener("click", pairDesktopAgent);
    desktopPairCodeInput?.addEventListener("keydown", (event) => {
        if (event.key === "Enter") { event.preventDefault(); pairDesktopAgent(); }
    });
    desktopUnpairButton?.addEventListener("click", async () => {
        if (!desktopSessionToken) {
            setDesktopAgentStatus("No active pairing in this page. Restart the agent if it is still paired elsewhere.");
            return;
        }
        try {
            const response = await fetch(`${DESKTOP_AGENT_URL}/v1/disconnect`, {
                method: "POST",
                headers: { "Content-Type": "application/json", "Authorization": `Bearer ${desktopSessionToken}` },
                body: JSON.stringify({})
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok || !data.ok) throw new Error(data.message || "Could not disconnect.");
            desktopSessionToken = null;
            setDesktopAgentStatus(data.message || "Disconnected. The agent created a new one-time code.");
            refreshPendingDesktopApprovals(false);
        } catch (_) {
            desktopSessionToken = null;
            setDesktopAgentStatus("Could not reach the agent. This page cleared its token; restart the agent to reset pairing.", "error");
            refreshPendingDesktopApprovals(false);
        }
    });

    settingsToggle?.addEventListener("click", () => {
        const open = voiceSettings?.hasAttribute("hidden");
        if (voiceSettings) voiceSettings.hidden = !open;
        settingsToggle.setAttribute("aria-expanded", String(open));
    });
    saveApiKeyButton?.addEventListener("click", saveApiKey);
    clearApiKeyButton?.addEventListener("click", clearApiKey);
    apiKeyInput?.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); saveApiKey(); } });

    
    if (clearButton) clearButton.addEventListener("click", clearChat);
    if (micButton) micButton.addEventListener("click", toggleVoice);

    if (messageInput) {
        messageInput.addEventListener("keydown", (event) => {
            if (event.key === "Enter") {
                event.preventDefault();
                sendMessage();
            }
        });
    }

    installAndroidSharePreview();
    initializeVoiceControls();
    setupVoice();
    setupWake();
    loadSavedChat();
    refreshApiKeyStatus();
    checkBackendStatus();
    console.log("EV AI fallback system loaded successfully.");
});
