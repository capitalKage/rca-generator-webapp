# RCA Generator

A small internal tool that turns a Jira XML export (one ticket or a bulk pull)
into a filled-out RCA PowerPoint deck, using your team's Claude API key to
draft the narrative text.

**How it works (architecture):**

```
 Team member's browser                Cloudflare Worker              Anthropic API
 ─────────────────────                ─────────────────              ─────────────
 GitHub Pages (static site)   ──POST──►  /check-password   (password gate)
   - login screen                       /summarize         ──POST──►  Claude
   - parses the Jira XML                  (holds your API key
   - builds the .pptx in-browser           as a secret, never
     with PptxGenJS, using the             shipped to the browser)
     images/colors/layout of
     your original EC-61 template
```

GitHub Pages can only serve static files — it can't hold a secret API key or
check a password on its own. So there are two pieces:

1. **`docs/`** — the actual app (HTML/CSS/JS). This is what you publish to
   GitHub Pages. It does the XML parsing and the PowerPoint building, both
   entirely in the browser.
2. **`worker/`** — a small Cloudflare Worker (a few dozen lines, free tier is
   plenty). It does exactly two things: checks the shared password, and calls
   the Claude API with your key so the key never appears in the browser.

Nothing else is needed — no database, no server to maintain.

---

## 1. Deploy the Worker (do this first)

You'll need a free [Cloudflare account](https://dash.cloudflare.com/sign-up)
and Node.js installed locally.

```bash
cd worker
npx wrangler login          # opens a browser to authorize
npx wrangler secret put ANTHROPIC_API_KEY   # paste your Claude API key when prompted
npx wrangler secret put APP_PASSWORD        # pick the password your team will log in with
npx wrangler deploy
```

The last command prints a URL like:

```
https://rca-generator-worker.<your-subdomain>.workers.dev
```

Copy that URL — you need it in the next step.

**Which Claude model?** `worker/wrangler.toml` sets `CLAUDE_MODEL` to a
default. Check [docs.claude.com/en/docs/about-claude/models](https://docs.claude.com/en/docs/about-claude/models)
for the current model ID your account has access to, and update that line if
needed, then re-run `npx wrangler deploy`.

## 2. Point the frontend at your Worker

Edit `docs/config.js`:

```js
const WORKER_URL = "https://rca-generator-worker.<your-subdomain>.workers.dev";
```

## 3. Publish to GitHub Pages

```bash
git init
git add .
git commit -m "RCA generator"
git branch -M main
git remote add origin https://github.com/<your-org>/<your-repo>.git
git push -u origin main
```

Then in the GitHub repo: **Settings → Pages → Source → Deploy from a branch
→ Branch: `main`, folder: `/docs`**. GitHub gives you a URL like
`https://<your-org>.github.io/<your-repo>/`.

## 4. Lock the Worker down to your Pages site (recommended)

By default the Worker accepts requests from anywhere (`ALLOWED_ORIGIN = "*"`
in `worker/wrangler.toml`), which means anyone who finds the Worker URL and
guesses the password could use your API key's quota. Once you know your
Pages URL from step 3, tighten it:

```toml
ALLOWED_ORIGIN = "https://<your-org>.github.io"
```

Then `npx wrangler deploy` again from the `worker/` folder.

---

## Using it

1. Open your GitHub Pages URL, log in with the shared password.
2. Upload one or more Jira XML exports (single ticket or bulk pull — both work).
3. Review the ticket list. Uncheck anything you don't want a deck for, or
   paste ticket keys into the "skip" box (handy for "don't redo tickets I
   already generated last time").
4. Click **Generate RCA decks**. Each selected ticket is sent to Claude to
   draft the RCA text, then the `.pptx` is built in your browser. One ticket
   downloads directly; more than one downloads as a zip.

## Known limitations

- **Review before sharing externally.** The AI drafts the incident/root-cause/
  resolution text and a small illustrative flow diagram from the ticket's
  description and comments. It's instructed not to invent facts, but it can
  still misjudge nuance — treat it as a strong first draft, not a verified RCA.
- **Auth is a shared password**, not real per-user login. Fine for an
  internal tool; if you later want individual accounts or SSO (Okta/Azure AD/
  Google), that replaces the `/check-password` check in `worker/src/index.js`
  and is a bigger lift.
- **Cost**: each "Generate" click makes one Claude API call per selected
  ticket, billed to whatever API key you configured.
- **Vendored libraries**: `docs/vendor/pptxgen.bundle.js` (PptxGenJS 3.12.0)
  and `docs/vendor/jszip.min.js` (JSZip 3.10.1) are committed directly so the
  app has no runtime dependency on a CDN. Update them by replacing those
  files if you want a newer version.
- **Template assets**: `docs/assets/*.png` were exported from your original
  EC-61 PowerPoint (title background, header logo band, footer line, and the
  static closing "Vision" slide). If your team's template changes, these
  need to be re-exported — ask for that and it can be regenerated the same way.
