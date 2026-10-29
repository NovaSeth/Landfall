# Agent security

**Purpose:** the OWASP Top 10 for Agentic Applications 2026 as checks for code that runs agents, tools and multi-agent flows; AGT-n is ASI0n (ASI10 for AGT-10). **Reads:** the security reviewer; implementer and designer while the pack is active. **When:** a diff that touches an agent loop, its tools, memory, credentials or MCP servers; an audit of an agent feature.

**Section map**
- §Goals and tools — goal hijack, tool misuse, code execution.
- §Identity and supply chain — identity and privileges, agentic supply chain.
- §Memory and communication — memory and context poisoning, communication between agents.
- §Control — cascading failures, human trust, rogue agents.

## Pack: ai

### Goals and tools
**AGT-1.** ASI01 Agent Goal Hijack: an agent's goal and plan come only from its principal; content it reads cannot add goals, so a plan change triggered by read content stops for confirmation, and tests feed documents and tool results that carry instructions (LLM-1).
**AGT-2.** ASI02 Tool Misuse and Exploitation: each tool validates its arguments as untrusted input (security pack, OWA-5), runs with least privilege and a rate limit, outbound network tools have a host allow-list, and no chain of allowed tools reaches a forbidden effect (read a secret, then send it out).
**AGT-5.** ASI05 Unexpected Code Execution: code an agent writes or runs executes in a sandbox without secrets, network or host write access by default, with an allow-list of commands; generated code never runs through `eval` in the host process.

### Identity and supply chain
**AGT-3.** ASI03 Identity and Privilege Abuse: an agent acts under its own identity with short-lived, scoped credentials, never a shared or inherited admin token; delegation passes the user's rights down and never widens them, and every action is attributable to the agent and the user.
**AGT-4.** ASI04 Agentic Supply Chain Vulnerabilities: MCP servers, plugins, tools and prompt templates are pinned by version or hash from known publishers; a changed tool description or manifest needs approval again (rug pull), and tool descriptions are read as untrusted text (tool poisoning).

### Memory and communication
**AGT-6.** ASI06 Memory and Context Poisoning: long-term memory, shared context and retrieved notes record their source and trust; content from an untrusted source is stored as data, never as instructions, memory is partitioned per user and tenant, and it can be inspected and rolled back.
**AGT-7.** ASI07 Insecure Inter-Agent Communication: messages between agents are authenticated and integrity-protected and carry the original principal; the receiver validates them like external input and never acts beyond its own permissions on a peer's request.

### Control
**AGT-8.** ASI08 Cascading Failures: every agent loop and pipeline has caps (steps, time, spend), stall detection and a typed exit; one agent's output is checked before another acts on it, and a circuit breaker stops a fan-out that keeps failing.
**AGT-9.** ASI09 Human-Agent Trust Exploitation: a confirmation shows the exact action, target and effect rendered by code, not the model's summary; the agent cannot claim urgency or authority, and a human approves irreversible or high-value actions with full context.
**AGT-10.** ASI10 Rogue Agents: each agent action is logged and compared with its declared scope; a kill switch revokes its credentials and stops its runs, and an agent cannot change its own permissions, instructions or monitors.
