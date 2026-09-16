# Project instructions

## UI / UX work

- Before changing any visible interface, read [docs/UI_UX_GUIDELINES.md](docs/UI_UX_GUIDELINES.md).
- Treat that document and `assets/ui-foundation.css` as the shared UI contract. Reuse existing components and tokens before adding page-specific styles.
- Follow the user's current request when it deliberately changes a documented decision; update the rule and shared component together. Do not ask for an extra approval just because a rule needs updating.
- Preserve API behavior, authentication, live status node IDs, unread tracking, and print/PDF output when making visual changes.
- Keep the external, scoped `support-share.html` flow separate from internal navigation and its UI enforcement.
- Run `python -m unittest test_ui_consistency.py` for interface changes and the existing tests relevant to changed behavior. Fix failures before delivery. Do not create tests that merely repeat CSS declarations.
- Apply the verification checklist in the guideline. Use browser QA when the user has authorized it; otherwise perform the applicable static and integration checks and state that limit.
- Keep user-facing reports focused on visible changes and verification, not tool or deployment details.

## Existing application

This repository is the existing Python/static application served at `app.aivida.tech`. Preserve its architecture and Railway deployment flow; do not initialize a replacement app or migrate hosting to perform a UI edit. Do not change secrets, storage, collectors, business calculations, or authentication as part of styling work.
