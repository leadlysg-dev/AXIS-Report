const { fetchMetaAds } = require("./fetchers");
const {
  getSheets,
  ensureTab,
  writeRows,
  deleteRowsByDate,
} = require("./sheets-writer");
const CONFIG = require("./config");

/**
 * Daily pull — fetches Meta ad-level data and writes to Google Sheet
 *
 * Triggered by:
 *   - Netlify cron (7am SGT / 11pm UTC)
 *   - Manual call: GET /api/daily-pull?date=2026-04-06
 *   - Backfill: GET /api/daily-pull?start=2026-01-01&end=2026-04-06
 */
exports.handler = async (event) => {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  };

  try {
    const params = event.queryStringParameters || {};
    const tabName = CONFIG.sheets.tabName;

    // Determine date(s) to pull
    let dates = [];

    if (params.start && params.end) {
      // Backfill mode — loop from start to end
      const start = new Date(params.start);
      const end = new Date(params.end);
      for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        dates.push(formatDate(d));
      }
    } else if (params.date) {
      // Single date mode
      dates = [params.date];
    } else {
      // Auto mode — pull yesterday (Singapore time)
      const now = new Date();
      const sgOffset = 8 * 60 * 60 * 1000;
      const sgNow = new Date(now.getTime() + sgOffset);
      const yesterday = new Date(sgNow);
      yesterday.setDate(yesterday.getDate() - 1);
      dates = [formatDate(yesterday)];
    }

    const sheets = await getSheets();
    await ensureTab(sheets, tabName);

    const results = { pulled: 0, errors: [], dates: dates.length };

    for (const dateStr of dates) {
      try {
        // Delete existing rows for this date (avoid duplicates)
        await deleteRowsByDate(sheets, tabName, dateStr);

        // Fetch from Meta
        const rows = await fetchMetaAds(dateStr);

        if (rows.length > 0) {
          await writeRows(sheets, tabName, rows);
          results.pulled += rows.length;
        }

        console.log(`${dateStr}: ${rows.length} ads pulled`);

        // Rate limiting — small delay between dates for backfill
        if (dates.length > 1) {
          await new Promise((r) => setTimeout(r, 1000));
        }
      } catch (err) {
        results.errors.push(`${dateStr}: ${err.message}`);
        console.error(`Error pulling ${dateStr}:`, err.message);
      }
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        ok: true,
        message: `Pulled ${results.pulled} ad rows across ${dates.length} date(s)`,
        results,
      }),
    };
  } catch (err) {
    console.error("Daily pull failed:", err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ ok: false, error: err.message }),
    };
  }
};

function formatDate(d) {
  return d.toISOString().split("T")[0];
}
