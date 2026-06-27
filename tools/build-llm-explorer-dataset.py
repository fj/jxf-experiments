#!/usr/bin/env python3
"""Build the vendored dataset for the LLM Explorer experiment.

The explorer is a static page, so it ships a self-contained JSON snapshot
rather than calling out to any API at runtime. This script regenerates that
snapshot from two sources:

  1. models.dev  — an open, CORS-enabled registry of models with first-party
     pricing, context/output limits, modalities, and release dates. This is
     the spine: everything except throughput comes from here, verbatim, so
     prices stay honest and refreshable. https://models.dev/api.json

  2. Curated throughput — median *output* tokens/sec. No open, redistributable
     registry publishes this (it's provider/hardware dependent), so the figures
     in THROUGHPUT below are indicative values compiled from the public
     Artificial Analysis benchmarks (https://artificialanalysis.ai), rounded.
     They're meant for relative comparison in an exploratory chart, not as
     precise quotes — actual speed varies by provider and load.

Usage:
    python3 tools/build-llm-explorer-dataset.py [path-to-models.dev.json]

With no argument it fetches models.dev live. Pass a local copy to build offline.
Output: site/assets/data/llm-explorer.json
"""

import json
import os
import sys
import urllib.request
from datetime import date

MODELS_DEV_URL = "https://models.dev/api.json"
# Shipped as a JS file (not JSON): the host page loads it with a plain
# <script src> that sets a global, so no JSON/templating pipeline is involved.
OUT_PATH = os.path.join(
    os.path.dirname(__file__), "..", "llm-explorer", "data.js"
)

# Curated "popular" set. Each entry pins a models.dev (provider, id) pair to a
# display brand (used to group/colour the chart) and an indicative median
# output-tokens/sec figure. Keep this list current when refreshing.
#   provider, id, brand, tok_per_sec
CURATED = [
    # Anthropic
    ("anthropic", "claude-opus-4-8", "Anthropic", 68),
    ("anthropic", "claude-sonnet-4-6", "Anthropic", 88),
    ("anthropic", "claude-haiku-4-5", "Anthropic", 145),
    ("anthropic", "claude-opus-4-5", "Anthropic", 70),
    ("anthropic", "claude-fable-5", "Anthropic", 60),
    # OpenAI
    ("openai", "gpt-5.2", "OpenAI", 90),
    ("openai", "gpt-5.1", "OpenAI", 110),
    ("openai", "gpt-5", "OpenAI", 130),
    ("openai", "gpt-5-mini", "OpenAI", 200),
    ("openai", "gpt-5-nano", "OpenAI", 290),
    ("openai", "o3", "OpenAI", 145),
    ("openai", "gpt-4o", "OpenAI", 140),
    ("openai", "gpt-4o-mini", "OpenAI", 180),
    # Google
    ("google", "gemini-3-pro-preview", "Google", 95),
    ("google", "gemini-2.5-pro", "Google", 150),
    ("google", "gemini-2.5-flash", "Google", 220),
    ("google", "gemini-2.5-flash-lite", "Google", 300),
    ("google", "gemini-3.5-flash", "Google", 200),
    # DeepSeek
    ("deepseek", "deepseek-v4-pro", "DeepSeek", 50),
    ("deepseek", "deepseek-chat", "DeepSeek", 35),
    ("deepseek", "deepseek-reasoner", "DeepSeek", 28),
    # xAI
    ("xai", "grok-4.3", "xAI", 45),
    # Mistral
    ("mistral", "mistral-medium-2604", "Mistral", 100),
    ("mistral", "mistral-small-latest", "Mistral", 150),
    ("mistral", "mistral-large-latest", "Mistral", 90),
    # Alibaba (Qwen)
    ("alibaba", "qwen3.7-max", "Qwen", 60),
    ("alibaba", "qwen3.7-plus", "Qwen", 75),
    # Moonshot (Kimi)
    ("moonshotai", "kimi-k2.6", "Moonshot", 44),
    ("moonshotai", "kimi-k2.7-code", "Moonshot", 50),
    # Zhipu (GLM)
    ("zhipuai", "glm-5.2", "Zhipu", 55),
    ("zhipuai", "glm-4.6", "Zhipu", 60),
    # Cohere
    ("cohere", "command-a-plus-05-2026", "Cohere", 70),
    # Meta (Llama) — open weights; priced/served here via Groq's LPU hardware,
    # which is why throughput is far higher than the frontier closed models.
    ("groq", "llama-3.3-70b-versatile", "Meta", 280),
    ("groq", "meta-llama/llama-4-scout-17b-16e-instruct", "Meta", 600),
    ("groq", "llama-3.1-8b-instant", "Meta", 750),
]

# Providers whose pricing/serving is via a third-party host rather than the
# model's own lab. Surfaced in the UI so the cost/speed is read in context.
HOST_LABEL = {"groq": "Groq"}

# Models selected by default when the page first loads (one or two notable
# current models per brand) so the chart isn't overwhelming on arrival. The
# full curated set is always available in the picker.
FEATURED = {
    "anthropic/claude-opus-4-8",
    "anthropic/claude-sonnet-4-6",
    "anthropic/claude-haiku-4-5",
    "openai/gpt-5.2",
    "openai/gpt-5-mini",
    "google/gemini-3-pro-preview",
    "google/gemini-2.5-flash",
    "deepseek/deepseek-v4-pro",
    "xai/grok-4.3",
    "mistral/mistral-medium-2604",
    "alibaba/qwen3.7-max",
    "moonshotai/kimi-k2.6",
    "zhipuai/glm-5.2",
    "groq/llama-3.3-70b-versatile",
}


def load_registry(path_arg):
    if path_arg:
        with open(path_arg) as f:
            return json.load(f)
    req = urllib.request.Request(MODELS_DEV_URL, headers={"User-Agent": "jxf-site/llm-explorer"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.load(resp)


def build(registry):
    models = []
    missing = []
    for provider, model_id, brand, tps in CURATED:
        node = registry.get(provider, {}).get("models", {}).get(model_id)
        if not node:
            missing.append(f"{provider}/{model_id}")
            continue
        cost = node.get("cost") or {}
        limit = node.get("limit") or {}
        modalities = (node.get("modalities") or {}).get("input") or ["text"]
        name = (node.get("name") or model_id).replace(" (latest)", "")
        entry = {
            "id": f"{provider}/{model_id}",
            "name": name,
            "brand": brand,
            "host": HOST_LABEL.get(provider),
            "input": cost.get("input"),
            "output": cost.get("output"),
            "cacheRead": cost.get("cache_read"),
            "cacheWrite": cost.get("cache_write"),
            "context": limit.get("context"),
            "maxOutput": limit.get("output"),
            "reasoning": bool(node.get("reasoning")),
            "modalities": modalities,
            "release": node.get("release_date"),
            "tokensPerSec": tps,
            "featured": f"{provider}/{model_id}" in FEATURED,
        }
        # Skip non-text or unpriced models defensively (shouldn't happen for the
        # curated set, but keeps the snapshot clean if an id drifts).
        if entry["input"] is None or entry["output"] is None:
            missing.append(f"{provider}/{model_id} (no price)")
            continue
        models.append(entry)

    if missing:
        sys.stderr.write("WARNING: skipped entries not found / unpriced:\n  " + "\n  ".join(missing) + "\n")

    models.sort(key=lambda m: (m["brand"], m["name"]))
    return {
        "generated": date.today().isoformat(),
        "sources": {
            "pricing_and_metadata": {
                "name": "models.dev",
                "url": MODELS_DEV_URL,
                "note": "First-party API pricing, context/output limits, modalities, and release dates.",
            },
            "throughput": {
                "name": "Artificial Analysis (indicative)",
                "url": "https://artificialanalysis.ai",
                "note": (
                    "Median output tokens/sec are representative figures compiled from public "
                    "Artificial Analysis benchmarks and rounded. Real throughput varies by "
                    "provider and load; use for relative comparison, not precise quotes."
                ),
            },
        },
        "units": {
            "input": "USD per 1M input tokens",
            "output": "USD per 1M output tokens",
            "cacheRead": "USD per 1M cached input tokens",
            "tokensPerSec": "median output tokens per second",
        },
        "models": models,
    }


def main():
    path_arg = sys.argv[1] if len(sys.argv) > 1 else None
    registry = load_registry(path_arg)
    data = build(registry)
    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, "w") as f:
        f.write("// Generated by tools/build-llm-explorer-dataset.py — do not edit by hand.\n")
        f.write("// Dataset is shipped as JS (not JSON) so the host page embeds it with a\n")
        f.write("// plain <script src>, never touching a JSON/templating pipeline.\n")
        f.write("window.JXF_EXP_DATA = window.JXF_EXP_DATA || {};\n")
        f.write('window.JXF_EXP_DATA["llm-explorer"] = ')
        json.dump(data, f, indent=2)
        f.write(";\n")
    print(f"Wrote {len(data['models'])} models to {os.path.relpath(OUT_PATH)} (generated {data['generated']})")


if __name__ == "__main__":
    main()
