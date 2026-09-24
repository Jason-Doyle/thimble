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

No deployment command or Cloudflare configuration is included yet. Deployment
will be added only after the local site is approved.
