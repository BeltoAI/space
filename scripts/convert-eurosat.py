#!/usr/bin/env python3
"""
Download cm93/resnet18-eurosat from HuggingFace and export it to ONNX
in the format BELTO expects.

Usage:
    pip install torch torchvision transformers safetensors onnx
    python scripts/convert-eurosat.py

Outputs:
    public/models/eurosat-resnet18.onnx  (~45 MB)
    public/models/eurosat-classes.json   (10 class labels in order)

After running, BELTO will auto-detect and use the model for scene
classification. The model is required for the new rule engine; the
heuristic fallback only runs if the file is missing.
"""

import json
import os
import sys
from pathlib import Path

try:
    import torch
    import torch.nn as nn
    from torchvision import models
    from huggingface_hub import hf_hub_download
    from safetensors.torch import load_file
except ImportError as e:
    print(f"missing dependency: {e}")
    print("install with: pip install torch torchvision transformers safetensors huggingface_hub onnx")
    sys.exit(1)


CLASS_NAMES = [
    "AnnualCrop",
    "Forest",
    "HerbaceousVegetation",
    "Highway",
    "Industrial",
    "Pasture",
    "PermanentCrop",
    "Residential",
    "River",
    "SeaLake"
]


def main():
    repo_root = Path(__file__).resolve().parent.parent
    out_dir = repo_root / "public" / "models"
    out_dir.mkdir(parents=True, exist_ok=True)
    out_onnx = out_dir / "eurosat-resnet18.onnx"
    out_classes = out_dir / "eurosat-classes.json"

    print("[1/4] downloading cm93/resnet18-eurosat from HuggingFace...")
    weights_path = hf_hub_download(
        repo_id="cm93/resnet18-eurosat",
        filename="model.safetensors"
    )
    print(f"      weights at: {weights_path}")

    print("[2/4] building ResNet-18 with 10-class head...")
    model = models.resnet18(weights=None)
    model.fc = nn.Linear(model.fc.in_features, 10)

    print("[3/4] loading fine-tuned weights...")
    state = load_file(weights_path)

    # Strip any prefixes ("model.", "module.") to match torchvision keys
    cleaned = {}
    for k, v in state.items():
        nk = k
        for prefix in ("model.", "module.", "backbone."):
            if nk.startswith(prefix):
                nk = nk[len(prefix):]
        cleaned[nk] = v

    missing, unexpected = model.load_state_dict(cleaned, strict=False)
    if missing:
        print(f"      WARNING: missing keys: {missing[:5]}{'...' if len(missing) > 5 else ''}")
    if unexpected:
        print(f"      WARNING: unexpected keys: {unexpected[:5]}{'...' if len(unexpected) > 5 else ''}")

    model.eval()

    print(f"[4/4] exporting to ONNX: {out_onnx}")
    dummy = torch.randn(1, 3, 224, 224)
    torch.onnx.export(
        model,
        dummy,
        str(out_onnx),
        export_params=True,
        opset_version=13,
        do_constant_folding=True,
        input_names=["input"],
        output_names=["logits"],
        dynamic_axes={"input": {0: "batch"}, "logits": {0: "batch"}}
    )

    with open(out_classes, "w") as f:
        json.dump(CLASS_NAMES, f, indent=2)

    size_mb = os.path.getsize(out_onnx) / (1024 * 1024)
    print()
    print(f"  ONNX model:    {out_onnx}  ({size_mb:.1f} MB)")
    print(f"  Class labels:  {out_classes}")
    print()
    print("Done. Run `npm run dev` and BELTO will auto-load the model.")


if __name__ == "__main__":
    main()
