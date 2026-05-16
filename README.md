---
title: AI IMAGE DETECTOR
sdk: docker
app_port: 7860
---

# AI vs Real Image Detection - DWDM Project

Data-driven detection and analysis of AI-generated vs real visual media.

This repository contains a complete Data Warehousing and Data Mining (DWDM) project for detecting whether an image is AI-generated or real. It includes data cleaning, EDA, GAN experimentation, model training, evaluation, a hosted Flask API, a Chrome extension, and a desktop drag-to-detect app.

Hosted API:

```text
https://rahuldewangan01-ai-image-detector.hf.space
```

Health check:

```powershell
curl https://rahuldewangan01-ai-image-detector.hf.space/health
```

## Project Overview

With the rapid growth of AI image generation tools such as Midjourney, Stable Diffusion, DALL-E, and GAN-based systems, identifying synthetic images has become important for digital forensics, misinformation detection, media verification, and content moderation.

This project builds a binary image classifier for:

- AI-generated images
- Real photographs

The project follows a full DWDM workflow:

```text
data collection -> cleaning -> EDA -> GAN experimentation -> model training -> evaluation -> inference -> deployment
```

## Team Credits

This project was developed for the DWDM course by:

- Rahul Dewangan
- Shashi Kant Kumar
- Mandeep Singh
- Akshat Agarwal
- Prathmesh Torse

## Results

| Model | Accuracy | AUC-ROC | Avg Precision |
|---|---:|---:|---:|
| ResNet50 transfer learning | 96.93% | 0.9939 | 0.9937 |
| Random Forest handcrafted features | 75.55% | 0.8283 | 0.7754 |
| Ensemble soft voting | ~97% | ~0.995 | - |

Best ResNet50 checkpoint: Epoch 17, validation AUC = 0.9946.

## Main Features

- End-to-end DWDM image classification pipeline
- 6-step data cleaning and standardization workflow
- EDA and visual analysis of image statistics
- ResNet50 transfer learning classifier
- Random Forest classifier using handcrafted image features
- Ensemble prediction combining deep learning and classical ML
- Flask API for remote inference
- Hugging Face Spaces Docker deployment
- Chrome extension for drag-to-detect inside browser pages
- Desktop app for screen-region detection using the hosted API

## Project Structure

```text
AI-vs-Real-Image-Detection/
|
|-- Analysis/                         # EDA and evaluation outputs
|-- extension/                        # Chrome extension
|   |-- manifest.json
|   |-- background.js
|   |-- content.js
|   |-- popup.html
|   |-- popup.js
|   |-- popup.css
|   |-- content.css
|   `-- icons/
|
|-- models/models/
|   |-- resnet50_best.pth             # ResNet50 checkpoint, tracked with Git LFS
|   |-- random_forest.pkl             # Random Forest model, tracked with Git LFS
|   `-- rf_scaler.pkl                 # Scaler for RF features, tracked with Git LFS
|
|-- Dockerfile                        # Hugging Face Spaces Docker build
|-- requirements-deploy.txt           # Minimal API deployment dependencies
|-- server.py                         # Hosted Flask API
|-- desktop_app.py                    # Desktop drag/capture app using hosted API
|-- run_desktop_app.bat               # Windows launcher for desktop app
|-- requirements.txt                  # Local development dependencies
|-- quick_check.py                    # Interactive local image checker
|-- predict.py                        # CLI prediction script
|-- train_model.py                    # Model training
|-- evaluate_model.py                 # Evaluation
|-- gan_generator.py                  # GAN training/generation
|-- gan_evaluate.py                   # GAN evaluation
|-- step1_data_audit.py
|-- step2_validate_images.py
|-- step3_remove_duplicates.py
|-- step4_standardise_images.py
|-- step5_eda.py
|-- step6_train_val_test_split.py
`-- README.md
```

## Dataset

| Class | Count | Sources |
|---|---:|---|
| AI-generated | 11,845 | Midjourney, Stable Diffusion, DALL-E, StyleGAN, Kaggle datasets |
| Real photos | 9,433 | COCO, Flickr30k, ImageNet, Open Images |
| Total | 21,278 | Mixed public image sources |

Split:

```text
Train: 14,894
Validation: 3,190
Test: 3,194
```

## Data Cleaning Pipeline

| Step | Script | Purpose |
|---|---|---|
| 1 | `step1_data_audit.py` | Scan dataset folders, count files, inspect formats and sizes |
| 2 | `step2_validate_images.py` | Detect corrupt, invalid, truncated, or unsupported images |
| 3 | `step3_remove_duplicates.py` | Remove exact and near duplicates using MD5 and perceptual hashing |
| 4 | `step4_standardise_images.py` | Convert images to RGB, resize to 224x224, strip metadata |
| 5 | `step5_eda.py` | Generate brightness, RGB, file-size, and pixel-stat visualizations |
| 6 | `step6_train_val_test_split.py` | Create stratified train/validation/test splits |

## Models

### ResNet50

- Transfer learning with ImageNet-pretrained ResNet50
- Custom binary classifier head
- Dropout regularization
- Frozen-backbone phase followed by fine-tuning
- Optimized using AdamW and cosine annealing

### Random Forest

- Uses handcrafted image statistics
- Feature set includes RGB means/stds, grayscale statistics, entropy, Laplacian variance, and interquartile range
- 300-tree Random Forest classifier
- Class-balanced training

### Ensemble

The API returns individual model outputs and an ensemble verdict. The ensemble uses soft voting by averaging AI/real probabilities from ResNet50 and Random Forest.

## Hosted API Usage

The Flask API is deployed on Hugging Face Spaces.

Base URL:

```text
https://rahuldewangan01-ai-image-detector.hf.space
```

### Health Check

```powershell
curl https://rahuldewangan01-ai-image-detector.hf.space/health
```

Expected response:

```json
{
  "status": "ok",
  "models": ["ResNet50", "RandomForest"],
  "device": "cpu"
}
```

### Predict From Image URL

```powershell
curl -Method POST "https://rahuldewangan01-ai-image-detector.hf.space/predict" `
  -ContentType "application/json" `
  -Body '{"image_url":"https://example.com/image.jpg"}'
```

### Predict From Local Image Using Base64

```powershell
$path = "C:\path\to\image.jpg"
$b64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($path))
$body = @{ image_base64 = $b64 } | ConvertTo-Json

curl -Method POST "https://rahuldewangan01-ai-image-detector.hf.space/predict" `
  -ContentType "application/json" `
  -Body $body
```

## Chrome Extension Setup

The extension lets users drag a box around images on web pages and send the selected image to the hosted API.

### Install Locally In Chrome

1. Clone or download this repository.
2. Open Chrome and go to:

```text
chrome://extensions
```

3. Turn on Developer mode.
4. Click Load unpacked.
5. Select the `extension/` folder from this project.
6. Open a normal website with images.
7. Refresh the website once after loading the extension.
8. Click the extension icon and choose Activate Detection, or use the configured shortcut.
9. Drag a rectangle around an image to classify it.

### Shortcut Setup

Open:

```text
chrome://extensions/shortcuts
```

Set or confirm the shortcut for Select-to-Detect:

```text
Alt + Shift + C
```

Important:

- The extension will not work on `chrome://` pages, the Chrome Web Store, browser settings pages, or new-tab internal pages.
- If the extension was already loaded before changes, click Reload in `chrome://extensions`.
- Hugging Face free Spaces may sleep when inactive; the first prediction may take longer while the Space wakes up.
- The extension uses the hosted API, so users do not need to run `server.py` locally.

## Desktop App Setup

The desktop app lets users select any screen region, not only browser content.

Run on Windows:

```powershell
.\run_desktop_app.bat
```

Then press:

```text
Alt + C
```

Drag around any image on screen. The desktop app sends the captured region to the hosted Hugging Face API.

Important:

- No local server is needed.
- Internet is required.
- Keep the desktop app running while using `Alt+C`.
- If the app is closed, the hotkey will stop working until it is opened again.

## Local Development Setup

Create and activate a virtual environment:

```powershell
python -m venv .venv
.\.venv\Scripts\activate
```

Install dependencies:

```powershell
pip install -r requirements.txt
```

Run the local API:

```powershell
python server.py
```

By default, the local API runs at:

```text
http://127.0.0.1:5000
```

For Hugging Face deployment, the app uses port `7860` through the Dockerfile and environment variables.

## Local Prediction

Interactive checker:

```powershell
python quick_check.py
```

Command-line prediction:

```powershell
python predict.py --image "path\to\image.jpg"
python predict.py --image "path\to\image.jpg" --model ensemble
python predict.py --folder "path\to\folder" --output results.csv
```

## Training And Evaluation

Run the cleaning pipeline:

```powershell
python step1_data_audit.py
python step2_validate_images.py
python step3_remove_duplicates.py
python step4_standardise_images.py
python step5_eda.py
python step6_train_val_test_split.py
```

Train models:

```powershell
python train_model.py
```

Evaluate:

```powershell
python evaluate_model.py
```

GAN workflow:

```powershell
python gan_generator.py --mode train
python gan_generator.py --mode generate --num_images 500
python gan_evaluate.py --integrate
```

## Hugging Face Spaces Deployment

The repository includes the files required for Docker deployment:

```text
Dockerfile
requirements-deploy.txt
server.py
README.md
models/models/resnet50_best.pth
models/models/random_forest.pkl
models/models/rf_scaler.pkl
```

The model files are stored with Git LFS. Before pushing to a remote, make sure Git LFS is installed and initialized:

```powershell
git lfs install
git lfs track "*.pth"
git lfs track "*.pkl"
```

Push code and LFS objects:

```powershell
git add .gitattributes Dockerfile README.md requirements-deploy.txt server.py
git add models/models/resnet50_best.pth models/models/random_forest.pkl models/models/rf_scaler.pkl
git commit -m "Deploy AI image detector"
git lfs push origin main
git push origin main
```

## Important GitHub Upload Notes

Recommended files/folders to include:

```text
.gitattributes
Dockerfile
README.md
requirements.txt
requirements-deploy.txt
server.py
desktop_app.py
run_desktop_app.bat
extension/
models/models/resnet50_best.pth
models/models/random_forest.pkl
models/models/rf_scaler.pkl
training/evaluation scripts
```

Do not upload generated caches and unnecessary heavy experiment outputs:

```text
__pycache__/
*.zip
build/
dist/
release/
models/models/gan_generator_epoch*.pth
models/models/eval_*.png
models/models/*_cm.png
models/models/*_roc.png
```

## Limitations

- The classifier is research/academic software, not a forensic guarantee.
- Very small thumbnails can reduce accuracy.
- Screenshots, compression, filters, and social-media recompression can affect predictions.
- Hugging Face free CPU Spaces can be slower than local GPU inference.
- First request after inactivity may take longer while the Space wakes up.

## Tech Stack

- Python
- PyTorch and torchvision
- scikit-learn
- Flask and Flask-CORS
- Pillow and NumPy
- MSS and pynput for desktop capture
- Chrome Extension Manifest V3
- Docker
- Hugging Face Spaces
- Git LFS

## License And Use

This project is submitted as an academic DWDM project for educational use.
