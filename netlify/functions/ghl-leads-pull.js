const fetch = require("node-fetch");
const { getSheets, ensureTab, writeRows, readTab } = require("./sheets-writer");
const CONFIG = require("./config");

const LEAD_COLUMNS = ["Date", "Name", "Phone", "Email", "Source", "Contact Type", "Tags"];

/**
 * Pull leads from GHL and write to FB LEADS / IG LEADS tabs
 *
 * Triggered by:
 *   - Manual: GET /api/ghl-leads-pull
 *   - Manual with date range: GET /api/ghl-leads-pull?start=2026-04-01&end=2026-04-22
 *   - Will also be called by weekly-summary before generating report
 */
exports.handler = async (event) => {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  };

  try {
    const params = event.queryStringParameters || {};

    // Default: last 7 days
    const now = new Date();
    const sgOffset = 8 * 60 * 60 * 1000;
    const sgNow = new Date(now.getTime() + sgOffset);

    const endDate = params.end ? new Date(params.end) : new Date(sgNow);
    const startDate = params.start ? new Date(params.start) : new Date(sgNow);
    if (!params.start) startDate.setDate(startDate.getDate() - 7);

    // Reset times
    startDate.setUTCHours(0, 0, 0, 0);
    endDate.setUTCHours(23, 59, 59, 999);

    // Fetch contacts from GHL
    const contacts = await fetchGHLContacts(startDate, endDate);

    // Split by source
    const fbLeads = contacts.filter((c) => {
      const src = (c.source || "").toLowerCase();
      return src.includes("facebook") || src === "fb";
    });

    const igLeads = contacts.filter((c) => {
      const src = (c.source || "").toLowerCase();
      return src.includes("instagram") || src === "ig";
    });

    // Write to sheets
    const sheets = await getSheets();

    // FB LEADS tab
    await ensureTabWithColumns(sheets, CONFIG.sheets.fbLeadsTab, LEAD_COLUMNS);
    if (fbLeads.length > 0) {
      // Remove existing entries for this date range to avoid duplicates
      await removeExistingRange(sheets, CONFIG.sheets.fbLeadsTab, fmtD(startDate), fmtD(endDate));
      const fbRows = fbLeads.map(contactToRow);
      await writeRows(sheets, CONFIG.sheets.fbLeadsTab, fbRows);
    }

    // IG LEADS tab
    await ensureTabWithColumns(sheets, CONFIG.sheets.igLeadsTab, LEAD_COLUMNS);
    if (igLeads.length > 0) {
      await removeExistingRange(sheets, CONFIG.sheets.igLeadsTab, fmtD(startDate), fmtD(endDate));
      const igRows = igLeads.map(contactToRow);
      await writeRows(sheets, CONFIG.sheets.igLeadsTab, igRows);
    }

    // Other sources (for debugging)
    const otherLeads = contacts.filter((c) => {
      const src = (c.source || "").toLowerCase();
      return !src.includes("facebook") && !src.includes("instagram") && src !== "fb" && src !== "ig";
    });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        ok: true,
        range: `${fmtD(startDate)} → ${fmtD(endDate)}`,
        total: contacts.length,
        facebook: fbLeads.length,
        instagram: igLeads.length,
        other: otherLeads.length,
        otherSources: [...new Set(otherLeads.map((c) => c.source || "unknown"))],
      }),
    };
  } catch (err) {
    console.error("GHL leads pull failed:", err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ ok: false, error: err.message }),
    };
  }
};

/**
 * Fetch contacts from GHL API v2
 * Uses search endpoint with date filter
 */
async function fetchGHLContacts(startDate, endDate) {
  const apiKey = CONFIG.ghl.apiKey;
  const locationId = CONFIG.ghl.locationId;

  if (!apiKey) throw new Error("Missing GHL_API_KEY");

  let allContacts = [];
  let nextPageUrl = null;
  let page = 1;
  const limit = 100;

  do {
    const url = nextPageUrl || `https://services.leadconnectorhq.com/contacts/?locationId=${locationId}&limit=${limit}&startAfter=0&startAfterId=`;

    const searchUrl = `https://services.leadconnectorhq.com/contacts/search`;

    const body = {
      locationId,
      pageSize: limit,
      page,
      filters: [
        {
          field: "dateAdded",
          operator: "gte",
          value: startDate.toISOString(),
        },
        {
          field: "dateAdded",
          operator: "lte",
          value: endDate.toISOString(),
        },
      ],
    };

    const res = await fetch(searchUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Version: "2021-07-28",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`GHL API error (${res.status}): ${text}`);
    }

    const json = await res.json();
    const contacts = json.contacts || [];

    for (const c of contacts) {
      allContacts.push({
        dateAdded: c.dateAdded || c.createdAt || "",
        firstName: c.firstName || "",
        lastName: c.lastName || "",
        phone: c.phone || "",
        email: c.email || "",
        source: c.source || c.attributionSource?.medium || "",
        contactType: c.type || "",
        tags: (c.tags || []).join(", "),
      });
    }

    // Pagination
    const total = json.total || 0;
    if (allContacts.length >= total || contacts.length < limit) {
      break;
    }
    page++;

    // Rate limit
    await new Promise((r) => setTimeout(r, 500));
  } while (true);

  return allContacts;
}

/**
 * Convert GHL contact object to sheet row
 */
function contactToRow(c) {
  const date = c.dateAdded ? c.dateAdded.split("T")[0] : "";
  const name = [c.firstName, c.lastName].filter(Boolean).join(" ");
  return [date, name, c.phone, c.email, c.source, c.contactType, c.tags];
}

/**
 * Ensure tab exists with specific columns
 */
async function ensureTabWithColumns(sheets, tabName, columns) {
  const spreadsheetId = CONFIG.sheets.sheetId;
  try {
    const meta = await sheets.spreadsheets.get({ spreadsheetId });
    const exists = meta.data.sheets.some((s) => s.properties.title === tabName);
    if (!exists) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [{ addSheet: { properties: { title: tabName } } }],
        },
      });
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `'${tabName}'!A1`,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [columns] },
      });
    }
  } catch (err) {
    console.error(`Error ensuring tab ${tabName}:`, err.message);
  }
}

/**
 * Remove rows within a date range to avoid duplicates
 */
async function removeExistingRange(sheets, tabName, startStr, endStr) {
  const spreadsheetId = CONFIG.sheets.sheetId;
  try {
    const data = await readTab(sheets, tabName);
    if (data.length <= 1) return;

    const meta = await sheets.spreadsheets.get({ spreadsheetId });
    const sheetMeta = meta.data.sheets.find((s) => s.properties.title === tabName);
    if (!sheetMeta) return;
    const sheetId = sheetMeta.properties.sheetId;

    const rowsToDelete = [];
    for (let i = data.length - 1; i >= 1; i--) {
      const rowDate = data[i][0] || "";
      if (rowDate >= startStr && rowDate <= endStr) {
        rowsToDelete.push(i);
      }
    }

    if (rowsToDelete.length === 0) return;

    const requests = rowsToDelete.map((idx) => ({
      deleteDimension: {
        range: { sheetId, dimension: "ROWS", startIndex: idx, endIndex: idx + 1 },
      },
    }));

    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests },
    });
  } catch (err) {
    console.error(`Error removing existing range in ${tabName}:`, err.message);
  }
}

function fmtD(d) {
  return d.toISOString().split("T")[0];
}
