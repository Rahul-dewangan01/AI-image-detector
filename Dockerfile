FROM python:3.11-slim

WORKDIR /app

# Install minimal system deps
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc && rm -rf /var/lib/apt/lists/*

# Install Python deps (CPU-only PyTorch to keep image small)
COPY requirements-deploy.txt .
RUN pip install --no-cache-dir -r requirements-deploy.txt

# Copy server code + models
COPY server.py .
COPY models/models/resnet50_best.pth models/models/resnet50_best.pth
COPY models/models/random_forest.pkl models/models/random_forest.pkl
COPY models/models/rf_scaler.pkl     models/models/rf_scaler.pkl

EXPOSE 7860

# HF Spaces expects port 7860
ENV PORT=7860
ENV HOST=0.0.0.0

CMD ["python", "server.py"]
