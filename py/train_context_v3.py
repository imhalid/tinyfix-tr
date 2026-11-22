"""Stage 2 fine-tuning, calibration, and INT8 ONNX export for Context Model v3.

Initializes `ContextScorerV3` from Stage 1 pretrained Turkish MLM+RTD backbone
(`data/work/context_v3/pretrained_backbone.pt`), fine-tunes on all 5 ambiguity tasks
(`marks`, `de_da`, `ki`, `mi`, `typo`), calibrates temperature & per-regime biases,
and exports a compact INT8 quantized ONNX model (<= 3 MB gzip, compatible with both
`onnxruntime-node` and `onnxruntime-web/wasm`).

Writes `data/work/context_v3/model/{context.pt, context.onnx, metrics.json, calibration.json}`.
"""

from __future__ import annotations

import argparse
import copy
import gzip
import json
import math
import sys
import time
from pathlib import Path

import numpy as np
import onnxruntime as ort
from onnxruntime.quantization import QuantType, quantize_dynamic
import torch
import torch.nn as nn
import torch.nn.functional as F

sys.path.insert(0, str(Path(__file__).parent))
from context_arch import (  # noqa: E402
    ContextScorerV3,
    FEATURE_DIM,
    KINDS,
    MAX_SUB_LEN,
    TurkishBackbone,
)

CLS_ID = 2
SUBTYPE_NAMES = [
    "other",
    "typo_hard_wrong",
    "typo_hard_ambig",
    "typo_below_multi",
    "typo_below_single",
    "typo_easy_multi",
    "neg_miss",
    "neg_oov",
]


def pack_subwords_vectorized(
    left: np.ndarray,
    candidates: np.ndarray,
    right: np.ndarray,
    features: np.ndarray,
):
    """Packs ONLY active candidate slots into dynamic [M_active, T_batch] int64 tensors.

    Format matches src/context.ts:packSubwords bit-for-bit:
      [CLS(seg=1)] + left(seg=1) + cand(seg=2) + right(seg=3) + PAD(0, seg=0)
    """
    n, k, s = candidates.shape
    l, r = left.shape[1], right.shape[1]
    total = min(1 + l + s + r, MAX_SUB_LEN)
    m = n * k

    cand = candidates.reshape(m, s)
    active_mask = (cand != 0).any(axis=1)
    active_idx = np.nonzero(active_mask)[0]
    q_idx = active_idx // k

    ma = len(active_idx)
    cls_col = np.full((ma, 1), CLS_ID, dtype=np.int64)
    left_a = left[q_idx].astype(np.int64, copy=False)
    cand_a = cand[active_idx].astype(np.int64, copy=False)
    right_a = right[q_idx].astype(np.int64, copy=False)
    feats_a = features.reshape(m, features.shape[-1])[active_idx]

    concat_tok = np.concatenate([cls_col, left_a, cand_a, right_a], axis=1)
    seg_cls = np.ones((ma, 1), dtype=np.int64)
    seg_left = (left_a != 0).astype(np.int64)
    seg_cand = (cand_a != 0).astype(np.int64) * 2
    seg_right = (right_a != 0).astype(np.int64) * 3
    concat_seg = np.concatenate([seg_cls, seg_left, seg_cand, seg_right], axis=1)

    nz = concat_tok != 0
    lengths = nz.sum(axis=1)
    seq_len = int(min(max(4, int(lengths.max())), total))

    dest_col = np.cumsum(nz, axis=1) - 1
    rows_idx, src_col = np.nonzero(nz)
    dst_col = dest_col[rows_idx, src_col]
    keep = dst_col < seq_len
    rows_idx, src_col, dst_col = rows_idx[keep], src_col[keep], dst_col[keep]

    subwords = np.zeros((ma, seq_len), dtype=np.int64)
    sub_segments = np.zeros((ma, seq_len), dtype=np.int64)
    subwords[rows_idx, dst_col] = concat_tok[rows_idx, src_col]
    sub_segments[rows_idx, dst_col] = concat_seg[rows_idx, src_col]
    return subwords, sub_segments, feats_a, active_mask


def load_npz(path: Path) -> dict[str, np.ndarray]:
    data = np.load(path)
    return {key: data[key] for key in data.files}


def batches(data: dict[str, np.ndarray], size: int, shuffle: bool, rng: np.random.Generator):
    order = rng.permutation(len(data["label"])) if shuffle else np.arange(len(data["label"]))
    for start in range(0, len(order), size):
        idx = order[start : start + size]
        sub, seg, feats, active = pack_subwords_vectorized(
            data["left"][idx], data["candidates"][idx], data["right"][idx], data["features"][idx]
        )
        yield idx, sub, seg, feats, active


def scores_for_parts(model, sub, seg, feats, active_mask, k: int, device: str, feat_dropout: float = 0.0) -> tuple[torch.Tensor, torch.Tensor]:
    tot_a, ctx_a = model.forward_parts(
        torch.from_numpy(sub).to(device),
        torch.from_numpy(seg).to(device),
        torch.from_numpy(feats).to(device),
        feat_dropout=feat_dropout,
    )
    active_t = torch.from_numpy(active_mask).to(device)
    out_tot = torch.full((len(active_mask),), -1e4, dtype=tot_a.dtype, device=device)
    out_tot[active_t] = tot_a
    out_ctx = torch.full((len(active_mask),), -1e4, dtype=ctx_a.dtype, device=device)
    out_ctx[active_t] = ctx_a
    return out_tot.view(-1, k), out_ctx.view(-1, k)


def scores_for(model, sub, seg, feats, active_mask, k: int, device: str) -> torch.Tensor:
    tot, _ = scores_for_parts(model, sub, seg, feats, active_mask, k, device, feat_dropout=0.0)
    return tot


def predict_all_with_ctx(model, data: dict[str, np.ndarray], device: str, size: int = 192) -> tuple[np.ndarray, np.ndarray]:
    model.eval()
    n, k = data["candidates"].shape[:2]
    all_tot = np.full((n, k), -1e4, dtype=np.float32)
    all_ctx = np.full((n, k), -1e4, dtype=np.float32)
    rng = np.random.default_rng(0)
    with torch.no_grad():
        for idx, sub, seg, feats, active in batches(data, size, False, rng):
            tot, ctx = scores_for_parts(model, sub, seg, feats, active, k, device, feat_dropout=0.0)
            all_tot[idx] = tot.cpu().numpy()
            all_ctx[idx] = ctx.cpu().numpy()
    model.train()
    return all_tot, all_ctx


def predict_all(model, data: dict[str, np.ndarray], device: str, size: int = 192) -> np.ndarray:
    tot, _ = predict_all_with_ctx(model, data, device, size=size)
    return tot


def predict_onnx(onnx_path: Path, data: dict[str, np.ndarray], size: int = 512) -> np.ndarray:
    sess = ort.InferenceSession(str(onnx_path), providers=["CPUExecutionProvider"])
    n, k = data["candidates"].shape[:2]
    all_scores = np.full((n, k), -1e4, dtype=np.float32)
    rng = np.random.default_rng(0)
    for idx, sub, seg, feats, active in batches(data, size, False, rng):
        raw_active = sess.run(None, {"subwords": sub, "sub_segments": seg, "features": feats})[0]
        flat = np.full((len(active),), -1e4, dtype=np.float32)
        flat[active] = raw_active
        all_scores[idx] = flat.reshape(-1, k)
    return all_scores


def summarize_valid(all_scores: np.ndarray, data: dict[str, np.ndarray]) -> dict:
    label = data["label"]
    kind = data["kind"]
    ascii_ctx = data["ascii_ctx"]
    subtype = data.get("subtype", np.zeros_like(kind))

    # Frequency / core baseline: for typo use coreMargin (feat 19) for non-typed, else logCount (feat 0)
    freq_scores = data["features"][:, :, 0].copy()
    is_typo_row = kind == KINDS.index("typo")
    if is_typo_row.any():
        # For typo rows, candidate with highest coreMargin among valid (morph_valid = feat 10 == 1) is core's pick
        cm = data["features"][is_typo_row, :, 19].copy()
        mv = data["features"][is_typo_row, :, 10]
        cm[mv < 0.5] = -1e4
        freq_scores[is_typo_row] = cm
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
            "base_acc": round(float((freq_picked[m] == label[m]).mean()), 4) if m.any() else 0.0,
            "model_acc": round(float((picked[m] == label[m]).mean()), 4) if m.any() else 0.0,
            "hard_n": int(hm.sum()),
            "hard_acc": round(float((picked[hm] == label[hm]).mean()), 4) if hm.any() else 0.0,
        }
    out["all"] = round(float((picked == label).mean()), 4)
    out["all_base"] = round(float((freq_picked == label).mean()), 4)
    out["all_hard"] = round(float((picked[hard] == label[hard]).mean()), 4) if hard.any() else 0.0

    m_ascii = (kind == 0) & (ascii_ctx == 1)
    m_marked = (kind == 0) & (ascii_ctx == 0)
    if m_ascii.any():
        out["marks_ascii_acc"] = round(float((picked[m_ascii] == label[m_ascii]).mean()), 4)
    if m_marked.any():
        out["marks_marked_acc"] = round(float((picked[m_marked] == label[m_marked]).mean()), 4)

    # Typo subtype breakdown
    typo_sub: dict[str, dict] = {}
    for st_id in range(1, len(SUBTYPE_NAMES)):
        sm = (kind == KINDS.index("typo")) & (subtype == st_id)
        if sm.any():
            typo_sub[SUBTYPE_NAMES[st_id]] = {
                "n": int(sm.sum()),
                "acc": round(float((picked[sm] == label[sm]).mean()), 4),
            }
    if typo_sub:
        out["typo_subtypes"] = typo_sub
    return out


def calibrate_temperature(raw_scores: np.ndarray, labels: np.ndarray) -> tuple[float, float, float]:
    logits = torch.from_numpy(raw_scores)
    y = torch.from_numpy(labels.astype(np.int64))
    nll_before = float(F.cross_entropy(logits, y).item())
    best_t, best_nll = 1.0, nll_before
    for t in np.linspace(0.4, 3.0, 131):
        nll = float(F.cross_entropy(logits / float(t), y).item())
        if nll < best_nll:
            best_nll, best_t = nll, float(t)
    return best_t, nll_before, best_nll


def calibration_curve(cal_scores: np.ndarray, data: dict[str, np.ndarray]) -> dict:
    label = data["label"]
    count = data["count"]
    kind = data["kind"]
    ascii_ctx = data["ascii_ctx"]
    n = len(label)

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
            best_alt = max((idx for idx in range(c) if idx != j), key=lambda idx: row[idx])
            margin = float(row[best_alt] - row[j])
            fix_margins.append((margin, best_alt == y))
            fix_regimes.append(reg)

    thresholds = [0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 4.5, 5.0, 6.0, 7.0, 8.0]
    regimes = ["all", "marks_ascii", "marks_marked", "de_da", "ki", "mi", "typo", "name"]
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


def export_quantized_onnx(model: ContextScorerV3, out_dir: Path, quantize: bool = True) -> tuple[Path, int, int]:
    """Exports ContextScorerV3 to ONNX with per-row int8 embeddings + dynamic int8 MatMul weights."""
    export_model = copy.deepcopy(model).cpu().eval()
    export_model.backbone.set_onnx_export(True)
    if quantize:
        export_model.backbone.quantize_embeddings()

    fp_path = out_dir / ("context_fp32_tmp.onnx" if quantize else "context.onnx")
    final_path = out_dir / "context.onnx"
    ex = (
        torch.randint(1, export_model.backbone.vocab, (2, 24), dtype=torch.long),
        torch.ones(2, 24, dtype=torch.long),
        torch.zeros(2, FEATURE_DIM, dtype=torch.float32),
    )
    ex[1][:, 10:13] = 2
    ex[1][:, 13:] = 3
    torch.onnx.export(
        export_model,
        ex,
        fp_path,
        input_names=["subwords", "sub_segments", "features"],
        output_names=["scores"],
        dynamic_axes={
            "subwords": {0: "n", 1: "t"},
            "sub_segments": {0: "n", 1: "t"},
            "features": {0: "n"},
            "scores": {0: "n"},
        },
        opset_version=17,
        dynamo=False,
    )
    if quantize:
        quantize_dynamic(
            str(fp_path),
            str(final_path),
            weight_type=QuantType.QUInt8,
            op_types_to_quantize=["MatMul"],
        )
        fp_path.unlink(missing_ok=True)
    raw = final_path.read_bytes()
    gz_bytes = len(gzip.compress(raw, compresslevel=9))
    return final_path, len(raw), gz_bytes


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", default="data/work/context_v3")
    parser.add_argument("--extra-data", default="", help="optional second NPZ dir to merge (e.g. data/work/name_context)")
    parser.add_argument("--out", default="", help="optional output model dir (default: <data>/model)")
    parser.add_argument("--pretrained", default="data/work/context_v3/pretrained_backbone.pt")
    parser.add_argument("--init-from", default="", help="optional warm-start full ContextScorerV3 checkpoint")
    parser.add_argument("--epochs", type=float, default=2.0)
    parser.add_argument("--batch", type=int, default=128)
    parser.add_argument("--backbone-lr", type=float, default=3.5e-4)
    parser.add_argument("--head-lr", type=float, default=1.5e-3)
    parser.add_argument("--dropout", type=float, default=0.07)
    parser.add_argument("--seed", type=int, default=3)
    parser.add_argument("--recalibrate-only", action="store_true")
    parser.add_argument("--no-quantize", action="store_true")
    parser.add_argument("--prior-bias", default="0.0,0.0,0.0,0.0,0.0,0.0", help="marks_marked,de_da_sep,ki_sep,mi_sep,typo,name_proper")
    parser.add_argument("--regime-inv-temp", default="1.0,1.0,1.0,1.0,1.0,1.0,1.0", help="marks_ascii,marks_marked,de_da,ki,mi,typo,name")
    args = parser.parse_args()

    torch.manual_seed(args.seed)
    rng = np.random.default_rng(args.seed)
    device = "mps" if torch.backends.mps.is_available() else "cpu"
    directory = Path(args.data)
    train, valid = load_npz(directory / "train.npz"), load_npz(directory / "valid.npz")
    if args.extra_data:
        extra_dir = Path(args.extra_data)
        ex_tr, ex_va = load_npz(extra_dir / "train.npz"), load_npz(extra_dir / "valid.npz")
        train = {k: np.concatenate([train[k], ex_tr[k]], axis=0) for k in train}
        valid = {k: np.concatenate([valid[k], ex_va[k]], axis=0) for k in valid}
        # Shuffle valid deterministically so calibration half (:half) and holdout half (half:) share ALL 6 tasks!
        v_perm = np.random.default_rng(args.seed + 99).permutation(len(valid["label"]))
        valid = {k: v[v_perm] for k, v in valid.items()}
        print(
            f"Merged extra data from {extra_dir}: train={len(train['label']):,}, valid={len(valid['label']):,}",
            flush=True,
        )
    vocab_size = len((directory / "vocab.txt").read_text(encoding="utf-8").splitlines())

    backbone = TurkishBackbone(vocab=vocab_size, emb=96, dim=192, layers=5, heads=6, ffn=512, dropout=args.dropout)
    model = ContextScorerV3(backbone, feature_dim=train["features"].shape[-1], dropout=args.dropout)
    parameters = sum(p.numel() for p in model.parameters())
    steps = math.ceil(args.epochs * len(train["label"]) / args.batch)
    started = time.time()

    out = Path(args.out) if args.out else (directory / "model")
    out.mkdir(parents=True, exist_ok=True)

    if args.recalibrate_only:
        ckpt = torch.load(out / "context.pt", map_location="cpu")
        model.load_state_dict(ckpt, strict=False)
        model.inv_temperature.fill_(1.0)
        model.prior_bias.zero_()
        model.regime_inv_temp.fill_(1.0)
        model.eval()
    else:
        if args.init_from and Path(args.init_from).is_file():
            print(f"Warm-starting full ContextScorerV3 from {args.init_from}...", flush=True)
            ckpt = torch.load(args.init_from, map_location="cpu")
            # Drop calibration buffers so resized 6/7 buffers start clean at 0.0/1.0
            for buf in ("inv_temperature", "prior_bias", "regime_inv_temp"):
                ckpt.pop(buf, None)
            missing, unexpected = model.load_state_dict(ckpt, strict=False)
            print(f"  loaded warm-start (missing={missing}, unexpected={unexpected})", flush=True)
            model.inv_temperature.fill_(1.0)
            model.prior_bias.zero_()
            model.regime_inv_temp.fill_(1.0)
        elif Path(args.pretrained).is_file():
            pt_path = Path(args.pretrained)
            print(f"Loading Stage 1 pretrained backbone from {pt_path}...", flush=True)
            pt_state = torch.load(pt_path, map_location="cpu")
            backbone.load_state_dict(pt_state, strict=True)
            # Warm-start candidate/right segment embeddings from pretrained context segment embedding
            with torch.no_grad():
                base_seg = backbone.seg.weight[1].clone()
                backbone.seg.weight[2].copy_(base_seg + 0.01 * torch.randn_like(base_seg))
                backbone.seg.weight[3].copy_(base_seg + 0.01 * torch.randn_like(base_seg))
        else:
            print("WARNING: No pretrained backbone found, training from scratch!", flush=True)

        model = model.to(device)
        backbone_params = list(model.backbone.parameters())
        backbone_ids = {id(p) for p in backbone_params}
        head_params = [p for p in model.parameters() if id(p) not in backbone_ids]
        optimizer = torch.optim.AdamW(
            [
                {"params": backbone_params, "lr": args.backbone_lr, "weight_decay": 1e-2},
                {"params": head_params, "lr": args.head_lr, "weight_decay": 1e-3},
            ],
            betas=(0.9, 0.98),
        )
        schedule = torch.optim.lr_scheduler.OneCycleLR(
            optimizer,
            max_lr=[args.backbone_lr, args.head_lr],
            total_steps=steps,
            pct_start=0.06,
            div_factor=15.0,
            final_div_factor=50.0,
        )
        print(
            f"ContextScorerV3: {parameters:,} params, {len(train['label']):,} train, {len(valid['label']):,} valid, "
            f"{steps} steps ({args.epochs} epochs) on {device}",
            flush=True,
        )

        k = train["candidates"].shape[1]
        step = 0
        best_acc = -1.0
        best_state = None
        eval_every = max(500, steps // 6)

        while step < steps:
            for idx, sub, seg, feats, active in batches(train, args.batch, True, rng):
                y_t = torch.from_numpy(train["label"][idx].astype(np.int64)).to(device)
                scores, ctx_scores = scores_for_parts(model, sub, seg, feats, active, k, device, feat_dropout=0.45)
                loss_tot = F.cross_entropy(scores, y_t)
                loss_ctx = F.cross_entropy(ctx_scores, y_t)
                loss = loss_tot + 0.8 * loss_ctx
                if not torch.isfinite(loss):
                    raise RuntimeError(f"Non-finite loss {loss.item()} at step {step}")
                optimizer.zero_grad()
                loss.backward()
                nn.utils.clip_grad_norm_(model.parameters(), 1.0)
                optimizer.step()
                schedule.step()
                step += 1
                if step % 200 == 0 or step == 50:
                    print(
                        f"step {step:4d}/{steps} loss={loss_tot.item():.4f} ctx_loss={loss_ctx.item():.4f} ({(time.time()-started)/60:.1f}m)",
                        flush=True,
                    )
                if step == 250 or step % eval_every == 0 or step == steps:
                    v_scores, v_ctx = predict_all_with_ctx(model, valid, device, size=192)
                    summary = summarize_valid(v_scores, valid)
                    ctx_acc = round(float((v_ctx.argmax(1) == valid["label"]).mean()), 4)
                    summary["ctx_only_all"] = ctx_acc
                    print(f"valid @ step {step}: {json.dumps(summary)}", flush=True)
                    if summary["all"] > best_acc:
                        best_acc = summary["all"]
                        best_state = {key: val.detach().cpu().clone() for key, val in model.state_dict().items()}
                        torch.save(best_state, out / "context.pt")
                if step >= steps:
                    break

        if best_state is not None:
            model.load_state_dict(best_state)
        model = model.cpu().eval()

    # Temperature calibration on first half of valid, calibration curve on second half.
    raw_valid = predict_all(model, valid, "cpu")
    half = len(valid["label"]) // 2
    temperature, nll_before, nll_after = calibrate_temperature(raw_valid[:half], valid["label"][:half])
    model.inv_temperature.fill_(1.0 / temperature)

    prior_vals = [float(x) for x in args.prior_bias.split(",")]
    while len(prior_vals) < len(model.prior_bias):
        prior_vals.append(0.0)
    regime_vals = [float(x) for x in args.regime_inv_temp.split(",")]
    while len(regime_vals) < len(model.regime_inv_temp):
        regime_vals.append(1.0)
    model.prior_bias.copy_(torch.tensor(prior_vals[: len(model.prior_bias)], dtype=torch.float32))
    model.regime_inv_temp.copy_(torch.tensor(regime_vals[: len(model.regime_inv_temp)], dtype=torch.float32))

    cal_valid = predict_all(model, valid, "cpu")
    cal_valid_holdout = {key: val[half:] for key, val in valid.items()}
    cal_table = calibration_curve(cal_valid[half:], cal_valid_holdout)
    raw_summary = summarize_valid(raw_valid / temperature, valid)
    cal_summary = summarize_valid(cal_valid, valid)

    torch.save(model.state_dict(), out / "context.pt")
    onnx_path, raw_bytes, gz_bytes = export_quantized_onnx(model, out, quantize=not args.no_quantize)

    # Verify quantized ONNX fidelity against PyTorch FP32 on validation holdout half!
    onnx_valid_holdout = predict_onnx(onnx_path, cal_valid_holdout)
    onnx_summary = summarize_valid(onnx_valid_holdout, cal_valid_holdout)
    valid_mask = cal_valid[half:] > -1e3
    max_diff = float(np.abs(onnx_valid_holdout[valid_mask] - cal_valid[half:][valid_mask]).max())
    mean_diff = float(np.abs(onnx_valid_holdout[valid_mask] - cal_valid[half:][valid_mask]).mean())

    metrics = {
        "architecture": "ContextScorerV3",
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
        "onnx_holdout_valid": onnx_summary,
        "onnx_quant_mean_abs_diff": round(mean_diff, 5),
        "onnx_quant_max_abs_diff": round(max_diff, 5),
        "onnx_bytes": raw_bytes,
        "onnx_gzip_bytes": gz_bytes,
        "args": vars(args),
    }
    (out / "metrics.json").write_text(json.dumps(metrics, indent=2), encoding="utf-8")
    (out / "calibration.json").write_text(json.dumps(cal_table, indent=2), encoding="utf-8")
    print("\n=== FINAL METRICS ===")
    print(json.dumps(metrics, indent=2))
    print(f"\nONNX size: raw={raw_bytes/1e6:.3f} MB, gzip={gz_bytes/1e6:.3f} MB (mean_diff={mean_diff:.4f}, max_diff={max_diff:.4f})")
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
