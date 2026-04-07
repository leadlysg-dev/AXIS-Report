const fetch = require("node-fetch");
const { getSheets, readTab } = require("./sheets-writer");
const CONFIG = require("./config");

/**
 * Weekly Tuesday summary — compares all ads over past 7 days
 * Flags best/worst performers, suggests actions
 *
 * Triggered by:
 *   - Netlify cron (8am SGT Tuesday / 0:00am UTC Tuesday)
 *   - Manual: GET /api/weekly-summary?preview=true
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
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ ok: false, message: "No data in sheet" }),
      };
    }

    const headerRow = allData[0];
    const dataRows = allData.slice(1);
    const colIndex = (name) => headerRow.indexOf(name);

    // Last 7 days
    const today = new Date();
    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 7);
    const twoWeeksAgo = new Date();
    twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14);

    const thisWeekRows = dataRows.filter((r) => {
      const d = new Date(r[0]);
      return d >= weekAgo && d < today;
    });

    const prevWeekRows = dataRows.filter((r) => {
      const d = new Date(r[0]);
      return d >= twoWeeksAgo && d < weekAgo;
    });

    if (thisWeekRows.length === 0) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ ok: false, message: "No data for past week" }),
      };
    }

    // Aggregate by ad
    const thisWeekByAd = aggregateByAd(thisWeekRows, colIndex);
    const prevWeekByAd = aggregateByAd(prevWeekRows, colIndex);

    // Build weekly message
    let msg = `📊 *Income Insurance — Weekly Report*\n`;
    msg += `📅 ${formatDate(weekAgo)} → ${formatDate(today)}\n\n`;

    // Totals
    const totalSpend = Object.values(thisWeekByAd).reduce((s, a) => s + a.spend, 0);
    const totalConv = Object.values(thisWeekByAd).reduce((s, a) => s + a.conversions, 0);
    const totalClicks = Object.values(thisWeekByAd).reduce((s, a) => s + a.clicks, 0);
    const avgCPL = totalConv > 0 ? totalSpend / totalConv : 0;

    const prevTotalSpend = Object.values(prevWeekByAd).reduce((s, a) => s + a.spend, 0);
    const prevTotalConv = Object.values(prevWeekByAd).reduce((s, a) => s + a.conversions, 0);

    msg += `💰 Total Spend: $${totalSpend.toFixed(2)}`;
    if (prevTotalSpend > 0) msg += ` (${changeStr(totalSpend, prevTotalSpend)} vs prev wk)`;
    msg += `\n`;

    msg += `🎯 Total Leads: ${totalConv}`;
    if (prevTotalConv > 0) msg += ` (${changeStr(totalConv, prevTotalConv)} vs prev wk)`;
    msg += `\n`;

    msg += `📉 Avg CPL: $${avgCPL.toFixed(2)} | Clicks: ${totalClicks}\n\n`;

    // Sort ads by spend
    const sortedAds = Object.entries(thisWeekByAd).sort(
      (a, b) => b[1].spend - a[1].spend
    );

    // Top performer
    const bestCPL = sortedAds
      .filter(([, a]) => a.conversions > 0)
      .sort((a, b) => a[1].cpl - b[1].cpl);

    if (bestCPL.length > 0) {
      const [name, data] = bestCPL[0];
      const shortName = name.length > 35 ? name.substring(0, 35) + "…" : name;
      msg += `🏆 *Best Performer:* ${shortName}\n`;
      msg += `    $${data.spend.toFixed(2)} spent | ${data.conversions} leads | $${data.cpl.toFixed(2)} CPL\n\n`;
    }

    // Worst performer (has spend but poor/no conversions)
    const worstAds = sortedAds
      .filter(([, a]) => a.spend > 5 && (a.conversions === 0 || a.cpl > avgCPL * 1.5));

    if (worstAds.length > 0) {
      msg += `⚠️ *Consider Pausing:*\n`;
      for (const [name, data] of worstAds.slice(0, 3)) {
        const shortName = name.length > 35 ? name.substring(0, 35) + "…" : name;
        msg += `🔴 ${shortName}\n`;
        msg += `    $${data.spend.toFixed(2)} spent | ${data.conversions} leads`;
        if (data.conversions > 0) msg += ` | $${data.cpl.toFixed(2)} CPL`;
        msg += `\n`;
      }
      msg += `\n`;
    }

    // Full breakdown
    msg += `*All Ads:*\n`;
    for (const [name, data] of sortedAds) {
      const shortName = name.length > 30 ? name.substring(0, 30) + "…" : name;
      let light = "⚪";
      if (data.conversions > 0) {
        if (data.cpl <= avgCPL * 0.8) light = "🟢";
        else if (data.cpl <= avgCPL * 1.2) light = "🟡";
        else light = "🔴";
      }
      msg += `${light} ${shortName}: $${data.spend.toFixed(2)} | ${data.conversions} leads`;
      if (data.conversions > 0) msg += ` | $${data.cpl.toFixed(2)}`;
      msg += `\n`;
    }

    // Generate Claude weekly insight
    let insight = "";
    if (CONFIG.anthropic.apiKey) {
      insight = await generateWeeklyInsight(thisWeekByAd, prevWeekByAd, totalSpend, totalConv, avgCPL);
    }

    const fullMessage = msg + (insight ? `\n💡 ${insight}` : "") + "\n\n— Leadly";

    if (preview) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ ok: true, preview: true, message: fullMessage }),
      };
    }

    await sendTelegram(fullMessage);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ ok: true, sent: true, message: fullMessage }),
    };
  } catch (err) {
    console.error("Weekly summary failed:", err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ ok: false, error: err.message }),
    };
  }
};

function aggregateByAd(rows, colIndex) {
  const byAd = {};
  for (const row of rows) {
    const name = row[colIndex("Ad name")] || "Unknown";
    if (!byAd[name]) {
      byAd[name] = { spend: 0, clicks: 0, impressions: 0, conversions: 0 };
    }
    byAd[name].spend += parseFloat(row[colIndex("Amount spent (SGD)")] || 0);
    byAd[name].clicks += parseInt(row[colIndex("Link clicks")] || 0);
    byAd[name].impressions += parseInt(row[colIndex("Impressions")] || 0);
    const leads = parseInt(row[colIndex("Leads")] || 0);
    const msgConv = parseInt(row[colIndex("Messaging conversations started")] || 0);
    byAd[name].conversions += leads + msgConv;
  }
  // Calculate CPL
  for (const ad of Object.values(byAd)) {
    ad.cpl = ad.conversions > 0 ? ad.spend / ad.conversions : 0;
  }
  return byAd;
}

async function generateWeeklyInsight(thisWeek, prevWeek, totalSpend, totalConv, avgCPL) {
  try {
    const prompt = `You are a performance marketing analyst for Income Insurance running Meta Ads for "Care Secure Pro".

This week's ad performance (aggregated over 7 days):
${Object.entries(thisWeek)
  .map(([name, d]) => `${name}: $${d.spend.toFixed(2)} spend, ${d.conversions} leads, $${d.cpl.toFixed(2)} CPL, ${d.clicks} clicks`)
  .join("\n")}

Total: $${totalSpend.toFixed(2)} spend, ${totalConv} leads, $${avgCPL.toFixed(2)} avg CPL

${Object.keys(prevWeek).length > 0 ? `Previous week:\n${Object.entries(prevWeek).map(([name, d]) => `${name}: $${d.spend.toFixed(2)} spend, ${d.conversions} leads, $${d.cpl.toFixed(2)} CPL`).join("\n")}` : "No previous week data."}

Give a 3-4 sentence weekly insight. Identify the top performer and explain why it might be working. Flag any ads that should be paused. Suggest one actionable next step (e.g. duplicate winning ad with new copy, increase budget on best performer, test new audience). Be direct and practical.`;

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
        messages: [{ role: "user", content: prompt }],
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
    body: JSON.stringify({
      chat_id: CONFIG.telegram.chatId,
      text: text,
      parse_mode: "Markdown",
    }),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`Telegram error: ${json.description}`);
  return json;
}

function changeStr(current, previous) {
  const pct = ((current - previous) / previous * 100).toFixed(0);
  return `${pct > 0 ? "+" : ""}${pct}%`;
}

function formatDate(d) {
  return d.toISOString().split("T")[0];
}
