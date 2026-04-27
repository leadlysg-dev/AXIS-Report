// ============================================================
// INCOME INSURANCE PIPELINE CONFIG
// ============================================================
// Env vars needed in Netlify:
//   META_ACCESS_TOKEN        — System User token from Meta
//   META_AD_ACCOUNT_ID       — act_2197251224432519
//   GOOGLE_SHEET_ID          — 1f_utIL-R3apr3AMNO38e9BB-_pSnFcY8ye8aC3BJWzg
//   GOOGLE_SA_PRIVATE_KEY    — base64-encoded service account private key
//   GOOGLE_SA_EMAIL          — legacy-dash@legacy-dash.iam.gserviceaccount.com
//   TELEGRAM_BOT_TOKEN       — @Leadly_sg_bot token
//   TELEGRAM_CHAT_ID         — -5159459410
//   ANTHROPIC_API_KEY        — for Claude insights
//   GHL_API_KEY              — GHL Private Integration API key
// ============================================================

const CONFIG = {
  client: "Income Insurance",
  product: "Care Secure Pro",

  // Meta Ads
  meta: {
    accessToken: process.env.META_ACCESS_TOKEN,
    adAccountId: process.env.META_AD_ACCOUNT_ID || "act_2197251224432519",
  },

  // GoHighLevel
  ghl: {
    apiKey: process.env.GHL_API_KEY,
    locationId: "X1a2fEQo01OcCmfeCvav",
  },

  // Google Sheets
  sheets: {
    sheetId: process.env.GOOGLE_SHEET_ID || "1f_utIL-R3apr3AMNO38e9BB-_pSnFcY8ye8aC3BJWzg",
    saEmail: process.env.GOOGLE_SA_EMAIL || "legacy-dash@legacy-dash.iam.gserviceaccount.com",
    saPrivateKey: process.env.GOOGLE_SA_PRIVATE_KEY, // base64 encoded
    tabName: "META ADS RAW", // daily API pull writes here
    fbLeadsTab: "FB LEADS",
    igLeadsTab: "IG LEADS",
  },

  // Telegram
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN,
    chatId: process.env.TELEGRAM_CHAT_ID || "-5159459410",
  },

  // Claude (for AI insights)
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY,
  },

  // Sheet columns — matches Meta Ads export format exactly
  columns: [
    "Day",
    "Ad ID",
    "Ad name",
    "Ad set name",
    "Campaign name",
    "Amount spent (SGD)",
    "Impressions",
    "Reach",
    "Frequency",
    "Link clicks",
    "CTR (all)",
    "CPC (cost per link click)",
    "CPM (cost per 1,000 impressions)",
    "Leads",
    "Cost per lead",
    "Messaging conversations started",
    "Cost per messaging conversation started",
  ],
};

module.exports = CONFIG;
