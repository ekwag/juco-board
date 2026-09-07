# Deploying the shared board (Cloudflare Worker + static assets + D1 + Access)

**Read this section only.** Everything below the first `---` is kept for
history but describes setups that no longer apply (an earlier "Cloudflare
Pages" plan, and before that the original GitHub Pages + GitHub OAuth
setup) -- Cloudflare has moved away from Pages as a distinct product, so
this board runs as a single Cloudflare Worker with static-assets support
instead. `site/worker.js` and the two `wrangler.*.toml.txt` files are old
and unused; ignore them.

**What you already have, as of today:** a Worker named `juco-board` exists
in your Cloudflare account (Workers & Pages -> juco-board). It's currently
empty/default -- the steps below connect it to your repo and turn it into
the real board.

## The big simplification

Almost everything that used to need manual dashboard clicking now lives in
`site/wrangler.toml`, which you already have and just push like any other
file:

- The D1 database binding (`DB`) is already in that file, pointing at your
  `juco-board` database -- **no dashboard binding step needed at all.**
- Cloudflare Access identity now reaches the Worker automatically via a
  built-in `ctx.access` API once you flip one toggle in the dashboard --
  **no separate Access application to create, no team domain or AUD tag to
  find and paste anywhere.**

So the only things left to actually do by hand are: connect the repo, flip
the Access toggle, and push.

## 1. Connect the repo to the Worker

1. Cloudflare dashboard -> **Workers & Pages** -> select **juco-board**.
2. **Settings** tab -> **Builds** (may also appear as "Build" or under a
   "Deployments" area depending on when you're reading this -- the button
   you want says **Connect**).
3. Connect it to the same GitHub repo you already push `site\` to.
4. When it asks for a **root directory**, set it to `site` -- that's the
   folder containing `_worker.js`, `wrangler.toml`, and `index.html`.
5. Leave the build command blank (there's nothing to compile -- `index.html`
   and `_worker.js` are already finished files by the time they're pushed).
   The deploy command defaults to `npx wrangler deploy`, which is correct --
   leave it as-is.

**Important:** the `name` in `site/wrangler.toml` (`"juco-board"`) must
match this Worker's name in the dashboard exactly, or the build will fail.
It already matches, so this should just work.

Once connected, every `git push` triggers a build-and-deploy automatically
-- same habit as before, one less moving part (no separate "deploy the
Worker" click, ever).

## 2. Turn on Cloudflare Access

1. Workers & Pages -> **juco-board** -> **Access** tab.
2. Click **Protect this Worker behind Access**.
3. Choose who can sign in -- for the first test, your own account email and
   `kwagner7@socal.rr.com`. This automatically covers the Worker's
   `workers.dev` URL (and any custom domain you add later) -- nothing else
   to configure.

That's it for Access. No team domain, no AUD tag, no environment variables
to set anywhere -- the Worker reads the signed-in visitor's identity
straight from Cloudflare at runtime.

## 3. Push

    cd site
    git add .
    git commit -m "cloudflare worker + d1 + access"
    git push

Cloudflare picks up the push, builds, and deploys automatically. Give it a
minute, then open the Worker's `workers.dev` URL (visible on the Worker's
**Overview** tab) in a private/incognito window.

## 4. Test it

You should hit an Access login screen first (enter an allowlisted email,
get a one-time code, you're in), then land on the board. The "You" box near
the top should already show your email, greyed out -- that's Access's
identity, not something you type. Leave a note on any player, hit Save,
and check the `reviews` table in Cloudflare's D1 dashboard query console
(`select * from reviews;`) to confirm it landed. Try "+ Add player" too.

If sign-in works but the page or a save fails with "not signed in" or
similar, double check step 1's root directory is exactly `site` (a wrong
root directory means `_worker.js` isn't found at all, and you'd just get a
plain static page with a broken Save button).

## Updating who can save later

Workers & Pages -> juco-board -> Access tab -> edit the policy's email
list. No redeploy needed, takes effect on the next sign-in.

## Updating the board's stats later

Exactly what you already do: `board.bat` (or `weekly.bat`), then
`build_site.bat`, then commit and push `site\`. Cloudflare picks up the
push and redeploys automatically -- nothing else to run.

## A domain later, if you ever want one

Workers & Pages -> juco-board -> **Domains** tab -> add a domain you own
(or buy one through Cloudflare right there). Cloudflare Access protection
you set up in step 2 automatically extends to cover any domain you add --
nothing to redo.

## A second board sharing this database later

If a future board's Worker wants to reuse the same `juco-board` D1 database
instead of its own, add the same `[[d1_databases]]` block to that Worker's
`wrangler.toml` and give its `_worker.js`/`build_site.py` a different
`BOARD_ID` value so its rows never mix with this board's. Each board still
gets its own Worker, its own Access setup, and its own URL -- only the
database is shared.

---

*Below this line: two earlier, now-superseded plans, kept only for
history.*

## SUPERSEDED -- earlier "Cloudflare Pages" plan

This plan assumed Cloudflare Pages was still the right product to use.
Cloudflare has since (as of this writing) steered new projects toward
Workers with built-in static-asset support instead, and Pages-specific
project creation became harder to find in the dashboard as a result --
which is exactly what caused the confusion that led to this rewrite. The
`_worker.js` design (one script serving both the page and the API) carried
over into the real setup above; the "create a Pages project" and "create a
separate Access application" steps did not -- both got simpler.

# Deploying the shared board (GitHub Pages + Cloudflare Worker) -- OLDEST

This is the one-time setup. After this, running `board.bat` (to refresh
stats) or `python build_site.py` (to rebuild the site) followed by a
`git push` is the whole update cycle -- the Worker itself never needs to be
touched again unless the allowlist of who can save changes.

Do these roughly in order -- a few steps need a value from an earlier one.

## 1. Create the repo

GitHub -> New repository. **Public** -- GitHub Pages on the free plan only
serves sites built from public repos (private-repo Pages needs GitHub Pro,
and even then the published site itself is still publicly reachable by
anyone with the link -- Pro only hides the source/commit history, it
doesn't gate the live page). Since we're staying on the free plan, that
means the repo -- including `reviews.json`, i.e. everyone's scouting notes
-- is technically public. The plan is to rely on the URL not being listed
anywhere rather than a real access wall: share it only with people who
should see it. Saving is still locked down regardless -- only GitHub
accounts in `ALLOWED_USERS` (Worker variable, step 2 below) can write.

Something like `juco-board`. Nothing to push yet.

## 2. Deploy the Worker (with placeholder values, for now)

Cloudflare dashboard -> Workers & Pages -> Create -> Create Worker. Give it
a name (e.g. `juco-board-api`) -- this name becomes part of its URL. Once
created, open it, go to the code editor, and paste in the full contents of
`worker.js` from this folder, replacing the default template. Deploy.

Note the URL it gives you -- something like
`https://juco-board-api.<your-subdomain>.workers.dev`. You'll need this in
steps 3 and 4.

Then, on that Worker's Settings -> Variables page, add these (as plain
"Environment Variables" for now -- three of them move to "Secrets" in step
6):

| Name | Value |
|---|---|
| `GITHUB_CLIENT_ID` | leave blank for now, fill in after step 3 |
| `REPO_OWNER` | your GitHub username |
| `REPO_NAME` | `juco-board` (or whatever you named it) |
| `REVIEWS_PATH` | `reviews.json` |
| `PAGE_URL` | `https://<your-username>.github.io/<repo-name>/` |
| `PAGE_URL_ORIGIN` | `https://<your-username>.github.io` |
| `ALLOWED_USERS` | comma-separated GitHub usernames who can save, e.g. `erikwagner3,coachb` |

## 3. Register the GitHub OAuth App

GitHub -> Settings (your own account settings, not the repo's) -> Developer
settings -> OAuth Apps -> New OAuth App.

- **Application name**: anything, e.g. "JUCO Board"
- **Homepage URL**: your Pages URL from step 2's `PAGE_URL` value
- **Authorization callback URL**: the Worker URL from step 2, with
  `/callback` appended -- e.g.
  `https://juco-board-api.<your-subdomain>.workers.dev/callback`

Register it. You'll get a **Client ID** immediately, and a button to
generate a **Client Secret**. Copy both somewhere for the next two steps --
don't paste the secret into chat with me; it goes straight into Cloudflare.

## 4. Fill in the Client ID

Back in the Worker's Variables (step 2), set `GITHUB_CLIENT_ID` to the value
from step 3.

## 5. Create the write token

GitHub -> Settings -> Developer settings -> Personal access tokens ->
Fine-grained tokens -> Generate new token.

- **Resource owner**: your account
- **Repository access**: "Only select repositories" -> pick just the
  `juco-board` repo
- **Permissions**: Repository permissions -> Contents -> **Read and write**.
  Leave everything else at No access.

Generate it, copy the token.

## 6. Set the three real secrets

Worker's Settings -> Variables -> the three below need to be added as
**Secrets** specifically (not plain variables -- Cloudflare has a separate
toggle/section for this), so they're encrypted and never shown again after
you set them:

| Secret name | Value |
|---|---|
| `GITHUB_CLIENT_SECRET` | from step 3 |
| `GITHUB_WRITE_TOKEN` | from step 5 |
| `SESSION_SECRET` | any long random string -- e.g. run `openssl rand -hex 32` anywhere, or just mash the keyboard for 40+ characters |

## 7. Tell me the two public values

`WORKER_URL` (the workers.dev URL from step 2) and `GITHUB_CLIENT_ID` (from
step 3) both need to go into `build_site.py` -- they're not secret, so
either paste them to me and I'll fill them in and rebuild, or edit
`build_site.py`'s two constants near the top yourself.

## 8. Build and push

    python build_site.py
    git add site/
    git commit -m "juco board site"
    git push

Then GitHub -> repo Settings -> Pages -> Source: Deploy from a branch ->
Branch: `main`, folder: `/site`. Save. GitHub Pages usually goes live within
a minute or two; the same is true for every later push.

## 9. Test it

Open the Pages URL. Click "Sign in with GitHub." You should land back on the
board signed in. Leave a note on any player, hit Save, and check that
`reviews.json` in the repo picked up a new commit. If your GitHub username
isn't in `ALLOWED_USERS` (step 2), sign-in will succeed but saving will be
refused -- that's the allowlist working as intended, not a bug.

## Updating who can save later

Just edit `ALLOWED_USERS` in the Worker's variables -- no redeploy of the
page needed, takes effect on the next save attempt.

## Updating the board's stats later

Same as always: `board.bat` (or `weekly.bat`), then `python build_site.py`,
then commit and push `site/`. `site/reviews.json` is never overwritten by a
rebuild if it already exists, so a rebuild can't clobber notes the Worker
has saved since the last one -- but if you want THIS rebuild to also carry
forward everything saved live, pull the current `site/reviews.json` down
first and copy it over `drop/reviews.json` before running `build_site.py`.
