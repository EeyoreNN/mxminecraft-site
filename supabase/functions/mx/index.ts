// MX Minecraft API (Supabase Edge Function).
// Members-only site: nothing but the login screen is public; member content comes from `me`.
//   register {first,last,email,mc}          -> {token}        (@mxschool.edu only; pings admin if not whitelisted)
//   login    {email}                        -> {token}         (school email only, no password)
//   me       (Authorization: Bearer token)   -> {profile, whitelisted, request, content}
//   logout   (Authorization: Bearer token)   -> {ok}
//   approve  GET ?token=..&deny=1            -> admin one-tap link from the ntfy push
//   skin     GET ?uuid=..                    -> skin PNG (CORS proxy of Mojang textures)
//   sync     {secret, whitelist, applied}    -> {toAdd}         (called by the server PC, outbound only)
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const ORIGINS = ["https://mxminecraft.net", "https://www.mxminecraft.net"];
const SELF = `${Deno.env.get("SUPABASE_URL")}/functions/v1/mx`;
const NAME_RE = /^[A-Za-z0-9_]{3,16}$/;
const EMAIL_RE = /^[a-z0-9._%+-]+@mxschool\.edu$/i;
const SESSION_DAYS = 30;

// ---------- members-only content (served only to logged-in users) ----------
const CONTENT = {
  address: "mxminecraft.net",
  version: "26.3",
  season1: "2026-11-20T18:00:00-05:00",
  steps: [
    ["Open Minecraft: Java Edition", "Use the latest release (26.3). Bedrock (console, phone, Windows Store) can't join."],
    ["Add the server", "Go to Multiplayer, then Add Server, and enter mxminecraft.net. You don't need a port."],
    ["Join", "Double-click the server. If it says you're not whitelisted, your approval is still pending."],
  ],
  world: [
    ["Fresh random seed", "A brand-new vanilla world. Nobody has seen the seed, so everyone starts even."],
    ["10,000 × 10,000 border", "The world border is 5,000 blocks out from spawn in every direction, and it's all pregenerated, so there's no chunk lag."],
    ["Nether ready", "The Nether is pregenerated too, which is good for fast travel and highways."],
    ["Recorded", "The server records gameplay (replays are kept for 14 days), so any dispute can be checked."],
  ],
  rules: [
    ["24h grace period", "PvP is off for the first 24 hours after Season 1 starts. It switches on automatically after that."],
    ["Stealing is fair", "Looting is allowed. Secret or hidden bases are fair game, including griefing them."],
    ["No griefing public builds", "Don't grief public builds like a town hall or a shared farm. Take what's hidden in them, but don't destroy them."],
    ["Teams of 2 max", "Duos only for now."],
    ["Cart PvP yes, crystals no", "TNT-minecart PvP is allowed. End crystal PvP is banned."],
    ["Villagers", "Villagers you trapped yourself are yours to do with as you like. Public villagers and villages are off limits."],
    ["No cheats", "No x-ray, hacked clients, dupes or exploits. The server runs an anticheat and anti-xray. Sodium, Iris and minimaps are fine."],
    ["No lag machines", "The server runs on a home PC. Don't build things meant to crash or lag it."],
  ],
};

// ---------- helpers ----------
function cors(req: Request) {
  const o = req.headers.get("origin") ?? "";
  return {
    "Access-Control-Allow-Origin": ORIGINS.includes(o) ? o : ORIGINS[0],
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "content-type, authorization, apikey, x-client-info",
    "Vary": "Origin",
  };
}
const json = (req: Request, body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors(req), "Content-Type": "application/json" } });
const hex = (b: ArrayBuffer | Uint8Array) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
async function sha256(s: string) { return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))); }
function safeEq(a: string, b: string) {
  if (a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
async function cfg(key: string) {
  const { data } = await db.from("app_config").select("value").eq("key", key).single();
  return data?.value as string;
}
// Rules/world text live in app_config key "content" (JSON) so they can change without a redeploy; CONTENT above is the fallback.
async function getContent() {
  try { const v = await cfg("content"); if (v) return { ...CONTENT, ...JSON.parse(v) }; } catch { /* use fallback */ }
  return CONTENT;
}
const clean = (s: unknown, n = 40) => String(s ?? "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, n);
const dash = (id: string) => id.includes("-") ? id : `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;

// Name -> {name, uuid}; tries several services because Mojang rate-limits shared edge IPs.
async function mojang(name: string) {
  const { data: wl } = await db.from("whitelist").select("uuid, name").ilike("name", name.replace(/_/g, "\\_")).maybeSingle();
  if (wl) return { name: wl.name as string, uuid: wl.uuid as string };
  const n = encodeURIComponent(name);
  const sources: [string, (j: any) => { name: string; id: string }][] = [
    [`https://api.minecraftservices.com/minecraft/profile/lookup/name/${n}`, (j) => ({ name: j.name, id: j.id })],
    [`https://api.mojang.com/users/profiles/minecraft/${n}`, (j) => ({ name: j.name, id: j.id })],
    [`https://playerdb.co/api/player/minecraft/${n}`, (j) => ({ name: j.data.player.username, id: j.data.player.id })],
  ];
  let notFound = false;
  for (const [u, pick] of sources) {
    try {
      const r = await fetch(u, { headers: { "User-Agent": "mxminecraft.net" } });
      if (r.status === 200) { const p = pick(await r.json()); if (p?.id && p?.name) return { name: p.name, uuid: dash(p.id) }; }
      if (r.status === 404 || r.status === 204 || r.status === 400) notFound = true;
    } catch { /* next */ }
  }
  if (notFound) return null;
  throw new Error("lookup unavailable");
}
async function isWhitelisted(uuid: string) {
  const { data } = await db.from("whitelist").select("uuid").eq("uuid", uuid).maybeSingle();
  return !!data;
}
async function pingAdmin(r: Record<string, string>) {
  const topic = await cfg("ntfy_topic");
  const link = `${SELF}?action=approve&token=${r.approve_token}`;
  await fetch(`https://ntfy.sh/${topic}`, {
    method: "POST",
    headers: {
      "Title": `MX whitelist request: ${r.mc_name}`, "Tags": "video_game",
      "Actions": `view, Approve, ${link}, clear=true; view, Deny, ${link}&deny=1, clear=true`,
    },
    body: `${r.first_name} ${r.last_name}\nMC: ${r.mc_name}\n${r.email}`,
  });
}
async function newSession(accountId: string) {
  const token = hex(crypto.getRandomValues(new Uint8Array(32)));
  await db.from("sessions").insert({ token_hash: await sha256(token), account_id: accountId,
    expires_at: new Date(Date.now() + SESSION_DAYS * 864e5).toISOString() });
  return token;
}
async function sessionAccount(req: Request) {
  const t = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!/^[0-9a-f]{64}$/.test(t)) return null;
  const { data: s } = await db.from("sessions").select("account_id, expires_at").eq("token_hash", await sha256(t)).maybeSingle();
  if (!s || new Date(s.expires_at) < new Date()) return null;
  const { data: a } = await db.from("accounts").select("*").eq("id", s.account_id).maybeSingle();
  return a ? { ...a, _tokenHash: await sha256(t) } : null;
}
async function tooManyFailures(email: string, ip: string) {
  const since = new Date(Date.now() - 15 * 60e3).toISOString();
  const { count: e } = await db.from("login_attempts").select("id", { count: "exact", head: true }).eq("email", email).eq("ok", false).gte("at", since);
  const { count: i } = await db.from("login_attempts").select("id", { count: "exact", head: true }).eq("ip", ip).eq("ok", false).gte("at", since);
  return (e ?? 0) >= 8 || (i ?? 0) >= 25;
}

// ---------- routes ----------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
  const url = new URL(req.url);
  const action = url.searchParams.get("action");
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim();

  try {
    if (action === "approve" && req.method === "GET") {
      const token = url.searchParams.get("token") ?? "", deny = url.searchParams.get("deny") === "1";
      const page = (msg: string) => new Response(`MX Minecraft admin\n\n${msg}\n`, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
      if (!/^[0-9a-f]{48}$/.test(token)) return page("Invalid link.");
      const { data: r } = await db.from("signup_requests").select("*").eq("approve_token", token).maybeSingle();
      if (!r) return page("Request not found.");
      if (r.status === "pending" || r.status === "unverified") {
        await db.from("signup_requests").update({ status: deny ? "denied" : "approved", decided_at: new Date().toISOString() }).eq("id", r.id);
        return page(deny ? `Denied ${r.mc_name}.` : `Approved ${r.mc_name}. They'll be whitelisted within a minute.`);
      }
      return page(`${r.mc_name} is already ${r.status}.`);
    }

    if (action === "skin" && req.method === "GET") {
      const uuid = (url.searchParams.get("uuid") ?? "").replace(/-/g, "");
      if (!/^[0-9a-f]{32}$/.test(uuid)) return json(req, { error: "bad uuid" }, 400);
      let tex: { url?: string; metadata?: { model?: string } } | undefined;
      try {
        const prof = await fetch(`https://sessionserver.mojang.com/session/minecraft/profile/${uuid}`);
        if (prof.status === 200) tex = JSON.parse(atob((await prof.json()).properties[0].value)).textures?.SKIN;
      } catch { /* fall through */ }
      if (!tex?.url) {
        try {
          const pd = await fetch(`https://playerdb.co/api/player/minecraft/${uuid}`, { headers: { "User-Agent": "mxminecraft.net" } });
          if (pd.status === 200) {
            const pl = (await pd.json()).data?.player;
            const raw = pl?.properties?.find((x: any) => x.name === "textures")?.value;
            tex = raw ? JSON.parse(atob(raw)).textures?.SKIN : { url: pl?.skin_texture };
          }
        } catch { /* fall through */ }
      }
      if (!tex?.url || !/^https?:\/\/textures\.minecraft\.net\//.test(tex.url)) return json(req, { error: "no skin" }, 404);
      const png = await fetch(tex.url.replace("http://", "https://"));
      return new Response(png.body, { headers: { ...cors(req), "Content-Type": "image/png", "Cache-Control": "public, max-age=3600" } });
    }

    if (req.method !== "POST") return json(req, { error: "method" }, 405);
    const b = await req.json().catch(() => ({}));

    if (action === "register") {
      const first = clean(b.first), last = clean(b.last), mc = clean(b.mc, 16);
      const email = clean(b.email, 120).toLowerCase();
      if (!first || !last) return json(req, { error: "Enter your first and last name." }, 400);
      if (!EMAIL_RE.test(email)) return json(req, { error: "Use your @mxschool.edu email address." }, 400);
      if (!NAME_RE.test(mc)) return json(req, { error: "That isn't a valid Minecraft username." }, 400);
      const since = new Date(Date.now() - 3600e3).toISOString();
      const { count: recent } = await db.from("accounts").select("id", { count: "exact", head: true }).gte("created_at", since);
      if ((recent ?? 0) > 40) return json(req, { error: "Too many sign-ups right now. Try again later." }, 429);
      const { data: exists } = await db.from("accounts").select("id").eq("email", email).maybeSingle();
      if (exists) return json(req, { error: "An account with that email already exists. Sign in instead." }, 409);
      const p = await mojang(mc);
      if (!p) return json(req, { error: "That Minecraft account doesn't exist (Java Edition)." }, 400);
      const { data: taken } = await db.from("accounts").select("id").eq("mc_uuid", p.uuid).maybeSingle();
      if (taken) return json(req, { error: "That Minecraft account is already registered." }, 409);

      let requestId: string | null = null;
      if (!(await isWhitelisted(p.uuid))) {
        const { data: r, error } = await db.from("signup_requests").insert({
          first_name: first, last_name: last, mc_name: p.name, mc_uuid: p.uuid, email, ip, status: "pending",
        }).select().single();
        if (error) throw error;
        requestId = r.id;
        await pingAdmin(r);
      }
      const { data: acct, error: e2 } = await db.from("accounts").insert({
        email, first_name: first, last_name: last, mc_name: p.name, mc_uuid: p.uuid, request_id: requestId,
      }).select("id").single();
      if (e2) throw e2;
      return json(req, { token: await newSession(acct.id) });
    }

    if (action === "login") {
      const email = clean(b.email, 120).toLowerCase();
      if (!EMAIL_RE.test(email)) return json(req, { error: "Use your @mxschool.edu email address." }, 400);
      if (await tooManyFailures(email, ip)) return json(req, { error: "Too many attempts. Wait 15 minutes and try again." }, 429);
      const { data: a } = await db.from("accounts").select("id").eq("email", email).maybeSingle();
      await db.from("login_attempts").insert({ email, ip, ok: !!a });
      if (!a) return json(req, { error: "No account with that email yet. Create one first." }, 404);
      return json(req, { token: await newSession(a!.id) });
    }

    if (action === "me") {
      const a = await sessionAccount(req);
      if (!a) return json(req, { error: "signed out" }, 401);
      const whitelisted = await isWhitelisted(a.mc_uuid);
      let request = null;
      if (!whitelisted && a.request_id) {
        const { data: r } = await db.from("signup_requests").select("status").eq("id", a.request_id).maybeSingle();
        request = r?.status ?? null;
      }
      return json(req, {
        profile: { first: a.first_name, last: a.last_name, mc: a.mc_name, uuid: a.mc_uuid, email: a.email },
        whitelisted, request, content: await getContent(),
      });
    }

    if (action === "logout") {
      const a = await sessionAccount(req);
      if (a) await db.from("sessions").delete().eq("token_hash", a._tokenHash);
      return json(req, { ok: true });
    }

    if (action === "sync") {
      const secret = await cfg("sync_secret");
      if (typeof b.secret !== "string" || !safeEq(await sha256(b.secret), await sha256(secret))) return json(req, { error: "forbidden" }, 403);
      const wl = (Array.isArray(b.whitelist) ? b.whitelist : []).filter((w: any) => NAME_RE.test(w?.name ?? "") && /^[0-9a-f-]{36}$/.test(w?.uuid ?? ""));
      await db.from("whitelist").delete().neq("uuid", "00000000-0000-0000-0000-000000000000");
      if (wl.length) await db.from("whitelist").insert(wl.map((w: any) => ({ uuid: w.uuid, name: w.name })));
      const applied = (Array.isArray(b.applied) ? b.applied : []).map(String);
      if (applied.length) await db.from("signup_requests").update({ status: "applied" }).in("id", applied);
      const { data: todo } = await db.from("signup_requests").select("id, mc_name").eq("status", "approved");
      return json(req, { toAdd: (todo ?? []).map((t) => ({ id: t.id, name: t.mc_name })) });
    }

    return json(req, { error: "unknown action" }, 404);
  } catch (e) {
    console.error(e);
    return json(req, { error: "Something went wrong. Try again in a minute." }, 500);
  }
});
