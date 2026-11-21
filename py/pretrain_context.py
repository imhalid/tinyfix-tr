"""Stage 1 pretraining for Context Model v3: Turkish MLM + Replaced Token Detection (RTD)
on cleaned non-heldout Wikipedia (trwiki) + OpenSubtitles (opensubs).

Strictly excludes held-out Wikipedia documents (`is_heldout(doc_id, 50)`) and held-out subtitle
lines (`idx % 50 == 0`, source of `bench/conversation/clean.jsonl`).

Builds a fast cached uint16 token stream (`data/work/context_v3/pretrain_tokens.npy`) on first run
(~45M tokens: 55% Wiki + 45% OpenSubtitles, with 10% ASCII-stripped paragraphs so the backbone also
learns ASCII-typed Turkish context), then trains the 5-layer Transformer on MPS.
"""

from __future__ import annotations

import argparse
import hashlib
import math
import random
import sys
import time
from pathlib import Path

import numpy as np
import pyarrow.parquet as pq
import torch
import torch.nn as nn
import torch.nn.functional as F

sys.path.insert(0, str(Path(__file__).parent))
from build_lexicon import clean_text, is_heldout  # noqa: E402
from build_tokenizer import SubwordTokenizer  # noqa: E402
from context_arch import MAX_SUB_LEN, PretrainLM, TurkishBackbone  # noqa: E402

ASCII_STRIP = str.maketrans("çğıöşüÇĞİÖŞÜâîûÂÎÛ", "cgiosuCGIOSUaiuAIU")


def build_pretrain_corpus(
    tok: SubwordTokenizer,
    wiki_dir: Path,
    subs_path: Path,
    out_path: Path,
    wiki_tokens: int = 24_000_000,
    subs_tokens: int = 20_000_000,
    ascii_prob: float = 0.10,
    seed: int = 42,
) -> tuple[np.ndarray, np.ndarray]:
    """Tokenize non-heldout Wiki + OpenSubtitles into packed [N, 64] uint16 training & valid blocks."""
    val_path = out_path.with_name("pretrain_valid.npy")
    if out_path.is_file() and val_path.is_file():
        print(f"Loading cached pretrain blocks from {out_path}...", flush=True)
        return np.load(out_path, mmap_mode="r"), np.load(val_path)

    rng = random.Random(seed)
    t0 = time.time()
    seq_len = MAX_SUB_LEN
    payload_len = seq_len - 1  # position 0 is always <cls>

    train_chunks: list[np.ndarray] = []
    valid_chunks: list[np.ndarray] = []

    def pack_stream(stream: list[int], dest: list[np.ndarray]):
        n_blocks = len(stream) // payload_len
        if n_blocks == 0:
            return
        arr = np.asarray(stream[: n_blocks * payload_len], dtype=np.uint16).reshape(n_blocks, payload_len)
        cls_col = np.full((n_blocks, 1), tok.cls_id, dtype=np.uint16)
        dest.append(np.concatenate([cls_col, arr], axis=1))
        del stream[: n_blocks * payload_len]

    # 1. Wikipedia (non-heldout only)
    w_train: list[int] = []
    w_valid: list[int] = []
    w_count = 0
    docs = 0
    for path in sorted(wiki_dir.glob("*.parquet")):
        if w_count >= wiki_tokens:
            break
        table = pq.read_table(path, columns=["id", "text"])
        order = list(range(table.num_rows))
        rng.shuffle(order)
        ids = table.column("id").to_pylist()
        texts = table.column("text").to_pylist()
        for row in order:
            if w_count >= wiki_tokens:
                break
            doc_id, text = ids[row], texts[row]
            if is_heldout(doc_id, 50):
                continue
            docs += 1
            is_val = int(hashlib.md5(("pt3" + doc_id).encode()).hexdigest(), 16) % 200 == 0
            cleaned = clean_text(text)
            for para in cleaned.split("\n"):
                para = para.strip()
                if len(para) < 30:
                    continue
                if not is_val and rng.random() < ascii_prob:
                    para = para.translate(ASCII_STRIP)
                tids = tok.encode(para)
                if len(tids) < 6:
                    continue
                if is_val and len(w_valid) < 200_000:
                    w_valid.extend(tids)
                else:
                    w_train.extend(tids)
                    w_count += len(tids)
                if len(w_train) >= 1_000_000:
                    pack_stream(w_train, train_chunks)
            if docs % 20_000 == 0:
                print(f"  wiki {docs:,} docs, {w_count/1e6:.1f}M/{wiki_tokens/1e6:.1f}M tok ({time.time()-t0:.0f}s)", flush=True)
    pack_stream(w_train, train_chunks)
    pack_stream(w_valid, valid_chunks)
    print(f"Wiki tokenized: {w_count:,} train tok in {time.time()-t0:.0f}s", flush=True)

    # 2. OpenSubtitles (strictly skipping idx % 50 == 0)
    s_train: list[int] = []
    s_valid: list[int] = []
    s_count = 0
    t1 = time.time()
    with open(subs_path, encoding="utf-8", errors="replace") as f:
        for idx, raw_line in enumerate(f):
            if s_count >= subs_tokens:
                break
            if idx % 50 == 0:
                continue  # held-out conversation/clean slice!
            line = raw_line.strip().lstrip("-# ").strip()
            if len(line) < 12:
                continue
            is_val = (idx % 500 == 1)
            if not is_val and rng.random() < ascii_prob:
                line = line.translate(ASCII_STRIP)
            tids = tok.encode(line)
            if len(tids) < 4:
                continue
            if is_val and len(s_valid) < 200_000:
                s_valid.extend(tids)
            else:
                s_train.extend(tids)
                s_count += len(tids)
            if len(s_train) >= 1_000_000:
                pack_stream(s_train, train_chunks)
            if idx > 0 and idx % 1_500_000 == 0:
                print(f"  subs {idx:,} lines, {s_count/1e6:.1f}M/{subs_tokens/1e6:.1f}M tok ({time.time()-t1:.0f}s)", flush=True)
    pack_stream(s_train, train_chunks)
    pack_stream(s_valid, valid_chunks)
    print(f"Subs tokenized: {s_count:,} train tok in {time.time()-t1:.0f}s", flush=True)

    train_arr = np.concatenate(train_chunks, axis=0)
    valid_arr = np.concatenate(valid_chunks, axis=0)
    # Shuffle blocks once on disk so training batches naturally mix Wiki + Subtitles.
    np_rng = np.random.default_rng(seed)
    np_rng.shuffle(train_arr)
    np_rng.shuffle(valid_arr)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    np.save(out_path, train_arr)
    np.save(val_path, valid_arr)
    print(f"Saved pretrain blocks: train={train_arr.shape}, valid={valid_arr.shape}", flush=True)
    return train_arr, valid_arr


def make_mlm_rtd_batch(
    batch: np.ndarray,
    tok: SubwordTokenizer,
    word_start_mask: np.ndarray,
    unigram_cdf: np.ndarray,
    rng: np.random.Generator,
    mlm_prob: float = 0.15,
    rtd_prob: float = 0.08,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Corrupts [B, T] tokens with whole-word/subword MLM (15%) + frequency-sampled RTD (8%)."""
    b, t = batch.shape
    inp = batch.astype(np.int64, copy=True)
    orig = batch.astype(np.int64, copy=False)

    # Select MLM positions (never position 0 = <cls>)
    rand_m = rng.random((b, t))
    mlm_mask = rand_m < mlm_prob
    mlm_mask[:, 0] = False

    # Whole-word expansion on 50% of masked positions: extend across immediate continuation subwords.
    expand = mlm_mask & (rng.random((b, t)) < 0.5)
    is_cont = (~word_start_mask[orig]) & (orig >= 7)
    for _ in range(3):
        prev_exp = np.pad(expand[:, :-1], ((0, 0), (1, 0)))
        add = prev_exp & is_cont
        mlm_mask |= add
        expand |= add

    # Apply BERT 80/10/10 masking rule on mlm_mask
    r_type = rng.random((b, t))
    to_mask = mlm_mask & (r_type < 0.80)
    to_rand = mlm_mask & (r_type >= 0.80) & (r_type < 0.90)
    inp[to_mask] = tok.mask_id

    # Additional RTD corruptions on non-MLM positions (frequency-weighted plausible wrong tokens!)
    rtd_corrupt = (~mlm_mask) & (rng.random((b, t)) < rtd_prob)
    rtd_corrupt[:, 0] = False
    all_rand = to_rand | rtd_corrupt
    n_rand = int(all_rand.sum())
    if n_rand > 0:
        sampled = np.searchsorted(unigram_cdf, rng.random(n_rand)).clip(7, len(tok.vocab) - 1)
        inp[all_rand] = sampled

    # RTD label: 1 wherever a visible (non-<mask>) token differs from original; ignore <mask> and <cls> in RTD loss.
    rtd_valid = (~to_mask) & (inp != 0)
    rtd_valid[:, 0] = False
    rtd_label = (inp != orig).astype(np.float32)
    mlm_targets = orig[mlm_mask]
    return inp, mlm_mask, mlm_targets, rtd_label, rtd_valid


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--vocab", default="data/work/context_v3/vocab.txt")
    parser.add_argument("--wiki", default="data/raw/trwiki")
    parser.add_argument("--subs", default="data/raw/opensubs/tr.part.txt")
    parser.add_argument("--out", default="data/work/context_v3")
    parser.add_argument("--wiki-tokens", type=int, default=24_000_000)
    parser.add_argument("--subs-tokens", type=int, default=20_000_000)
    parser.add_argument("--steps", type=int, default=4000)
    parser.add_argument("--batch", type=int, default=256)
    parser.add_argument("--lr", type=float, default=2.5e-3)
    parser.add_argument("--seed", type=int, default=3)
    args = parser.parse_args()

    out_dir = Path(args.out)
    tok = SubwordTokenizer.load(args.vocab)
    train_arr, valid_arr = build_pretrain_corpus(
        tok,
        Path(args.wiki),
        Path(args.subs),
        out_dir / "pretrain_tokens.npy",
        wiki_tokens=args.wiki_tokens,
        subs_tokens=args.subs_tokens,
        seed=args.seed,
    )

    # Estimate subword unigram distribution (smoothed p^0.75) for plausible RTD replacements!
    sample_ids = np.asarray(train_arr[: min(len(train_arr), 100_000)]).ravel()
    counts = np.bincount(sample_ids, minlength=len(tok.vocab)).astype(np.float64)
    counts[:7] = 0.0
    probs = (counts + 1.0) ** 0.75
    probs[:7] = 0.0
    unigram_cdf = np.cumsum(probs / probs.sum())
    word_start_mask = np.asarray(tok.is_word_start, dtype=bool)

    torch.manual_seed(args.seed)
    rng = np.random.default_rng(args.seed)
    device = "mps" if torch.backends.mps.is_available() else "cpu"

    backbone = TurkishBackbone(vocab=len(tok.vocab), emb=96, dim=192, layers=5, heads=6, ffn=512, dropout=0.05)
    model = PretrainLM(backbone).to(device)
    n_params = sum(p.numel() for p in backbone.parameters())
    print(f"PretrainLM backbone={n_params:,} params, blocks={len(train_arr):,}, steps={args.steps} on {device}", flush=True)

    opt = torch.optim.AdamW(model.parameters(), lr=args.lr, betas=(0.9, 0.98), weight_decay=0.01)
    warmup = max(200, args.steps // 20)

    def lr_lambda(step: int) -> float:
        if step < warmup:
            return (step + 1) / warmup
        prog = (step - warmup) / max(1, args.steps - warmup)
        return 0.05 + 0.95 * 0.5 * (1.0 + math.cos(math.pi * min(1.0, prog)))

    sched = torch.optim.lr_scheduler.LambdaLR(opt, lr_lambda)

    def eval_valid() -> tuple[float, float, float]:
        model.eval()
        val_rng = np.random.default_rng(12345)
        mlm_loss_sum, mlm_n = 0.0, 0
        rtd_correct, rtd_pos_hit, rtd_pos_tot, rtd_tot = 0, 0, 0, 0
        with torch.no_grad():
            for start in range(0, min(len(valid_arr), 4096), args.batch):
                batch = np.asarray(valid_arr[start : start + args.batch])
                inp, mlm_m, mlm_y, rtd_y, rtd_v = make_mlm_rtd_batch(batch, tok, word_start_mask, unigram_cdf, val_rng)
                inp_t = torch.from_numpy(inp).to(device)
                mlm_m_t = torch.from_numpy(mlm_m).to(device)
                mlm_y_t = torch.from_numpy(mlm_y).to(device)
                logits, rtd_logits = model(inp_t, mlm_m_t)
                mlm_loss_sum += float(F.cross_entropy(logits, mlm_y_t, reduction="sum").item())
                mlm_n += len(mlm_y)
                pred = (rtd_logits.cpu().numpy() > 0.0)
                v = rtd_v
                y = rtd_y > 0.5
                rtd_correct += int((pred[v] == y[v]).sum())
                rtd_tot += int(v.sum())
                rtd_pos_hit += int((pred[v & y]).sum())
                rtd_pos_tot += int((v & y).sum())
        model.train()
        ppl = math.exp(min(20.0, mlm_loss_sum / max(1, mlm_n)))
        return mlm_loss_sum / max(1, mlm_n), ppl, rtd_pos_hit / max(1, rtd_pos_tot)

    n_blocks = len(train_arr)
    started = time.time()
    best_mlm = 1e9
    pos_weight = torch.tensor([6.0], device=device)

    for step in range(1, args.steps + 1):
        idx = rng.integers(0, n_blocks, size=args.batch)
        batch = np.asarray(train_arr[idx])
        inp, mlm_m, mlm_y, rtd_y, rtd_v = make_mlm_rtd_batch(batch, tok, word_start_mask, unigram_cdf, rng)
        inp_t = torch.from_numpy(inp).to(device)
        mlm_m_t = torch.from_numpy(mlm_m).to(device)
        mlm_y_t = torch.from_numpy(mlm_y).to(device)
        rtd_y_t = torch.from_numpy(rtd_y).to(device)
        rtd_v_t = torch.from_numpy(rtd_v).to(device)

        logits, rtd_logits = model(inp_t, mlm_m_t)
        loss_mlm = F.cross_entropy(logits, mlm_y_t)
        loss_rtd = F.binary_cross_entropy_with_logits(rtd_logits[rtd_v_t], rtd_y_t[rtd_v_t], pos_weight=pos_weight)
        loss = loss_mlm + 1.5 * loss_rtd

        opt.zero_grad()
        loss.backward()
        nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        opt.step()
        sched.step()

        if step % 200 == 0 or step == 50:
            lr_now = sched.get_last_lr()[0]
            print(
                f"step {step:4d}/{args.steps} mlm={loss_mlm.item():.3f} rtd={loss_rtd.item():.3f} "
                f"lr={lr_now:.5f} ({(time.time()-started)/60:.1f}m)",
                flush=True,
            )
        if step % 1000 == 0 or step == args.steps:
            v_mlm, v_ppl, v_rtd_rec = eval_valid()
            print(f"  VALID @ step {step}: mlm_loss={v_mlm:.3f} ppl={v_ppl:.2f} rtd_recall={v_rtd_rec*100:.1f}%", flush=True)
            if v_mlm < best_mlm:
                best_mlm = v_mlm
                torch.save(backbone.state_dict(), out_dir / "pretrained_backbone.pt")

    print(f"Pretraining done in {(time.time()-started)/60:.1f} min, best valid mlm={best_mlm:.3f} (ppl={math.exp(best_mlm):.2f})", flush=True)


if __name__ == "__main__":
    main()
