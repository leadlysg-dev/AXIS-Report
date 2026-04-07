const fetch = require("node-fetch");
const { getSheets, readTab } = require("./sheets-writer");
const CONFIG = require("./config");

/**
 * Daily Telegram briefing — reads sheet, generates Claude insight, sends to Telegram
 *
 * Triggered by:
 *   - Netlify cron (7:30am SGT / 11:30pm UTC)
 *   - Manual call: GET /api/daily-insight?preview=true (returns text, doesn't send)
 *   - Manual send: GET /api/daily-insight (sends to Telegram)
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
        body: JSON.stringify({ ok: false, message: "No data in sheet yet" }),
      };
    }

    const headerRow = allData[0];
    const dataRows = allData.slice(1);

    // Get yesterday's date
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = formatDate(yesterday);

    // Get day-before-yesterday for comparison
    const dayBefore = new Date();
    dayBefore.setDate(dayBefore.getDate() - 2);
    const dayBeforeStr = formatDate(dayBefore);

    // Get last week same day for WoW
    const lastWeek = new Date();
    lastWeek.setDate(lastWeek.getDate() - 8);
    const lastWeekStr = formatDate(lastWeek);

    // Filter rows
    const yesterdayRows = dataRows.filter((r) => r[0] === yesterdayStr);
    const dayBeforeRows = dataRows.filter((r) => r[0] === dayBeforeStr);
    const lastWeekRows = dataRows.filter((r) => r[0] === lastWeekStr);

    if (yesterdayRows.length === 0) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          ok: false,
          message: `No data for ${yesterdayStr}`,
        }),
      };
    }

    // Build the briefing
    const briefing = buildBriefing(
      yesterdayStr,
      yesterdayRows,
      dayBeforeRows,
      lastWeekRows,
      headerRow
    );

    // Generate Claude insight
    let insight = "";
    if (CONFIG.anthropic.apiKey) {
      insight = await generateInsight(
        yesterdayStr,
        yesterdayRows,
        dayBeforeRows,
        lastWeekRows,
        headerRow
      );
    }

    const fullMessage = briefing + (insight ? `\n💡 ${insight}` : "") + "\n\n— Leadly";

    if (preview) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ ok: true, preview: true, message: fullMessage }),
      };
    }

    // Send to Telegram
    await sendTelegram(fullMessage);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ ok: true, sent: true, message: fullMessage }),
    };
  } catch (err) {
    console.error("Daily insight failed:", err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ ok: false, error: err.message }),
    };
  }
};

/**
 * Build the daily briefing message
 */
function buildBriefing(dateStr, todayRows, prevRows, wowRows, headers) {
  const colIndex = (name) => headers.indexOf(name);

  // Sum totals for today
  const totalSpend = sumCol(todayRows, colIndex("Spend"));
  const totalClicks = sumCol(todayRows, colIndex("Clicks"));
  const totalImpressions = sumCol(todayRows, colIndex("Impressions"));
  const totalConversions = sumCol(todayRows, colIndex("Conversions"));
  const avgCPL = totalConversions > 0 ? totalSpend / totalConversions : 0;

  // WoW comparison
  const wowSpend = sumCol(wowRows, colIndex("Spend"));
  const wowConversions = sumCol(wowRows, colIndex("Conversions"));

  const spendChange = wowSpend > 0 ? ((totalSpend - wowSpend) / wowSpend * 100).toFixed(0) : "N/A";
  const convChange = wowConversions > 0 ? ((totalConversions - wowConversions) / wowConversions * 100).toFixed(0) : "N/A";

  let msg = `📊 *Income Insurance — Daily Briefing*\n`;
  msg += `📅 ${dateStr}\n\n`;

  // Totals
  msg += `💰 Total Spend: $${totalSpend.toFixed(2)}`;
  if (spendChange !== "N/A") msg += ` (${spendChange > 0 ? "+" : ""}${spendChange}% WoW)`;
  msg += `\n`;

  msg += `👆 Clicks: ${totalClicks} | Impressions: ${totalImpressions.toLocaleString()}\n`;
  msg += `🎯 Conversions: ${totalConversions}`;
  if (convChange !== "N/A") msg += ` (${convChange > 0 ? "+" : ""}${convChange}% WoW)`;
  msg += `\n`;

  msg += `📉 Avg CPL: $${avgCPL.toFixed(2)}\n\n`;

  // Per-ad breakdown with traffic lights
  msg += `*Ad Breakdown:*\n`;
  const sorted = [...todayRows].sort(
    (a, b) => parseFloat(b[colIndex("Spend")] || 0) - parseFloat(a[colIndex("Spend")] || 0)
  );

  for (const row of sorted) {
    const adName = row[colIndex("Ad Name")] || "Unknown";
    const spend = parseFloat(row[colIndex("Spend")] || 0);
    const conv = parseInt(row[colIndex("Conversions")] || 0);
    const cpl = conv > 0 ? spend / conv : 0;

    // Traffic light based on CPL relative to average
    let light = "⚪";
    if (conv > 0) {
      if (cpl <= avgCPL * 0.8) light = "🟢";
      else if (cpl <= avgCPL * 1.2) light = "🟡";
      else light = "🔴";
    }

    // Truncate long ad names
    const shortName = adName.length > 35 ? adName.substring(0, 35) + "…" : adName;
    msg += `${light} ${shortName}\n    $${spend.toFixed(2)} spent | ${conv} leads`;
    if (conv > 0) msg += ` | $${cpl.toFixed(2)} CPL`;
    msg += `\n`;
  }

  return msg;
}

/**
 * Generate Claude-powered insight
 */
async function generateInsight(dateStr, todayRows, prevRows, wowRows, headers) {
  try {
    const prompt = `You are a performance marketing analyst for an insurance agency running Meta Ads for "Care Secure Pro" (Income Insurance).

Here is yesterday's (${dateStr}) ad-level performance data:
Columns: ${headers.join(", ")}
Data:
${todayRows.map((r) => r.join(", ")).join("\n")}

${prevRows.length > 0 ? `Day before:\n${prevRows.map((r) => r.join(", ")).join("\n")}` : "No day-before data."}

${wowRows.length > 0 ? `Same day last week:\n${wowRows.map((r) => r.join(", ")).join("\n")}` : "No week-ago data."}

Give a 2-3 sentence insight. Be specific about which ads are performing well or poorly. Mention CPL trends. If any ad should be paused or scaled, say so. Keep it practical and direct. No fluff.`;

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
        messages: [{ role: "user", content: prompt }],
      }),
    });

    const json = await res.json();
    if (json.content && json.content[0]) {
      return json.content[0].text;
    }
    return "";
  } catch (err) {
    console.error("Claude insight error:", err.message);
    return "";
  }
}

/**
 * Send message to Telegram
 */
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
  if (!json.ok) {
    throw new Error(`Telegram error: ${json.description}`);
  }
  return json;
}

function sumCol(rows, index) {
  return rows.reduce((sum, r) => sum + parseFloat(r[index] || 0), 0);
}

function formatDate(d) {
  return d.toISOString().split("T")[0];
}
