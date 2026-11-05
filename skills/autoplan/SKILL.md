---
name: autoplan
description: Plan on the stronger planning tier, then implement immediately on the main tier without an approval gate. Use when the user invokes /autoplan, or asks to plan-and-implement in one shot instead of reviewing the plan first.
---

Work the request in two phases, back to back. Do not pause between them.

## Phase 1 — Plan (planning tier)

Gather the facts you need first — files, commands, docs. Never ask the user for anything you can look up yourself.

Dispatch the plan design as one delegation:

- Call `subagent_fork` with the description `plan: design the implementation plan for <short task name>`. The `plan:` prefix routes this unit to the planning tier's more capable model, and the fork inherits this conversation, so the planner already has the full context.
- Ask it for a decision-complete plan: the goal and success criteria, the changes grouped by file or subsystem, schema/API/data-flow impact, edge cases and failure modes, the tests to add or run, and explicit assumptions where the request was ambiguous.
- If `subagent_fork` is not available to you, use `subagent` with the same `plan:` description and a self-contained prompt carrying every fact the planner needs.
- If you are already running as a delegated subagent, do not delegate again: write the plan yourself in a few lines and move on.

Do not ask the user to approve, review, or adjust the plan. Do not enter plan mode for this, and never route it through `exit_plan_mode` — the whole point is that implementation does not wait on sign-off.

If the delegation fails or comes back empty, retry once. If it still fails, write a short plan yourself and continue. Never stall waiting for a plan.

## Phase 2 — Implement (main tier)

Start implementing the moment the plan comes back.

- Do not ask for confirmation or permission, and do not ask the user to choose between options you can decide yourself. Make the sensible choice, record the assumption, and carry on. The user can correct course on the result.
- Implement it yourself, or dispatch independent parts as plain (execution-tier) units per the active delegation policy. Label only image, screenshot, or OCR work with `vision:`.
- Follow the plan as written. Where reality forces a deviation, deviate minimally and note it.
- Keep the harness's normal safety surface: approval prompts for risky operations, sandbox limits, and destructive-operation confirmations are not part of what this skill skips. Only plan review is.

## Finish

Report what was implemented, the checks or tests you ran and their results, any deviation from the plan, and the assumptions the plan made on the user's behalf.