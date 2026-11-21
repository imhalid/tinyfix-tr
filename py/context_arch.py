"""Shared Transformer backbone and ContextScorerV3 architecture for Turkish contextual scoring.

Architecture:
  - 8,192-token Turkish subword vocabulary with factorized 96-dim embedding -> 192-dim hidden.
  - 5 Pre-LN Transformer encoder layers (6 heads, FFN=512, GELU), max_len=64.
  - Pretrained with MLM + Replaced Token Detection (RTD) on non-heldout trwiki + opensubs.
  - Fine-tuned as ContextScorerV3 with 5-way pooling (cand_mean, cand_max, left_edge, right_edge,
    global context attention) + 26-dim structured feature fusion + folded per-regime calibration.
  - Exported to ONNX with per-row int8 quantized token embeddings + dynamic int8 MatMul weights
    (~2.7 MB gzip, ~230-320 us/row CPU, bit-identical in onnxruntime-node and onnxruntime-web/wasm).
"""

from __future__ import annotations

import math
import torch
import torch.nn as nn
import torch.nn.functional as F

FEATURE_DIM = 26
KINDS = ["marks", "de_da", "ki", "mi", "typo"]
# Packed subword sequence layout: [CLS] + left(<=24) + cand(<=8) + right(<=20) <= 53 (max_len=64)
LEFT_SUB = 24
SPAN_SUB = 8
RIGHT_SUB = 20
MAX_SUB_LEN = 64


class TransformerBlock(nn.Module):
    def __init__(self, dim: int, heads: int, ffn: int, dropout: float = 0.05):
        super().__init__()
        self.dim = dim
        self.heads = heads
        self.head_dim = dim // heads
        self.ln1 = nn.LayerNorm(dim)
        self.qkv = nn.Linear(dim, dim * 3)
        self.proj = nn.Linear(dim, dim)
        self.ln2 = nn.LayerNorm(dim)
        self.fc1 = nn.Linear(dim, ffn)
        self.fc2 = nn.Linear(ffn, dim)
        self.drop = nn.Dropout(dropout)
        self.onnx_export = False

    def forward(self, x: torch.Tensor, attn_bias: torch.Tensor) -> torch.Tensor:
        b, t, d = x.shape
        h = self.ln1(x)
        qkv = self.qkv(h).view(b, t, 3, self.heads, self.head_dim)
        q = qkv[:, :, 0].transpose(1, 2)
        k = qkv[:, :, 1].transpose(1, 2)
        v = qkv[:, :, 2].transpose(1, 2)
        if self.onnx_export:
            att = torch.matmul(q, k.transpose(-2, -1)) * (self.head_dim ** -0.5) + attn_bias
            att = torch.softmax(att, dim=-1)
            out = torch.matmul(att, v)
        else:
            # Explicit attention avoids PyTorch MPS SDPA NaN bug when float attn_mask + dropout are combined.
            att = torch.matmul(q, k.transpose(-2, -1)) * (self.head_dim ** -0.5) + attn_bias
            att = self.drop(torch.softmax(att, dim=-1))
            out = torch.matmul(att, v)
        out = out.transpose(1, 2).contiguous().view(b, t, d)
        x = x + self.drop(self.proj(out))
        x = x + self.drop(self.fc2(F.gelu(self.fc1(self.ln2(x)))))
        return x


class QuantizedEmbedding(nn.Module):
    """Per-row int8 embedding with float32 scale — exports cleanly to ONNX opset 17 & ORT WASM."""

    def __init__(self, weight: torch.Tensor):
        super().__init__()
        scale = weight.abs().amax(dim=-1, keepdim=True).clamp(min=1e-6) / 127.0
        q = torch.round(weight / scale).clamp(-127, 127).to(torch.int8)
        self.register_buffer("q", q)
        self.register_buffer("scale", scale.to(torch.float32))

    def forward(self, ids: torch.Tensor) -> torch.Tensor:
        return F.embedding(ids, self.q).float() * F.embedding(ids, self.scale)


class TurkishBackbone(nn.Module):
    def __init__(
        self,
        vocab: int = 8192,
        emb: int = 96,
        dim: int = 192,
        layers: int = 5,
        heads: int = 6,
        ffn: int = 512,
        max_len: int = MAX_SUB_LEN,
        dropout: float = 0.06,
    ):
        super().__init__()
        self.vocab = vocab
        self.emb = emb
        self.dim = dim
        self.layers = layers
        self.heads = heads
        self.ffn = ffn
        self.max_len = max_len
        self.tok = nn.Embedding(vocab, emb, padding_idx=0)
        self.tok_proj = nn.Linear(emb, dim, bias=False)
        self.seg = nn.Embedding(4, dim)
        self.pos = nn.Embedding(max_len, dim)
        self.emb_drop = nn.Dropout(dropout)
        self.blocks = nn.ModuleList([TransformerBlock(dim, heads, ffn, dropout) for _ in range(layers)])
        self.norm = nn.LayerNorm(dim)
        self._init_weights()

    def _init_weights(self):
        for m in self.modules():
            if isinstance(m, nn.Linear):
                nn.init.normal_(m.weight, std=0.02)
                if m.bias is not None:
                    nn.init.zeros_(m.bias)
            elif isinstance(m, nn.Embedding):
                nn.init.normal_(m.weight, std=0.02)
                if m.padding_idx is not None:
                    m.weight.data[m.padding_idx].zero_()
        # Scale residual output projections by 1/sqrt(2*L) for stable deep Pre-LN training.
        scale = 1.0 / math.sqrt(2.0 * self.layers)
        for blk in self.blocks:
            blk.proj.weight.data.mul_(scale)
            blk.fc2.weight.data.mul_(scale)

    def set_onnx_export(self, enabled: bool = True):
        for blk in self.blocks:
            blk.onnx_export = enabled

    def quantize_embeddings(self):
        if isinstance(self.tok, nn.Embedding):
            self.tok = QuantizedEmbedding(self.tok.weight.detach())

    def forward(self, subwords: torch.Tensor, sub_segments: torch.Tensor) -> torch.Tensor:
        _, t = subwords.shape
        pos = torch.arange(t, device=subwords.device).unsqueeze(0)
        x = self.tok_proj(self.tok(subwords)) + self.seg(sub_segments) + self.pos(pos)
        x = self.emb_drop(x)
        present = (subwords != 0).float()
        attn_bias = (1.0 - present).unsqueeze(1).unsqueeze(2) * (-1e4)
        for blk in self.blocks:
            x = blk(x, attn_bias)
        return self.norm(x)


class PretrainLM(nn.Module):
    """Stage 1 pretraining wrapper: MLM (tied embeddings) + Replaced Token Detection (RTD)."""

    def __init__(self, backbone: TurkishBackbone):
        super().__init__()
        self.backbone = backbone
        self.mlm_proj = nn.Linear(backbone.dim, backbone.emb)
        self.mlm_ln = nn.LayerNorm(backbone.emb)
        self.mlm_bias = nn.Parameter(torch.zeros(backbone.vocab))
        self.rtd_head = nn.Sequential(
            nn.Linear(backbone.dim, backbone.dim // 2),
            nn.GELU(),
            nn.Linear(backbone.dim // 2, 1),
        )

    def forward(self, ids: torch.Tensor, mask_pos: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
        seg = torch.ones_like(ids)
        seg = seg * (ids != 0).long()
        h = self.backbone(ids, seg)
        h_masked = h[mask_pos]
        mlm_vec = self.mlm_ln(F.gelu(self.mlm_proj(h_masked)))
        mlm_logits = F.linear(mlm_vec, self.backbone.tok.weight, self.mlm_bias)
        rtd_logits = self.rtd_head(h).squeeze(-1)
        return mlm_logits, rtd_logits


class ContextScorerV3(nn.Module):
    """Stage 2 discriminative candidate scorer with pure-context primary head + regularized feature fusion.

    Separating `ctx_head(ctx_vec)` (zero scalar features!) from `feat_head(ctx_vec, features)` lets us
    apply a direct auxiliary cross-entropy loss on `ctx_head` plus 50% feature dropout during training,
    eliminating scalar-feature shortcut collapse and forcing the 5-layer Transformer to disambiguate
    from genuine Turkish sentence semantics and syntax.
    """

    def __init__(
        self,
        backbone: TurkishBackbone,
        feature_dim: int = FEATURE_DIM,
        dropout: float = 0.08,
    ):
        super().__init__()
        self.backbone = backbone
        d = backbone.dim
        self.attn_score = nn.Linear(d, 1)
        # 5 pooled vectors: cand_mean, cand_max, left_edge, right_edge, ctx_attn -> 5*d
        self.ctx_proj = nn.Sequential(
            nn.Linear(5 * d, 192),
            nn.GELU(),
            nn.Dropout(dropout),
        )
        # Primary pure-context scorer (sees ZERO scalar features!)
        self.ctx_head = nn.Sequential(
            nn.Linear(192, 96),
            nn.GELU(),
            nn.Dropout(dropout),
            nn.Linear(96, 1),
        )
        self.feat_proj = nn.Sequential(
            nn.Linear(feature_dim, 64),
            nn.GELU(),
        )
        self.head = nn.Sequential(
            nn.Linear(192 + 64, 96),
            nn.GELU(),
            nn.Dropout(dropout),
            nn.Linear(96, 1),
        )
        self.feat_skip = nn.Linear(feature_dim, 1)
        # Folded post-hoc calibration buffers:
        self.register_buffer("inv_temperature", torch.tensor(1.0, dtype=torch.float32))
        # [marks_marked_has_mark, de_da_sep, ki_sep, mi_sep, typo_bias]
        self.register_buffer("prior_bias", torch.zeros(5, dtype=torch.float32))
        # [marks_ascii, marks_marked, de_da, ki, mi, typo]
        self.register_buffer("regime_inv_temp", torch.ones(6, dtype=torch.float32))

    def forward_parts(
        self,
        subwords: torch.Tensor,
        sub_segments: torch.Tensor,
        features: torch.Tensor,
        feat_dropout: float = 0.0,
    ) -> tuple[torch.Tensor, torch.Tensor]:
        h = self.backbone(subwords, sub_segments)  # [N, T, D]
        present = (subwords != 0).float()  # [N, T]
        is_cand = (sub_segments == 2).float()  # [N, T]
        is_left = (sub_segments == 1).float()  # [N, T]
        is_right = (sub_segments == 3).float()  # [N, T]

        cand_mask = is_cand.unsqueeze(-1)
        cand_count = cand_mask.sum(1).clamp(min=1.0)
        cand_mean = (h * cand_mask).sum(1) / cand_count
        cand_max = (h * cand_mask - (1.0 - cand_mask) * 1e4).max(1).values

        # Immediate left boundary token (last token of left before candidate) and right boundary token.
        left_edge_mask = (F.pad(is_cand[:, 1:], (0, 1)) * is_left).unsqueeze(-1)
        left_edge = (h * left_edge_mask).sum(1) / left_edge_mask.sum(1).clamp(min=1.0)
        right_edge_mask = (F.pad(is_cand[:, :-1], (1, 0)) * is_right).unsqueeze(-1)
        right_edge = (h * right_edge_mask).sum(1) / right_edge_mask.sum(1).clamp(min=1.0)

        attn_logits = self.attn_score(h).squeeze(-1) - (1.0 - present) * 1e4
        attn_weights = torch.softmax(attn_logits, dim=-1).unsqueeze(-1)
        ctx_attn = (h * attn_weights).sum(1)

        ctx_vec = self.ctx_proj(torch.cat([cand_mean, cand_max, left_edge, right_edge, ctx_attn], dim=-1))
        ctx_score = self.ctx_head(ctx_vec).squeeze(-1)

        feat_in = features
        if self.training and feat_dropout > 0.0:
            # Randomly mask out frequency/edit scalar features (keeping kind/ascii flags 5..9 & 18 intact)
            # on 50% of rows so the model never collapses onto scalar shortcuts.
            keep = (torch.rand(features.shape[0], 1, device=features.device) >= feat_dropout).float()
            mask = torch.ones_like(features)
            mask[:, 0:5] = keep
            mask[:, 10:18] = keep
            mask[:, 19:26] = keep
            feat_in = features * mask

        feat_vec = self.feat_proj(feat_in)
        feat_delta = self.head(torch.cat([ctx_vec, feat_vec], dim=-1)).squeeze(-1) + self.feat_skip(feat_in).squeeze(-1)
        raw_score = ctx_score + feat_delta

        is_space = features[:, 3]
        has_marks = features[:, 4]
        ascii_ctx = features[:, 5]
        is_marks = features[:, 6]
        is_deda = features[:, 7]
        is_ki = features[:, 8]
        is_mi = features[:, 9]
        is_typo = features[:, 18]
        is_marks_ascii = is_marks * ascii_ctx
        is_marks_marked = is_marks * (1.0 - ascii_ctx)

        bias = (
            self.prior_bias[0] * is_marks_marked * has_marks
            + self.prior_bias[1] * is_deda * is_space
            + self.prior_bias[2] * is_ki * is_space
            + self.prior_bias[3] * is_mi * is_space
            + self.prior_bias[4] * is_typo
        )
        scale = (
            self.regime_inv_temp[0] * is_marks_ascii
            + self.regime_inv_temp[1] * is_marks_marked
            + self.regime_inv_temp[2] * is_deda
            + self.regime_inv_temp[3] * is_ki
            + self.regime_inv_temp[4] * is_mi
            + self.regime_inv_temp[5] * is_typo
        )
        scale = scale + (1.0 - (is_marks + is_deda + is_ki + is_mi + is_typo)).clamp(min=0.0)
        return (raw_score - bias) * scale * self.inv_temperature, ctx_score

    def forward(
        self,
        subwords: torch.Tensor,
        sub_segments: torch.Tensor,
        features: torch.Tensor,
    ) -> torch.Tensor:
        total, _ = self.forward_parts(subwords, sub_segments, features, feat_dropout=0.0)
        return total
