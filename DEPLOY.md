# Deploying the shared board (GitHub Pages + Cloudflare Worker)

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
