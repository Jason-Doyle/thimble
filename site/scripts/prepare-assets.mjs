import {
  copyFile,
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const siteRoot = fileURLToPath(new URL("../", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const sourceLogo = path.join(
  repositoryRoot,
  "public",
  "thimbledb-logo.png",
);
const sourceStudio = path.join(
  repositoryRoot,
  "docs",
  "assets",
  "thimbledb-studio.png",
);
const assetsDirectory = path.join(siteRoot, "public", "assets");
const evidenceDirectory = path.join(
  siteRoot,
  "public",
  "evidence",
);

await mkdir(assetsDirectory, { recursive: true });
await mkdir(evidenceDirectory, { recursive: true });
await copyFile(sourceLogo, path.join(assetsDirectory, "logo.png"));
for (const file of [
  "r2-current-layout-multiregion-2026-09-25.json",
  "r2-current-layout-summary-2026-09-25.csv",
]) {
  const source = await readFile(
    path.join(repositoryRoot, "evidence", file),
    "utf8",
  );
  await writeFile(
    path.join(evidenceDirectory, file),
    source.replaceAll("\r\n", "\n"),
    "utf8",
  );
}

await sharp(sourceLogo)
  .resize(64, 64)
  .png()
  .toFile(path.join(assetsDirectory, "favicon.png"));

await sharp(sourceLogo)
  .resize(180, 180)
  .png()
  .toFile(path.join(assetsDirectory, "apple-touch-icon.png"));

await sharp(sourceLogo)
  .resize(320, 320)
  .webp({ quality: 86 })
  .toFile(path.join(assetsDirectory, "logo-320.webp"));

await sharp(sourceLogo)
  .resize(384, 384)
  .webp({ quality: 86 })
  .toFile(path.join(assetsDirectory, "logo-384.webp"));

await sharp(sourceLogo)
  .resize(640, 640)
  .webp({ quality: 88 })
  .toFile(path.join(assetsDirectory, "logo-640.webp"));

await sharp(sourceLogo)
  .resize(96, 96)
  .webp({ quality: 84 })
  .toFile(path.join(assetsDirectory, "logo-96.webp"));

await sharp(sourceStudio)
  .resize({ width: 960, withoutEnlargement: true })
  .webp({ quality: 86 })
  .toFile(path.join(assetsDirectory, "studio-960.webp"));

await sharp(sourceStudio)
  .resize({ width: 1600, withoutEnlargement: true })
  .webp({ quality: 88 })
  .toFile(path.join(assetsDirectory, "studio-1600.webp"));

const socialBackground = Buffer.from(`
  <svg width="1200" height="630" viewBox="0 0 1200 630" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="background" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#03142f"/>
        <stop offset="0.55" stop-color="#07285c"/>
        <stop offset="1" stop-color="#075ee8"/>
      </linearGradient>
      <radialGradient id="glow" cx="0.82" cy="0.18" r="0.72">
        <stop offset="0" stop-color="#12c8ff" stop-opacity="0.45"/>
        <stop offset="1" stop-color="#12c8ff" stop-opacity="0"/>
      </radialGradient>
    </defs>
    <rect width="1200" height="630" fill="url(#background)"/>
    <rect width="1200" height="630" fill="url(#glow)"/>
    <path d="M0 500 C260 410 450 610 760 500 C960 430 1070 420 1200 455 V630 H0 Z" fill="#020c1f" opacity="0.56"/>
    <circle cx="1090" cy="90" r="170" fill="none" stroke="#42d7ff" stroke-opacity="0.2" stroke-width="2"/>
    <circle cx="1090" cy="90" r="120" fill="none" stroke="#42d7ff" stroke-opacity="0.16" stroke-width="2"/>
    <text x="500" y="255" fill="#ffffff" font-family="Arial, sans-serif" font-size="88" font-weight="700" letter-spacing="-4">ThimbleDB</text>
    <text x="505" y="325" fill="#a9dfff" font-family="Arial, sans-serif" font-size="31" font-weight="600">A small database for small web apps.</text>
    <text x="505" y="383" fill="#d9e8ff" font-family="Arial, sans-serif" font-size="24">Encrypted browser cache. Object storage durability.</text>
    <text x="505" y="425" fill="#d9e8ff" font-family="Arial, sans-serif" font-size="24">Cloudflare-first. Open source.</text>
    <rect x="505" y="476" width="276" height="48" rx="24" fill="#0c72ff"/>
    <text x="643" y="508" text-anchor="middle" fill="#ffffff" font-family="Arial, sans-serif" font-size="20" font-weight="700">thimbledb.com</text>
  </svg>
`);

await sharp(socialBackground)
  .composite([
    {
      input: await sharp(sourceLogo).resize(360, 360).png().toBuffer(),
      left: 88,
      top: 126,
    },
  ])
  .png()
  .toFile(path.join(assetsDirectory, "social-card.png"));
