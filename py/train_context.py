"""Train the context model: scores how well a candidate span fits between the characters on its left and right.

Input to the network is one packed character sequence per candidate: left context, the candidate, right context,
with no padding between them, plus a segment id per character (1 left, 2 candidate, 3 right, 0 padding). The
packing is done outside the network so the browser code can do exactly the same (src/context.ts).

Writes data/work/context/model/{context.pt, context.onnx, metrics.json}.
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


def pack(left: np.ndarray, candidates: np.ndarray, right: np.ndarray):
    """[N, L], [N, K, S], [N, R] uint8 -> tokens and segments [N*K, L+S+R] int64, packed without inner padding."""
    n, k, s = candidates.shape
    l, r = left.shape[1], right.shape[1]
    total = l + s + r
    left_k = np.repeat(left, k, axis=0)
    right_k = np.repeat(right, k, axis=0)
    cand = candidates.reshape(n * k, s)
    tokens = np.zeros((n * k, total), np.int64)
    segments = np.zeros((n * k, total), np.int64)
    left_len = (left_k != 0).sum(1)
    cand_len = (cand != 0).sum(1)
    right_len = (right_k != 0).sum(1)
    # Left context is right-aligned in its buffer; candidate and right context are left-aligned.
    for i in range(n * k):
        a, b, c = left_len[i], cand_len[i], right_len[i]
        if b == 0:
            continue
        row = np.concatenate([left_k[i, l - a :], cand[i, :b], right_k[i, :c]])
        tokens[i, : len(row)] = row
        segments[i, :a] = 1
        segments[i, a : a + b] = 2
        segments[i, a + b : a + b + c] = 3
    return tokens, segments


class ContextScorer(nn.Module):
    def __init__(self, vocabulary: int, embedding: int = 48, width: int = 128, dilations=(1, 2, 4, 8), kernel: int = 5):
        super().__init__()
        self.characters = nn.Embedding(vocabulary, embedding, padding_idx=0)
        self.segments = nn.Embedding(4, embedding)
        self.inward = nn.Conv1d(embedding, width, 1)
        self.convolutions = nn.ModuleList(
            nn.Conv1d(width, width, kernel, dilation=d, padding=d * (kernel - 1) // 2) for d in dilations
        )
        self.hidden = nn.Linear(2 * width, width)
        self.out = nn.Linear(width, 1)

    def forward(self, tokens, segments):
        present = (tokens != 0).unsqueeze(1).float()  # [N, 1, T]
        x = (self.characters(tokens) + self.segments(segments)).transpose(1, 2)
        x = self.inward(x) * present
        for convolution in self.convolutions:
            x = (x + F.relu(convolution(x))) * present
        candidate = (segments == 2).unsqueeze(1).float()
        size = candidate.sum(-1).clamp(min=1.0)
        mean = (x * candidate).sum(-1) / size
        peak = (x * candidate - (1 - candidate) * 1e4).max(-1).values
        return self.out(F.relu(self.hidden(torch.cat([mean, peak], dim=-1)))).squeeze(-1)


def load(path: Path):
    data = np.load(path)
    return {key: data[key] for key in data.files}


def batches(data, size: int, shuffle: bool, rng: np.random.Generator):
    order = rng.permutation(len(data["label"])) if shuffle else np.arange(len(data["label"]))
    for start in range(0, len(order), size):
        idx = order[start : start + size]
        tokens, segments = pack(data["left"][idx], data["candidates"][idx], data["right"][idx])
        yield idx, tokens, segments


def scores_for(model, tokens, segments, count, k, device):
    raw = model(torch.from_numpy(tokens).to(device), torch.from_numpy(segments).to(device)).view(-1, k)
    present = torch.arange(k, device=device).unsqueeze(0) < torch.from_numpy(count.astype(np.int64)).to(device).unsqueeze(1)
    return raw.masked_fill(~present, -1e4)


def evaluate(model, data, device, size: int = 1024):
    model.eval()
    rng = np.random.default_rng(0)
    right = np.zeros(len(KINDS))
    total = np.zeros(len(KINDS))
    k = data["candidates"].shape[1]
    with torch.no_grad():
        for idx, tokens, segments in batches(data, size, False, rng):
            scores = scores_for(model, tokens, segments, data["count"][idx], k, device)
            picked = scores.argmax(-1).cpu().numpy()
            for kind in range(len(KINDS)):
                mask = data["kind"][idx] == kind
                right[kind] += (picked[mask] == data["label"][idx][mask]).sum()
                total[kind] += mask.sum()
    model.train()
    return {name: float(right[i] / max(total[i], 1)) for i, name in enumerate(KINDS)} | {"all": float(right.sum() / total.sum())}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", default="data/work/context")
    parser.add_argument("--epochs", type=float, default=3)
    parser.add_argument("--batch", type=int, default=512)
    parser.add_argument("--learning-rate", type=float, default=3e-3)
    parser.add_argument("--width", type=int, default=128)
    parser.add_argument("--seed", type=int, default=0)
    args = parser.parse_args()
    torch.manual_seed(args.seed)
    rng = np.random.default_rng(args.seed)
    device = "mps" if torch.backends.mps.is_available() else "cpu"
    directory = Path(args.data)
    train, valid = load(directory / "train.npz"), load(directory / "valid.npz")
    vocabulary = len((directory / "alphabet.txt").read_text()) + 2
    model = ContextScorer(vocabulary, width=args.width).to(device)
    parameters = sum(p.numel() for p in model.parameters())
    steps = math.ceil(args.epochs * len(train["label"]) / args.batch)
    optimizer = torch.optim.AdamW(model.parameters(), lr=args.learning_rate, weight_decay=1e-4)
    schedule = torch.optim.lr_scheduler.OneCycleLR(optimizer, max_lr=args.learning_rate, total_steps=steps, pct_start=0.05)
    print(f"{parameters:,} parameters, {len(train['label']):,} train, {len(valid['label']):,} valid, {steps} steps on {device}", flush=True)

    k = train["candidates"].shape[1]
    step, started = 0, time.time()
    while step < steps:
        for idx, tokens, segments in batches(train, args.batch, True, rng):
            scores = scores_for(model, tokens, segments, train["count"][idx], k, device)
            loss = F.cross_entropy(scores, torch.from_numpy(train["label"][idx].astype(np.int64)).to(device))
            optimizer.zero_grad()
            loss.backward()
            nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            optimizer.step()
            schedule.step()
            step += 1
            if step % 200 == 0:
                print(f"step {step}/{steps} loss {loss.item():.3f} {time.time() - started:.0f}s", flush=True)
            if step % 2000 == 0 or step == steps:
                print("valid", evaluate(model, valid, device), flush=True)
            if step >= steps:
                break

    metrics = {"parameters": parameters, "steps": steps, "minutes": (time.time() - started) / 60, "valid": evaluate(model, valid, device), "args": vars(args)}
    out = directory / "model"
    out.mkdir(parents=True, exist_ok=True)
    model = model.cpu().eval()
    torch.save(model.state_dict(), out / "context.pt")
    example = (torch.ones(2, 144, dtype=torch.long), torch.ones(2, 144, dtype=torch.long))
    torch.onnx.export(
        model, example, out / "context.onnx", input_names=["tokens", "segments"], output_names=["scores"],
        dynamic_axes={"tokens": {0: "n", 1: "t"}, "segments": {0: "n", 1: "t"}, "scores": {0: "n"}}, opset_version=17, dynamo=False,
    )
    metrics["onnx_bytes"] = (out / "context.onnx").stat().st_size
    (out / "metrics.json").write_text(json.dumps(metrics, indent=2))
    print(json.dumps(metrics, indent=2))


if __name__ == "__main__":
    main()
