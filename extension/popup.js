/*
 * Circle-to-Detect — Popup Logic
 * Handles activation button, server health check, and detection history.
 */

document.addEventListener("DOMContentLoaded", () => {
  const activateBtn   = document.getElementById("activate-btn");
  const statusDot     = document.getElementById("status-dot");
  const statusText    = document.getElementById("status-text");
  const historySection = document.getElementById("history-section");
  const historyList   = document.getElementById("history-list");

  // ── Check server health ────────────────────────────────────
  checkServerHealth();

  // ── Activate button ────────────────────────────────────────
  activateBtn.addEventListener("click", () => {
    chrome.runtime.sendMessage({ action: "activate-tab" }, () => {
      window.close(); // Close popup after activating
    });
  });

  // ── Load history ───────────────────────────────────────────
  loadHistory();

  // ── Server health check ────────────────────────────────────
  function checkServerHealth() {
    chrome.runtime.sendMessage({ action: "health-check" }, (response) => {
      if (chrome.runtime.lastError) {
        setStatus("offline", "Extension error");
        return;
      }

      if (response && response.status === "ok") {
        setStatus("online", `Server running · ${response.device || "CPU"}`);
        activateBtn.disabled = false;
      } else {
        setStatus("offline", response?.message || "Hosted API offline");
        activateBtn.disabled = true;
      }
    });
  }

  function setStatus(state, text) {
    statusDot.className = "status-dot " + state;
    statusText.textContent = text;
  }

  // ── History ────────────────────────────────────────────────
  function loadHistory() {
    chrome.storage.local.get("history", ({ history = [] }) => {
      if (history.length === 0) {
        historySection.style.display = "none";
        return;
      }

      historySection.style.display = "block";
      historyList.innerHTML = "";

      history.slice(0, 5).forEach((item) => {
        const el = document.createElement("div");
        el.className = "history-item";

        const isAI = item.prediction === "AI";
        const timeStr = getRelativeTime(item.timestamp);

        el.innerHTML = `
          <span class="history-verdict ${isAI ? 'ai' : 'real'}">${item.prediction}</span>
          <span class="history-confidence">${item.confidence.toFixed(1)}%</span>
          <span class="history-time">${timeStr}</span>
        `;

        historyList.appendChild(el);
      });
    });
  }

  function getRelativeTime(timestamp) {
    const diff = Date.now() - timestamp;
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
  }
});
