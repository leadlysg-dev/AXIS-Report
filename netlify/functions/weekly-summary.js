const fetch = require("node-fetch");
const { getSheets, readTab } = require("./sheets-writer");
const CONFIG = require("./config");

/**
 * Weekly Monday summary — AARO format
 * Date range, WoW comparison, category split, Claude bullet insights
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

    // Date ranges — this week = last 7 days, prev week = 7 days before that
    const today = new Date();
    const thisWeekEnd = new Date(today);
    thisWeekEnd.setDate(thisWeekEnd.getDate() - 1); // yesterday
    const thisWeekStart = new Date(thisWeekEnd);
    thisWeekStart.setDate(thisWeekStart.getDate() - 6);

    const prevWeekEnd = new Date(thisWeekStart);
    prevWeekEnd.setDate(prevWeekEnd.getDate() - 1);
    const prevWeekStart = new Date(prevWeekEnd);
    prevWeekStart.setDate(prevWeekStart.getDate() - 6);

    // Filter rows
    const thisWeekRows = dataRows.filter((r) => r[0] >= fmtD(thisWeekStart) && r[0] <= fmtD(thisWeekEnd));
    const prevWeekRows = dataRows.filter((r) => r[0] >= fmtD(prevWeekStart) && r[0] <= fmtD(prevWeekEnd));

    if (thisWeekRows.length === 0) {
      return resp(200, headers, { ok: false, message: "No data for past week" });
    }

    // === HELPERS ===
    const getLeads = (rows) => rows.reduce((s, r) => s + (parseInt(r[col("Leads")] || 0)) + (parseInt(r[col("Messaging conversations started")] || 0)), 0);
    const getSpend = (rows) => rows.reduce((s, r) => s + (parseFloat(r[col("Amount spent (SGD)")] || 0)), 0);

    const isDisability = (r) => {
      const adset = (r[col("Ad set name")] || "").toLowerCase();
      const campaign = (r[col("Campaign name")] || "").toLowerCase();
      return adset.includes("disability") || campaign.includes("disability");
    };

    const isRetirement = (r) => {
      const adset = (r[col("Ad set name")] || "").toLowerCase();
      const campaign = (r[col("Campaign name")] || "").toLowerCase();
      return adset.includes("retirement") || campaign.includes("retirement");
    };

    // === THIS WEEK TOTALS ===
    const twLeads = getLeads(thisWeekRows);
    const twSpend = getSpend(thisWeekRows);
    const twCPL = twLeads > 0 ? twSpend / twLeads : 0;

    // === PREV WEEK TOTALS ===
    const pwLeads = getLeads(prevWeekRows);
    const pwSpend = getSpend(prevWeekRows);
    const pwCPL = pwLeads > 0 ? pwSpend / pwLeads : 0;

    // === CATEGORY SPLIT ===
    const twDisRows = thisWeekRows.filter(isDisability);
    const twRetRows = thisWeekRows.filter(isRetirement);
    const pwDisRows = prevWeekRows.filter(isDisability);
    const pwRetRows = prevWeekRows.filter(isRetirement);

    const twDisLeads = getLeads(twDisRows);
    const twDisSpend = getSpend(twDisRows);
    const twDisCPL = twDisLeads > 0 ? twDisSpend / twDisLeads : 0;

    const twRetLeads = getLeads(twRetRows);
    const twRetSpend = getSpend(twRetRows);
    const twRetCPL = twRetLeads > 0 ? twRetSpend / twRetLeads : 0;

    const pwDisLeads = getLeads(pwDisRows);
    const pwDisSpend = getSpend(pwDisRows);
    const pwDisCPL = pwDisLeads > 0 ? pwDisSpend / pwDisLeads : 0;

    const pwRetLeads = getLeads(pwRetRows);
    const pwRetSpend = getSpend(pwRetRows);
    const pwRetCPL = pwRetLeads > 0 ? pwRetSpend / pwRetLeads : 0;

    // Date formatting
    const fmtDisplay = (d) => {
      const day = d.getDate();
      const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
      return `${day} ${months[d.getMonth()]} ${d.getFullYear()}`;
    };

    // Traffic light for category
    const catLight = (twCpl, pwCpl, twL) => {
      if (twL === 0) return "🔴";
      if (pwCpl === 0) return "🟢"; // no prev data, has leads = green
      if (twCpl <= pwCpl) return "🟢"; // improved or same
      if (twCpl > pwCpl * 1.15) return "🔴"; // >15% worse
      return "🟡"; // slightly worse
    };

    // === BUILD MESSAGE ===
    let msg = `📊 Weekly Report\n`;
    msg += `This week: ${fmtDisplay(thisWeekStart)} – ${fmtDisplay(thisWeekEnd)}\n`;
    msg += `Previous week: ${fmtDisplay(prevWeekStart)} – ${fmtDisplay(prevWeekEnd)}\n\n`;

    // Totals
    msg += `This week: ${twLeads} leads · SGD ${fmtN(twSpend)} · SGD ${fmtN(twCPL)}/lead\n`;
    msg += `Prev week: ${pwLeads} leads · SGD ${fmtN(pwSpend)} · SGD ${fmtN(pwCPL)}/lead\n\n`;

    // Category breakdown
    const disLight = catLight(twDisCPL, pwDisCPL, twDisLeads);
    const retLight = catLight(twRetCPL, pwRetCPL, twRetLeads);

    msg += `${disLight} Disability — ${twDisLeads} leads · SGD ${fmtN(twDisSpend)} · SGD ${fmtN(twDisCPL)}/lead`;
    if (pwDisLeads > 0) msg += ` (prev: ${pwDisLeads} leads · SGD ${fmtN(pwDisCPL)}/lead)`;
    msg += `\n`;

    msg += `${retLight} Retirement — ${twRetLeads} leads · SGD ${fmtN(twRetSpend)} · SGD ${fmtN(twRetCPL)}/lead`;
    if (pwRetLeads > 0) msg += ` (prev: ${pwRetLeads} leads · SGD ${fmtN(pwRetCPL)}/lead)`;
    msg += `\n`;

    // Generate Claude insights
    let insight = "";
    if (CONFIG.anthropic.apiKey) {
      insight = await generateInsight({
        twLeads, twSpend, twCPL,
        pwLeads, pwSpend, pwCPL,
        twDisLeads, twDisSpend, twDisCPL,
        twRetLeads, twRetSpend, twRetCPL,
        pwDisLeads, pwDisCPL,
        pwRetLeads, pwRetCPL,
        thisWeekRows, prevWeekRows, col,
      });
    }

    if (insight) msg += `\n${insight}`;

    msg += `\n\n— Leadly`;

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

async function generateInsight(data) {
  try {
    const {
      twLeads, twSpend, twCPL,
      pwLeads, pwSpend, pwCPL,
      twDisLeads, twDisSpend, twDisCPL,
      twRetLeads, twRetSpend, twRetCPL,
      pwDisLeads, pwDisCPL,
      pwRetLeads, pwRetCPL,
      thisWeekRows, prevWeekRows, col,
    } = data;

    // Build per-ad stats for this week
    const adStats = {};
    for (const r of thisWeekRows) {
      const name = r[col("Ad name")] || "Unknown";
      if (!adStats[name]) adStats[name] = { spend: 0, leads: 0 };
      adStats[name].spend += parseFloat(r[col("Amount spent (SGD)")] || 0);
      adStats[name].leads += (parseInt(r[col("Leads")] || 0)) + (parseInt(r[col("Messaging conversations started")] || 0));
    }

    const adSummary = Object.entries(adStats)
      .sort((a, b) => b[1].leads - a[1].leads)
      .slice(0, 5)
      .map(([n, d]) => `${n}: $${d.spend.toFixed(2)} spend, ${d.leads} leads, $${d.leads > 0 ? (d.spend / d.leads).toFixed(2) : '∞'} CPL`)
      .join("\n");

    const leadsPctChange = pwLeads > 0 ? ((twLeads - pwLeads) / pwLeads * 100).toFixed(0) : "N/A";
    const cplPctChange = pwCPL > 0 ? ((twCPL - pwCPL) / pwCPL * 100).toFixed(0) : "N/A";

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
        system: `You are a sharp performance marketing strategist writing weekly insights for a Telegram briefing about Meta Ads. Currency is SGD.

Write exactly 3-4 bullet points. Each bullet starts with either 📈 (positive trend) or ⚠️ (concern/watch item).

Rules:
- Be specific with numbers and percentages
- Reference the Disability and Retirement categories by name
- Mention specific ads if they drove the results
- Last bullet should be a forward-looking recommendation
- No greetings, no sign-off, no headers
- Each bullet is one sentence, max two
- Professional and strategic tone`,
        messages: [{
          role: "user",
          content: `This week: ${twLeads} leads, SGD ${twSpend.toFixed(2)} spend, SGD ${twCPL.toFixed(2)} CPL
Prev week: ${pwLeads} leads, SGD ${pwSpend.toFixed(2)} spend, SGD ${pwCPL.toFixed(2)} CPL
WoW leads change: ${leadsPctChange}%, WoW CPL change: ${cplPctChange}%

Disability: ${twDisLeads} leads, SGD ${twDisCPL.toFixed(2)} CPL (prev: ${pwDisLeads} leads, SGD ${pwDisCPL.toFixed(2)} CPL)
Retirement: ${twRetLeads} leads, SGD ${twRetCPL.toFixed(2)} CPL (prev: ${pwRetLeads} leads, SGD ${pwRetCPL.toFixed(2)} CPL)

Top ads this week:
${adSummary}

Write the insight bullets.`,
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

function resp(code, h, body) {
  return { statusCode: code, headers: h, body: JSON.stringify(body) };
}

function fmtD(d) {
  return d.toISOString().split("T")[0];
}

function fmtN(n) {
  return n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
