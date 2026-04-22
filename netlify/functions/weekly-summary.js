const fetch = require("node-fetch");
const { getSheets, readTab } = require("./sheets-writer");
const CONFIG = require("./config");

/**
 * Weekly Monday summary — structured format
 * Week X Month, MTD stats, Disability/Retirement split, top ads, next steps
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

    // Date calculations
    const today = new Date();
    const weekAgo = new Date(today);
    weekAgo.setDate(weekAgo.getDate() - 7);
    const twoWeeksAgo = new Date(today);
    twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14);

    // MTD
    const mtdStart = new Date(today.getFullYear(), today.getMonth(), 1);

    // Week number in month
    const dayOfMonth = today.getDate();
    const weekNum = Math.ceil(dayOfMonth / 7);
    const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    const monthName = monthNames[today.getMonth()];

    // Filter rows
    const thisWeekRows = dataRows.filter((r) => r[0] >= fmtD(weekAgo) && r[0] < fmtD(today));
    const prevWeekRows = dataRows.filter((r) => r[0] >= fmtD(twoWeeksAgo) && r[0] < fmtD(weekAgo));
    const mtdRows = dataRows.filter((r) => r[0] >= fmtD(mtdStart) && r[0] < fmtD(today));

    if (thisWeekRows.length === 0) {
      return resp(200, headers, { ok: false, message: "No data for past week" });
    }

    // === AGGREGATE ===
    const getLeads = (rows) => {
      return rows.reduce((sum, r) => {
        return sum + (parseInt(r[col("Leads")] || 0)) + (parseInt(r[col("Messaging conversations started")] || 0));
      }, 0);
    };

    const getSpend = (rows) => {
      return rows.reduce((sum, r) => sum + (parseFloat(r[col("Amount spent (SGD)")] || 0)), 0);
    };

    // Filter by category (check ad set name AND campaign name)
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

    // This week
    const weekLeads = getLeads(thisWeekRows);
    const weekSpend = getSpend(thisWeekRows);

    // Prev week
    const prevLeads = getLeads(prevWeekRows);
    const prevSpend = getSpend(prevWeekRows);

    // WoW
    const wowLeads = prevLeads > 0 ? ((weekLeads - prevLeads) / prevLeads * 100).toFixed(0) : "N/A";
    const wowSpend = prevSpend > 0 ? ((weekSpend - prevSpend) / prevSpend * 100).toFixed(0) : "N/A";

    // MTD
    const mtdSpend = getSpend(mtdRows);
    const mtdLeads = getLeads(mtdRows);
    const mtdCPL = mtdLeads > 0 ? mtdSpend / mtdLeads : 0;

    // Disability / Retirement split (MTD)
    const mtdDisabilityRows = mtdRows.filter(isDisability);
    const mtdRetirementRows = mtdRows.filter(isRetirement);
    const mtdDisabilityLeads = getLeads(mtdDisabilityRows);
    const mtdRetirementLeads = getLeads(mtdRetirementRows);

    // === TOP PERFORMING ADS (MTD) ===
    const adStats = {};
    for (const r of mtdRows) {
      const name = r[col("Ad name")] || "Unknown";
      if (!adStats[name]) adStats[name] = { spend: 0, leads: 0 };
      adStats[name].spend += parseFloat(r[col("Amount spent (SGD)")] || 0);
      adStats[name].leads += (parseInt(r[col("Leads")] || 0)) + (parseInt(r[col("Messaging conversations started")] || 0));
    }

    // Sort by leads desc, then CPL asc
    const topAds = Object.entries(adStats)
      .filter(([, d]) => d.leads > 0)
      .sort((a, b) => {
        if (b[1].leads !== a[1].leads) return b[1].leads - a[1].leads;
        const cplA = a[1].spend / a[1].leads;
        const cplB = b[1].spend / b[1].leads;
        return cplA - cplB;
      })
      .slice(0, 3);

    // === BUILD MESSAGE ===
    let msg = `Weekly Performance Summary (Week ${weekNum}, ${monthName})\n\n`;

    msg += `Total MTD Spend: $${mtdSpend.toFixed(2)}\n`;
    msg += `Total Leads: ${mtdLeads}\n`;
    msg += `Total Disability Leads: ${mtdDisabilityLeads}\n`;
    msg += `Total Retirement Leads: ${mtdRetirementLeads}\n`;
    msg += `Cost Per Lead: $${mtdCPL.toFixed(2)}\n\n`;

    if (wowLeads !== "N/A") {
      msg += `WoW Leads: ${wowLeads > 0 ? "+" : ""}${wowLeads}%\n`;
    }
    if (wowSpend !== "N/A") {
      msg += `WoW Spend: ${wowSpend > 0 ? "+" : ""}${wowSpend}%\n`;
    }

    msg += `\nMTD Top Performing Ads:\n`;

    // Build top ads data for Claude
    const topAdsData = [];
    for (const [name, data] of topAds) {
      const cpl = data.leads > 0 ? data.spend / data.leads : 0;
      const shortName = name.length > 45 ? name.substring(0, 45) + "…" : name;
      msg += `\n${shortName}\n`;
      msg += `• Spend: $${data.spend.toFixed(2)}\n`;
      msg += `• Leads: ${data.leads}\n`;
      msg += `• CPL: $${cpl.toFixed(2)}\n`;
      topAdsData.push({ name, spend: data.spend, leads: data.leads, cpl });
    }

    // Generate Claude insight for top ads + next steps
    let insight = "";
    if (CONFIG.anthropic.apiKey) {
      insight = await generateInsight(topAdsData, adStats, mtdSpend, mtdLeads, mtdCPL, weekLeads, prevLeads, mtdDisabilityLeads, mtdRetirementLeads);
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

async function generateInsight(topAds, allAds, totalSpend, totalLeads, avgCPL, weekLeads, prevLeads, disabilityLeads, retirementLeads) {
  try {
    const underperformers = Object.entries(allAds)
      .filter(([, d]) => d.spend > 5 && (d.leads === 0 || (d.leads > 0 && d.spend / d.leads > avgCPL * 1.5)))
      .map(([name, d]) => `${name}: $${d.spend.toFixed(2)} spend, ${d.leads} leads, $${d.leads > 0 ? (d.spend / d.leads).toFixed(2) : '∞'} CPL`);

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": CONFIG.anthropic.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 500,
        system: `You are a sharp performance marketing strategist writing a weekly Telegram briefing about Meta Ads for an insurance agency. Currency is SGD.

You need to provide two things:

1. For each top performing ad, write ONE sentence explaining why you think it's performing well (based on the ad name, spend efficiency, lead volume). Be specific and strategic.

2. Write a "Next Steps" section with 3 bullet points:
   - First bullet: Always remind them to call all leads that came through ASAP to reduce friction
   - Second bullet: An optimisation suggestion based on the data (budget shifts, pausing underperformers, scaling winners)
   - Third bullet: A creative suggestion (new angles to test, duplicate winning creatives with variations)

Tone: professional, confident, strategic. No fluff. Use bullet points with • for the Next Steps section only.`,
        messages: [{
          role: "user",
          content: `MTD Performance:
Total Spend: $${totalSpend.toFixed(2)}
Total Leads: ${totalLeads} (Disability: ${disabilityLeads}, Retirement: ${retirementLeads})
Avg CPL: $${avgCPL.toFixed(2)}
This week leads: ${weekLeads}, Last week: ${prevLeads}

Top performing ads:
${topAds.map(a => `${a.name}: $${a.spend.toFixed(2)} spend, ${a.leads} leads, $${a.cpl.toFixed(2)} CPL`).join("\n")}

${underperformers.length > 0 ? `Underperforming ads:\n${underperformers.join("\n")}` : "No clear underperformers."}

Write:
1. One sentence per top ad explaining why it's performing well (prefix each with "• ")
2. A "Next Steps:" section with 3 bullets`,
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

function fmtD(d) {
  return d.toISOString().split("T")[0];
}
