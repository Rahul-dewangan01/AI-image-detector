"""
Select-to-Detect — System-Wide Desktop Overlay
═══════════════════════════════════════════════════════════════════
Press Alt+C ANYWHERE (File Explorer, Desktop, etc.) to activate.
Drag a rectangle around any image on screen (screenshot-style).
The selected region is captured and classified as AI or Real.

Works exactly like the browser extension, but for your entire screen.

Usage:
    python desktop_app.py

Controls:
    Alt+C   → Activate overlay (select mode)
    ESC     → Cancel / close overlay
    Drag    → Click and drag a box around an image
"""

import io
import os
import sys
import base64
import threading
import time

import subprocess
import requests as http_requests
import mss
import mss.tools
from PIL import Image
from pynput import keyboard

import tkinter as tk

# ── Config ────────────────────────────────────────────────────────
API_BASE = os.environ.get(
    "CTD_API_BASE",
    "https://rahuldewangan01-ai-image-detector.hf.space",
).rstrip("/")
ACCENT = "#6366f1"
ACCENT_GLOW = "#818cf8"
AI_COLOR = "#ef4444"
REAL_COLOR = "#22c55e"
BG_OVERLAY = "#000000"
OVERLAY_ALPHA = 0.35
FONT = "Segoe UI"


# Minimum capture dimension — below this we show a thumbnail warning
MIN_GOOD_SIZE = 300


class SystemOverlay:
    """
    System-wide transparent overlay.
    Press Alt+C → fullscreen overlay appears → drag rectangle → classify.
    """

    def __init__(self):
        self.root = tk.Tk()
        self.root.withdraw()  # hidden until activated

        self.overlay_win = None
        self.canvas = None
        self.result_win = None

        self.is_active = False
        self.is_drawing = False
        self.start_x = 0
        self.start_y = 0
        self.rect_id = None           # canvas rectangle being dragged
        self.dim_label_id = None      # live dimension label
        self.detected_image_name = ""

        # System tray indicator
        self._build_tray_window()

        # Global hotkey listener (runs in background thread)
        self.hotkey_listener = keyboard.GlobalHotKeys({
            "<alt>+c": self._on_hotkey,
        })
        self.hotkey_listener.start()

        print("=" * 52)
        print("  Select-to-Detect -- Desktop Overlay Running")
        print("")
        print("  Press  Alt+C  anywhere to activate")
        print("  Drag a box around any image on screen")
        print("  Press  ESC  to cancel")
        print("=" * 52)

        self._check_server()
        self.root.mainloop()

    # ══════════════════════════════════════════════════════════════
    # TRAY INDICATOR (small always-on-top window)
    # ══════════════════════════════════════════════════════════════
    def _build_tray_window(self):
        """Small indicator window in bottom-right showing the app is running."""
        self.tray = tk.Toplevel(self.root)
        self.tray.overrideredirect(True)
        self.tray.attributes("-topmost", True)
        self.tray.attributes("-alpha", 0.85)
        self.tray.configure(bg="#1a1a2e")

        frame = tk.Frame(self.tray, bg="#1a1a2e", padx=10, pady=6)
        frame.pack()

        tk.Label(
            frame, text="📷 Select-to-Detect", font=(FONT, 9, "bold"),
            fg=ACCENT_GLOW, bg="#1a1a2e",
        ).pack(side=tk.LEFT)

        self.tray_status = tk.Label(
            frame, text="  Alt+C to activate", font=(FONT, 8),
            fg="#94a3b8", bg="#1a1a2e",
        )
        self.tray_status.pack(side=tk.LEFT, padx=(8, 0))

        # Position bottom-right
        self.tray.update_idletasks()
        sw = self.tray.winfo_screenwidth()
        sh = self.tray.winfo_screenheight()
        tw = self.tray.winfo_width()
        self.tray.geometry(f"+{sw - tw - 16}+{sh - 80}")

    def _check_server(self):
        try:
            r = http_requests.get(f"{API_BASE}/health", timeout=3)
            if r.ok:
                self.tray_status.config(text="  ● Online  |  Alt+C", fg=REAL_COLOR)
            else:
                self.tray_status.config(text="  ● Server Error", fg=AI_COLOR)
        except Exception:
                self.tray_status.config(text="  ● API Offline", fg=AI_COLOR)

    # ══════════════════════════════════════════════════════════════
    # HOTKEY HANDLER
    # ══════════════════════════════════════════════════════════════
    def _on_hotkey(self):
        """Called from pynput thread — schedule on tk main thread."""
        self.root.after(0, self._toggle_overlay)

    def _toggle_overlay(self):
        if self.is_active:
            self._close_overlay()
        else:
            self._open_overlay()

    # ══════════════════════════════════════════════════════════════
    # OVERLAY WINDOW (fullscreen transparent)
    # ══════════════════════════════════════════════════════════════
    def _get_selected_file_from_explorer(self):
        """Try to get the selected file name from File Explorer via COM."""
        try:
            ps_cmd = (
                '(New-Object -ComObject Shell.Application).Windows() | '
                'ForEach-Object { $_.Document.SelectedItems() | '
                'ForEach-Object { $_.Name } }'
            )
            result = subprocess.run(
                ['powershell', '-NoProfile', '-Command', ps_cmd],
                capture_output=True, text=True, timeout=3,
                creationflags=subprocess.CREATE_NO_WINDOW,
            )
            names = [n.strip() for n in result.stdout.strip().splitlines() if n.strip()]
            if names:
                return names[0]  # Return the first selected file
        except Exception:
            pass

        # Fallback: get the foreground window title
        try:
            import ctypes
            buf = ctypes.create_unicode_buffer(512)
            hwnd = ctypes.windll.user32.GetForegroundWindow()
            ctypes.windll.user32.GetWindowTextW(hwnd, buf, 512)
            title = buf.value
            if title:
                return title
        except Exception:
            pass

        return ""

    def _open_overlay(self):
        if self.is_active:
            return
        self.is_active = True
        self._close_result()

        # Detect image name BEFORE overlay covers the screen
        self.detected_image_name = self._get_selected_file_from_explorer()

        # Get TRUE screen size (DPI-aware) to cover everything incl. taskbar
        try:
            import ctypes
            user32 = ctypes.windll.user32
            user32.SetProcessDPIAware()
            sw = user32.GetSystemMetrics(0)
            sh = user32.GetSystemMetrics(1)
        except Exception:
            sw = self.root.winfo_screenwidth()
            sh = self.root.winfo_screenheight()

        self.overlay_win = tk.Toplevel(self.root)
        self.overlay_win.overrideredirect(True)
        self.overlay_win.geometry(f"{sw}x{sh}+0+0")
        self.overlay_win.configure(bg=BG_OVERLAY, cursor="crosshair")
        self.overlay_win.attributes("-topmost", True)
        # Alpha must be > 0.5 for Windows to reliably send mouse events
        self.overlay_win.attributes("-alpha", 0.55)

        self.canvas = tk.Canvas(
            self.overlay_win, width=sw, height=sh,
            bg=BG_OVERLAY, highlightthickness=0, cursor="crosshair",
        )
        self.canvas.pack(fill=tk.BOTH, expand=True)

        # Instruction badge at top
        self.canvas.create_rectangle(
            sw // 2 - 240, 16, sw // 2 + 240, 60,
            fill="#1a1a2e", outline=ACCENT, width=2,
        )
        self.canvas.create_text(
            sw // 2, 38,
            text="Select-to-Detect Active  —  Drag a box around an image  |  ESC to cancel",
            font=(FONT, 11, "bold"), fill=ACCENT_GLOW,
        )

        # Mouse events on canvas (rectangle drag)
        self.canvas.bind("<ButtonPress-1>", self._on_mouse_down)
        self.canvas.bind("<B1-Motion>", self._on_mouse_move)
        self.canvas.bind("<ButtonRelease-1>", self._on_mouse_up)
        self.overlay_win.bind("<Escape>", lambda e: self._close_overlay())

        # Force this window to grab ALL input
        self.overlay_win.lift()
        self.overlay_win.focus_force()
        self.overlay_win.grab_set_global()

        self.tray_status.config(text="  ACTIVE — drag to select", fg=ACCENT_GLOW)

    def _close_overlay(self):
        if not self.is_active:
            return
        self.is_active = False
        self.is_drawing = False
        self.start_x = 0
        self.start_y = 0
        self.rect_id = None
        self.dim_label_id = None

        if self.overlay_win:
            try:
                self.overlay_win.grab_release()
            except Exception:
                pass
            self.overlay_win.destroy()
            self.overlay_win = None
            self.canvas = None

        self.tray_status.config(text="  Online  |  Alt+C", fg=REAL_COLOR)

    # ══════════════════════════════════════════════════════════════
    # RECTANGLE SELECTION (screenshot-style drag)
    # ══════════════════════════════════════════════════════════════
    def _on_mouse_down(self, event):
        self.is_drawing = True
        self.start_x = event.x
        self.start_y = event.y

        # Remove previous rectangle / label if any
        if self.rect_id:
            self.canvas.delete(self.rect_id)
        if self.dim_label_id:
            self.canvas.delete(self.dim_label_id)

    def _on_mouse_move(self, event):
        if not self.is_drawing:
            return

        # Redraw the rectangle as the user drags
        if self.rect_id:
            self.canvas.delete(self.rect_id)
        if self.dim_label_id:
            self.canvas.delete(self.dim_label_id)

        self.rect_id = self.canvas.create_rectangle(
            self.start_x, self.start_y, event.x, event.y,
            outline=ACCENT_GLOW, width=2, dash=(6, 4),
        )

        # Show live dimensions
        w = abs(event.x - self.start_x)
        h = abs(event.y - self.start_y)
        mid_x = (self.start_x + event.x) / 2
        label_y = min(self.start_y, event.y) - 14
        self.dim_label_id = self.canvas.create_text(
            mid_x, max(label_y, 10),
            text=f"{w} × {h}",
            font=(FONT, 9), fill=ACCENT_GLOW,
        )

    def _on_mouse_up(self, event):
        if not self.is_drawing:
            return
        self.is_drawing = False

        # Calculate bounding box (handle any drag direction)
        x1 = min(self.start_x, event.x)
        y1 = min(self.start_y, event.y)
        x2 = max(self.start_x, event.x)
        y2 = max(self.start_y, event.y)

        # Ignore tiny accidental clicks (< 20px in either dimension)
        if (x2 - x1) < 20 or (y2 - y1) < 20:
            if self.rect_id:
                self.canvas.delete(self.rect_id)
            if self.dim_label_id:
                self.canvas.delete(self.dim_label_id)
            return

        bbox = (x1, y1, x2, y2)

        # Close the overlay FIRST so the screenshot captures the actual screen
        self._close_overlay()

        # Small delay to let overlay disappear, then capture
        image_name = self.detected_image_name or ""
        self.root.after(150, lambda: self._capture_and_classify(bbox, image_name))

    # ══════════════════════════════════════════════════════════════
    # SCREEN CAPTURE + CLASSIFY
    # ══════════════════════════════════════════════════════════════
    def _capture_and_classify(self, bbox, image_name=""):
        """Capture the selected screen region and send to backend."""
        left, top, right, bottom = bbox

        # Pad slightly to include edges
        pad = 5
        left = max(0, left - pad)
        top = max(0, top - pad)
        right += pad
        bottom += pad

        self._show_loading(bbox, image_name)

        # Capture in background thread
        def do_capture():
            try:
                with mss.mss() as sct:
                    monitor = {
                        "left": int(left),
                        "top": int(top),
                        "width": int(right - left),
                        "height": int(bottom - top),
                    }
                    screenshot = sct.grab(monitor)

                # Convert to PIL → base64
                img = Image.frombytes("RGB", screenshot.size, screenshot.bgra, "raw", "BGRX")
                cap_w, cap_h = img.size
                is_thumbnail = min(cap_w, cap_h) < MIN_GOOD_SIZE
                print(f"  >> Captured region: {cap_w}x{cap_h}" +
                      (" ⚠ THUMBNAIL" if is_thumbnail else ""))

                buf = io.BytesIO()
                img.save(buf, format="PNG")
                b64 = base64.b64encode(buf.getvalue()).decode("utf-8")
                data_uri = f"data:image/png;base64,{b64}"

                # Send to server
                resp = http_requests.post(
                    f"{API_BASE}/predict",
                    json={"image_base64": data_uri},
                    timeout=30,
                )
                result = resp.json()

                if resp.ok and "prediction" in result:
                    result["_is_thumbnail"] = is_thumbnail
                    self.root.after(0, lambda: self._show_result(result, bbox, image_name))
                else:
                    err = result.get("error", "Server error")
                    self.root.after(0, lambda: self._show_error(err, bbox))

            except http_requests.ConnectionError:
                self.root.after(0, lambda: self._show_error(
                    "Cannot connect to hosted API", bbox))
            except Exception as e:
                self.root.after(0, lambda: self._show_error(str(e), bbox))

        threading.Thread(target=do_capture, daemon=True).start()

    # ══════════════════════════════════════════════════════════════
    # RESULT CARD (floating window at the circled location)
    # ══════════════════════════════════════════════════════════════
    def _close_result(self):
        if self.result_win:
            self.result_win.destroy()
            self.result_win = None

    def _card_position(self, bbox):
        """Position the card to the right of the selected region."""
        _, top, right, _ = bbox
        card_w, card_h = 340, 320
        margin = 16

        x = int(right) + margin
        y = int(top)

        sw = self.root.winfo_screenwidth()
        sh = self.root.winfo_screenheight()

        # If off-screen right, place left
        if x + card_w > sw:
            x = int(bbox[0]) - card_w - margin
        if x < 0:
            x = max(margin, (int(bbox[0]) + int(bbox[2])) // 2 - card_w // 2)
        if y + card_h > sh:
            y = sh - card_h - margin
        if y < margin:
            y = margin

        return x, y

    def _create_card_window(self, bbox):
        """Create the floating result card window."""
        self._close_result()
        x, y = self._card_position(bbox)

        win = tk.Toplevel(self.root)
        win.overrideredirect(True)
        win.attributes("-topmost", True)
        win.configure(bg="#1a1a2e")
        win.geometry(f"+{x}+{y}")

        # Allow closing by clicking anywhere outside or pressing Escape
        win.bind("<Escape>", lambda e: self._close_result())
        win.bind("<FocusOut>", lambda e: None)  # keep open on focus loss

        self.result_win = win
        return win

    def _show_loading(self, bbox, image_name=""):
        win = self._create_card_window(bbox)

        frame = tk.Frame(win, bg="#1a1a2e", padx=24, pady=20)
        frame.pack()

        # Header
        hdr = tk.Frame(frame, bg="#1a1a2e")
        hdr.pack(fill=tk.X, pady=(0, 12))
        tk.Label(hdr, text="Select-to-Detect", font=(FONT, 12, "bold"),
                 fg=ACCENT_GLOW, bg="#1a1a2e").pack(side=tk.LEFT, padx=8)

        tk.Label(frame, text="Analyzing image...", font=(FONT, 13),
                 fg="#94a3b8", bg="#1a1a2e").pack(pady=(8, 4))
        if image_name:
            tk.Label(frame, text=image_name, font=(FONT, 9),
                     fg="#64748b", bg="#1a1a2e", wraplength=280).pack()

    def _show_result(self, result, bbox, image_name=""):
        is_ai = result.get("prediction") == "AI"
        color = AI_COLOR if is_ai else REAL_COLOR
        icon = "AI" if is_ai else "Real"
        label = "AI-Generated" if is_ai else "Real Photo"
        confidence = result.get("confidence", 0)

        win = self._create_card_window(bbox)

        outer = tk.Frame(win, bg=color, padx=2, pady=2)
        outer.pack(padx=0, pady=0)

        frame = tk.Frame(outer, bg="#1a1a2e", padx=24, pady=16)
        frame.pack()

        # Header row
        hdr = tk.Frame(frame, bg="#1a1a2e")
        hdr.pack(fill=tk.X, pady=(0, 8))
        tk.Label(hdr, text="Select-to-Detect", font=(FONT, 11, "bold"),
                 fg=ACCENT_GLOW, bg="#1a1a2e").pack(side=tk.LEFT, padx=6)

        close_btn = tk.Label(hdr, text="X", font=(FONT, 12), fg="#64748b",
                             bg="#1a1a2e", cursor="hand2")
        close_btn.pack(side=tk.RIGHT)
        close_btn.bind("<Button-1>", lambda e: self._close_result())

        # Image name (if detected)
        if image_name:
            tk.Label(frame, text=image_name, font=(FONT, 10),
                     fg="#a5b4fc", bg="#1a1a2e", wraplength=280,
                     anchor=tk.W, justify=tk.LEFT).pack(fill=tk.X, pady=(0, 4))

        # Thumbnail quality warning (no preprocessing — just inform the user)
        if result.get("_is_thumbnail"):
            warn_frame = tk.Frame(frame, bg="#78350f", padx=8, pady=4)
            warn_frame.pack(fill=tk.X, pady=(2, 4))
            tk.Label(
                warn_frame,
                text="⚠ Small image detected (thumbnail)",
                font=(FONT, 8, "bold"), fg="#fbbf24", bg="#78350f",
            ).pack(anchor=tk.W)
            tk.Label(
                warn_frame,
                text="Open the full photo for more accurate results",
                font=(FONT, 8), fg="#fcd34d", bg="#78350f",
            ).pack(anchor=tk.W)

        # Divider
        tk.Frame(frame, bg="#2a2a4a", height=1).pack(fill=tk.X, pady=4)

        # Verdict
        tk.Label(frame, text=label, font=(FONT, 18, "bold"),
                 fg=color, bg="#1a1a2e").pack(pady=(8, 0))
        tk.Label(frame, text=f"{confidence:.1f}%", font=(FONT, 24, "bold"),
                 fg=color, bg="#1a1a2e").pack()
        tk.Label(frame, text="Ensemble Verdict", font=(FONT, 9),
                 fg="#64748b", bg="#1a1a2e").pack(pady=(0, 8))

        # Prob bars
        prob_frame = tk.Frame(frame, bg="#1a1a2e")
        prob_frame.pack(fill=tk.X, pady=4)

        ai_pct = result.get("prob_ai", 0)
        real_pct = result.get("prob_real", 0)

        self._draw_prob_bar(prob_frame, "🤖 AI", ai_pct, AI_COLOR)
        self._draw_prob_bar(prob_frame, "📷 Real", real_pct, REAL_COLOR)

        # Divider
        tk.Frame(frame, bg="#2a2a4a", height=1).pack(fill=tk.X, pady=8)

        # Individual models
        if "resnet50" in result:
            rn = result["resnet50"]
            rn_color = AI_COLOR if rn["prediction"] == "AI" else REAL_COLOR
            row = tk.Frame(frame, bg="#1a1a2e")
            row.pack(fill=tk.X, pady=1)
            tk.Label(row, text="🧠 ResNet50", font=(FONT, 9),
                     fg="#94a3b8", bg="#1a1a2e").pack(side=tk.LEFT)
            tk.Label(row, text=f"{rn['prediction']} {rn['confidence']:.1f}%",
                     font=(FONT, 9, "bold"), fg=rn_color, bg="#1a1a2e").pack(side=tk.RIGHT)

        if "random_forest" in result:
            rf = result["random_forest"]
            rf_color = AI_COLOR if rf["prediction"] == "AI" else REAL_COLOR
            row = tk.Frame(frame, bg="#1a1a2e")
            row.pack(fill=tk.X, pady=1)
            tk.Label(row, text="🌲 Random Forest", font=(FONT, 9),
                     fg="#94a3b8", bg="#1a1a2e").pack(side=tk.LEFT)
            tk.Label(row, text=f"{rf['prediction']} {rf['confidence']:.1f}%",
                     font=(FONT, 9, "bold"), fg=rf_color, bg="#1a1a2e").pack(side=tk.RIGHT)

        # Footer
        tk.Frame(frame, bg="#2a2a4a", height=1).pack(fill=tk.X, pady=(8, 4))
        tk.Label(frame, text="Ensemble (ResNet50 + RF) · Select-to-Detect",
                 font=(FONT, 8), fg="#475569", bg="#1a1a2e").pack()

        # Auto-close after 15 seconds
        win.after(15000, self._close_result)

        self.tray_status.config(text="  ● Online  |  Alt+C", fg=REAL_COLOR)

        # Print to console too
        print(f"  >> RESULT: {label} ({confidence:.1f}%)")

    def _draw_prob_bar(self, parent, label_text, pct, color):
        row = tk.Frame(parent, bg="#1a1a2e")
        row.pack(fill=tk.X, pady=2)

        tk.Label(row, text=label_text, font=(FONT, 9), fg="#94a3b8",
                 bg="#1a1a2e", width=8, anchor=tk.W).pack(side=tk.LEFT)

        bar_bg = tk.Frame(row, bg="#2a2a4a", height=8)
        bar_bg.pack(side=tk.LEFT, fill=tk.X, expand=True, padx=4)
        bar_bg.update_idletasks()

        bar_fill = tk.Frame(bar_bg, bg=color, height=8)
        bar_fill.place(relwidth=max(0.02, pct / 100), relheight=1.0)

        tk.Label(row, text=f"{pct:.1f}%", font=(FONT, 9, "bold"),
                 fg=color, bg="#1a1a2e", width=6, anchor=tk.E).pack(side=tk.RIGHT)

    def _show_error(self, msg, bbox):
        win = self._create_card_window(bbox)

        outer = tk.Frame(win, bg=AI_COLOR, padx=2, pady=2)
        outer.pack()

        frame = tk.Frame(outer, bg="#1a1a2e", padx=24, pady=20)
        frame.pack()

        hdr = tk.Frame(frame, bg="#1a1a2e")
        hdr.pack(fill=tk.X, pady=(0, 8))
        tk.Label(hdr, text="⚠️", font=(FONT, 14), bg="#1a1a2e").pack(side=tk.LEFT)
        tk.Label(hdr, text="Error", font=(FONT, 12, "bold"),
                 fg=AI_COLOR, bg="#1a1a2e").pack(side=tk.LEFT, padx=8)

        close_btn = tk.Label(hdr, text="✕", font=(FONT, 12), fg="#64748b",
                             bg="#1a1a2e", cursor="hand2")
        close_btn.pack(side=tk.RIGHT)
        close_btn.bind("<Button-1>", lambda e: self._close_result())

        tk.Label(frame, text=msg, font=(FONT, 10), fg="#94a3b8",
                 bg="#1a1a2e", wraplength=280).pack(pady=8)
        tk.Label(frame, text=f"API: {API_BASE}",
                 font=(FONT, 8), fg="#475569", bg="#1a1a2e").pack()

        win.after(10000, self._close_result)
        self.tray_status.config(text="  ● Online  |  Alt+C", fg=REAL_COLOR)


# ══════════════════════════════════════════════════════════════════
# MAIN
# ══════════════════════════════════════════════════════════════════
if __name__ == "__main__":
    app = SystemOverlay()
