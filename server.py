"""
Circle-to-Detect — Flask API Server
=====================================================================
Serves ResNet50 + Random Forest ensemble as a REST API for the Chrome extension.

Usage:
    python server.py

Endpoints:
    POST /predict   — classify an image (accepts URL or base64)
    GET  /health    — check if server + models are loaded
"""

import os
import sys
import io
import base64
import pickle
import traceback

import numpy as np
from PIL import Image

# ─────────────────────────────────────────────────────────────────
# CONFIG
# ─────────────────────────────────────────────────────────────────
MODELS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "models", "models")
IMG_SIZE   = 224
CLASSES    = ["ai", "real"]
HOST       = os.environ.get("HOST", "127.0.0.1")     # 0.0.0.0 on HF Spaces
PORT       = int(os.environ.get("PORT", 5000))        # 7860 on HF Spaces
# ─────────────────────────────────────────────────────────────────

# ══════════════════════════════════════════════════════════════════
# IMPORTS
# ══════════════════════════════════════════════════════════════════
try:
    from flask import Flask, request, jsonify
    from flask_cors import CORS
except ImportError:
    print("[ERROR] Flask not installed. Run:")
    print("  pip install flask flask-cors")
    sys.exit(1)

try:
    import torch
    import torch.nn as nn
    from torchvision import transforms, models
except ImportError:
    print("[ERROR] PyTorch not installed. Run:")
    print("  pip install torch torchvision")
    sys.exit(1)

try:
    import requests as http_requests
except ImportError:
    print("[ERROR] requests not installed. Run:")
    print("  pip install requests")
    sys.exit(1)


# ══════════════════════════════════════════════════════════════════
# FEATURE EXTRACTION (for Random Forest)
# ══════════════════════════════════════════════════════════════════
def _entropy(arr, bins=64):
    hist, _ = np.histogram(arr, bins=bins, range=(0, 255), density=True)
    hist = hist[hist > 0]
    return float(-np.sum(hist * np.log2(hist + 1e-12)))


def _laplacian_var(gray):
    kernel = np.array([[0, 1, 0], [1, -4, 1], [0, 1, 0]], dtype=np.float32)
    h, w = gray.shape
    lap = np.zeros((h - 2, w - 2), dtype=np.float32)
    for i in range(3):
        for j in range(3):
            lap += kernel[i, j] * gray[i:h - 2 + i, j:w - 2 + j]
    return float(lap.var())


def extract_features_from_pil(pil_image):
    """Extract 13 features from a PIL Image (same as quick_check.py)."""
    img = pil_image.convert("RGB").resize((IMG_SIZE, IMG_SIZE))
    arr = np.array(img, dtype=np.float32)
    r, g, b = arr[:, :, 0], arr[:, :, 1], arr[:, :, 2]
    gray = 0.299 * r + 0.587 * g + 0.114 * b
    return np.array([
        r.mean(), r.std(), g.mean(), g.std(), b.mean(), b.std(),
        gray.mean(), gray.std(),
        r.mean() / (g.mean() + 1e-6), b.mean() / (g.mean() + 1e-6),
        np.percentile(gray, 25), np.percentile(gray, 75),
        np.percentile(gray, 75) - np.percentile(gray, 25),
        _entropy(gray.flatten()), _laplacian_var(gray),
    ], dtype=np.float32)


# ══════════════════════════════════════════════════════════════════
# MODEL LOADING
# ══════════════════════════════════════════════════════════════════
def get_device():
    if torch.cuda.is_available():
        return torch.device("cuda")
    if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
        return torch.device("mps")
    return torch.device("cpu")


def build_resnet50(num_classes=2):
    model = models.resnet50(weights=None)
    in_features = model.fc.in_features
    model.fc = nn.Sequential(
        nn.Dropout(p=0.4),
        nn.Linear(in_features, 256),
        nn.ReLU(),
        nn.Dropout(p=0.3),
        nn.Linear(256, num_classes),
    )
    return model


def load_resnet50():
    """Load ResNet50 model from checkpoint."""
    ckpt_path = os.path.join(MODELS_DIR, "resnet50_best.pth")
    if not os.path.exists(ckpt_path):
        print(f"  [WARN] ResNet50 not found: {ckpt_path}")
        return None, None, None

    device = get_device()
    ckpt = torch.load(ckpt_path, map_location=device, weights_only=False)

    if isinstance(ckpt, dict) and "model_state" in ckpt:
        num_classes = len(ckpt.get("class_to_idx", {"ai": 0, "real": 1}))
        model = build_resnet50(num_classes=num_classes).to(device)
        model.load_state_dict(ckpt["model_state"])
        class_to_idx = ckpt.get("class_to_idx", {"ai": 0, "real": 1})
        val_auc = ckpt.get('val_auc', 0)
    else:
        model = build_resnet50(num_classes=2).to(device)
        model.load_state_dict(ckpt)
        class_to_idx = {"ai": 0, "real": 1}
        val_auc = 0

    model.eval()
    idx_to_class = {v: k for k, v in class_to_idx.items()}

    print(f"  [OK] ResNet50 loaded (Val AUC={val_auc:.4f}, device={device})")
    return model, idx_to_class, device


def load_random_forest():
    """Load Random Forest model and scaler."""
    rf_path = os.path.join(MODELS_DIR, "random_forest.pkl")
    scaler_path = os.path.join(MODELS_DIR, "rf_scaler.pkl")

    if not os.path.exists(rf_path):
        print(f"  [WARN] Random Forest not found: {rf_path}")
        return None, None

    with open(rf_path, "rb") as f:
        rf = pickle.load(f)
    with open(scaler_path, "rb") as f:
        scaler = pickle.load(f)

    print(f"  [OK] Random Forest loaded")
    return rf, scaler


# ══════════════════════════════════════════════════════════════════
# INFERENCE
# ══════════════════════════════════════════════════════════════════
val_transform = transforms.Compose([
    transforms.Resize((IMG_SIZE, IMG_SIZE)),
    transforms.ToTensor(),
    transforms.Normalize([0.485, 0.456, 0.406], [0.229, 0.224, 0.225]),
])


def predict_resnet50(pil_image, rn_model, idx_to_class, device):
    """Run ResNet50 inference on a PIL Image."""
    img_rgb = pil_image.convert("RGB")
    tensor = val_transform(img_rgb).unsqueeze(0).to(device)

    with torch.no_grad():
        logits = rn_model(tensor)
        probs = torch.softmax(logits, dim=1).squeeze().cpu().numpy()

    pred_idx = int(probs.argmax())
    pred_label = idx_to_class.get(pred_idx, str(pred_idx))

    return {
        "prediction": pred_label.upper(),
        "confidence": round(float(probs[pred_idx]) * 100, 2),
        "prob_ai":    round(float(probs[0]) * 100, 2),
        "prob_real":  round(float(probs[1]) * 100, 2),
    }


def predict_random_forest(pil_image, rf_model, scaler):
    """Run Random Forest inference on a PIL Image."""
    feat = extract_features_from_pil(pil_image).reshape(1, -1)
    feats = scaler.transform(feat)
    pred = rf_model.predict(feats)[0]
    probs = rf_model.predict_proba(feats)[0]

    return {
        "prediction": CLASSES[pred].upper(),
        "confidence": round(float(probs[pred]) * 100, 2),
        "prob_ai":    round(float(probs[0]) * 100, 2),
        "prob_real":  round(float(probs[1]) * 100, 2),
    }


def predict_ensemble(pil_image):
    """Run both models and return individual + ensemble results."""
    result = {"status": "success"}

    rn_result = None
    rf_result = None

    # ResNet50
    if rn_model is not None:
        rn_result = predict_resnet50(pil_image, rn_model, idx_to_class, device)
        result["resnet50"] = rn_result

    # Random Forest
    if rf_model is not None:
        rf_result = predict_random_forest(pil_image, rf_model, rf_scaler)
        result["random_forest"] = rf_result

    # Ensemble (soft voting — average probabilities)
    if rn_result and rf_result:
        avg_ai = (rn_result["prob_ai"] + rf_result["prob_ai"]) / 2
        avg_real = (rn_result["prob_real"] + rf_result["prob_real"]) / 2
        ensemble_pred = "AI" if avg_ai > avg_real else "REAL"
        ensemble_conf = max(avg_ai, avg_real)

        result["ensemble"] = {
            "prediction": ensemble_pred,
            "confidence": round(ensemble_conf, 2),
            "prob_ai":    round(avg_ai, 2),
            "prob_real":  round(avg_real, 2),
        }
        # Top-level = ensemble verdict
        result["prediction"] = ensemble_pred
        result["confidence"] = round(ensemble_conf, 2)
        result["prob_ai"] = round(avg_ai, 2)
        result["prob_real"] = round(avg_real, 2)
    elif rn_result:
        result["prediction"] = rn_result["prediction"]
        result["confidence"] = rn_result["confidence"]
        result["prob_ai"] = rn_result["prob_ai"]
        result["prob_real"] = rn_result["prob_real"]
    elif rf_result:
        result["prediction"] = rf_result["prediction"]
        result["confidence"] = rf_result["confidence"]
        result["prob_ai"] = rf_result["prob_ai"]
        result["prob_real"] = rf_result["prob_real"]
    else:
        return {"error": "No models loaded", "status": "error"}

    return result


def fetch_image_from_url(url):
    """Download an image from a URL and return as PIL Image."""
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                      "AppleWebKit/537.36 (KHTML, like Gecko) "
                      "Chrome/120.0.0.0 Safari/537.36"
    }
    resp = http_requests.get(url, headers=headers, timeout=15, stream=True)
    resp.raise_for_status()
    return Image.open(io.BytesIO(resp.content))


def decode_base64_image(data_str):
    """Decode a base64 data URI or raw base64 string to PIL Image."""
    if "," in data_str:
        data_str = data_str.split(",", 1)[1]
    img_bytes = base64.b64decode(data_str)
    return Image.open(io.BytesIO(img_bytes))


# ══════════════════════════════════════════════════════════════════
# FLASK APP
# ══════════════════════════════════════════════════════════════════
app = Flask(__name__)
CORS(app)

# Load models at startup
print("\n" + "=" * 60)
print("  Circle-to-Detect -- Flask API Server")
print("=" * 60)
print(f"  Models dir: {MODELS_DIR}")

rn_model, idx_to_class, device = load_resnet50()
rf_model, rf_scaler = load_random_forest()

models_loaded = []
if rn_model is not None: models_loaded.append("ResNet50")
if rf_model is not None: models_loaded.append("RandomForest")
print(f"  Models active: {', '.join(models_loaded) or 'NONE'}")


@app.route("/health", methods=["GET"])
def health():
    """Health check endpoint."""
    return jsonify({
        "status":  "ok",
        "models":  models_loaded,
        "device":  str(device) if device else "cpu",
        "message": "Circle-to-Detect server is running"
    })


@app.route("/predict", methods=["POST"])
def predict():
    """
    Classify an image as AI-generated or Real.
    Returns individual model results + ensemble verdict.

    Accepts JSON body with either:
        { "image_url": "https://..." }
        { "image_base64": "data:image/png;base64,..." }
    """
    try:
        data = request.get_json(force=True)

        if not data:
            return jsonify({"error": "No JSON body provided"}), 400

        pil_image = None

        # Option 1: image URL
        if "image_url" in data and data["image_url"]:
            url = data["image_url"]
            try:
                pil_image = fetch_image_from_url(url)
            except Exception as e:
                return jsonify({"error": f"Failed to fetch image: {str(e)}"}), 400

        # Option 2: base64 encoded image
        elif "image_base64" in data and data["image_base64"]:
            try:
                pil_image = decode_base64_image(data["image_base64"])
            except Exception as e:
                return jsonify({"error": f"Failed to decode base64 image: {str(e)}"}), 400

        else:
            return jsonify({"error": "Provide 'image_url' or 'image_base64'"}), 400

        # Run ensemble prediction
        print(f"  >> Image: {pil_image.size[0]}x{pil_image.size[1]} mode={pil_image.mode}")
        result = predict_ensemble(pil_image)

        if "resnet50" in result:
            rn = result["resnet50"]
            print(f"  >> ResNet50:      {rn['prediction']} ({rn['confidence']}%)")
        if "random_forest" in result:
            rf = result["random_forest"]
            print(f"  >> RandomForest:  {rf['prediction']} ({rf['confidence']}%)")
        if "ensemble" in result:
            en = result["ensemble"]
            print(f"  >> ENSEMBLE:      {en['prediction']} ({en['confidence']}%)")

        return jsonify(result)

    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e), "status": "error"}), 500


@app.route("/", methods=["GET"])
def index():
    return jsonify({
        "name":    "Circle-to-Detect API",
        "version": "2.0.0",
        "models":  models_loaded,
        "endpoints": {
            "GET  /":        "This info page",
            "GET  /health":  "Server health check",
            "POST /predict": "Classify image (send image_url or image_base64)",
        }
    })


# ══════════════════════════════════════════════════════════════════
# RUN
# ══════════════════════════════════════════════════════════════════
if __name__ == "__main__":
    print(f"\n  Server starting on http://{HOST}:{PORT}")
    print(f"  Press Ctrl+C to stop\n")
    app.run(host=HOST, port=PORT, debug=False)
