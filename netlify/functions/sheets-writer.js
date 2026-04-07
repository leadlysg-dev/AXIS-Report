const { google } = require("googleapis");
const CONFIG = require("./config");

/**
 * Get authenticated Google Sheets client
 */
async function getSheets() {
  const raw = Buffer.from(CONFIG.sheets.saPrivateKey, "base64").toString("utf8");
  // Handle both raw PEM and JSON key file formats
  let privateKey;
  try {
    const json = JSON.parse(raw);
    privateKey = json.private_key;
  } catch {
    privateKey = raw;
  }

  const auth = new google.auth.JWT(
    CONFIG.sheets.saEmail,
    null,
    privateKey,
    ["https://www.googleapis.com/auth/spreadsheets"]
  );
  await auth.authorize();
  return google.sheets({ version: "v4", auth });
}

/**
 * Ensure the tab exists, create it with headers if not
 */
async function ensureTab(sheets, tabName) {
  const spreadsheetId = CONFIG.sheets.sheetId;
  try {
    const meta = await sheets.spreadsheets.get({ spreadsheetId });
    const exists = meta.data.sheets.some(
      (s) => s.properties.title === tabName
    );
    if (!exists) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [{ addSheet: { properties: { title: tabName } } }],
        },
      });
      // Write header row
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `'${tabName}'!A1`,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [CONFIG.columns] },
      });
    }
  } catch (err) {
    console.error(`Error ensuring tab ${tabName}:`, err.message);
    throw err;
  }
}

/**
 * Write rows to the sheet (append)
 */
async function writeRows(sheets, tabName, rows) {
  const spreadsheetId = CONFIG.sheets.sheetId;
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `'${tabName}'!A1`,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: rows },
  });
}

/**
 * Read all data from a tab
 */
async function readTab(sheets, tabName) {
  const spreadsheetId = CONFIG.sheets.sheetId;
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `'${tabName}'!A1:Z`,
    });
    return res.data.values || [];
  } catch (err) {
    console.error(`Error reading tab ${tabName}:`, err.message);
    return [];
  }
}

/**
 * Delete rows for a specific date (to avoid duplicates on re-pull)
 */
async function deleteRowsByDate(sheets, tabName, dateStr) {
  const spreadsheetId = CONFIG.sheets.sheetId;
  const data = await readTab(sheets, tabName);
  if (data.length <= 1) return; // only header or empty

  // Find the sheet ID (gid)
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const sheetMeta = meta.data.sheets.find(
    (s) => s.properties.title === tabName
  );
  if (!sheetMeta) return;
  const sheetId = sheetMeta.properties.sheetId;

  // Find rows matching the date (column A = index 0)
  const rowsToDelete = [];
  for (let i = data.length - 1; i >= 1; i--) {
    if (data[i][0] === dateStr) {
      rowsToDelete.push(i);
    }
  }

  if (rowsToDelete.length === 0) return;

  // Delete from bottom to top to preserve indices
  const requests = rowsToDelete.map((rowIndex) => ({
    deleteDimension: {
      range: {
        sheetId,
        dimension: "ROWS",
        startIndex: rowIndex,
        endIndex: rowIndex + 1,
      },
    },
  }));

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests },
  });
}

module.exports = { getSheets, ensureTab, writeRows, readTab, deleteRowsByDate };
