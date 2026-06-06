# Deploy the KOINE MCP server (GitHub → Vercel)

**End result:** a public URL like `https://koine-mcp-server.vercel.app`, with your MCP endpoint at **`https://…vercel.app/api/mcp`**. That URL is what agents connect to and what goes into DAEMON's ERC-8004 agent card.

**Accounts:** your project's GitHub + Vercel. **Cost:** $0 on the free tiers. **Risk:** none — the server is read-only and holds no keys.

---

## 1 · Put the code on GitHub

The only thing that matters is keeping the folder structure intact — especially `app/api/[transport]/route.js` (the `[transport]` folder, brackets included).

**Easiest (GitHub Desktop, no command line):**
1. Install GitHub Desktop, sign in to the project account.
2. File → Add Local Repository → choose the `koine-mcp-server` folder → "create a repository" → Publish to GitHub (Private is fine).

**Or via command line (most reliable for the folder structure):**
1. On GitHub (project account): **New repository** → name `koine-mcp-server` → Create (leave it empty).
2. In a terminal:
   ```bash
   cd "path/to/koine-mcp-server"
   git init && git add . && git commit -m "KOINE MCP server"
   git branch -M main
   git remote add origin https://github.com/YOUR_ACCOUNT/koine-mcp-server.git
   git push -u origin main
   ```
(`node_modules` and `.next` are git-ignored — don't upload them.)

---

## 2 · Deploy on Vercel
1. Vercel (project account) → **Add New… → Project**.
2. **Import Git Repository** → authorize GitHub if prompted → select **koine-mcp-server**.
3. Framework Preset auto-detects **Next.js** — leave all build settings at default.
4. *(Optional)* **Environment Variables** → add `KOINE_RPC` = your Alchemy/Infura mainnet URL for reliability. Skip it and it uses a free public endpoint. (Addable later.)
5. Click **Deploy** (~1–2 min).

---

## 3 · Get your endpoint + test it
- Vercel gives you a URL, e.g. `https://koine-mcp-server-xxxx.vercel.app`. Open it → you'll see the KOINE landing page.
- **Your MCP endpoint = that URL + `/api/mcp`.**
- Test it actually works (either):
  - **Claude:** Settings → Connectors → add a custom/remote connector with the `/api/mcp` URL. Then ask *"verify KOINE #22"* → expect `canonical_ok: true`.
  - **MCP Inspector:** `npx @modelcontextprotocol/inspector` → connect to your `/api/mcp` URL → you'll see the 5 tools and can call them.

---

## 4 · Later
- *(Optional)* add a **custom domain** in Vercel.
- Put the `/api/mcp` URL into **DAEMON's ERC-8004 agent card** so agents discover KOINE on-chain (next step).

**Notes**
- Vercel free **Hobby** tier runs this fine to start. If Vercel ever flags commercial use, Pro is $20/mo (not needed now).
- Change contract/RPC anytime via the `KOINE_ADDR` / `KOINE_RPC` env vars in Vercel.
- Endpoints exposed: `/api/mcp` (Streamable HTTP) and `/api/sse` (legacy SSE).
