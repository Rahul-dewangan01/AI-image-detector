/*
 * Select-to-Detect — Content Script
 * ═══════════════════════════════════════════════════════════════
 * Handles:
 *   1. Rectangle drag selection on page overlay (screenshot-style)
 *   2. Image detection under the selected region
 *   3. Sending image to backend for AI/Real classification
 *   4. Displaying animated result overlay card
 */

(() => {
  "use strict";

  // ── State ────────────────────────────────────────────────────
  let isActive = false;
  let isDrawing = false;
  let startX = 0, startY = 0;  // rectangle origin
  let overlay = null;
  let canvas = null;
  let ctx = null;
  let resultCard = null;
  let activationIndicator = null;

  // ── Constants ────────────────────────────────────────────────
  const GLOW_COLOR = "rgba(99, 102, 241, 0.9)";      // indigo
  const GLOW_SHADOW = "rgba(99, 102, 241, 0.6)";
  const TRAIL_COLOR = "rgba(139, 92, 246, 0.7)";      // violet
  const AI_COLOR = "#ef4444";
  const REAL_COLOR = "#22c55e";

  // ── Listen for messages from background ──────────────────────
  chrome.runtime.onMessage.addListener((message) => {
    if (message.action === "toggle-circle-mode") {
      toggleCircleMode();
    }
  });

  // ── Direct keyboard shortcut fallback for pages where commands lag ──
  document.addEventListener("keydown", (e) => {
    const isC = e.key === "c" || e.key === "C";
    const isDirectShortcut = e.altKey && isC && !e.ctrlKey && !e.metaKey;
    if (isDirectShortcut) {
      e.preventDefault();
      e.stopPropagation();
      toggleCircleMode();
    }
  }, true);

  // ══════════════════════════════════════════════════════════════
  // ACTIVATION / DEACTIVATION
  // ══════════════════════════════════════════════════════════════
  function toggleCircleMode() {
    isActive ? deactivate() : activate();
  }

  function activate() {
    if (isActive) return;
    isActive = true;
    createOverlay();
    showActivationIndicator();
    document.addEventListener("keydown", onKeyDown);
  }

  function deactivate() {
    if (!isActive) return;
    isActive = false;
    isDrawing = false;
    startX = startY = 0;
    removeOverlay();
    removeResultCard();
    removeActivationIndicator();
    document.removeEventListener("keydown", onKeyDown);
  }

  function onKeyDown(e) {
    if (e.key === "Escape") {
      deactivate();
    }
  }

  // ══════════════════════════════════════════════════════════════
  // ACTIVATION INDICATOR (top-center badge)
  // ══════════════════════════════════════════════════════════════
  function showActivationIndicator() {
    removeActivationIndicator();
    activationIndicator = document.createElement("div");
    activationIndicator.className = "ctd-activation-badge";
    activationIndicator.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <rect x="3" y="3" width="18" height="18" rx="2"/>
        <path d="M12 16v-4M12 8h.01"/>
      </svg>
      <span>Select-to-Detect Active</span>
      <span class="ctd-badge-hint">Drag a box around an image · ESC to exit</span>
    `;
    document.body.appendChild(activationIndicator);

    // Auto-fade after 3 seconds
    setTimeout(() => {
      if (activationIndicator) {
        activationIndicator.classList.add("ctd-badge-fade");
      }
    }, 3000);
  }

  function removeActivationIndicator() {
    if (activationIndicator) {
      activationIndicator.remove();
      activationIndicator = null;
    }
  }

  // ══════════════════════════════════════════════════════════════
  // OVERLAY + CANVAS
  // ══════════════════════════════════════════════════════════════
  function createOverlay() {
    removeOverlay();

    overlay = document.createElement("div");
    overlay.className = "ctd-overlay";
    overlay.id = "ctd-overlay";

    canvas = document.createElement("canvas");
    canvas.className = "ctd-canvas";
    canvas.id = "ctd-canvas";
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;

    overlay.appendChild(canvas);
    document.body.appendChild(overlay);

    ctx = canvas.getContext("2d");

    // Event listeners
    canvas.addEventListener("mousedown", onMouseDown);
    canvas.addEventListener("mousemove", onMouseMove);
    canvas.addEventListener("mouseup", onMouseUp);
    canvas.addEventListener("mouseleave", onMouseUp);

    // Touch support
    canvas.addEventListener("touchstart", onTouchStart, { passive: false });
    canvas.addEventListener("touchmove", onTouchMove, { passive: false });
    canvas.addEventListener("touchend", onTouchEnd);

    // Resize handler
    window.addEventListener("resize", onResize);

    // Entry animation
    requestAnimationFrame(() => {
      overlay.classList.add("ctd-overlay-active");
    });
  }

  function removeOverlay() {
    if (overlay) {
      overlay.classList.remove("ctd-overlay-active");
      setTimeout(() => {
        if (overlay) {
          overlay.remove();
          overlay = null;
          canvas = null;
          ctx = null;
        }
      }, 200);
    }
    window.removeEventListener("resize", onResize);
  }

  function onResize() {
    if (canvas) {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    }
  }

  // ══════════════════════════════════════════════════════════════
  // DRAWING — MOUSE
  // ══════════════════════════════════════════════════════════════
  function onMouseDown(e) {
    e.preventDefault();
    startDrawing(e.clientX, e.clientY);
  }

  function onMouseMove(e) {
    if (!isDrawing) return;
    e.preventDefault();
    continueDrawing(e.clientX, e.clientY);
  }

  function onMouseUp(e) {
    if (!isDrawing) return;
    e.preventDefault();
    finishDrawing(e.clientX, e.clientY);
  }

  // ══════════════════════════════════════════════════════════════
  // DRAWING — TOUCH
  // ══════════════════════════════════════════════════════════════
  function onTouchStart(e) {
    e.preventDefault();
    const touch = e.touches[0];
    startDrawing(touch.clientX, touch.clientY);
  }

  function onTouchMove(e) {
    if (!isDrawing) return;
    e.preventDefault();
    const touch = e.touches[0];
    continueDrawing(touch.clientX, touch.clientY);
  }

  function onTouchEnd(e) {
    if (!isDrawing) return;
    const touch = e.changedTouches[0];
    finishDrawing(touch?.clientX || startX, touch?.clientY || startY);
  }

  // ══════════════════════════════════════════════════════════════
  // RECTANGLE SELECTION LOGIC (screenshot-style drag)
  // ══════════════════════════════════════════════════════════════
  function startDrawing(x, y) {
    isDrawing = true;
    startX = x;
    startY = y;
    removeResultCard();
    clearCanvas();
  }

  function continueDrawing(x, y) {
    renderSelectionRect(x, y);
  }

  function finishDrawing(x, y) {
    isDrawing = false;

    // Build bounding box (handles any drag direction)
    const x1 = Math.min(startX, x || startX);
    const y1 = Math.min(startY, y || startY);
    const x2 = Math.max(startX, x || startX);
    const y2 = Math.max(startY, y || startY);

    // Ignore tiny clicks (< 20px)
    if ((x2 - x1) < 20 || (y2 - y1) < 20) {
      clearCanvas();
      return;
    }

    const boundingBox = { left: x1, top: y1, right: x2, bottom: y2,
                          width: x2 - x1, height: y2 - y1 };

    const image = findImageInRegion(boundingBox);

    if (image) {
      highlightImage(image, boundingBox);
      classifyImage(image, boundingBox);
    } else {
      showNoImageFound(boundingBox);
    }
  }

  // ══════════════════════════════════════════════════════════════
  // CANVAS RENDERING
  // ══════════════════════════════════════════════════════════════
  function clearCanvas() {
    if (ctx && canvas) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
  }

  function renderSelectionRect(curX, curY) {
    if (!ctx) return;
    clearCanvas();

    const x = Math.min(startX, curX);
    const y = Math.min(startY, curY);
    const w = Math.abs(curX - startX);
    const h = Math.abs(curY - startY);

    // Dim area outside the selection
    ctx.save();
    ctx.fillStyle = "rgba(0, 0, 0, 0.35)";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.clearRect(x, y, w, h);
    ctx.restore();

    // Outer glow border
    ctx.save();
    ctx.strokeStyle = GLOW_SHADOW;
    ctx.lineWidth = 6;
    ctx.shadowColor = GLOW_SHADOW;
    ctx.shadowBlur = 16;
    ctx.strokeRect(x, y, w, h);
    ctx.restore();

    // Dashed inner border
    ctx.save();
    ctx.strokeStyle = GLOW_COLOR;
    ctx.lineWidth = 2;
    ctx.setLineDash([8, 4]);
    ctx.shadowColor = GLOW_COLOR;
    ctx.shadowBlur = 8;
    ctx.strokeRect(x, y, w, h);
    ctx.restore();

    // Corner handles (small squares at each corner)
    const hs = 5; // handle size
    ctx.save();
    ctx.fillStyle = GLOW_COLOR;
    ctx.shadowColor = GLOW_COLOR;
    ctx.shadowBlur = 6;
    ctx.fillRect(x - hs, y - hs, hs * 2, hs * 2);
    ctx.fillRect(x + w - hs, y - hs, hs * 2, hs * 2);
    ctx.fillRect(x - hs, y + h - hs, hs * 2, hs * 2);
    ctx.fillRect(x + w - hs, y + h - hs, hs * 2, hs * 2);
    ctx.restore();

    // Dimension label above the selection
    ctx.save();
    ctx.font = "12px Inter, Segoe UI, sans-serif";
    ctx.fillStyle = GLOW_COLOR;
    ctx.shadowColor = "rgba(0,0,0,0.8)";
    ctx.shadowBlur = 4;
    const label = `${w} × ${h}`;
    const tw = ctx.measureText(label).width;
    ctx.fillText(label, x + w / 2 - tw / 2, Math.max(y - 8, 14));
    ctx.restore();
  }

  // ══════════════════════════════════════════════════════════════
  // IMAGE DETECTION
  // ══════════════════════════════════════════════════════════════
  function rectsOverlap(a, b) {
    return !(a.right < b.left || a.left > b.right ||
             a.bottom < b.top || a.top > b.bottom);
  }

  function overlapArea(a, b) {
    const x1 = Math.max(a.left, b.left);
    const y1 = Math.max(a.top, b.top);
    const x2 = Math.min(a.right, b.right);
    const y2 = Math.min(a.bottom, b.bottom);
    if (x2 <= x1 || y2 <= y1) return 0;
    return (x2 - x1) * (y2 - y1);
  }

  function findImageInRegion(bbox) {
    const images = document.querySelectorAll("img, picture img, video, canvas, [style*='background-image']");
    let bestImg = null;
    let bestOverlap = 0;

    for (const el of images) {
      const rect = el.getBoundingClientRect();
      // Skip tiny or invisible images
      if (rect.width < 20 || rect.height < 20) continue;
      if (el.offsetParent === null && el.tagName !== "BODY") continue;

      const elBox = {
        left: rect.left, top: rect.top,
        right: rect.right, bottom: rect.bottom,
      };

      if (rectsOverlap(bbox, elBox)) {
        const area = overlapArea(bbox, elBox);
        if (area > bestOverlap) {
          bestOverlap = area;
          bestImg = el;
        }
      }
    }

    return bestImg;
  }

  // ══════════════════════════════════════════════════════════════
  // HIGHLIGHT DETECTED IMAGE
  // ══════════════════════════════════════════════════════════════
  function highlightImage(imgEl, bbox) {
    const rect = imgEl.getBoundingClientRect();

    ctx.save();
    ctx.strokeStyle = "rgba(99, 102, 241, 0.5)";
    ctx.lineWidth = 2;
    ctx.setLineDash([8, 4]);
    ctx.shadowColor = "rgba(99, 102, 241, 0.4)";
    ctx.shadowBlur = 10;
    ctx.strokeRect(rect.left, rect.top, rect.width, rect.height);
    ctx.restore();
  }

  // ══════════════════════════════════════════════════════════════
  // CLASSIFICATION
  // ══════════════════════════════════════════════════════════════
  const MIN_QUALITY_SIZE = 224; // model input size — images smaller than this are thumbnails

  function classifyImage(imgEl, bbox) {
    // Show loading spinner
    showLoadingCard(bbox);

    const natW = imgEl.naturalWidth || 0;
    const natH = imgEl.naturalHeight || 0;
    const isThumbnail = natW < MIN_QUALITY_SIZE || natH < MIN_QUALITY_SIZE;

    console.log(`[CTD] Classifying: ${imgEl.tagName} ${natW}x${natH} ` +
                `thumbnail=${isThumbnail} src=${imgEl.src?.substring(0, 60)}`);

    if (isThumbnail) {
      // Small thumbnail — canvas capture would give low-quality pixels
      // Try to find a high-res URL instead
      const hiRes = getHighResSrc(imgEl);
      if (hiRes && !hiRes.startsWith("data:") && !hiRes.startsWith("blob:")) {
        console.log("[CTD] Thumbnail detected, using URL fetch:", hiRes.substring(0, 80));
        sendToBackend({ imageUrl: hiRes }, bbox, () => {
          // URL fetch failed — fall back to canvas capture anyway
          console.log("[CTD] URL fetch failed, falling back to canvas");
          captureAndClassify(imgEl, bbox);
        });
        return;
      }
    }

    // Full-size image or no URL available — use canvas capture
    captureAndClassify(imgEl, bbox);
  }

  function getHighResSrc(el) {
    /**
     * Try to find the highest-resolution source URL for an image.
     * Searches srcset, data attributes, parent links, etc.
     */
    if (el.tagName === "IMG") {
      // 1. Check srcset for the largest version
      if (el.srcset) {
        const candidates = el.srcset.split(",").map((s) => {
          const parts = s.trim().split(/\s+/);
          const url = parts[0];
          const descriptor = parts[1] || "1x";
          let size = 1;
          if (descriptor.endsWith("w")) size = parseInt(descriptor);
          else if (descriptor.endsWith("x")) size = parseFloat(descriptor) * 1000;
          return { url, size };
        });
        candidates.sort((a, b) => b.size - a.size);
        if (candidates.length > 0 && candidates[0].size > 200) return candidates[0].url;
      }

      // 2. Check common data attributes for high-res src
      const dataAttrs = [
        "data-src", "data-original", "data-lazy-src", "data-full-src",
        "data-hi-res-src", "data-large-file", "data-orig-file"
      ];
      for (const attr of dataAttrs) {
        const val = el.getAttribute(attr);
        if (val && val.startsWith("http")) return val;
      }

      // 3. Check parent <a> link — often links to full image (Google Images, etc.)
      const parentLink = el.closest("a[href]");
      if (parentLink) {
        const href = parentLink.href;
        // Check if link points to an image file
        if (/\.(jpg|jpeg|png|webp|bmp|tiff?)(\?|$)/i.test(href)) {
          return href;
        }
        // Google Images: extract imgurl from the link
        try {
          const url = new URL(href);
          const imgUrl = url.searchParams.get("imgurl");
          if (imgUrl) return imgUrl;
        } catch (e) {}
      }

      // 4. currentSrc is the actually-loaded source
      return el.currentSrc || el.src;
    }

    if (el.tagName === "VIDEO") {
      return null;
    }

    // Background image
    const bgImg = window.getComputedStyle(el).backgroundImage;
    if (bgImg && bgImg !== "none") {
      const match = bgImg.match(/url\(["']?(.*?)["']?\)/);
      if (match) return match[1];
    }
    return null;
  }

  function captureAndClassify(el, bbox) {
    try {
      const captureCanvas = document.createElement("canvas");

      if (el.tagName === "IMG") {
        const w = el.naturalWidth || el.width || 300;
        const h = el.naturalHeight || el.height || 300;
        captureCanvas.width = w;
        captureCanvas.height = h;
        const captureCtx = captureCanvas.getContext("2d");
        captureCtx.drawImage(el, 0, 0, w, h);
      } else if (el.tagName === "VIDEO") {
        captureCanvas.width = el.videoWidth || 300;
        captureCanvas.height = el.videoHeight || 300;
        const captureCtx = captureCanvas.getContext("2d");
        captureCtx.drawImage(el, 0, 0, captureCanvas.width, captureCanvas.height);
      } else {
        const src = getHighResSrc(el);
        if (src) {
          sendToBackend({ imageUrl: src }, bbox);
        } else {
          showError("Cannot capture this element", bbox);
        }
        return;
      }

      // CORS check — try to read pixel data
      captureCanvas.getContext("2d").getImageData(0, 0, 1, 1);

      const dataUrl = captureCanvas.toDataURL("image/png");
      console.log(`[CTD] Canvas capture OK: ${captureCanvas.width}x${captureCanvas.height}, ` +
                  `data size: ${(dataUrl.length / 1024).toFixed(0)}KB`);
      sendToBackend({ imageBase64: dataUrl }, bbox);
    } catch (e) {
      // CORS restriction — fall back to URL fetch, then screenshot
      console.log("[CTD] Canvas CORS blocked, falling back to URL fetch");
      const src = getHighResSrc(el);
      if (src && !src.startsWith("data:") && !src.startsWith("blob:")) {
        console.log("[CTD] Using URL:", src.substring(0, 80));
        sendToBackend({ imageUrl: src }, bbox, () => {
          // URL fetch also failed (Instagram, etc.) — use screenshot capture
          console.log("[CTD] URL fetch failed too, using screenshot capture");
          screenshotCaptureAndClassify(el, bbox);
        });
      } else if (src && src.startsWith("data:")) {
        sendToBackend({ imageBase64: src }, bbox);
      } else {
        // No URL available — try screenshot capture as last resort
        screenshotCaptureAndClassify(el, bbox);
      }
    }
  }

  /**
   * Last-resort capture: ask the background script to screenshot the visible
   * tab, then crop the image element's bounding rect from the screenshot.
   * This bypasses ALL CORS restrictions (works on Instagram, Twitter/X, etc.)
   */
  function screenshotCaptureAndClassify(el, bbox) {
    const rect = el.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;

    // Send the element's viewport position to the background script
    const cropInfo = {
      x: Math.round(rect.left * dpr),
      y: Math.round(rect.top * dpr),
      w: Math.round(rect.width * dpr),
      h: Math.round(rect.height * dpr),
    };

    console.log(`[CTD] Screenshot capture: rect=${JSON.stringify(cropInfo)} dpr=${dpr}`);

    chrome.runtime.sendMessage(
      { action: "capture-screenshot", crop: cropInfo },
      (response) => {
        if (chrome.runtime.lastError) {
          console.error("[CTD] Screenshot error:", chrome.runtime.lastError);
          showError("Cannot capture this image", bbox);
          return;
        }

        if (response && response.imageBase64) {
          console.log(`[CTD] Screenshot crop OK: ${(response.imageBase64.length / 1024).toFixed(0)}KB`);
          sendToBackend({ imageBase64: response.imageBase64 }, bbox);
        } else if (response && response.error) {
          showError(response.error, bbox);
        } else {
          showError("Screenshot capture failed", bbox);
        }
      }
    );
  }

  function sendToBackend(payload, bbox, onError) {
    const message = { action: "predict", ...payload };

    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        if (onError) {
          onError();
        } else {
          showError("Extension error", bbox);
        }
        return;
      }

      if (response && response.error) {
        if (onError) {
          onError();
        } else {
          showError(response.error, bbox);
        }
        return;
      }

      if (response && response.prediction) {
        showResultCard(response, bbox);
      } else {
        if (onError) {
          onError();
        } else {
          showError("Invalid response from hosted API", bbox);
        }
      }
    });
  }

  // ══════════════════════════════════════════════════════════════
  // RESULT CARD UI
  // ══════════════════════════════════════════════════════════════
  function removeResultCard() {
    if (resultCard) {
      resultCard.classList.add("ctd-card-exit");
      const card = resultCard;
      setTimeout(() => card.remove(), 300);
      resultCard = null;
    }
    // Also remove any existing loading/error cards
    document.querySelectorAll(".ctd-result-card").forEach((c) => c.remove());
  }

  function showLoadingCard(bbox) {
    removeResultCard();

    resultCard = document.createElement("div");
    resultCard.className = "ctd-result-card ctd-loading-card";

    const pos = getCardPosition(bbox);
    resultCard.style.left = pos.x + "px";
    resultCard.style.top = pos.y + "px";

    resultCard.innerHTML = `
      <div class="ctd-card-inner">
        <div class="ctd-spinner"></div>
        <div class="ctd-loading-text">Analyzing image...</div>
      </div>
    `;

    document.body.appendChild(resultCard);
    requestAnimationFrame(() => resultCard.classList.add("ctd-card-enter"));
  }

  function showResultCard(result, bbox) {
    removeResultCard();

    // Ensemble verdict (top-level)
    const isAI = result.prediction === "AI";
    const color = isAI ? AI_COLOR : REAL_COLOR;
    const icon = isAI ? "\u{1F916}" : "\u{1F4F7}";
    const label = isAI ? "AI-Generated" : "Real Photo";

    resultCard = document.createElement("div");
    resultCard.className = "ctd-result-card";

    const pos = getCardPosition(bbox);
    resultCard.style.left = pos.x + "px";
    resultCard.style.top = pos.y + "px";

    // Build individual model rows
    let modelRows = "";

    if (result.resnet50) {
      const rn = result.resnet50;
      const rnIsAI = rn.prediction === "AI";
      const rnColor = rnIsAI ? AI_COLOR : REAL_COLOR;
      modelRows += `
        <div class="ctd-model-row">
          <div class="ctd-model-header">
            <span class="ctd-model-name">\u{1F9E0} ResNet50</span>
            <span class="ctd-model-verdict" style="color: ${rnColor}">${rn.prediction} ${rn.confidence.toFixed(1)}%</span>
          </div>
          <div class="ctd-prob-row ctd-compact">
            <div class="ctd-prob-bar-bg">
              <div class="ctd-prob-bar ctd-prob-ai" style="--bar-width: ${rn.prob_ai}%; --bar-color: ${AI_COLOR}"></div>
            </div>
          </div>
        </div>
      `;
    }

    if (result.random_forest) {
      const rf = result.random_forest;
      const rfIsAI = rf.prediction === "AI";
      const rfColor = rfIsAI ? AI_COLOR : REAL_COLOR;
      modelRows += `
        <div class="ctd-model-row">
          <div class="ctd-model-header">
            <span class="ctd-model-name">\u{1F332} Random Forest</span>
            <span class="ctd-model-verdict" style="color: ${rfColor}">${rf.prediction} ${rf.confidence.toFixed(1)}%</span>
          </div>
          <div class="ctd-prob-row ctd-compact">
            <div class="ctd-prob-bar-bg">
              <div class="ctd-prob-bar ctd-prob-ai" style="--bar-width: ${rf.prob_ai}%; --bar-color: ${AI_COLOR}"></div>
            </div>
          </div>
        </div>
      `;
    }

    resultCard.innerHTML = `
      <div class="ctd-card-inner">
        <div class="ctd-card-header">
          <div class="ctd-card-icon">${icon}</div>
          <div class="ctd-card-title">Select-to-Detect</div>
          <button class="ctd-card-close" title="Close">\u2715</button>
        </div>

        <div class="ctd-verdict" style="--verdict-color: ${color}">
          <div class="ctd-verdict-label">${label}</div>
          <div class="ctd-verdict-confidence">${result.confidence.toFixed(1)}%</div>
          <div class="ctd-verdict-subtitle">Ensemble Verdict</div>
        </div>

        <div class="ctd-probabilities">
          <div class="ctd-prob-row">
            <span class="ctd-prob-label">\u{1F916} AI</span>
            <div class="ctd-prob-bar-bg">
              <div class="ctd-prob-bar ctd-prob-ai" style="--bar-width: ${result.prob_ai}%; --bar-color: ${AI_COLOR}"></div>
            </div>
            <span class="ctd-prob-value">${result.prob_ai.toFixed(1)}%</span>
          </div>
          <div class="ctd-prob-row">
            <span class="ctd-prob-label">\u{1F4F7} Real</span>
            <div class="ctd-prob-bar-bg">
              <div class="ctd-prob-bar ctd-prob-real" style="--bar-width: ${result.prob_real}%; --bar-color: ${REAL_COLOR}"></div>
            </div>
            <span class="ctd-prob-value">${result.prob_real.toFixed(1)}%</span>
          </div>
        </div>

        <div class="ctd-models-section">
          <div class="ctd-models-divider"></div>
          ${modelRows}
        </div>

        <div class="ctd-card-footer">
          <span>Ensemble (ResNet50 + RF) \u00b7 Select-to-Detect</span>
        </div>
      </div>
    `;

    document.body.appendChild(resultCard);

    // Close button
    resultCard.querySelector(".ctd-card-close").addEventListener("click", (e) => {
      e.stopPropagation();
      deactivate();
    });

    // Entry animation
    requestAnimationFrame(() => resultCard.classList.add("ctd-card-enter"));

    // Animate progress bars
    setTimeout(() => {
      const bars = resultCard.querySelectorAll(".ctd-prob-bar");
      bars.forEach((bar) => bar.classList.add("ctd-bar-animate"));
    }, 100);
  }

  function showError(message, bbox) {
    removeResultCard();

    resultCard = document.createElement("div");
    resultCard.className = "ctd-result-card ctd-error-card";

    const pos = getCardPosition(bbox);
    resultCard.style.left = pos.x + "px";
    resultCard.style.top = pos.y + "px";

    resultCard.innerHTML = `
      <div class="ctd-card-inner">
        <div class="ctd-card-header">
          <div class="ctd-card-icon">⚠️</div>
          <div class="ctd-card-title">Error</div>
          <button class="ctd-card-close" title="Close">✕</button>
        </div>
        <div class="ctd-error-message">${escapeHTML(message)}</div>
        <div class="ctd-card-footer">
          <span>Check that the hosted API is awake</span>
        </div>
      </div>
    `;

    document.body.appendChild(resultCard);
    resultCard.querySelector(".ctd-card-close").addEventListener("click", (e) => {
      e.stopPropagation();
      deactivate();
    });

    requestAnimationFrame(() => resultCard.classList.add("ctd-card-enter"));
  }

  function showNoImageFound(bbox) {
    removeResultCard();

    resultCard = document.createElement("div");
    resultCard.className = "ctd-result-card ctd-info-card";

    const pos = getCardPosition(bbox);
    resultCard.style.left = pos.x + "px";
    resultCard.style.top = pos.y + "px";

    resultCard.innerHTML = `
      <div class="ctd-card-inner">
        <div class="ctd-card-header">
          <div class="ctd-card-icon">🔍</div>
          <div class="ctd-card-title">No Image Found</div>
          <button class="ctd-card-close" title="Close">✕</button>
        </div>
        <div class="ctd-info-message">Drag a box around an image to classify it.</div>
        <div class="ctd-card-footer">
          <span>Try selecting a larger area around the image</span>
        </div>
      </div>
    `;

    document.body.appendChild(resultCard);
    resultCard.querySelector(".ctd-card-close").addEventListener("click", (e) => {
      e.stopPropagation();
      deactivate();
    });

    requestAnimationFrame(() => resultCard.classList.add("ctd-card-enter"));
  }

  // ══════════════════════════════════════════════════════════════
  // POSITIONING HELPERS
  // ══════════════════════════════════════════════════════════════
  function getCardPosition(bbox) {
    const cardWidth = 320;
    const cardHeight = 240;
    const margin = 16;

    let x = bbox.right + margin;
    let y = bbox.top;

    // If card goes off-screen right, show on left
    if (x + cardWidth > window.innerWidth) {
      x = bbox.left - cardWidth - margin;
    }
    // If still off-screen, center horizontally
    if (x < 0) {
      x = Math.max(margin, (bbox.left + bbox.right) / 2 - cardWidth / 2);
    }

    // Vertical bounds
    if (y + cardHeight > window.innerHeight) {
      y = window.innerHeight - cardHeight - margin;
    }
    if (y < margin) y = margin;

    return { x, y };
  }

  function escapeHTML(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }
})();
