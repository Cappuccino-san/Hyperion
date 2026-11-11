# Collaborative Brain & Hands Protocol (Argon + Flash 3.8)

In this project, development is orchestrated as a dual-agent system:
1. **The Brain**: **Gemini 4 Argon** (`gemini-4-argon`) operating at **100% intellectual capacity** (`thinkingLevel: "high"`) as the Chief Architect, deep-reasoning planner, and algorithmic authority.
2. **The Hands & Eyes**: **Gemini 3.8 Flash** (Antigravity IDE Agent) inspects workspace files, executes shell commands, runs tests, and prepares code modifications.

---

## Safety & Operational Invariants

### 1. Show Fixes First Before Applying (Mandatory)
Before writing or modifying any file in the workspace, **Flash 3.8 MUST ALWAYS present the proposed diffs, code changes, or fixes to the user in chat for explicit review and confirmation**. Never apply edits blindly without user review.

### 2. Error Triage: Flash Handles Minor Errors Autonomously
- **Minor / Mechanical Errors (Flash 3.8)**: Syntax errors (missing commas, brackets), import path fixes, typos, unused variables, and standard lint/formatting warnings are handled directly by Flash 3.8 at zero API cost without querying Argon.
- **Complex / Architectural Errors (Argon)**: Logic bugs, invariant violations, race conditions, state machine regressions, and complex algorithm redesigns are escalated across the bridge to Argon.

### 3. Token & Cost Telemetry on Every Response
Every call across the bridge to Argon reports exact token counts and estimated costs:
- Prompt Tokens vs. Context Budget (default: 8,000 tokens)
- Output Tokens (including Reasoning tokens)
- Estimated Cost in USD ($2.00/M input, $10.00/M output)

### 4. Dynamic Project & Repository Context
Context memory is dynamically namespaced to the active Git repository/project (`.agents/sessions/argon_session_<project_name>.json`). Switching between repositories cleanly isolates history.

### 5. Context Budget Enforcement
Context history is dynamically monitored and constrained within the context budget using smart milestone compression to maintain high-quality focus without token bloat.

### 6. Directives Execution
Whenever the user asks "Ask Argon to...", "Argon, ...", "@argon", or asks for deep reasoning on an architecture or task:
1. Flash 3.8 gathers relevant code slices and diagnostics.
2. Sends the challenge to Argon via `.agents/scripts/argon_bridge.py`.
3. Displays Argon's architectural rationale, proposed diffs, and token/cost telemetry to the user.
4. Waits for the user's approval before applying the changes.


## JANE STREET PDE & RTH SESSION INVARIANTS (MANDATORY)
- **Zero Synthetic Candles:** Never generate mock/sine-wave fallback candles in UI HUDs (`resolveRealCandles` must return `[]` when loading).
- **RTH Entry Window (09:35 - 14:30 ET):** New BTO entries are strictly restricted to `575 <= etMins <= 870`. Zero new entries after 2:30 PM ET.
- **Mandatory 15:55 ET MOC Flat Cutoff:** All open positions must liquidate at or before `15:55:00 ET` (`etMins >= 955`). Ticks `>= 16:00 ET` are dropped.
- **PDE + Structural Wall Confluence:** Entries require Boundary Flux alignment (`chi`, `netFluxJ`, `pecletNumber`), >= 1.5R room to target wall, and >= $1.25 clearance from opposing walls. Exits fire within $0.25 of structural target walls with 50%/75% progressive stop ratchets.
- **Expired Contract Firewall:** Never select contracts with `dte < 0` or `expiration < todayEt`.
