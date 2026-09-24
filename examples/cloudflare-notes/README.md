# Cloudflare notes authority starter

This starter compiles the reusable ThimbleDB Cloudflare authority. It keeps
all account-specific resources disabled until real buckets, domains, and OIDC
settings exist.

```powershell
npm install
npm run check
```

To configure a deployment:

1. Copy `wrangler.example.jsonc` to `wrangler.jsonc`.
2. Create separate private R2 buckets for application and authentication data.
3. Uncomment the R2 bindings and replace the disabled examples with real
   resource names.
4. Configure Microsoft Entra or another OIDC provider.
5. Store `THIMBLE_MASTER_KEY` with `wrangler secret put`.
6. Run `npx wrangler deploy --dry-run` before deploying.

Continue with the
[Cloudflare deployment guide](../../docs/DEPLOYMENT-CLOUDFLARE.md) and
[Quickstart](../../docs/QUICKSTART.md).
