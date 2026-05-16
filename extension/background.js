/*
 * Select-to-Detect — Background Service Worker
 * Handles communication between content script and hosted Flask API.
 */

const API_BASE = "https://rahuldewangan01-ai-image-detector.hf.space";

// ── Listen for keyboard shortcut command ─────────────────────────
chrome.commands.onCommand.addListener((command) => {
  if (command === "toggle-circle-mode") {
    activateOnCurrentTab();
  }
});

// ── Listen for extension icon click (as backup activation) ───────
chrome.action.onClicked.addListener((tab) => {
  activateOnCurrentTab();
});

// ── Listen for messages from content script / popup ──────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "predict") {
    handlePrediction(message, sendResponse);
    return true; // async response
  }

  if (message.action === "health-check") {
    handleHealthCheck(sendResponse);
    return true;
  }

  if (message.action === "capture-screenshot") {
    handleScreenshotCapture(message, sender, sendResponse);
    return true; // async response
  }

  if (message.action === "activate-tab") {
    activateOnCurrentTab();
    sendResponse({ status: "ok" });
    return false;
  }
});

// ── Inject content script + activate ─────────────────────────────
async function activateOnCurrentTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) return;

    // Skip chrome:// and edge:// pages
    if (tab.url && (tab.url.startsWith("chrome://") || tab.url.startsWith("edge://") || tab.url.startsWith("about:"))) {
      console.log("Select-to-Detect: Cannot run on browser internal pages");
      return;
    }

    // Try to send message first (content script already loaded)
    try {
      await chrome.tabs.sendMessage(tab.id, { action: "toggle-circle-mode" });
      console.log("Select-to-Detect: Activated via existing content script");
    } catch (e) {
      // Content script not injected yet — inject it now
      console.log("Select-to-Detect: Injecting content script on tab", tab.id);

      await chrome.scripting.insertCSS({
        target: { tabId: tab.id },
        files: ["content.css"],
      });

      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["content.js"],
      });

      // Small delay then send activate message
      setTimeout(async () => {
        try {
          await chrome.tabs.sendMessage(tab.id, { action: "toggle-circle-mode" });
          console.log("Select-to-Detect: Activated after injection");
        } catch (err) {
          console.error("Select-to-Detect: Failed to activate after injection", err);
        }
      }, 200);
    }
  } catch (err) {
    console.error("Select-to-Detect: Activation error", err);
  }
}

// ── API communication ────────────────────────────────────────────
async function handlePrediction(message, sendResponse) {
  try {
    const body = {};

    if (message.imageUrl) {
      body.image_url = message.imageUrl;
    } else if (message.imageBase64) {
      body.image_base64 = message.imageBase64;
    } else {
      sendResponse({ error: "No image data provided" });
      return;
    }

    const response = await fetch(`${API_BASE}/predict`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const result = await response.json();

    if (!response.ok) {
      sendResponse({ error: result.error || "Server error" });
      return;
    }

    // Save to history
    saveToHistory(result, message.imageUrl || "base64-image");

    sendResponse(result);
  } catch (err) {
    console.error("Select-to-Detect: API error", err);
    sendResponse({
      error: "Cannot connect to hosted API. The Space may still be waking up.",
    });
  }
}

async function handleHealthCheck(sendResponse) {
  try {
    const response = await fetch(`${API_BASE}/health`, { method: "GET" });
    const data = await response.json();
    sendResponse(data);
  } catch (err) {
    sendResponse({
      status: "offline",
      message: "Hosted API not reachable. Try again after the Space wakes up.",
    });
  }
}

// ── Screenshot capture (CORS fallback for Instagram, etc.) ──────
async function handleScreenshotCapture(message, sender, sendResponse) {
  try {
    const tab = sender.tab;
    if (!tab || !tab.windowId) {
      sendResponse({ error: "No active tab for screenshot" });
      return;
    }

    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
      format: "png",
      quality: 100,
    });

    const crop = message.crop;
    if (!crop || !crop.w || !crop.h) {
      // No crop info — send the full screenshot
      sendResponse({ imageBase64: dataUrl });
      return;
    }

    // Crop the screenshot to the image region using OffscreenCanvas
    const resp = await fetch(dataUrl);
    const blob = await resp.blob();
    const bitmap = await createImageBitmap(blob);

    // Clamp crop values to screenshot bounds
    const sx = Math.max(0, Math.min(crop.x, bitmap.width - 1));
    const sy = Math.max(0, Math.min(crop.y, bitmap.height - 1));
    const sw = Math.min(crop.w, bitmap.width - sx);
    const sh = Math.min(crop.h, bitmap.height - sy);

    const offscreen = new OffscreenCanvas(sw, sh);
    const octx = offscreen.getContext("2d");
    octx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);

    const croppedBlob = await offscreen.convertToBlob({ type: "image/png" });
    const reader = new FileReader();
    reader.onloadend = () => {
      sendResponse({ imageBase64: reader.result });
    };
    reader.readAsDataURL(croppedBlob);
  } catch (err) {
    console.error("Select-to-Detect: Screenshot capture error", err);
    sendResponse({ error: "Screenshot capture failed: " + err.message });
  }
}

// ── History management ───────────────────────────────────────────
async function saveToHistory(result, source) {
  try {
    const { history = [] } = await chrome.storage.local.get("history");
    history.unshift({
      prediction: result.prediction,
      confidence: result.confidence,
      prob_ai: result.prob_ai,
      prob_real: result.prob_real,
      source: source.substring(0, 80),
      timestamp: Date.now(),
    });
    // Keep only last 20 entries
    if (history.length > 20) history.length = 20;
    await chrome.storage.local.set({ history });
  } catch (e) {
    console.error("Failed to save history", e);
  }
}
