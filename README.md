# pi-context-workflow

Automated code development pipeline for the pi coding agent.

```
Write → Test → Review → Fix → Verify → Done
```

## Quick Start

```
/workflow my-project strict create a password hasher with bcrypt... fixes #42
/workflow quick utils create helper functions
/workflow strict auth-service build login API with JWT tokens
```

## Modes

| Mode | Pipeline | Gate |
|------|----------|------|
| default | Write → Test → Review → Fix → Verify → Done | Coverage ≥80% |
| `quick` | Write → Test → Verify → Done | None |
| `strict` | Write → Test → Review → Fix → Verify → Done | Coverage ≥90% |

## Usage

```
/workflow [name] [quick|strict] <spec>
```

- **name** — optional project name (auto-generated from spec if omitted)
- **mode** — optional mode prefix (`quick` or `strict`)
- **spec** — feature description, or path to `.md`/`.txt` file

### Examples

```bash
# Full cycle with custom name
/workflow markdown-parser in @tests create a heading parser...

# Strict mode with linked issue
/workflow strict auth-service create login API with JWT tokens fixes #42

# Quick mode, auto-named
/workflow quick create a set of math utility functions

# From file
/workflow ./specs/feature.md
```

## Pipeline Stages

### 1. Write
Agent creates implementation in `projects/<name>/src/` and tests in `projects/<name>/tests/`. Commits with `wip:` prefix.

### 2. Test
Agent runs test suite. Exit code parsed deterministically — 0 = pass. Commits with `test:` prefix.

### 3. Review
Agent reviews code with domain-specific checklist injected based on spec keywords:

| Spec keywords | Checklist items |
|---|---|
| auth, password, login, token | Security: injection, hashing, token safety |
| api, fetch, http, request | API: error handling, timeouts, response validation |
| file, fs, read, write, save | I/O: error recovery, missing files, encoding |
| async, promise, await | Async: error propagation, unhandled rejections |
| ui, component, render, dom | UI: a11y, loading/empty states, error boundaries |
| db, database, sql, query | Data: injection, transactions, connection handling |

### 4. Fix
Agent addresses review findings. Commits with `fix:` prefix. Returns to test stage.

### 5. Verify
Agent runs tests + coverage. Must meet coverage threshold (80% default, 90% strict). Gate status shown in completion.

### 6. Done
Workflow finalizes — the completion banner (project name, location, tests, coverage, linked issues) is returned as tool result content from `workflow_complete`. README, changelog entry, and final commit are generated.

## Directory Structure

```
projects/<name>/
├── src/
│   └── <module>.ts
├── tests/
│   └── <module>.test.ts
├── README.md          ← generated on completion
└── POSTMORTEM.md      ← generated on failure
```

## Tools

| Tool | Stage | Description |
|------|-------|-------------|
| `workflow_next` | all | Advance to next stage |
| `workflow_test_result` | test, verify | Report test exit code |
| `workflow_review_result` | review | Report review findings |
| `workflow_verify_result` | verify | Report type-check, lint, coverage |
| `workflow_complete` | verify, done | Finalize workflow |

## Commands

| Command | Description |
|---------|-------------|
| `/workflow [name] [mode] <spec>` | Start workflow |
| `/workflow:status` | Show current stage, gates, issues |
| `/workflow:cancel` | Cancel workflow |

## Git Integration

Auto-commits after each stage with structured messages:

```
wip: project-name — implementation + tests
test: all passing
fix: project-name — address review feedback
chore: workflow complete — project-name
```

## Issue Linking

Extracts issue references from spec and displays them in completion:

```
closes #42, resolves RM-123, GH-789
```

Linked issues appear in the completion banner, README, and changelog.

## Changelog

Appends to `CHANGELOG.md` on completion:

```markdown
## 2026-05-09 — markdown-parser: fixed trailing whitespace in headings (fixes #42)
```

## Output Artifacts

| File | When | Contents |
|------|------|----------|
| `projects/<name>/README.md` | Completion | Summary, spec, results table, stats |
| `CHANGELOG.md` (root) | Completion | Date, project, summary, linked issues |
| `projects/<name>/POSTMORTEM.md` | Failure | Timeline, root cause, spec |

## Completion Banner

Returned as tool result content from `workflow_complete`:

```
✅ **markdown-parser** is complete

📁 **Location:** `projects/markdown-parser/`
🧪 **Tests:** All passing
📊 **Coverage:** 94% ✓ (≥80% required)

Linked: fixes #42
```

## State Persistence

Workflow state persists in session branch entries. Survives context compaction. Restored on session restart.

## Installation

Copy `index.ts` to `~/.pi/agent/extensions/context-workflow.ts`. Restart pi.

```bash
cp index.ts ~/.pi/agent/extensions/context-workflow.ts
```
