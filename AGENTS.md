# Event Console contributor guidance

## Purpose and reading order

This repository is a starting point for people who give its GitHub URL to their own AI CLI and adapt it to their event and equipment. Read `README.md`, `docs/AI_CUSTOMIZATION.md`, `docs/ARCHITECTURE.md`, `docs/OPERATION_TIPS.md` and `docs/DEVLOG.md` before changing behavior. Verify historical notes against current code and tests.

- First establish the user's OS, event rules, team count, display resolution, camera/audio devices and OBS workflow. Inspect installed prerequisites; if OBS is needed but missing, require installation through its official download instructions before OBS rehearsal. The browser-only projector workflow does not require OBS.
- OBS Browser Source has a separate browser context from Chrome/Edge. Capture the existing display window by default; direct Browser Source integration needs an explicit synchronization design.
- Leave concise rationale near non-obvious state, timing, audio and persistence boundaries. Update the relevant guide and `docs/DEVLOG.md` when those contracts change; record the symptom, decision, code/test references and verification limits.
- Keep `docs/FILE_GUIDE.md` aligned with file and folder responsibilities when adding, moving or splitting modules. The distribution's single-commit history is not a substitute for these explanations and source comments.
- Use neutral fictional fixtures. Never copy participant/operator names, raw private conversations, original handoffs, personal paths or account secrets into source, tests, screenshots, commit messages or devlogs. Preserve legally required third-party copyright and license notices verbatim.

## Repository and validation rules

- Keep the GitHub repository **private** until the owner explicitly authorizes a public visibility change. MIT licensing does not authorize changing repository visibility.
- Keep the project name Event Console. The README may name the original organization and event as factual creation context and a usage example. Describe this as the creator's personal project; do not imply an official organizational product, release or endorsement. Do not remove factual attribution merely because it includes the event name.
- Preserve the original event installation. This repository has its own browser storage, IndexedDB, window names and synchronization channels; do not reuse the original installation's namespaces. The distribution's existing `nsdh-console` / `nsdh.console.*` internal identifiers are retained for data compatibility after renaming; they are not display branding. Do not rename persistent identifiers without a tested migration for state and media.
- Do not add event videos, music, participant photos, broadcast reference images, personal absolute paths, credentials, browser profiles or generated app bundles to Git.
- Keep the five bundled fonts and their copyright/OFL notices together. Application code and original SVG fallback artwork use MIT; fonts retain OFL 1.1.
- Keep the standalone default usable without optional event media. Test playback/state logic with synthetic fixtures, not private files or skipped tests.
- Runtime paths must be relative to the installation or selected by the user. Do not change machine-wide browser policy or automatically reuse an unrelated server.
- Before committing, run `npm run typecheck`, `npm test`, `npm run build`, `npm audit` and `git diff --check`. Keep MIT and font notices in built output.
- Repository-specific owner instruction: use descriptive commit titles without an AI-tool prefix. This overrides the global Codex commit-prefix convention for this repository. Do not add `Co-Authored-By` trailers.
- Do not treat unit tests as a substitute for real camera, sound-system and projector rehearsal.
