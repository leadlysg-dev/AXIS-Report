const fetch = require("node-fetch");
const { getSheets, readTab } = require("./sheets-writer");
const CONFIG = require("./config");

/**
 * Daily Telegram briefing — matches AARO format
 * Plain text, emoji traffic lights, Claude insight, links at bottom
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
      return resp(200, headers, { ok: false, message: "No data in sheet yet" });
    }

    const headerRow = allData[0];
    const dataRows = allData.slice(1);
    const col = (name) => headerRow.indexOf(name);

    // Yesterday
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = formatDate(yesterday);

    // Day name
    const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const dayName = dayNames[yesterday.getDay()];
    const dateDisplay = `${dayName}, ${yesterday.getDate().toString().padStart(2, "0")} ${monthNames[yesterday.getMonth()]} ${yesterday.getFullYear()}`;

    // This week (Mon–yesterday)
    const dayOfWeek = yesterday.getDay();
    const mondayOffset = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    const monday = new Date(yesterday);
    monday.setDate(monday.getDate() - mondayOffset);

    // Last week (previous Mon–Sun)
    const lastMonday = new Date(monday);
    lastMonday.setDate(lastMonday.getDate() - 7);
    const lastSunday = new Date(monday);
    lastSunday.setDate(lastSunday.getDate() - 1);

    // Filter rows
    const yesterdayRows = dataRows.filter((r) => r[0] === yesterdayStr);
    const thisWeekRows = dataRows.filter((r) => r[0] >= formatDate(monday) && r[0] <= yesterdayStr);
    const lastWeekRows = dataRows.filter((r) => r[0] >= formatDate(lastMonday) && r[0] <= formatDate(lastSunday));

    if (yesterdayRows.length === 0) {
      return resp(200, headers, { ok: false, message: `No data for ${yesterdayStr}` });
    }

    // Yesterday totals
    const totalSpend = sumCol(yesterdayRows, col("Amount spent (SGD)"));
    const totalLeads = sumCol(yesterdayRows, col("Leads"));
    const totalMsg = sumCol(yesterdayRows, col("Messaging conversations started"));
    const totalConv = totalLeads + totalMsg;
    const cpl = totalConv > 0 ? totalSpend / totalConv : 0;

    // Build per-ad stats
    const adStats = buildAdStats(yesterdayRows, col);
    const sortedAds = Object.entries(adStats).sort((a, b) => {
      const convA = a[1].leads + a[1].msg;
      const convB = b[1].leads + b[1].msg;
      if (convB !== convA) return convB - convA; // most conversions first
      return b[1].spend - a[1].spend;
    });

    // === BUILD MESSAGE ===
    let msg = "";

    // Just the date
    msg += `${dateDisplay}\n\n`;

    // Summary line
    msg += `Leads: ${totalConv}\n`;
    msg += `Spend: SGD ${totalSpend.toFixed(2)} | CPL: SGD ${cpl.toFixed(2)}\n\n`;

    // Per-ad breakdown with traffic lights
    for (const [name, data] of sortedAds) {
      const conv = data.leads + data.msg;
      const adCPL = conv > 0 ? data.spend / conv : 0;
      const shortName = name.length > 45 ? name.substring(0, 45) + "…" : name;

      let light;
      if (data.spend === 0) light = "⚪";
      else if (conv === 0) light = "🔴";
      else if (conv >= 2) light = "🟢";
      else light = "🟡";

      if (data.spend === 0) {
        msg += `${light} ${shortName} — paused\n`;
      } else if (conv === 0) {
        msg += `${light} ${shortName} — 0 (SGD ${data.spend.toFixed(2)} spent, no leads)\n`;
      } else {
        msg += `${light} ${shortName} — ${conv} lead${conv > 1 ? "s" : ""} (SGD ${adCPL.toFixed(2)}/lead)\n`;
      }
    }

    // Week comparison
    const weekConv = sumCol(thisWeekRows, col("Leads")) + sumCol(thisWeekRows, col("Messaging conversations started"));
    const lastWeekConv = sumCol(lastWeekRows, col("Leads")) + sumCol(lastWeekRows, col("Messaging conversations started"));

    msg += `\nThis week so far: ${weekConv} leads\n`;
    if (lastWeekConv > 0) {
      const pct = ((weekConv - lastWeekConv) / lastWeekConv * 100).toFixed(0);
      msg += `Last week: ${lastWeekConv} (${pct > 0 ? "+" : ""}${pct}%)\n`;
    }

    // Claude insight
    let insight = "";
    if (CONFIG.anthropic.apiKey) {
      insight = await generateInsight(yesterdayStr, yesterdayRows, thisWeekRows, lastWeekRows, headerRow);
    }
    if (insight) msg += `\n${insight}\n`;

    // Sign off
    msg += `\n— Leadly`;

    if (preview) {
      return resp(200, headers, { ok: true, preview: true, message: msg });
    }

    await sendTelegram(msg);
    return resp(200, headers, { ok: true, sent: true, message: msg });
  } catch (err) {
    console.error("Daily insight failed:", err);
    return resp(500, headers, { ok: false, error: err.message });
  }
};

function buildAdStats(rows, col) {
  const stats = {};
  for (const row of rows) {
    const name = row[col("Ad name")] || "Unknown";
    if (!stats[name]) stats[name] = { spend: 0, leads: 0, msg: 0 };
    stats[name].spend += parseFloat(row[col("Amount spent (SGD)")] || 0);
    stats[name].leads += parseInt(row[col("Leads")] || 0);
    stats[name].msg += parseInt(row[col("Messaging conversations started")] || 0);
  }
  return stats;
}

async function generateInsight(dateStr, todayRows, weekRows, lastWeekRows, headers) {
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
        system: `You are a sharp, concise performance marketing strategist writing a daily Telegram briefing about Meta Ads. Currency is SGD.

Write a 3-4 sentence insight about yesterday's ad performance. Be specific — name the ads, cite the numbers, explain what's driving performance. Compare against previous days or last week where relevant. End with one concrete, actionable next step (e.g. "scale budget by X%", "duplicate this creative with a new angle", "pause this ad").

Tone: professional, confident, to the point. Like a strategist who respects the reader's time. No fluff, no filler, no greetings. Just sharp analysis and a clear recommendation.`,
        messages: [{
          role: "user",
          content: `Yesterday (${dateStr}) ad data:\nColumns: ${headers.join(", ")}\n${todayRows.map((r) => r.join(", ")).join("\n")}\n\nThis week so far:\n${weekRows.map((r) => r.join(", ")).join("\n")}\n\n${lastWeekRows.length > 0 ? `Last week:\n${lastWeekRows.map((r) => r.join(", ")).join("\n")}` : "No last week data."}\n\nWrite the insight.`,
        }],
      }),
    });
    const json = await res.json();
    if (json.content && json.content[0]) return json.content[0].text;
    return "";
  } catch (err) {
    console.error("Claude insight error:", err.message);
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

function sumCol(rows, index) {
  if (index < 0) return 0;
  return rows.reduce((sum, r) => sum + (parseFloat(r[index]) || 0), 0);
}

function formatDate(d) {
  return d.toISOString().split("T")[0];
}
