// ============================================================
//  ROASDASH — Robô Macle (ApiCRM) -> Meta (conversões offline)
//  Roda 1x por execução (Render Cron Job): node index.js
//  Configs vêm das VARIÁVEIS DE AMBIENTE (aba Environment).
// ============================================================
import crypto from "node:crypto";
const g = (k, d = "") => process.env[k] ?? d;

const MODE = g("MODE", "dry-run").toLowerCase();       // dry-run (testa) | live (envia)
const LOOKBACK = parseFloat(g("LOOKBACK_HOURS", "48")); // 48 = ontem + hoje
const BASE = (g("MACLE_SALES_URL") || "").split("?")[0]; // usa só a base da ApiCRM
const AUTH_NAME = g("MACLE_AUTH_HEADER_NAME", "x-api-key");
const AUTH_VALUE = g("MACLE_AUTH_HEADER_VALUE");
const DATASET = g("META_DATASET_ID");
const TOKEN = g("META_ACCESS_TOKEN");
const VER = g("META_API_VERSION", "v21.0");
const CURRENCY = g("CURRENCY", "BRL");
const ACTION_SOURCE = g("ACTION_SOURCE", "physical_store");

const sha = (v) => crypto.createHash("sha256").update(v).digest("hex");
function normPhone(p) { let d = String(p).replace(/\D/g, ""); if (d.length >= 10 && d.length <= 11) d = "55" + d; return d; }
function ddmmyyyy(dt) { const d = String(dt.getDate()).padStart(2, "0"); const m = String(dt.getMonth() + 1).padStart(2, "0"); return `${d}/${m}/${dt.getFullYear()}`; }
function parseBR(s) { const p = String(s).split("/"); if (p.length !== 3) return 0; const dt = new Date(Number(p[2]), Number(p[1]) - 1, Number(p[0]), 12, 0, 0); return Math.floor(dt.getTime() / 1000); }

async function apiGet(action, from, to) {
  const url = `${BASE}?action=${action}&dataINI=${from}&dataFIM=${to}`;
  const headers = {};
  if (AUTH_VALUE) headers[AUTH_NAME] = AUTH_VALUE;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`Macle (${action}) HTTP ${res.status}`);
  return res.json();
}

async function main() {
  const now = new Date();
  const from = new Date(now.getTime() - LOOKBACK * 3600 * 1000);
  const f = ddmmyyyy(from), t = ddmmyyyy(now);
  console.log(`Janela ${f} a ${t} · modo ${MODE}`);
  if (!BASE) throw new Error("MACLE_SALES_URL não configurado.");

  const vendas = await apiGet("vendas", f, t);
  const clientes = await apiGet("clientes", f, t);

  const mapa = new Map();
  for (const c of (Array.isArray(clientes) ? clientes : [])) {
    if (c && c.codCliente) mapa.set(String(c.codCliente), { phone: c.celular || "", email: c.email || "" });
  }

  const events = [];
  let semCliente = 0;
  for (const v of (Array.isArray(vendas) ? vendas : [])) {
    const cod = String(v.codCliente || "0.0");
    const cli = mapa.get(cod);
    const phone = cli ? cli.phone : "";
    const email = cli ? cli.email : "";
    if (cod === "0.0" || (!phone && !email)) { semCliente++; continue; }
    const user = {};
    if (email) user.em = [sha(String(email).trim().toLowerCase())];
    if (phone) user.ph = [sha(normPhone(phone))];
    events.push({
      event_name: "Purchase",
      event_time: parseBR(v.dataEmissao) || Math.floor(Date.now() / 1000),
      event_id: `macle-${v.codVenda}`,
      action_source: ACTION_SOURCE,
      user_data: user,
      custom_data: { value: Number(v.valor) || 0, currency: CURRENCY },
    });
  }

  const totalVendas = Array.isArray(vendas) ? vendas.length : 0;
  console.log(`${totalVendas} venda(s) · ${events.length} com cliente identificado · ${semCliente} consumidor (sem cadastro)`);
  if (!events.length) { console.log("Nada para enviar (nenhuma venda com cliente identificado na janela)."); return; }

  if (MODE !== "live") {
    console.log("DRY-RUN — enviaria", events.length, "evento(s). Exemplo:", JSON.stringify(events[0]));
    return;
  }
  if (!DATASET || !TOKEN) throw new Error("META_DATASET_ID / META_ACCESS_TOKEN ausentes.");
  const url = `https://graph.facebook.com/${VER}/${DATASET}/events`;
  const chunk = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };
  let sent = 0;
  for (const part of chunk(events, 1000)) {
    const body = new URLSearchParams({ data: JSON.stringify(part), access_token: TOKEN });
    const res = await fetch(url, { method: "POST", body });
    const j = await res.json();
    if (!res.ok) throw new Error(`Meta HTTP ${res.status}: ${JSON.stringify(j)}`);
    sent += part.length;
  }
  console.log(`✓ ${sent} venda(s) enviada(s) ao Meta.`);
}
main().catch((e) => { console.error("ERRO:", e.message); process.exit(1); });
