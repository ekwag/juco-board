/*
 * JUCO board API + static site -- one Cloudflare Worker serves both.
 *
 * This used to be split across a GitHub Pages site and a separate
 * "juco-board-api" Worker doing GitHub OAuth (see the old site/worker.js,
 * kept only for reference). It's now a single Worker: this same hostname
 * serves the board's HTML AND its API (/api/whoami, /api/reviews,
 * /api/save, /api/players). One hostname means Cloudflare Access can
 * protect the whole thing with a single toggle -- no separate login
 * domain, no CORS, and it works exactly the same on the free
 * *.workers.dev URL as it will on a custom domain later, if one gets added.
 *
 * WHY THE PAGE IS IMPORTED RATHER THAN SERVED AS A "STATIC ASSET". Workers
 * has a separate "Static Assets" feature (an `[assets]` block in
 * wrangler.toml) that sounds like the obvious way to serve index.html --
 * this project used it briefly and it turned out to have a real gap:
 * Cloudflare's own docs say the internal router that feature adds does NOT
 * forward `ctx.access` (see below) through to the Worker script, even
 * though Access still gates the request. That silently broke identity for
 * every page load, so this Worker doesn't use that feature at all. Instead,
 * `index.html` is imported directly as a text module (the `[[rules]]`
 * block in wrangler.toml) and bundled straight into this script -- there
 * is no separate router in between, so `ctx.access` is populated
 * correctly for every request, page loads included.
 *
 * WHO YOU ARE. This Worker is protected by Cloudflare Access (Workers &
 * Pages -> juco-board -> Access tab -> "Protect this Worker" -- see
 * site/DEPLOY.md). Once that's on, every request that reaches this script
 * has already been through Access's login screen, and Cloudflare hands the
 * signed-in visitor's identity to this code directly via `ctx.access` --
 * no JWT parsing, no JWKS fetching, no crypto code to maintain. This is
 * also why there's no sign-in button anywhere in board_app.txt: Access
 * handles that before the page ever loads.
 *
 * DATA. Reviews and manually-added players live in one shared D1 database
 * (real SQL), bound as `DB` in wrangler.toml. Every row is tagged with a
 * board id so a second, unrelated board can share the same database
 * without its rows ever mixing with this one's -- see the
 * "reviews"/"manual_players" schema in site/DEPLOY.md.
 */

import PAGE_HTML from "./index.html";

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200, headers: { "Content-Type": "application/json" } });
}
function boardId(env, url) { return url.searchParams.get("board") || env.BOARD_ID || "juco2027"; }

// The verified identity for this request, or null if Access didn't
// authenticate it. Should not happen once "Protect this Worker" is on --
// Access blocks the request before it gets here -- but every handler
// checks anyway rather than trusting that blindly.
async function identify(ctx) {
  if (!ctx.access) return null;
  try {
    const identity = await ctx.access.getIdentity();
    return identity && identity.email ? String(identity.email).toLowerCase() : null;
  } catch (e) { return null; }
}

// ---------- /api/whoami ----------
async function handleWhoami(ctx) {
  return json({ email: await identify(ctx) });
}

// ---------- /api/reviews (read) ----------
async function handleReviewsGet(env, url) {
  var bid = boardId(env, url);
  var rows = await env.DB.prepare(
    "select player_key, who, verdict, stars, note, context, where_seen, seen_on, grades, at "
    + "from reviews where board_id = ? order by at asc"
  ).bind(bid).all();
  var out = {};
  (rows.results || []).forEach(function (r) {
    (out[r.player_key] = out[r.player_key] || []).push({
      who: r.who, verdict: r.verdict || undefined, stars: r.stars == null ? undefined : r.stars,
      note: r.note || "", context: r.context || undefined, where: r.where_seen || "",
      seen_on: r.seen_on || "", grades: r.grades || "", at: r.at,
    });
  });
  return json(out);
}

// ---------- /api/save (write) ----------
// One review row per (board, player, reviewer) -- a new save from the same
// person replaces their old one. delete-then-insert inside a batch keeps
// that atomic without needing a unique-index upsert.
async function handleSave(request, env, ctx, url) {
  var who = await identify(ctx);
  if (!who) return json({ error: "not_authorized" }, 403);
  var body;
  try { body = await request.json(); } catch (e) { return json({ error: "bad_request" }, 400); }
  if (!body.key || typeof body.key !== "string" || !body.patch) return json({ error: "bad_request" }, 400);
  var bid = boardId(env, url), p = body.patch, at = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare("delete from reviews where board_id = ? and player_key = ? and who = ?")
      .bind(bid, body.key, who),
    env.DB.prepare(
      "insert into reviews (board_id, player_key, who, verdict, stars, note, context, where_seen, seen_on, grades, at) "
      + "values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind(bid, body.key, who, p.verdict || null, p.stars == null ? null : p.stars,
           p.note || "", p.context || null, p.where || "", p.seen_on || "", p.grades || "", at),
  ]);
  var rows = await env.DB.prepare(
    "select who, verdict, stars, note, context, where_seen, seen_on, grades, at "
    + "from reviews where board_id = ? and player_key = ? order by at asc"
  ).bind(bid, body.key).all();
  var reviews = (rows.results || []).map(function (r) {
    return { who: r.who, verdict: r.verdict || undefined, stars: r.stars == null ? undefined : r.stars,
             note: r.note || "", context: r.context || undefined, where: r.where_seen || "",
             seen_on: r.seen_on || "", grades: r.grades || "", at: r.at };
  });
  return json({ ok: true, reviews: reviews });
}

// ---------- /api/players (the "+ Add player" feature) ----------
async function handlePlayersGet(env, url) {
  var bid = boardId(env, url);
  var rows = await env.DB.prepare(
    "select mode, name, team, pos, added_by, at from manual_players where board_id = ? order by at asc"
  ).bind(bid).all();
  return json({ players: rows.results || [] });
}
async function handlePlayersPost(request, env, ctx, url) {
  var who = await identify(ctx);
  if (!who) return json({ error: "not_authorized" }, 403);
  var body;
  try { body = await request.json(); } catch (e) { return json({ error: "bad_request" }, 400); }
  var mode = body.mode === "p" ? "p" : "h";
  var name = (body.name || "").trim(), team = (body.team || "").trim(), pos = (body.pos || "").trim();
  if (!name || !team) return json({ error: "bad_request" }, 400);
  var bid = boardId(env, url), at = new Date().toISOString();
  await env.DB.prepare(
    "insert into manual_players (board_id, mode, name, team, pos, added_by, at) values (?, ?, ?, ?, ?, ?, ?)"
  ).bind(bid, mode, name, team, pos, who, at).run();
  return json({ ok: true, player: { mode: mode, name: name, team: team, pos: pos, added_by: who, at: at } });
}
async function handlePlayersDelete(request, env, ctx, url) {
  var who = await identify(ctx);
  if (!who) return json({ error: "not_authorized" }, 403);
  var body;
  try { body = await request.json(); } catch (e) { return json({ error: "bad_request" }, 400); }
  var mode = body.mode === "p" ? "p" : "h";
  var bid = boardId(env, url);
  await env.DB.prepare(
    "delete from manual_players where board_id = ? and mode = ? and name = ? and team = ?"
  ).bind(bid, mode, body.name || "", body.team || "").run();
  return json({ ok: true });
}

export default {
  async fetch(request, env, ctx) {
    var url = new URL(request.url);
    if (url.pathname === "/api/whoami") return handleWhoami(ctx);
    if (url.pathname === "/api/reviews" && request.method === "GET") return handleReviewsGet(env, url);
    if (url.pathname === "/api/save" && request.method === "POST") return handleSave(request, env, ctx, url);
    if (url.pathname === "/api/players" && request.method === "GET") return handlePlayersGet(env, url);
    if (url.pathname === "/api/players" && request.method === "POST") return handlePlayersPost(request, env, ctx, url);
    if (url.pathname === "/api/players" && request.method === "DELETE") return handlePlayersDelete(request, env, ctx, url);
    // Everything else is the board page itself. Belt-and-suspenders check:
    // the dashboard-level "Protect this Worker" toggle should already have
    // blocked an unauthenticated request before it got here, but this
    // makes the security boundary explicit in code too, rather than
    // resting entirely on a dashboard setting someone could accidentally
    // turn off.
    if (!(await identify(ctx))) return new Response("Access required", { status: 403 });
    return new Response(PAGE_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
  },
};
