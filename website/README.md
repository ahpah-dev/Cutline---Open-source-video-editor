# Cutline introduction website

Live: https://cutlinevideo.vercel.app/

A lightweight, static marketing website for Cutline v0.8.6. HTML, CSS and a small progressive-enhancement gallery; no application framework, build step, tracking, backend or environment secrets. Fonts and authentic editor screenshots are served locally. Includes seven keyboard-accessible interface views, full-size screenshot dialogs, responsive feature cards, reduced-motion support and current release/checksum links.

## Deployment

Deploy **this directory**, not the parent editor repository. Vercel project: `cutlinevideo`, team: `davidegeric-clouds-projects`. Framework: Other; no build or install command.

```powershell
npx vercel --scope davidegeric-clouds-projects deploy --project cutlinevideo --prod --yes --non-interactive
```

The Windows installer and portable links pin the public v0.8.6 GitHub release. When publishing a newer app release, update the version labels, URLs and feature claims together. Screenshot assets originate from the Cutline repository's `docs/screenshots`; fonts include their licenses under `assets`.

Verify the existing project and scope before deploying. Prefer a production-target staging deployment with `--skip-domain`, test it, then promote the same deployment. Run `tests/website-qa.cjs` with Electron against the local static preview or set `CUTLINE_WEBSITE_URL` to the deployment URL.
