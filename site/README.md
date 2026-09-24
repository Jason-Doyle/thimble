# ThimbleDB public site

The site is a static Astro build. Repository Markdown under `../docs`,
`../CHANGELOG.md`, and the checked-in logo remain the content sources.

## Local development

From the repository root:

```powershell
npm --prefix site install
npm run site:dev
```

Open `http://localhost:4321`.

## Production build

```powershell
npm run site:build
npm run site:preview
```

## Cloudflare deployment

Deployment uses the existing `thimbledb-redirect` Worker so the current
custom-domain bindings remain in place while its redirect response is replaced
by static Workers Assets.

Validate the Cloudflare package without uploading:

```powershell
npm run site:deploy:check
```

Deploy after the protected branch and site review are approved:

```powershell
npm run site:deploy
```
