# LLM application security

**Purpose:** the OWASP Top 10 for LLM Applications 2025 as checks for code that calls a model; LLM-n is LLM0n:2025 (LLM10 for LLM-10). **Reads:** the security reviewer; implementer and designer while the pack is active. **When:** a diff that touches prompts, model calls, retrieval or tools for a model; an audit of an LLM feature.

**Section map**
- §Input and context — prompt injection, sensitive data, system prompts.
- §Output and agency — output handling, excessive agency, misinformation.
- §Data and models — supply chain, poisoning, vectors and embeddings.
- §Consumption — limits on requests, tokens and spend.

## Pack: ai

### Input and context
**LLM-1.** LLM01 Prompt Injection: every text a model reads (user input, documents, web pages, tool results, files) may carry instructions; the defence is what the model cannot do, not the prompt: no secret in its context, tools per LLM-6, untrusted content separated and labeled, and a direct and indirect injection test for each new input source.
**LLM-2.** LLM02 Sensitive Information Disclosure: a model's context holds only data the current user may see, filtered by tenant and permission before retrieval, not after generation; training, fine-tuning and prompt logs exclude secrets and personal data without consent, and output passes the same redaction as logs (security pack, SCD-9).
**LLM-7.** LLM07 System Prompt Leakage: a system prompt holds no secret, credential, internal URL or authorization rule; code outside the model enforces access, so a leaked prompt grants nothing.

### Output and agency
**LLM-5.** LLM05 Improper Output Handling: model output is untrusted input to every sink (security pack, OWA-5): encode it for HTML and Markdown (no auto-loaded images or links to arbitrary hosts, which leak data), never pass it to `eval`, a shell, SQL or a file path unchecked, and validate structured output against a schema before use.
**LLM-6.** LLM06 Excessive Agency: each tool gives the model the narrowest function, permission and data the feature needs and acts with the user's rights, not a service account's; an irreversible or costly action needs a human confirmation outside the model (security pack, SCD-10).
**LLM-9.** LLM09 Misinformation: an answer people act on cites its sources and says when it does not know; where a wrong answer causes harm it gets a human or automated check; generated code and package names are verified to exist before use (package hallucination).

### Data and models
**LLM-3.** LLM03 Supply Chain: models, adapters, datasets and model SDKs come from verified sources with pinned versions or hashes; no `trust_remote_code` or pickle loading from an unverified source; a model or provider change goes through a decision and an evaluation run.
**LLM-4.** LLM04 Data and Model Poisoning: data that trains, fine-tunes or feeds retrieval has a known origin and an ingestion check; user content enters shared stores or training only after validation, and an evaluation set catches a behaviour change before release.
**LLM-8.** LLM08 Vector and Embedding Weaknesses: a vector store is partitioned by tenant and checks permission on every query, documents are checked before embedding (hidden text, embedded instructions), and embeddings of sensitive data get the protection of the data.

### Consumption
**LLM-10.** LLM10 Unbounded Consumption: limits per user and per tenant cap requests, input and output tokens, tool-call loops and spend, with timeouts and an alert on anomalies; an oversized input is cut or refused before it reaches the model.
