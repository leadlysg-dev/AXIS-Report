const fetch = require("node-fetch");
const { getSheets, readTab } = require("./sheets-writer");
const CONFIG = require("./config");

/**
 * Weekly Tuesday summary — plain text, AARO style
 */
exports.handler = async (event) => {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  };

  try {
    const params = event.queryStringParameters || {};
    const preview = params.preview === "true";

    const sheets = await getSheets();
    const allData = await readTab(sheets, CONFIG.sheets.tabName);

    if (allData.length <= 1) {
      return resp(200, headers, { ok: false, message: "No data in sheet" });
    }

    const headerRow = allData[0];
    const dataRows = allData.slice(1);
    const col = (name) => headerRow.indexOf(name);

    // This week = last 7 days, prev week = 7 days before that
    const today = new Date();
    const weekAgo = new Date(today);
    weekAgo.setDate(weekAgo.getDate() - 7);
    const twoWeeksAgo = new Date(today);
    twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14);

    const thisWeekRows = dataRows.filter((r) => r[0] >= formatDate(weekAgo) && r[0] < formatDate(today));
    const prevWeekRows = dataRows.filter((r) => r[0] >= formatDate(twoWeeksAgo) && r[0] < formatDate(weekAgo));

    if (thisWeekRows.length === 0) {
      return resp(200, headers, { ok: false, message: "No data for past week" });
    }

    // Aggregate
    const thisWeekByAd = aggregateByAd(thisWeekRows, col);
    const prevWeekByAd = aggregateByAd(prevWeekRows, col);

    const totalSpend = sumObj(thisWeekByAd, "spend");
    const totalConv = sumObj(thisWeekByAd, "conversions");
    const totalClicks = sumObj(thisWeekByAd, "clicks");
    const avgCPL = totalConv > 0 ? totalSpend / totalConv : 0;

    const prevSpend = sumObj(prevWeekByAd, "spend");
    const prevConv = sumObj(prevWeekByAd, "conversions");

    const spendPct = prevSpend > 0 ? ((totalSpend - prevSpend) / prevSpend * 100).toFixed(0) : null;
    const convPct = prevConv > 0 ? ((totalConv - prevConv) / prevConv * 100).toFixed(0) : null;

    // Date display
    const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const fmtShort = (d) => `${d.getDate().toString().padStart(2, "0")} ${monthNames[d.getMonth()]}`;

    // === BUILD MESSAGE ===
    let msg = `${fmtShort(weekAgo)} – ${fmtShort(today)} ${today.getFullYear()}\n\n`;

    msg += `Leads: ${totalConv}`;
    if (convPct !== null) msg += ` (${convPct > 0 ? "+" : ""}${convPct}% vs prev wk)`;
    msg += `\n`;

    msg += `Spend: SGD ${totalSpend.toFixed(2)}`;
    if (spendPct !== null) msg += ` (${spendPct > 0 ? "+" : ""}${spendPct}% vs prev wk)`;
    msg += `\n`;

    msg += `CPL: SGD ${avgCPL.toFixed(2)} | Clicks: ${totalClicks}\n\n`;

    // Sort by conversions
    const sortedAds = Object.entries(thisWeekByAd).sort((a, b) => {
      if (b[1].conversions !== a[1].conversions) return b[1].conversions - a[1].conversions;
      return a[1].spend - b[1].spend;
    });

    // Per-ad breakdown
    for (const [name, data] of sortedAds) {
      const shortName = name.length > 45 ? name.substring(0, 45) + "…" : name;

      let light;
      if (data.spend === 0) light = "⚪";
      else if (data.conversions === 0) light = "🔴";
      else if (data.cpl <= avgCPL * 0.8) light = "🟢";
      else if (data.cpl <= avgCPL * 1.2) light = "🟡";
      else light = "🔴";

      if (data.spend === 0) {
        msg += `${light} ${shortName} — paused\n`;
      } else if (data.conversions === 0) {
        msg += `${light} ${shortName} — 0 leads (SGD ${data.spend.toFixed(2)} spent)\n`;
      } else {
        msg += `${light} ${shortName} — ${data.conversions} leads (SGD ${data.cpl.toFixed(2)}/lead)\n`;
      }
    }

    // Claude insight
    let insight = "";
    if (CONFIG.anthropic.apiKey) {
      insight = await generateWeeklyInsight(thisWeekByAd, prevWeekByAd, totalSpend, totalConv, avgCPL);
    }
    if (insight) msg += `\n${insight}\n`;

    msg += `\n— Leadly`;

    if (preview) {
      return resp(200, headers, { ok: true, preview: true, message: msg });
    }

    await sendTelegram(msg);
    return resp(200, headers, { ok: true, sent: true, message: msg });
  } catch (err) {
    console.error("Weekly summary failed:", err);
    return resp(500, headers, { ok: false, error: err.message });
  }
};

function aggregateByAd(rows, col) {
  const byAd = {};
  for (const row of rows) {
    const name = row[col("Ad name")] || "Unknown";
    if (!byAd[name]) byAd[name] = { spend: 0, clicks: 0, impressions: 0, conversions: 0 };
    byAd[name].spend += parseFloat(row[col("Amount spent (SGD)")] || 0);
    byAd[name].clicks += parseInt(row[col("Link clicks")] || 0);
    byAd[name].impressions += parseInt(row[col("Impressions")] || 0);
    byAd[name].conversions += parseInt(row[col("Leads")] || 0) + parseInt(row[col("Messaging conversations started")] || 0);
  }
  for (const ad of Object.values(byAd)) {
    ad.cpl = ad.conversions > 0 ? ad.spend / ad.conversions : 0;
  }
  return byAd;
}

function sumObj(obj, key) {
  return Object.values(obj).reduce((s, a) => s + a[key], 0);
}

async function generateWeeklyInsight(thisWeek, prevWeek, totalSpend, totalConv, avgCPL) {
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": CONFIG.anthropic.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 400,
        system: `You are a sharp, concise performance marketing strategist writing a weekly Telegram briefing about Meta Ads. Currency is SGD.

Write a 4-5 sentence weekly insight. Name the top performer and explain why it's winning. Flag any ads that should be paused or scaled down, with the numbers to back it up. Compare this week vs last week on CPL and volume. End with one specific, actionable next step (e.g. "increase AD11's daily budget by 30-50%", "duplicate the winning creative with a different hook", "test a new audience segment").

Tone: professional, confident, strategic. Like a senior media buyer presenting to a client. No fluff, no filler, no greetings. Sharp analysis, clear reasoning, decisive recommendation.`,
        messages: [{
          role: "user",
          content: `This week (7 days):\n${Object.entries(thisWeek).map(([n, d]) => `${n}: SGD ${d.spend.toFixed(2)} spend, ${d.conversions} leads, SGD ${d.cpl.toFixed(2)} CPL, ${d.clicks} clicks`).join("\n")}\n\nTotal: SGD ${totalSpend.toFixed(2)}, ${totalConv} leads, SGD ${avgCPL.toFixed(2)} avg CPL\n\n${Object.keys(prevWeek).length > 0 ? `Prev week:\n${Object.entries(prevWeek).map(([n, d]) => `${n}: SGD ${d.spend.toFixed(2)}, ${d.conversions} leads, SGD ${d.cpl.toFixed(2)} CPL`).join("\n")}` : "No prev week data."}\n\nWrite the weekly insight.`,
        }],
      }),
    });
    const json = await res.json();
    if (json.content && json.content[0]) return json.content[0].text;
    return "";
  } catch (err) {
    console.error("Claude weekly insight error:", err.message);
    return "";
  }
}

async function sendTelegram(text) {
  const url = `https://api.telegram.org/bot${CONFIG.telegram.botToken}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: CONFIG.telegram.chatId, text }),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`Telegram error: ${json.description}`);
  return json;
}

function resp(code, headers, body) {
  return { statusCode: code, headers, body: JSON.stringify(body) };
}

function formatDate(d) {
  return d.toISOString().split("T")[0];
}
