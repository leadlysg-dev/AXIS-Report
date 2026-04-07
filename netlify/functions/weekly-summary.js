const fetch = require("node-fetch");
const { getSheets, readTab } = require("./sheets-writer");
const CONFIG = require("./config");

/**
 * Weekly Tuesday summary — plain text, no Markdown
 * Compares past 7 days, flags best/worst ads
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
    const col = (name) => headerRow.indexOf(name);

    // This week = last 7 days
    const today = new Date();
    const weekAgo = new Date(today);
    weekAgo.setDate(weekAgo.getDate() - 7);
    const twoWeeksAgo = new Date(today);
    twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14);

    const thisWeekRows = dataRows.filter((r) => r[0] >= formatDate(weekAgo) && r[0] < formatDate(today));
    const prevWeekRows = dataRows.filter((r) => r[0] >= formatDate(twoWeeksAgo) && r[0] < formatDate(weekAgo));

    if (thisWeekRows.length === 0) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ ok: false, message: "No data for past week" }),
      };
    }

    // Aggregate by ad
    const thisWeekByAd = aggregateByAd(thisWeekRows, col);
    const prevWeekByAd = aggregateByAd(prevWeekRows, col);

    // Totals
    const totalSpend = Object.values(thisWeekByAd).reduce((s, a) => s + a.spend, 0);
    const totalConv = Object.values(thisWeekByAd).reduce((s, a) => s + a.conversions, 0);
    const totalClicks = Object.values(thisWeekByAd).reduce((s, a) => s + a.clicks, 0);
    const avgCPL = totalConv > 0 ? totalSpend / totalConv : 0;

    const prevTotalSpend = Object.values(prevWeekByAd).reduce((s, a) => s + a.spend, 0);
    const prevTotalConv = Object.values(prevWeekByAd).reduce((s, a) => s + a.conversions, 0);

    const spendChange = prevTotalSpend > 0 ? ((totalSpend - prevTotalSpend) / prevTotalSpend * 100).toFixed(0) : "N/A";
    const convChange = prevTotalConv > 0 ? ((totalConv - prevTotalConv) / prevTotalConv * 100).toFixed(0) : "N/A";

    // Build message — plain text
    let msg = `Income Insurance — Weekly Report\n`;
    msg += `${formatDate(weekAgo)} → ${formatDate(today)}\n\n`;

    msg += `Total spend: $${totalSpend.toFixed(2)}`;
    if (spendChange !== "N/A") msg += ` (${spendChange > 0 ? "+" : ""}${spendChange}% vs prev wk)`;
    msg += `\n`;

    msg += `Total leads: ${totalConv}`;
    if (convChange !== "N/A") msg += ` (${convChange > 0 ? "+" : ""}${convChange}% vs prev wk)`;
    msg += `\n`;

    msg += `Avg CPL: $${avgCPL.toFixed(2)} | Clicks: ${totalClicks}\n\n`;

    // Sort ads by conversions (best first)
    const sortedAds = Object.entries(thisWeekByAd).sort((a, b) => {
      if (b[1].conversions !== a[1].conversions) return b[1].conversions - a[1].conversions;
      return a[1].spend - b[1].spend; // lower spend first if same conv
    });

    // Best performer
    const bestAds = sortedAds.filter(([, a]) => a.conversions > 0);
    if (bestAds.length > 0) {
      const [name, data] = bestAds[0];
      const shortName = name.length > 40 ? name.substring(0, 40) + "…" : name;
      msg += `🏆 Best: ${shortName}\n`;
      msg += `   ${data.conversions} leads, $${data.spend.toFixed(2)} spent, $${data.cpl.toFixed(2)} CPL\n\n`;
    }

    // Ads to watch (spend but poor/no conversions)
    const watchAds = sortedAds.filter(([, a]) => a.spend > 5 && (a.conversions === 0 || a.cpl > avgCPL * 1.5));
    if (watchAds.length > 0) {
      msg += `⚠️ Watch list:\n`;
      for (const [name, data] of watchAds.slice(0, 3)) {
        const shortName = name.length > 40 ? name.substring(0, 40) + "…" : name;
        if (data.conversions === 0) {
          msg += `🔴 ${shortName} — $${data.spend.toFixed(2)} spent, 0 leads\n`;
        } else {
          msg += `🔴 ${shortName} — ${data.conversions} leads, $${data.cpl.toFixed(2)} CPL\n`;
        }
      }
      msg += `\n`;
    }

    // Full breakdown
    msg += `All ads this week:\n`;
    for (const [name, data] of sortedAds) {
      const shortName = name.length > 35 ? name.substring(0, 35) + "…" : name;
      let light;
      if (data.spend === 0) light = "⚪";
      else if (data.conversions === 0) light = "🔴";
      else if (data.cpl <= avgCPL * 0.8) light = "🟢";
      else if (data.cpl <= avgCPL * 1.2) light = "🟡";
      else light = "🔴";

      if (data.spend === 0) {
        msg += `${light} ${shortName} — paused\n`;
      } else if (data.conversions === 0) {
        msg += `${light} ${shortName} — $${data.spend.toFixed(2)}, 0 leads\n`;
      } else {
        msg += `${light} ${shortName} — ${data.conversions} leads, $${data.cpl.toFixed(2)} CPL\n`;
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
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ ok: true, preview: true, message: msg }),
      };
    }

    await sendTelegram(msg);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ ok: true, sent: true, message: msg }),
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

function aggregateByAd(rows, col) {
  const byAd = {};
  for (const row of rows) {
    const name = row[col("Ad name")] || "Unknown";
    if (!byAd[name]) byAd[name] = { spend: 0, clicks: 0, impressions: 0, conversions: 0 };
    byAd[name].spend += parseFloat(row[col("Amount spent (SGD)")] || 0);
    byAd[name].clicks += parseInt(row[col("Link clicks")] || 0);
    byAd[name].impressions += parseInt(row[col("Impressions")] || 0);
    const leads = parseInt(row[col("Leads")] || 0);
    const msgConv = parseInt(row[col("Messaging conversations started")] || 0);
    byAd[name].conversions += leads + msgConv;
  }
  for (const ad of Object.values(byAd)) {
    ad.cpl = ad.conversions > 0 ? ad.spend / ad.conversions : 0;
  }
  return byAd;
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
        max_tokens: 300,
        system: `You are a performance marketing analyst for Income Insurance running Meta Ads for "Care Secure Pro".

Write a 3-4 sentence weekly insight. Identify which ads performed best and why. Flag any ads that should be considered for pausing. Note any CPL trends. Keep it conversational — like a message from a colleague. No bullet points, no headers, no markdown. Just observations and one suggested next step.`,
        messages: [{
          role: "user",
          content: `This week's ad performance (7 days aggregated):
${Object.entries(thisWeek).map(([name, d]) => `${name}: $${d.spend.toFixed(2)} spend, ${d.conversions} leads, $${d.cpl.toFixed(2)} CPL, ${d.clicks} clicks`).join("\n")}

Total: $${totalSpend.toFixed(2)} spend, ${totalConv} leads, $${avgCPL.toFixed(2)} avg CPL

${Object.keys(prevWeek).length > 0 ? `Previous week:\n${Object.entries(prevWeek).map(([name, d]) => `${name}: $${d.spend.toFixed(2)} spend, ${d.conversions} leads, $${d.cpl.toFixed(2)} CPL`).join("\n")}` : "No previous week data."}

Write the weekly insight.`,
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
    body: JSON.stringify({
      chat_id: CONFIG.telegram.chatId,
      text: text,
    }),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`Telegram error: ${json.description}`);
  return json;
}

function formatDate(d) {
  return d.toISOString().split("T")[0];
}
