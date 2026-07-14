# Orchestrating Claude Code (Opus) from Codex

A field guide for a **coordinating agent** (Codex, or any outer agent/human
operator) that drives the local **Claude Code CLI** to do the token-heavy
implementation, while the coordinator plans, reviews, and gates. This is the
companion to [DRIVING-OPUS.md](DRIVING-OPUS.md): that guide covers a human
operating Opus directly in the Claude Code UI; this one covers an outer agent
shelling out to `claude -p` as a worker pool.

It is written from how **Phase 8 (the AI reasoning layer) was actually
orchestrated** in this repo — including the parts that did not go cleanly.
Where a lesson is repo-specific it is marked *(Meridian)*; the rest is
portable.

> **Honesty rule (non-negotiable).** Never report a worker as having completed
> when it timed out, was quota-interrupted, or left partial output. Never call
> a gate green unless the command exited zero and you saw the output. The
> value of this whole pattern is independent verification; fabricated success
> destroys it.

---

## 1. Prerequisites

- **Local Claude Code CLI** installed and authenticated. *(Meridian used
  version 2.1.177.)* Check with `claude --version`.
- The coordinator invokes it non-interactively: `claude -p --model opus …`.
  - `--model opus` is an **alias** that resolves to the authenticated
    account's current Opus. It does **not** pin an exact build. Phase 8 workers
    ran on the **unpinned `opus` alias** and did **not** capture a full
    resolved model ID at launch time. The 2026-07-14 documentation
    writer/reviewer JSON did report `modelUsage` as `claude-opus-4-8`, but
    that alias can resolve differently in the future — treat it as a snapshot,
    not a guarantee. If you need exact pinning (reproducibility, audits), pass
    the full model ID instead, e.g. `--model claude-opus-4-8`, and record the
    resolved ID from the session output rather than assuming it.
- **Network/filesystem access for the worker.** On the **Codex host/session
  used for Phase 8**, a managed disclosure/security gate blocked the outer
  agent from launching Claude Code by default. This is specific to that host's
  configuration — it is **not** a universal Claude default; other environments
  gate differently or not at all. Phase 8 only proceeded after the user
  **explicitly changed the environment to unrestricted network/filesystem
  access**. Where such a gate exists, expect the launch to be refused until
  then — that refusal is a feature, not a bug.
- **Data-egress authorization.** Running Claude Code over this repo **sends
  relevant private repository content to Anthropic**. That requires the user's
  authorization and a trusted-use policy. Confirm it before the first run; do
  not infer consent from a general "go ahead."
- A clean baseline: capture `git status` before dispatching any worker
  (see §6).

---

## 2. Why this shape (and when *not* to use it)

Claude Code sessions launched with `--no-session-persistence` are **fresh** —
no memory of prior workers. That is the whole reason for the
**plan → review → execute → gate** discipline below: the reconciled plan must
be re-embedded into every execute prompt, because nothing carries over.

Use this pattern for a large, decomposable phase with real architectural
decisions (Phase 8 was a provider-agnostic AI gateway + services + Studio +
evals). For a single-file sequential change, just drive one session; the
orchestration overhead is not worth it.

---

## 3. Role matrix

| Role | Who | Permissions | Persistence | Output |
|---|---|---|---|---|
| **Orchestrator** | Codex / outer agent | full (its own env) | across the phase | reconciliation, dispatch, final validation |
| **Planner** (×N parallel) | Claude Code | read-only (`--permission-mode plan`) | fresh | a plan artifact, no edits |
| **Implementer** (×N, disjoint files) | Claude Code | write, trusted execute only | fresh | edits within its file scope |
| **Reviewer** (×N parallel) | Claude Code | read-only | fresh | adversarial findings, no edits |
| **Remediator** (bounded) | Claude Code | write, narrow scope | fresh | fixes for specific findings |
| **Gate** | Orchestrator + human | — | — | independent re-run of gates; human tag |

Planners and reviewers are **read-only on purpose** — an agent that cannot
write cannot "helpfully" edit while it is supposed to be analyzing.

---

## 4. Staged workflow (the pattern that was applied)

1. **Plan (parallel, read-only).** Dispatch three planning workers with
   **disjoint questions** — for Phase 8: (a) requirements/scope from the
   roadmap, (b) provider architecture (the `AiProvider` seam, adapter
   confinement), (c) the test matrix (record/replay, failure modes). Each is
   `--permission-mode plan` and produces a written plan only.
2. **Reconcile (orchestrator).** The coordinator reads all three plans and
   writes a single **reconciled contract**: explicit decisions, file
   ownership map, and the acceptance gates. This is the artifact every later
   worker gets a copy of.
3. **Execute (waves, disjoint file ownership).** Fresh implementation
   sessions, each owning a **non-overlapping** set of files. The execute
   prompt **embeds the reconciled contract** verbatim (workers are fresh —
   see §2). Prefer several medium, bounded sessions over one giant session
   (see §7).
4. **Review (parallel, read-only, adversarial).** Independent reviewers, none
   of which wrote the code, each told to *try to break it*. Read-only.
5. **Remediate (bounded).** Narrow workers apply specific review findings —
   each scoped to a named fix, not "clean up the module."
6. **Validate (orchestrator + human).** The coordinator **independently**
   re-runs the gates (§8). The human closes the phase and tags.

Initial generic platform subagents were **stopped** when the user asked for
local Claude Code specifically; do not keep a parallel worker pool running on
a different substrate once the substrate has been chosen.

---

## 5. Command templates

Portable shapes — adjust tool lists and paths to your repo. Mind shell
quoting: keep the whole prompt in single quotes, or pass it on stdin.

**Read-only planning:**

```sh
claude -p --model opus \
  --permission-mode plan \
  --no-session-persistence \
  --name plan-provider-arch \
  'Read docs/ROADMAP.md Phase 8 and docs/adr/0029*. Produce a written
   provider-architecture plan: the AiProvider seam, adapter confinement,
   config-based routing. Do NOT edit any file. Output the plan only.'
```

**Workspace editing (trusted execute), only after explicit authorization:**

```sh
claude -p --model opus \
  --permission-mode acceptEdits \
  --no-session-persistence \
  --name exec-gateway-core \
  'CONTRACT (reconciled): <paste the full reconciled contract here>.
   You own ONLY these files: packages/ai/src/{session,budget,...}.ts.
   Do not touch any other path. Do not commit. Write tests as you go.'
```

- `acceptEdits` lets the worker write files **but still denies shell
  verification** — it could not, in Phase 8, run the test command it needed to
  self-check (see §7). Budget for the orchestrator to run verification.
- `--dangerously-skip-permissions` **bypasses all checks and is recommended
  only for sandboxes with no internet access** (the local CLI help says as
  much). Explicit authorization does **not** remove that risk — it only
  records that someone accepted it. In Phase 8 it was used for **trusted
  execute sessions only, and only after the user explicitly authorized it**.
  Never make it the default; prefer the narrowest `--permission-mode` and an
  explicit `--allowedTools` list. Treat bypass mode as a deliberate, authorized
  exception, documented each time.

**Independent review (read-only):**

```sh
claude -p --model opus \
  --permission-mode plan \
  --no-session-persistence \
  --name review-budget-policy \
  'Adversarially review packages/ai/src/budget.ts and its callers against
   docs/adr/0032*. Look specifically for units confusion (dollars vs tokens).
   Report findings with severity. Do NOT edit.'
```

**Recovery / continuation (after a partial or timed-out worker):**

```sh
claude -p --model opus \
  --permission-mode acceptEdits \
  --no-session-persistence \
  --name exec-gateway-core-cont \
  'Prior session left partial changes. CURRENT FAILURES:
   <paste exact failing test output / git diff summary here>.
   Fix only these. You own ONLY <files>. Do not commit.'
```

There is no invented flag here — if your CLI version names a flag differently,
check `claude --help` rather than copying blindly.

---

## 6. Shared-worktree discipline

All workers operated on **one shared working tree** *(Meridian)*. That is
efficient but fragile; the rules that kept it safe:

- **Baseline first.** Record `git status` before dispatch; that is your
  "user's pre-existing changes" reference. Preserve them — never revert or
  stash a file the user was editing.
- **No worker commits.** Ever. The orchestrator/human reviews and commits.
  (Same rule as [DRIVING-OPUS.md](DRIVING-OPUS.md) §3 "Builder never commits.")
- **No overlapping write scopes.** Two concurrent writers must own disjoint
  file sets. Overlap on a shared tree corrupts both.
- **Unique `--name` per worker** so process/output can be told apart.
- **Stop and recover on partial output.** If a worker dies mid-edit, do not
  fire a blind continuation — **inspect the diff first**, then embed the
  concrete current failures in the recovery prompt (§5).
- Watch for stray artifacts: a shared-worktree run once left a **NUL-byte
  artifact** in a file. `git diff --check` catches **whitespace errors and
  conflict markers** — it does **not** catch NUL bytes. Scan worker-changed
  text files explicitly with `rg -a -l '\x00' <changed paths>`, and inspect
  any unexpected binary entries reported by `git diff --numstat`.

---

## 7. Operational lessons (things that actually happened)

- **`acceptEdits` ≠ can verify.** Writes were allowed; **shell verification
  was denied**, so the worker could not run its own tests. Plan for the
  orchestrator to run gates.
- **Stream idle timeout on long/high-effort sessions.** Long `-p` sessions
  sometimes ended on a **stream idle timeout** after leaving *valid* partial
  changes. The changes were fine; the session just stopped. Do not treat a
  timeout as a failure of the work, nor as success — inspect the tree.
- **Account session quotas interrupt work.** Claude account quota limits
  interrupted sessions and displayed **reset times**. Work stopped mid-task;
  resume after reset with a recovery prompt.
- **Medium beats maximal.** Medium-effort, smaller **bounded** sessions
  completed more reliably than long maximal-effort ones. Slice work smaller.
- **`-p` text mode emits only a final answer.** There is no streaming
  progress in plain text mode, so **monitor process and file activity**
  (watch the tree, `git status`) rather than waiting for chatter — and send
  the user periodic updates yourself.
- **Never pretend a timed-out worker finished.** If it timed out, say it timed
  out and show the partial diff.

---

## 8. Validation checklist (orchestrator, independent)

- Use **`pnpm run ci`** — *not* bare `pnpm ci`, which pnpm treats as a clean
  install, not this repo's CI script *(Meridian; also flagged in the
  [README](../README.md))*.
- Re-run **focused gates independently** (per-package tests) so a slow or
  flaky monolithic run does not mask a real result.
- Run **`git diff --check`** (whitespace errors and conflict markers — note
  it does **not** detect NUL bytes).
- **Scan for NUL bytes explicitly** — `rg -a -l '\x00' <changed paths>` over
  worker-changed text files, and inspect any unexpected binary entries in
  `git diff --numstat`.
- **Verify file integrity** — open the files the workers touched; confirm no
  truncation or stray bytes.
- **Record failures honestly.** A nonzero exit is a failure, full stop.

**What the monolithic run did *(Meridian)*:** `pnpm run ci` was blocked by a
single **untouched, load-sensitive layout timing test** (a `<4ms` assertion)
that **passed in isolation** but failed under CI load. The response was to run
the **skipped stages independently** rather than declare CI red or fudge it
green; the full Playwright suite then passed **37/37** after fixing the real
Studio regression. The timing test was not "made to pass" — it was recognized
as environment-sensitive and verified in isolation, and that was reported as
such.

---

## 9. Reporting template

```text
PHASE / SCOPE: <what>
WORKERS DISPATCHED: <n planners, n implementers, n reviewers, n remediators>
AUTHORED BY:
  - Opus (Claude Code): <planning, gateway/docs impl, service/UI/eval work, reviews>
  - Bounded internal agents: <specific already-specified cleanups / one-line fixes>
GATES RUN (command → exit code → key numbers):
  - pnpm --filter @meridian/ai test → 0 → 88/88
  - pnpm run ci → <exit> → <which stages, which skipped-and-why>
UNVERIFIED / HUMAN-OWNED: <live recordings, human ratings, ADR acceptance, tag>
INTERRUPTIONS: <timeouts, quota resets, partial recoveries — honestly>
```

**Provenance of labor — keep it honest.** In Phase 8, **Opus** did the
token-heavy planning, the gateway and docs implementation, the
service/UI/eval work, and **two independent reviews**. After Opus **quota
exhaustion**, **bounded internal agents** applied the *already-specified*
gateway/eval cleanup and a **one-line Studio UI regression repair**. Future
reports must **distinguish** that split, not claim every edit was
Opus-authored.

---

## 10. Why independent review earns its cost

Real findings that the adversarial read-only reviewers surfaced in Phase 8 —
listed as **workflow lessons**, not as a phase changelog:

- A **dollar** budget was initially wired as **tokens** (units confusion).
- **OpenAI strict structured output** rejected otherwise-valid schemas.
- **Replay metering / provenance** mismatches.
- The eval **`--record` path was a stub**, not a real recorder.
- The **AI benchmarks were not initially in CI** (added to `pnpm bench`).
- A **stale phase checklist**.
- A shared-worktree **NUL-byte artifact**.
- A **Studio z-index regression**.

An independent reviewer who did not write the code brings a fresh perspective
and different assumptions, which makes defects like these easier to surface
than in self-review — which is exactly the argument for a separate,
adversarial, read-only review pass before the gate.

---

## 11. Bootstrap prompt (paste to start a run)

Give this to the coordinating agent to kick off an orchestrated phase:

```text
You are the coordinating agent. Drive the local Claude Code CLI
(`claude -p --model opus --no-session-persistence`) as a worker pool to
implement <PHASE>. Do NOT write the implementation yourself.

Before anything: confirm the user has (a) authorized sending this private
repo's content to Anthropic, and (b) enabled network/filesystem access for
the worker. Capture `git status` as the baseline.

Then run plan → reconcile → execute → review → remediate → validate:
1. Dispatch 3 read-only planners (--permission-mode plan) on disjoint
   questions: requirements, architecture, test matrix.
2. Reconcile into one written contract with explicit decisions + a disjoint
   file-ownership map + acceptance gates.
3. Execute in waves; each worker owns non-overlapping files and gets the FULL
   reconciled contract embedded (workers are fresh — nothing persists). Use
   the narrowest --permission-mode that works; use bypass mode only with
   explicit per-run authorization. No worker commits.
4. Dispatch independent read-only adversarial reviewers.
5. Remediate with bounded, single-purpose workers.
6. Independently re-run gates (`pnpm run ci`, focused suites, `git diff
   --check`). Report exit codes and real numbers.

Rules: no worker commits; preserve the user's pre-existing changes; unique
--name per worker; on any timeout/quota interruption, inspect the diff and
report the partial state honestly — never claim a stopped worker finished;
never call a gate green on a nonzero exit. Attribute labor accurately
(Opus vs. any fallback agents).
```

---

## 12. Portable principles vs. Meridian specifics

**Portable** (any repo): fresh workers → re-embed the contract; read-only
planners/reviewers; disjoint file ownership; no-commit workers; prefer narrow
permissions over bypass; medium bounded sessions over maximal ones; monitor
files not chatter; independent gate re-runs; honest reporting of timeouts,
quotas, and labor provenance.

**Meridian-specific**: `pnpm run ci` vs bare `pnpm ci`; the AI package layout
(`packages/ai`, `packages/ai-services`, `evals/`); the load-sensitive `<4ms`
layout timing test; Phase 8's `AiProvider`-seam architecture and its ADRs
(0029–0032); the 88/88 and 37/37 numbers. Treat these as examples of the
principles, not as commands to copy into another project.
