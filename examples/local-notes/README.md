# Local notes example

This example demonstrates the public ThimbleDB engine and local provider
without running a database process.

```powershell
npm install
npm run demo
npm test
```

Try the CLI:

```powershell
npm start -- add "Review architecture" "Check the workload boundaries"
npm start -- list
```

Data is stored below `.data`.

This is an engine example, not a complete authenticated web deployment. Use
the main quickstart for OIDC, encrypted envelopes, brokered browser reads, and
the Node or Cloudflare authority.
