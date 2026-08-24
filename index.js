// ============================================================
//  ROASDASH — Robô Macle -> Meta (conversões offline)
//  Roda 1 vez por execução. No Render (Cron Job) rode: node index.js
//  Todas as configs vêm das VARIÁVEIS DE AMBIENTE (aba Environment do Render).
//  Nenhuma chave fica no código.
// ============================================================
import crypto from "node:crypto";

const g = (k, d = "") => process.env[k] ?? d;

const CFG = {
  mode: g("MODE", "dry-run").toLowerCase(),              // dry-run (testa) | live (envia)
  lookbackHours: parseFloat(g("LOOKBACK_HOURS", "48")),  // 48 = ontem + hoje
  macle: {
    url: g("MACLE_SALES_URL"),
    authName: g("MACLE_AUTH_HEADER_NAME", "Authorization"),
    authValue: g("MACLE_AUTH_HEADER_VALUE"),
    f: {
      id: g("F_ORDER_ID", "id"), datetime: g("F_DATETIME", "data"),
      value: g("F_VALUE", "valor"), phone: g("F_PHONE", "telefone"), email: g("F_EMAIL", "email"),
    },
  },
  meta: {
    datasetId: g("META_DATASET_ID"), token: g("META_ACCESS_TOKEN"),
    version: g("META_API_VERSION", "v21.0"),
    currency: g("CURRENCY", "BRL"), actionSource: g("ACTION_SOURCE", "physical_store"),
  },
};

const sha256 = (v) => crypto.createHash("sha256").update(v).digest("hex");
const fmtDate = (d) => d.toISOString().slice(0, 10);
function normPhone(p) { let d = String(p).replace(/\D/g, ""); if (d.length >= 10 && d.length <= 11) d = "55" + d; return d; }

async function fetchSales() {
  const now = new Date();
  const from = new Date(now.getTime() - CFG.lookbackHours * 3600 * 1000);
  const url = (CFG.macle.url || "").replace("{from}", fmtDate(from)).replace("{to}", fmtDate(now));
  if (!url) throw new Error("MACLE_SALES_URL não configurado (aba Environment).");
  const headers = {};
  if (CFG.macle.authValue) headers[CFG.macle.authName] = CFG.macle.authValue;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`Macle respondeu HTTP ${res.status}`);
  const json = await res.json();
  const rows = Array.isArray(json) ? json : (json.data || json.vendas || json.sales || []);
  const f = CFG.macle.f;
  return rows.map((r) => ({
    orderId: String(r[f.id] ?? ""),
    datetime: r[f.datetime],
    value: parseFloat(String(r[f.value] ?? "0").replace(",", ".")) || 0,
    phone: r[f.phone] || "", email: r[f.email] || "",
  })).filter((s) => s.orderId && s.value > 0);
}

function toEvent(s) {
  const user = {};
  if (s.email) user.em = [sha256(String(s.email).trim().toLowerCase())];
  if (s.phone) user.ph = [sha256(normPhone(s.phone))];
  return {
    event_name: "Purchase",
    event_time: Math.floor(new Date(s.datetime).getTime() / 1000) || Math.floor(Date.now() / 1000),
    event_id: `macle-${s.orderId}`,           // Meta deduplica por aqui — nunca conta 2x
    action_source: CFG.meta.actionSource,
    user_data: user,
    custom_data: { value: s.value, currency: CFG.meta.currency },
  };
}
const chunk = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };

async function main() {
  const stamp = new Date().toISOString();
  const sales = await fetchSales();
  console.log(`[${stamp}] ${sales.length} venda(s) na janela · modo ${CFG.mode}`);
  if (!sales.length) return;

  const events = sales.map(toEvent);
  if (CFG.mode !== "live") {
    console.log("DRY-RUN — enviaria", events.length, "evento(s). Exemplo:", JSON.stringify(events[0]));
    return;
  }
  if (!CFG.meta.datasetId || !CFG.meta.token) throw new Error("META_DATASET_ID / META_ACCESS_TOKEN ausentes.");
  const url = `https://graph.facebook.com/${CFG.meta.version}/${CFG.meta.datasetId}/events`;
  let sent = 0;
  for (const part of chunk(events, 1000)) {
    const body = new URLSearchParams({ data: JSON.stringify(part), access_token: CFG.meta.token });
    const res = await fetch(url, { method: "POST", body });
    const j = await res.json();
    if (!res.ok) throw new Error(`Meta HTTP ${res.status}: ${JSON.stringify(j)}`);
    sent += part.length;
  }
  console.log(`[${stamp}] ✓ ${sent} venda(s) enviada(s) ao Meta.`);
}

main().catch((e) => { console.error("ERRO:", e.message); process.exit(1); });
