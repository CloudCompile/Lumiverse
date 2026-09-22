---
title: Connections
---

# Connections

A **connection** links Lumiverse to an AI provider. The Connections drawer groups profiles by purpose: chat/LLM, embedding models, image generation, speech-to-text, and text-to-speech. Each profile specifies the provider, model, endpoint, and encrypted API key for that purpose.

Embedding profiles live under **Embedding Models** and are only offered in **Settings > Embeddings**. Keeping them separate prevents a chat model endpoint from being selected accidentally for vectorization. Existing direct embedding configurations and embedding profiles created from OpenAI-compatible chat connections are migrated automatically.

---

## Key Concepts

- **Provider** — The AI service (OpenAI, Anthropic, Google, etc.)
- **Model** — The specific model to use (e.g., GPT-4o, Claude Sonnet, Gemini Pro)
- **API Key** — Your authentication credential (stored encrypted)
- **API URL** — The endpoint URL (auto-filled for standard providers, customizable for self-hosted models)
- **Default Connection** — The connection used when no specific one is selected

---

## Quick Links

- [Setting Up a Connection](setting-up.md) — Step-by-step guide
- [Supported Providers](providers.md) — Full list of 21 supported providers
