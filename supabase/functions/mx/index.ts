// MX Minecraft sign-up API (Supabase Edge Function).
// Routes (all JSON, POST unless noted):
//   check   {mc}                         -> {exists, uuid, name, whitelisted}
//   signup  {first,last,mc,email}        -> {id, needsCode}   (emails a 6-digit code if Resend is configured)
//   verify  {id, code}                   -> {status}           (pings admin when not whitelisted)
//   approve GET ?token=..&deny=1         -> page for the admin's one-tap link
//   skin    GET ?uuid=..                 -> skin PNG (CORS-enabled proxy of Mojang textures)
//   sync    {secret, whitelist:[{uuid,name}], applied:[id]} -> {toAdd:[{id,name}]}   (called by the PC)
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const ORIGINS = ["https://mxminecraft.net", "https://www.mxminecraft.net"];
const RESEND = Deno.env.get("RESEND_API_KEY") ?? "";
const SELF = `${Deno.env.get("SUPABASE_URL")}/functions/v1/mx`;
const NAME_RE = /^[A-Za-z0-9_]{3,16}$/;
const EMAIL_RE = /^[a-z0-9._%+-]+@mxschool\.edu$/i;

function cors(req: Request) {
  const o = req.headers.get("origin") ?? "";
  return {
    "Access-Control-Allow-Origin": ORIGINS.includes(o) ? o : ORIGINS[0],
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "content-type, apikey, authorization, x-client-info",
    "Vary": "Origin",
  };
}
const json = (req: Request, body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors(req), "Content-Type": "application/json" } });

async function sha256(s: string) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
async function cfg(key: string) {
  const { data } = await db.from("app_config").select("value").eq("key", key).single();
  return data?.value as string;
}
async function mojang(name: string) {
  const r = await fetch(`https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(name)}`);
  if (r.status !== 200) return null;
  const j = await r.json();
  const id = j.id as string;
  return { name: j.name as string, uuid: `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}` };
}
async function isWhitelisted(uuid: string) {
  const { data } = await db.from("whitelist").select("uuid").eq("uuid", uuid).maybeSingle();
  return !!data;
}
const clean = (s: unknown, n = 40) => String(s ?? "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, n);

async function pingAdmin(r: Record<string, string>, verified: boolean) {
  const topic = await cfg("ntfy_topic");
  const link = `${SELF}?action=approve&token=${r.approve_token}`;
  await fetch(`https://ntfy.sh/${topic}`, {
    method: "POST",
    headers: {
      "Title": `MX whitelist request: ${r.mc_name}`,
      "Tags": verified ? "video_game,white_check_mark" : "video_game,warning",
      "Actions": `view, Approve, ${link}, clear=true; view, Deny, ${link}&deny=1, clear=true`,
    },
    body: `${r.first_name} ${r.last_name}\nMC: ${r.mc_name}\n${r.email}${verified ? " (email verified)" : " (email NOT verified)"}`,
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
  const url = new URL(req.url);
  const action = url.searchParams.get("action");
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim();

  try {
    if (action === "approve" && req.method === "GET") {
      const token = url.searchParams.get("token") ?? "";
      const deny = url.searchParams.get("deny") === "1";
      // Supabase serves function HTML as text/plain, so the admin page is plain text.
      const page = (msg: string) => new Response(`MX Minecraft admin\n\n${msg}\n`,
        { headers: { "Content-Type": "text/plain; charset=utf-8" } });
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
      // Proxy the player's skin PNG from Mojang (textures.minecraft.net has no CORS).
      const uuid = (url.searchParams.get("uuid") ?? "").replace(/-/g, "");
      if (!/^[0-9a-f]{32}$/.test(uuid)) return json(req, { error: "bad uuid" }, 400);
      const prof = await fetch(`https://sessionserver.mojang.com/session/minecraft/profile/${uuid}`);
      if (prof.status !== 200) return json(req, { error: "no profile" }, 404);
      const tex = JSON.parse(atob((await prof.json()).properties[0].value)).textures?.SKIN;
      if (!tex?.url?.startsWith("http://textures.minecraft.net/") && !tex?.url?.startsWith("https://textures.minecraft.net/"))
        return json(req, { error: "no skin" }, 404);
      const png = await fetch(tex.url.replace("http://", "https://"));
      return new Response(png.body, { headers: { ...cors(req), "Content-Type": "image/png", "Cache-Control": "public, max-age=3600",
        "X-Skin-Model": tex.metadata?.model === "slim" ? "slim" : "default", "Access-Control-Expose-Headers": "X-Skin-Model" } });
    }
    if (req.method !== "POST") return json(req, { error: "method" }, 405);
    const b = await req.json().catch(() => ({}));

    if (action === "check") {
      const mc = clean(b.mc, 16);
      if (!NAME_RE.test(mc)) return json(req, { error: "That isn't a valid Minecraft username." }, 400);
      const p = await mojang(mc);
      if (!p) return json(req, { exists: false });
      return json(req, { exists: true, ...p, whitelisted: await isWhitelisted(p.uuid) });
    }

    if (action === "signup") {
      const first = clean(b.first), last = clean(b.last), mc = clean(b.mc, 16), email = clean(b.email, 120).toLowerCase();
      if (!first || !last) return json(req, { error: "Please enter your first and last name." }, 400);
      if (!EMAIL_RE.test(email)) return json(req, { error: "Use your @mxschool.edu email address." }, 400);
      if (!NAME_RE.test(mc)) return json(req, { error: "That isn't a valid Minecraft username." }, 400);
      const since = new Date(Date.now() - 3600e3).toISOString();
      const { count: c1 } = await db.from("signup_requests").select("id", { count: "exact", head: true }).eq("email", email).gte("created_at", since);
      const { count: c2 } = await db.from("signup_requests").select("id", { count: "exact", head: true }).eq("ip", ip).gte("created_at", since);
      if ((c1 ?? 0) >= 3 || (c2 ?? 0) >= 6) return json(req, { error: "Too many attempts. Try again in an hour." }, 429);
      const p = await mojang(mc);
      if (!p) return json(req, { error: "That Minecraft account doesn't exist (Java Edition)." }, 400);
      if (await isWhitelisted(p.uuid)) return json(req, { status: "whitelisted", ...p });

      const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, "0");
      const { data: r, error } = await db.from("signup_requests").insert({
        first_name: first, last_name: last, mc_name: p.name, mc_uuid: p.uuid, email, ip,
        code_hash: RESEND ? await sha256(code) : null,
        code_expires: new Date(Date.now() + 15 * 60e3).toISOString(),
      }).select().single();
      if (error) throw error;

      if (RESEND) {
        const sent = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { Authorization: `Bearer ${RESEND}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            from: "MX Minecraft <noreply@mxminecraft.net>", to: [email],
            subject: `Your MX Minecraft code: ${code}`,
            text: `Hi ${first},\n\nYour MX Minecraft verification code is ${code}. It expires in 15 minutes.\n\nIf you didn't request this, you can ignore this email.`,
          }),
        });
        if (!sent.ok) throw new Error("email send failed " + sent.status);
        return json(req, { id: r.id, needsCode: true });
      }
      // No email provider configured yet: hand straight to the admin, flagged as unverified.
      await db.from("signup_requests").update({ status: "pending" }).eq("id", r.id);
      await pingAdmin(r, false);
      return json(req, { id: r.id, needsCode: false, status: "pending" });
    }

    if (action === "verify") {
      const id = clean(b.id, 36), code = clean(b.code, 6);
      const { data: r } = await db.from("signup_requests").select("*").eq("id", id).maybeSingle();
      if (!r || r.status !== "unverified") return json(req, { error: "This request has expired. Start again." }, 400);
      if (r.attempts >= 5 || new Date(r.code_expires) < new Date()) return json(req, { error: "Code expired. Start again." }, 400);
      if ((await sha256(code)) !== r.code_hash) {
        await db.from("signup_requests").update({ attempts: r.attempts + 1 }).eq("id", id);
        return json(req, { error: "Wrong code. Check your email and try again." }, 400);
      }
      if (await isWhitelisted(r.mc_uuid)) {
        await db.from("signup_requests").update({ status: "applied", verified_at: new Date().toISOString() }).eq("id", id);
        return json(req, { status: "whitelisted" });
      }
      await db.from("signup_requests").update({ status: "pending", verified_at: new Date().toISOString() }).eq("id", id);
      await pingAdmin(r, true);
      return json(req, { status: "pending" });
    }

    if (action === "status") {
      const { data: r } = await db.from("signup_requests").select("status, mc_uuid").eq("id", clean(b.id, 36)).maybeSingle();
      if (!r) return json(req, { error: "not found" }, 404);
      return json(req, { status: (await isWhitelisted(r.mc_uuid)) ? "whitelisted" : r.status });
    }

    if (action === "sync") {
      const secret = await cfg("sync_secret");
      if (typeof b.secret !== "string" || b.secret.length !== secret.length || (await sha256(b.secret)) !== (await sha256(secret)))
        return json(req, { error: "forbidden" }, 403);
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
