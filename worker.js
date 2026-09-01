/*
 * JUCO board write-proxy -- Cloudflare Worker.
 *
 * WHAT THIS IS FOR. The board itself is a static page on GitHub Pages --
 * plain HTML/CSS/JS, no server. That's fine for reading the board, but
 * "Save to board" needs somewhere to write to, and it needs to know who's
 * actually allowed to write. This Worker is that somewhere. It is the ONLY
 * place the GitHub write credential exists. It never reaches the browser,
 * in a page source, a cookie, or anywhere else a visitor could read it.
 *
 * THE TWO THINGS THIS DOES:
 *   1. /callback -- finishes a "Sign in with GitHub" round trip. The page
 *      sends the visitor to GitHub directly (no secret needed for that
 *      half); GitHub sends them back here with a one-time code. This Worker
 *      exchanges that code for the visitor's GitHub username -- and NOTHING
 *      else. The scope requested is read:user only. Signing in proves who
 *      someone is. It does not, by itself, grant them anything.
 *   2. /save -- the actual write. Takes a signed session (proof of who's
 *      asking), checks that username against ALLOWED_USERS, and if it
 *      passes, uses ITS OWN token (GITHUB_WRITE_TOKEN, a secret only this
 *      Worker holds) to commit the updated review into reviews.json in the
 *      board's repo. The username in the saved review always comes from the
 *      verified session -- never from anything the client sends -- so
 *      nobody can save a note under someone else's name.
 *
 * WHY A SEPARATE WRITE TOKEN INSTEAD OF THE VISITOR'S OWN GITHUB ACCESS.
 * Using each signed-in visitor's own token would mean every reviewer needs
 * their own write access to the repo, and their token (scoped to whatever
 * they can normally touch) would have to pass through this Worker on every
 * save. Simpler and narrower: one token, held only here, scoped to
 * Contents: Read and write on ONLY this one repo (a fine-grained PAT) --
 * nothing else it could do even if it somehow leaked, and reviewers never
 * need write access to anything themselves.
 *
 * REQUIRED SECRETS (wrangler secret put <name>, or the Cloudflare dashboard
 * -- never in code, never in chat):
 *   GITHUB_CLIENT_SECRET   the OAuth App's client secret
 *   GITHUB_WRITE_TOKEN     fine-grained PAT, Contents: Read and write,
 *                          scoped to ONLY the board's repo
 *   SESSION_SECRET         any long random string; signs session tokens
 *
 * REQUIRED PLAIN VARIABLES (wrangler.toml [vars], or the dashboard --
 * these aren't secret, just configuration):
 *   GITHUB_CLIENT_ID       the OAuth App's client ID
 *   REPO_OWNER, REPO_NAME  e.g. "erikwagner3", "juco-board"
 *   REVIEWS_PATH           e.g. "reviews.json"
 *   PAGE_URL               e.g. "https://erikwagner3.github.io/juco-board/"
 *   ALLOWED_USERS          comma-separated GitHub usernames, e.g.
 *                          "erikwagner3,coachb,coachc"
 *   REPO_BRANCH            optional, defaults to the repo's default branch
 *                          if unset
 */

const SESSION_TTL_SECONDS = 60 * 60 * 12; // 12 hours

// ---------- small helpers ----------

function b64urlFromBytes(bytes) {
  var bin = "";
  for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function bytesFromB64url(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  var bin = atob(s);
  var out = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function utf8Bytes(str) { return new TextEncoder().encode(str); }

async function hmacKey(secret) {
  return crypto.subtle.importKey(
    "raw", utf8Bytes(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
async function signSession(env, login) {
  var payload = JSON.stringify({ login: login, exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS });
  var payloadB64 = b64urlFromBytes(utf8Bytes(payload));
  var key = await hmacKey(env.SESSION_SECRET);
  var sig = await crypto.subtle.sign("HMAC", key, utf8Bytes(payloadB64));
  return payloadB64 + "." + b64urlFromBytes(new Uint8Array(sig));
}
async function verifySession(env, token) {
  if (!token || token.indexOf(".") === -1) return null;
  var parts = token.split(".");
  var payloadB64 = parts[0], sigB64 = parts[1];
  var key = await hmacKey(env.SESSION_SECRET);
  var ok = await crypto.subtle.verify("HMAC", key, bytesFromB64url(sigB64), utf8Bytes(payloadB64));
  if (!ok) return null;
  var payload;
  try { payload = JSON.parse(new TextDecoder().decode(bytesFromB64url(payloadB64))); }
  catch (e) { return null; }
  if (!payload || !payload.login || !payload.exp) return null;
  if (payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload.login;
}
function allowedUsers(env) {
  return (env.ALLOWED_USERS || "").split(",").map(function (s) { return s.trim().toLowerCase(); })
    .filter(Boolean);
}
function isAllowed(env, login) {
  return allowedUsers(env).indexOf(String(login || "").toLowerCase()) > -1;
}

function corsHeaders(env) {
  return {
    "Access-Control-Allow-Origin": env.PAGE_URL_ORIGIN || "*",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}
function json(env, obj, status) {
  var h = corsHeaders(env);
  h["Content-Type"] = "application/json";
  return new Response(JSON.stringify(obj), { status: status || 200, headers: h });
}
function redirect(url) {
  return new Response(null, { status: 302, headers: { Location: url } });
}

// ---------- GitHub API ----------

async function githubUserFromCode(env, code) {
  var r = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code: code,
    }),
  });
  var tok = await r.json();
  if (!tok.access_token) return null;
  var ru = await fetch("https://api.github.com/user", {
    headers: {
      "Authorization": "Bearer " + tok.access_token,
      "Accept": "application/vnd.github+json",
      "User-Agent": "juco-board-worker",
    },
  });
  if (!ru.ok) return null;
  var u = await ru.json();
  return u && u.login ? u.login : null;
}

async function getReviewsFile(env) {
  var url = "https://api.github.com/repos/" + env.REPO_OWNER + "/" + env.REPO_NAME
    + "/contents/" + encodeURIComponent(env.REVIEWS_PATH)
    + (env.REPO_BRANCH ? "?ref=" + encodeURIComponent(env.REPO_BRANCH) : "");
  var r = await fetch(url, {
    headers: {
      "Authorization": "Bearer " + env.GITHUB_WRITE_TOKEN,
      "Accept": "application/vnd.github+json",
      "User-Agent": "juco-board-worker",
    },
  });
  if (r.status === 404) return { data: {}, sha: null };
  if (!r.ok) throw new Error("github_get_failed_" + r.status);
  var body = await r.json();
  var text = decodeURIComponent(escape(atob(body.content.replace(/\n/g, ""))));
  var data;
  try { data = JSON.parse(text || "{}"); } catch (e) { data = {}; }
  return { data: data, sha: body.sha };
}

async function putReviewsFile(env, data, sha, message) {
  var url = "https://api.github.com/repos/" + env.REPO_OWNER + "/" + env.REPO_NAME
    + "/contents/" + encodeURIComponent(env.REVIEWS_PATH);
  var content = btoa(unescape(encodeURIComponent(JSON.stringify(data, null, 2))));
  var payload = { message: message, content: content };
  if (sha) payload.sha = sha;
  if (env.REPO_BRANCH) payload.branch = env.REPO_BRANCH;
  var r = await fetch(url, {
    method: "PUT",
    headers: {
      "Authorization": "Bearer " + env.GITHUB_WRITE_TOKEN,
      "Accept": "application/vnd.github+json",
      "User-Agent": "juco-board-worker",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  return r;
}

// Small retry: GitHub's Contents API needs the current file SHA to update
// it, and rejects a stale SHA with 409 -- if two saves land at nearly the
// same moment, the second one just needs to refetch and reapply. Two
// attempts is enough for two people clicking Save within the same second;
// it is not trying to be a general-purpose queue.
async function upsertReview(env, key, login, patch) {
  for (var attempt = 0; attempt < 2; attempt++) {
    var current = await getReviewsFile(env);
    var arr = current.data[key] || [];
    arr = arr.filter(function (r) { return r.who !== login; });
    arr.push({
      who: login,
      verdict: patch.verdict || undefined,
      stars: patch.stars != null ? patch.stars : undefined,
      note: patch.note || "",
      context: patch.context || undefined,
      where: patch.where || "",
      seen_on: patch.seen_on || "",
      grades: patch.grades || "",
      at: new Date().toISOString(),
    });
    current.data[key] = arr;
    var r = await putReviewsFile(env, current.data, current.sha,
      "review: " + login + " on " + key);
    if (r.ok) return arr;
    if (r.status !== 409 || attempt === 1) {
      var body = await r.text();
      throw new Error("github_put_failed_" + r.status + ": " + body.slice(0, 300));
    }
    // 409 (sha stale) -- loop and retry with a fresh fetch.
  }
}

// ---------- routes ----------

async function handleCallback(url, env) {
  var code = url.searchParams.get("code");
  var state = url.searchParams.get("state");
  var target = env.PAGE_URL + (env.PAGE_URL.indexOf("#") > -1 ? "" : "#");
  if (!code) return redirect(target + "error=missing_code");
  var login;
  try { login = await githubUserFromCode(env, code); }
  catch (e) { return redirect(target + "error=exchange_failed"); }
  if (!login) return redirect(target + "error=exchange_failed");
  if (!isAllowed(env, login)) return redirect(target + "error=not_authorized&user=" + encodeURIComponent(login));
  var session = await signSession(env, login);
  var qs = "session=" + encodeURIComponent(session)
    + "&user=" + encodeURIComponent(login)
    + "&state=" + encodeURIComponent(state || "");
  return redirect(target + qs);
}

async function handleSave(request, env) {
  if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders(env) });
  var body;
  try { body = await request.json(); } catch (e) { return json(env, { error: "bad_request" }, 400); }
  var login = await verifySession(env, body.session);
  if (!login) return json(env, { error: "bad_session" }, 401);
  if (!isAllowed(env, login)) return json(env, { error: "not_authorized" }, 403);
  if (!body.key || typeof body.key !== "string" || !body.patch) {
    return json(env, { error: "bad_request" }, 400);
  }
  try {
    var reviews = await upsertReview(env, body.key, login, body.patch);
    return json(env, { ok: true, reviews: reviews });
  } catch (e) {
    return json(env, { error: "write_failed", detail: String(e && e.message || e) }, 502);
  }
}

async function handleWhoami(request, env) {
  var url = new URL(request.url);
  var token = url.searchParams.get("session");
  var login = await verifySession(env, token);
  if (!login || !isAllowed(env, login)) return json(env, { login: null }, 200);
  return json(env, { login: login }, 200);
}

export default {
  async fetch(request, env) {
    var url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders(env) });
    if (url.pathname === "/callback") return handleCallback(url, env);
    if (url.pathname === "/save" && request.method === "POST") return handleSave(request, env);
    if (url.pathname === "/whoami") return handleWhoami(request, env);
    return json(env, { error: "not_found" }, 404);
  },
};
