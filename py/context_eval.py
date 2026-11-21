"""Evaluate Context Model v2 against the frequency baseline on the held-out half of valid.npz
and print the per-regime calibration table (false-alarm rate when typed is right vs fix rate when typed is wrong).
"""

import json
import sys
from pathlib import Path

import numpy as np
import torch

sys.path.insert(0, str(Path(__file__).parent))
from train_context import KINDS, ContextScorerV2, calibration_curve, load, predict_all, summarize_valid  # noqa: E402


def main():
    directory = Path(sys.argv[1] if len(sys.argv) > 1 else "data/work/context")
    alphabet = (directory / "alphabet.txt").read_text()
    valid = load(directory / "valid.npz")
    metrics = json.loads((directory / "model" / "metrics.json").read_text())
    args = metrics.get("args", {})

    model = ContextScorerV2(
        len(alphabet) + 2,
        feature_dim=valid["features"].shape[-1],
        embedding=args.get("embedding", 64),
        width=args.get("width", 160),
    )
    model.load_state_dict(torch.load(directory / "model" / "context.pt", map_location="cpu"))
    model.eval()

    scores = predict_all(model, valid, "cpu")
    half = len(valid["label"]) // 2
    holdout = {k: v[half:] for k, v in valid.items()}
    summary = summarize_valid(scores[half:], holdout)
    print("=== VALIDATION HOLDOUT SUMMARY ===")
    print(json.dumps(summary, indent=2))

    cal = calibration_curve(scores[half:], holdout)
    print("\n=== CALIBRATION CURVE (valid holdout half) ===")
    for reg, rows_out in cal.items():
        print(f"\n[{reg}]")
        for r in rows_out:
            print(
                f"  T={r['threshold']:4.1f}  FA(typed=right)={r['false_alarm_when_right']*100:6.3f}%  "
                f"Fix(typed=wrong)={r['fix_rate_when_wrong']*100:6.2f}%  WrongFix={r['wrong_fix_when_wrong']*100:5.3f}%"
            )


if __name__ == "__main__":
    main()
