# Codex Project Guide

This project is **Recall AI 错题本**, an MVP-stage AI-assisted wrong-answer review product.

## Start Here

At the start of every new task in this project, read these files first:

1. `docs/PROJECT_STATE.md`
2. `Recall AI错题本产品需求文档_PRD_V2.0.md`
3. `Recall AI 错题本 UIUX 设计方案.md`
4. `AI错题本技术方案.md`
5. `AI错题本系统架构图.md`

Use `docs/PROJECT_STATE.md` as the current progress snapshot. Use the PRD, UIUX document, technical plan, and architecture diagram as the product and engineering baseline.

## Product Principles

- This is a wrong-answer review product, not an AI search-answer product.
- AI should be embedded in the workflow, not exposed as the main entry.
- Uploading a question does not make it official; AI recognition must be confirmed by the user before entering the wrong-answer library.
- The user’s own solving note is a core learning asset. Standard explanations should be secondary and folded by default.
- MVP should favor completion over optimization.

## UIUX Direction

- Visual style: Codex-like minimal structure, soft learning colors, light asymmetry.
- Bottom navigation: 首页 / 错题 / 复习 / 我的.
- Upload is not a bottom-nav item; it is a primary action on the home page.
- Home page is upload-first for cold start, while review grows in weight as due-review pressure increases.
- Avoid heavy gamification, course-marketplace styling, and AI-chat-first layouts.

## Working Style

- Before changing files, understand the relevant documents and existing state.
- Keep changes scoped to the user’s current goal.
- Prefer concise, maintainable documents and implementation plans.
- When creating new project memory, update `docs/PROJECT_STATE.md` instead of relying on chat history.
- Do not remove or rewrite prior user-authored decisions unless the user explicitly asks.

## Suggested Next Development Documents

When moving from planning into implementation, create these before coding large features:

- `docs/MVP_TASK_BREAKDOWN.md`
- `docs/API_SPEC.md`
- `docs/DATABASE_SCHEMA.md`
- `docs/UI_PAGE_SPEC.md`

## Repeated Error Memory

- At the start of each task, scan `docs/ERROR_LOG.md` for `Open` and `Monitoring` items related to the current area.
- If the same error appears twice in one task, reappears after a fix, or causes data loss, quota loss, model cost, key exposure, or a blocked user path, add an entry to `docs/ERROR_LOG.md` before finishing the task.
- Each entry must include the symptom, root cause, impact, fix, verification evidence, and prevention rule.
- Do not delete old error entries. Move them through `Open -> Fixed/Monitoring -> Closed` and preserve the history.
