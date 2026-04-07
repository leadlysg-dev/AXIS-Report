const fetch = require("node-fetch");
const { getSheets, readTab } = require("./sheets-writer");
const CONFIG = require("./config");

/**
 * Daily Telegram briefing — clean plain text, emoji traffic lights, Claude insight
 * Matches the AARO briefing format exactly
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
    const col = (name) => headerRow.indexOf(name);

    // Get yesterday
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = formatDate(yesterday);

    // Get this week so far (Mon–yesterday)
    const dayOfWeek = yesterday.getDay(); // 0=Sun
    const mondayOffset = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    const monday = new Date(yesterday);
    monday.setDate(monday.getDate() - mondayOffset);
    const mondayStr = formatDate(monday);

    // Get last week (previous Mon–Sun)
    const lastMonday = new Date(monday);
    lastMonday.setDate(lastMonday.getDate() - 7);
    const lastSunday = new Date(monday);
    lastSunday.setDate(lastSunday.getDate() - 1);

    // Filter rows
    const yesterdayRows = dataRows.filter((r) => r[0] === yesterdayStr);
    const thisWeekRows = dataRows.filter((r) => r[0] >= mondayStr && r[0] <= yesterdayStr);
    const lastWeekRows = dataRows.filter((r) => r[0] >= formatDate(lastMonday) && r[0] <= formatDate(lastSunday));

    if (yesterdayRows.length === 0) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ ok: false, message: `No data for ${yesterdayStr}` }),
      };
    }

    // Yesterday totals
    const totalSpend = sumCol(yesterdayRows, col("Amount spent (SGD)"));
    const totalLeads = sumCol(yesterdayRows, col("Leads"));
    const totalMsg = sumCol(yesterdayRows, col("Messaging conversations started"));
    const totalConv = totalLeads + totalMsg;
    const cpl = totalConv > 0 ? totalSpend / totalConv : 0;

    // This week totals
    const weekConv = sumCol(thisWeekRows, col("Leads")) + sumCol(thisWeekRows, col("Messaging conversations started"));

    // Last week totals
    const lastWeekConv = sumCol(lastWeekRows, col("Leads")) + sumCol(lastWeekRows, col("Messaging conversations started"));
    const weekChange = lastWeekConv > 0 ? ((weekConv - lastWeekConv) / lastWeekConv * 100).toFixed(0) : "N/A";

    // Build per-ad breakdown
    const adStats = {};
    for (const row of yesterdayRows) {
      const name = row[col("Ad name")] || "Unknown";
      if (!adStats[name]) adStats[name] = { spend: 0, leads: 0, msg: 0 };
      adStats[name].spend += parseFloat(row[col("Amount spent (SGD)")] || 0);
      adStats[name].leads += parseInt(row[col("Leads")] || 0);
      adStats[name].msg += parseInt(row[col("Messaging conversations started")] || 0);
    }

    // Sort by spend descending
    const sortedAds = Object.entries(adStats).sort((a, b) => b[1].spend - a[1].spend);

    // Build the message — plain text, no Markdown
    let msg = `Income Insurance — Daily Briefing\n`;
    msg += `${yesterdayStr}\n\n`;

    msg += `Yesterday's leads: ${totalConv}\n`;
    msg += `Ad spend: $${totalSpend.toFixed(2)} | Cost per lead: $${cpl.toFixed(2)}\n\n`;

    // Per-ad with traffic lights
    for (const [name, data] of sortedAds) {
      const conv = data.leads + data.msg;
      const adCPL = conv > 0 ? data.spend / conv : 0;

      let light;
      if (data.spend === 0) light = "⚪"; // paused
      else if (conv === 0) light = "🔴"; // spend but no leads
      else if (conv === 1) light = "🟡"; // low volume
      else light = "🟢"; // performing

      const shortName = name.length > 40 ? name.substring(0, 40) + "…" : name;
      if (data.spend === 0) {
        msg += `${light} ${shortName} — paused\n`;
      } else if (conv === 0) {
        msg += `${light} ${shortName} — $${data.spend.toFixed(2)} spent, 0 leads\n`;
      } else {
        msg += `${light} ${shortName} — ${conv} lead${conv > 1 ? "s" : ""}, $${adCPL.toFixed(2)} CPL\n`;
      }
    }

    msg += `\nThis week so far: ${weekConv} leads\n`;
    if (weekChange !== "N/A") {
      const sign = weekChange > 0 ? "+" : "";
      msg += `Last week: ${lastWeekConv} (${sign}${weekChange}%)\n`;
    }

    // Generate Claude insight
    let insight = "";
    if (CONFIG.anthropic.apiKey) {
      insight = await generateInsight(yesterdayStr, yesterdayRows, thisWeekRows, lastWeekRows, headerRow);
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
    console.error("Daily insight failed:", err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ ok: false, error: err.message }),
    };
  }
};

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
        max_tokens: 250,
        system: `You are a performance marketing analyst for an insurance agency (Income Insurance) running Meta Ads for "Care Secure Pro".

Write a 2-3 sentence insight about yesterday's ad performance. Be specific about which ads are doing well or poorly. Mention CPL trends if relevant. Keep it conversational — like a message from a colleague. No bullet points, no headers, no markdown, no action items. Just observations and context.`,
        messages: [{
          role: "user",
          content: `Yesterday (${dateStr}) ad data:
Columns: ${headers.join(", ")}
${todayRows.map((r) => r.join(", ")).join("\n")}

This week so far:
${weekRows.map((r) => r.join(", ")).join("\n")}

${lastWeekRows.length > 0 ? `Last week:\n${lastWeekRows.map((r) => r.join(", ")).join("\n")}` : "No last week data."}

Write the insight.`,
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
    body: JSON.stringify({
      chat_id: CONFIG.telegram.chatId,
      text: text,
    }),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`Telegram error: ${json.description}`);
  return json;
}

function sumCol(rows, index) {
  if (index < 0) return 0;
  return rows.reduce((sum, r) => sum + (parseFloat(r[index]) || 0), 0);
}

function formatDate(d) {
  return d.toISOString().split("T")[0];
}
