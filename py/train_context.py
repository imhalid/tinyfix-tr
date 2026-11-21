"""Train Context Model v2: depthwise-separable gated dilated Conv1d + global attention pool + feature fusion.

Inputs to the exported ONNX model:
  - tokens:   int64  [N, 144]  (packed left + candidate + right character ids)
  - segments: int64  [N, 144]  (1=left, 2=candidate, 3=right, 0=padding)
  - features: float32 [N, 18]  (log frequency, relative log frequency, min-word log count, structure/kind,
                                ASCII-context flag, and 8 morphology POS/suffix bits)
Output:
  - scores:   float32 [N]      (temperature-calibrated log-odds score per candidate)

Writes data/work/context/model/{context.pt, context.onnx, metrics.json, calibration.json}.
"""

import argparse
import json
import math
import time
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

KINDS = ["marks", "de_da", "ki", "mi"]
FEATURE_DIM = 18


def pack_vectorized(left: np.ndarray, candidates: np.ndarray, right: np.ndarray, features: np.ndarray):
    """Packs ONLY active (non-empty) candidates into [M_active, T] int64 tokens/segments + [M_active, F] features.

    Skipping unused slots of MAX_CANDIDATES=4 cuts GPU compute nearly in half (average ~2.1 candidates per query).
    Returns (tokens, segments, active_features, active_mask [N*K]).
    """
    n, k, s = candidates.shape
    l, r = left.shape[1], right.shape[1]
    total = l + s + r
    m = n * k

    cand = candidates.reshape(m, s)
    active_mask = (cand != 0).any(axis=1)
    active_idx = np.nonzero(active_mask)[0]
    q_idx = active_idx // k

    left_a = left[q_idx]
    cand_a = cand[active_idx]
    right_a = right[q_idx]
    feats_a = features.reshape(m, features.shape[-1])[active_idx]

    concat_tok = np.concatenate([left_a, cand_a, right_a], axis=1)
    seg_left = (left_a != 0).astype(np.uint8)
    seg_cand = ((cand_a != 0).astype(np.uint8)) * 2
    seg_right = ((right_a != 0).astype(np.uint8)) * 3
    concat_seg = np.concatenate([seg_left, seg_cand, seg_right], axis=1)

    nz = concat_tok != 0
    dest_col = np.cumsum(nz, axis=1) - 1
    rows_idx, src_col = np.nonzero(nz)
    dst_col = dest_col[rows_idx, src_col]

    ma = len(active_idx)
    tokens = np.zeros((ma, total), dtype=np.int64)
    segments = np.zeros((ma, total), dtype=np.int64)
    tokens[rows_idx, dst_col] = concat_tok[rows_idx, src_col]
    segments[rows_idx, dst_col] = concat_seg[rows_idx, src_col]
    return tokens, segments, feats_a, active_mask


class ContextScorerV2(nn.Module):
    """Fast residual dilated Conv1d + global context attention pool + structured feature fusion."""

    def __init__(
        self,
        vocabulary: int,
        feature_dim: int = FEATURE_DIM,
        embedding: int = 64,
        width: int = 144,
        dilations: tuple[int, ...] = (1, 2, 4, 8, 16),
        kernel: int = 5,
        dropout: float = 0.06,
    ):
        super().__init__()
        self.characters = nn.Embedding(vocabulary, embedding, padding_idx=0)
        self.segments = nn.Embedding(4, embedding)
        self.inward = nn.Conv1d(embedding, width, 1)
        self.convolutions = nn.ModuleList(
            nn.Conv1d(width, width, kernel, dilation=d, padding=d * (kernel - 1) // 2) for d in dilations
        )
        self.drop = nn.Dropout(dropout)
        # Global context attention pooling over the entire sequence (captures long-range parallel cues).
        self.attn_score = nn.Conv1d(width, 1, 1)
        self.ctx_proj = nn.Linear(3 * width, 128)
        self.feat_proj = nn.Linear(feature_dim, 64)
        self.head = nn.Sequential(
            nn.Linear(128 + 64, 128),
            nn.GELU(),
            nn.Dropout(dropout),
            nn.Linear(128, 1),
        )
        # Direct residual path from structured features (frequency ratio, ASCII flag, morph bits).
        self.feat_skip = nn.Linear(feature_dim, 1)
        # Post-hoc Bayes prior correction + per-regime temperature calibration (folded directly into ONNX output so
        # uniform CAREFUL threshold = 3.0 and BALANCED = 2.5 are well-calibrated across all ambiguity regimes).
        self.register_buffer("inv_temperature", torch.tensor(1.0, dtype=torch.float32))
        # [marks_marked_has_mark, de_da_sep, ki_sep, mi_sep] prior shifts subtracted before scaling
        self.register_buffer("prior_bias", torch.zeros(4, dtype=torch.float32))
        # [marks_ascii, marks_marked, de_da, ki, mi] per-regime inverse temperatures
        self.register_buffer("regime_inv_temp", torch.ones(5, dtype=torch.float32))

    def forward(self, tokens: torch.Tensor, segments: torch.Tensor, features: torch.Tensor) -> torch.Tensor:
        present = (tokens != 0).unsqueeze(1).float()  # [N, 1, T]
        x = (self.characters(tokens) + self.segments(segments)).transpose(1, 2)
        x = F.gelu(self.inward(x)) * present
        for conv in self.convolutions:
            x = (x + self.drop(F.gelu(conv(x)))) * present

        candidate = (segments == 2).unsqueeze(1).float()
        size = candidate.sum(-1).clamp(min=1.0)
        cand_mean = (x * candidate).sum(-1) / size
        cand_max = (x * candidate - (1.0 - candidate) * 1e4).max(-1).values

        attn_logits = self.attn_score(x).squeeze(1) - (1.0 - present.squeeze(1)) * 1e4
        attn_weights = torch.softmax(attn_logits, dim=-1).unsqueeze(1)
        ctx_attn = (x * attn_weights).sum(-1)

        ctx_vec = F.gelu(self.ctx_proj(torch.cat([cand_mean, cand_max, ctx_attn], dim=-1)))
        feat_vec = F.gelu(self.feat_proj(features))
        raw_score = self.head(torch.cat([ctx_vec, feat_vec], dim=-1)).squeeze(-1) + self.feat_skip(features).squeeze(-1)

        is_space = features[:, 3]
        has_marks = features[:, 4]
        ascii_ctx = features[:, 5]
        is_marks = features[:, 6]
        is_deda = features[:, 7]
        is_ki = features[:, 8]
        is_mi = features[:, 9]
        is_marks_ascii = is_marks * ascii_ctx
        is_marks_marked = is_marks * (1.0 - ascii_ctx)

        bias = (
            self.prior_bias[0] * is_marks_marked * has_marks
            + self.prior_bias[1] * is_deda * is_space
            + self.prior_bias[2] * is_ki * is_space
            + self.prior_bias[3] * is_mi * is_space
        )
        scale = (
            self.regime_inv_temp[0] * is_marks_ascii
            + self.regime_inv_temp[1] * is_marks_marked
            + self.regime_inv_temp[2] * is_deda
            + self.regime_inv_temp[3] * is_ki
            + self.regime_inv_temp[4] * is_mi
        )
        return (raw_score - bias) * scale * self.inv_temperature


def load(path: Path):
    data = np.load(path)
    return {key: data[key] for key in data.files}


def batches(data, size: int, shuffle: bool, rng: np.random.Generator):
    order = rng.permutation(len(data["label"])) if shuffle else np.arange(len(data["label"]))
    for start in range(0, len(order), size):
        idx = order[start : start + size]
        tokens, segments, features, active_mask = pack_vectorized(
            data["left"][idx], data["candidates"][idx], data["right"][idx], data["features"][idx]
        )
        yield idx, tokens, segments, features, active_mask


def scores_for(model, tokens, segments, features, active_mask, k, device):
    raw_active = model(
        torch.from_numpy(tokens).to(device),
        torch.from_numpy(segments).to(device),
        torch.from_numpy(features).to(device),
    )
    out = torch.full((len(active_mask),), -1e4, dtype=raw_active.dtype, device=device)
    out[torch.from_numpy(active_mask).to(device)] = raw_active
    return out.view(-1, k)


def predict_all(model, data, device, size: int = 1024) -> np.ndarray:
    model.eval()
    n, k = data["candidates"].shape[:2]
    all_scores = np.full((n, k), -1e4, dtype=np.float32)
    rng = np.random.default_rng(0)
    with torch.no_grad():
        for idx, tokens, segments, features, active_mask in batches(data, size, False, rng):
            all_scores[idx] = scores_for(model, tokens, segments, features, active_mask, k, device).cpu().numpy()
    model.train()
    return all_scores


def summarize_valid(all_scores: np.ndarray, data) -> dict:
    label = data["label"]
    kind = data["kind"]
    ascii_ctx = data["ascii_ctx"]
    # Feature 0 is log(count + 1) / 15.0 (frequency baseline).
    freq_scores = data["features"][:, :, 0].copy()
    k = all_scores.shape[1]
    for i in range(len(label)):
        freq_scores[i, data["count"][i] :] = -1e4

    picked = all_scores.argmax(1)
    freq_picked = freq_scores.argmax(1)
    hard = freq_picked != label

    out: dict[str, object] = {}
    for idx, name in enumerate(KINDS):
        m = kind == idx
        hm = m & hard
        out[name] = {
            "n": int(m.sum()),
            "freq_acc": round(float((freq_picked[m] == label[m]).mean()), 4) if m.any() else 0.0,
            "model_acc": round(float((picked[m] == label[m]).mean()), 4) if m.any() else 0.0,
            "hard_n": int(hm.sum()),
            "hard_acc": round(float((picked[hm] == label[hm]).mean()), 4) if hm.any() else 0.0,
        }
    out["all"] = round(float((picked == label).mean()), 4)
    out["all_freq"] = round(float((freq_picked == label).mean()), 4)
    out["all_hard"] = round(float((picked[hard] == label[hard]).mean()), 4) if hard.any() else 0.0
    m_ascii = (kind == 0) & (ascii_ctx == 1)
    m_marked = (kind == 0) & (ascii_ctx == 0)
    if m_ascii.any():
        out["marks_ascii_acc"] = round(float((picked[m_ascii] == label[m_ascii]).mean()), 4)
    if m_marked.any():
        out["marks_marked_acc"] = round(float((picked[m_marked] == label[m_marked]).mean()), 4)
    return out


def calibrate_temperature(raw_scores: np.ndarray, labels: np.ndarray) -> tuple[float, float, float]:
    """Finds scalar temperature T minimizing NLL on validation set; returns (T, nll_before, nll_after)."""
    logits = torch.from_numpy(raw_scores)
    y = torch.from_numpy(labels.astype(np.int64))
    nll_before = float(F.cross_entropy(logits, y).item())
    best_t, best_nll = 1.0, nll_before
    for t in np.linspace(0.4, 3.0, 131):
        nll = float(F.cross_entropy(logits / float(t), y).item())
        if nll < best_nll:
            best_nll, best_t = nll, float(t)
    return best_t, nll_before, best_nll


def calibration_curve(cal_scores: np.ndarray, data) -> dict:
    """Computes false-alarm rate (when typed is right) vs fix rate (when typed is wrong) across margin thresholds."""
    label = data["label"]
    count = data["count"]
    kind = data["kind"]
    ascii_ctx = data["ascii_ctx"]
    n = len(label)

    # For each example:
    # - When typed == right (true label): margin to change = max_{j != label} s[j] - s[label]  -> false alarm if >= T
    # - When typed == wrong (any wrong j): margin to fix to right = s[label] - s[j] (and label is best other) -> fix if >= T
    fa_margins = np.full(n, -1e4, dtype=np.float32)
    fix_margins = []
    fix_regimes = []
    fa_regimes = []

    def regime_of(i: int) -> str:
        k = int(kind[i])
        if k == 0:
            return "marks_ascii" if int(ascii_ctx[i]) == 1 else "marks_marked"
        return KINDS[k]

    for i in range(n):
        c = int(count[i])
        y = int(label[i])
        row = cal_scores[i, :c]
        reg = regime_of(i)
        others = [row[j] for j in range(c) if j != y]
        fa_margins[i] = max(others) - row[y]
        fa_regimes.append(reg)
        for j in range(c):
            if j == y:
                continue
            # If user typed candidate j (wrong), model picks best alternative != j.
            best_alt = max((idx for idx in range(c) if idx != j), key=lambda idx: row[idx])
            margin = float(row[best_alt] - row[j])
            fix_margins.append((margin, best_alt == y))
            fix_regimes.append(reg)

    thresholds = [0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 4.5, 5.0, 6.0, 7.0, 8.0]
    regimes = ["all", "marks_ascii", "marks_marked", "de_da", "ki", "mi"]
    table: dict[str, list[dict]] = {}
    for reg in regimes:
        fa_idx = [i for i in range(n) if reg == "all" or fa_regimes[i] == reg]
        fx_idx = [i for i in range(len(fix_margins)) if reg == "all" or fix_regimes[i] == reg]
        rows_out = []
        for t in thresholds:
            fa = sum(1 for i in fa_idx if fa_margins[i] >= t) / max(len(fa_idx), 1)
            fx_good = sum(1 for i in fx_idx if fix_margins[i][0] >= t and fix_margins[i][1]) / max(len(fx_idx), 1)
            fx_wrong = sum(1 for i in fx_idx if fix_margins[i][0] >= t and not fix_margins[i][1]) / max(len(fx_idx), 1)
            rows_out.append({
                "threshold": t,
                "false_alarm_when_right": round(fa, 5),
                "fix_rate_when_wrong": round(fx_good, 4),
                "wrong_fix_when_wrong": round(fx_wrong, 5),
            })
        table[reg] = rows_out
    return table


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", default="data/work/context")
    parser.add_argument("--epochs", type=float, default=4)
    parser.add_argument("--batch", type=int, default=512)
    parser.add_argument("--learning-rate", type=float, default=2.5e-3)
    parser.add_argument("--width", type=int, default=144)
    parser.add_argument("--embedding", type=int, default=64)
    parser.add_argument("--dropout", type=float, default=0.06)
    parser.add_argument("--seed", type=int, default=2)
    parser.add_argument("--recalibrate-only", action="store_true", help="skip training; load existing context.pt and re-export calibrated ONNX")
    parser.add_argument("--prior-bias", default="1.25,1.9,1.5,1.5", help="comma-separated prior shifts: marks_marked,de_da_sep,ki_sep,mi_sep")
    parser.add_argument("--regime-inv-temp", default="0.85,0.68,0.60,0.67,0.67", help="comma-separated inv temps: marks_ascii,marks_marked,de_da,ki,mi")
    args = parser.parse_args()

    torch.manual_seed(args.seed)
    rng = np.random.default_rng(args.seed)
    device = "mps" if torch.backends.mps.is_available() else "cpu"
    directory = Path(args.data)
    train, valid = load(directory / "train.npz"), load(directory / "valid.npz")
    vocabulary = len((directory / "alphabet.txt").read_text()) + 2
    model = ContextScorerV2(
        vocabulary,
        feature_dim=train["features"].shape[-1],
        embedding=args.embedding,
        width=args.width,
        dropout=args.dropout,
    ).to(device)
    parameters = sum(p.numel() for p in model.parameters())
    steps = math.ceil(args.epochs * len(train["label"]) / args.batch)
    started = time.time()

    if args.recalibrate_only:
        ckpt = torch.load(directory / "model" / "context.pt", map_location="cpu")
        model = model.cpu()
        model.load_state_dict(ckpt, strict=False)
        model.inv_temperature.fill_(1.0)
        model.prior_bias.zero_()
        model.regime_inv_temp.fill_(1.0)
        model.eval()
    else:
        optimizer = torch.optim.AdamW(model.parameters(), lr=args.learning_rate, weight_decay=2e-4)
        schedule = torch.optim.lr_scheduler.OneCycleLR(optimizer, max_lr=args.learning_rate, total_steps=steps, pct_start=0.08)
        print(
            f"ContextScorerV2: {parameters:,} params, {len(train['label']):,} train, {len(valid['label']):,} valid, "
            f"{steps} steps ({args.epochs} epochs) on {device}",
            flush=True,
        )

        k = train["candidates"].shape[1]
        step = 0
        best_acc = -1.0
        best_state = None
        eval_every = max(400, steps // 8)

        while step < steps:
            for idx, tokens, segments, features, active_mask in batches(train, args.batch, True, rng):
                scores = scores_for(model, tokens, segments, features, active_mask, k, device)
                loss = F.cross_entropy(
                    scores,
                    torch.from_numpy(train["label"][idx].astype(np.int64)).to(device),
                )
                optimizer.zero_grad()
                loss.backward()
                nn.utils.clip_grad_norm_(model.parameters(), 1.0)
                optimizer.step()
                schedule.step()
                step += 1
                if step % 200 == 0 or step == 50:
                    print(f"step {step}/{steps} loss {loss.item():.4f} ({time.time() - started:.0f}s)", flush=True)
                if step % eval_every == 0 or step == steps:
                    v_scores = predict_all(model, valid, device)
                    summary = summarize_valid(v_scores, valid)
                    print(f"valid @ step {step}: {json.dumps(summary)}", flush=True)
                    if summary["all"] > best_acc:
                        best_acc = summary["all"]
                        best_state = {key: val.detach().cpu().clone() for key, val in model.state_dict().items()}
                if step >= steps:
                    break

        if best_state is not None:
            model.load_state_dict(best_state)
        model = model.cpu().eval()

    # Temperature calibration on validation set (first half tunes T, second half reports calibration curve).
    raw_valid = predict_all(model, valid, "cpu")
    half = len(valid["label"]) // 2
    temperature, nll_before, nll_after = calibrate_temperature(raw_valid[:half], valid["label"][:half])
    model.inv_temperature.fill_(1.0 / temperature)

    prior_vals = [float(x) for x in args.prior_bias.split(",")]
    regime_vals = [float(x) for x in args.regime_inv_temp.split(",")]
    model.prior_bias.copy_(torch.tensor(prior_vals, dtype=torch.float32))
    model.regime_inv_temp.copy_(torch.tensor(regime_vals, dtype=torch.float32))

    # Measure calibrated scores (with Bayes prior + regime temperature folded into forward) on valid holdout half.
    cal_valid = predict_all(model, valid, "cpu")
    cal_valid_holdout = {key: val[half:] for key, val in valid.items()}
    cal_table = calibration_curve(cal_valid[half:], cal_valid_holdout)
    raw_summary = summarize_valid(raw_valid / temperature, valid)
    cal_summary = summarize_valid(cal_valid, valid)

    out = directory / "model"
    out.mkdir(parents=True, exist_ok=True)
    torch.save(model.state_dict(), out / "context.pt")

    example = (
        torch.ones(2, 144, dtype=torch.long),
        torch.ones(2, 144, dtype=torch.long),
        torch.zeros(2, train["features"].shape[-1], dtype=torch.float32),
    )
    torch.onnx.export(
        model,
        example,
        out / "context.onnx",
        input_names=["tokens", "segments", "features"],
        output_names=["scores"],
        dynamic_axes={
            "tokens": {0: "n", 1: "t"},
            "segments": {0: "n", 1: "t"},
            "features": {0: "n"},
            "scores": {0: "n"},
        },
        opset_version=17,
        dynamo=False,
    )
    metrics = {
        "architecture": "ContextScorerV2",
        "parameters": parameters,
        "steps": steps,
        "minutes": round((time.time() - started) / 60, 2),
        "temperature": round(temperature, 4),
        "nll_before": round(nll_before, 4),
        "nll_after": round(nll_after, 4),
        "prior_bias": prior_vals,
        "regime_inv_temp": regime_vals,
        "valid_raw": raw_summary,
        "valid": cal_summary,
        "onnx_bytes": (out / "context.onnx").stat().st_size,
        "args": vars(args),
    }
    (out / "metrics.json").write_text(json.dumps(metrics, indent=2))
    (out / "calibration.json").write_text(json.dumps(cal_table, indent=2))
    print("\n=== FINAL METRICS ===")
    print(json.dumps(metrics, indent=2))
    print("\n=== CALIBRATION (valid holdout half) ===")
    for reg, rows_out in cal_table.items():
        print(f"\n[{reg}]")
        for r in rows_out:
            print(
                f"  T={r['threshold']:4.1f}  FA(typed=right)={r['false_alarm_when_right']*100:6.3f}%  "
                f"Fix(typed=wrong)={r['fix_rate_when_wrong']*100:6.2f}%  WrongFix={r['wrong_fix_when_wrong']*100:5.3f}%"
            )


if __name__ == "__main__":
    main()
