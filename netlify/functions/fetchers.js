const fetch = require("node-fetch");
const CONFIG = require("./config");

/**
 * Fetch ad-level data from Meta Marketing API for a specific date
 * Returns array of ad objects with metrics
 */
async function fetchMetaAds(dateStr) {
  const { accessToken, adAccountId } = CONFIG.meta;

  if (!accessToken || !adAccountId) {
    throw new Error("Missing META_ACCESS_TOKEN or META_AD_ACCOUNT_ID");
  }

  const fields = [
    "ad_id",
    "ad_name",
    "adset_name",
    "campaign_name",
    "spend",
    "impressions",
    "clicks",
    "ctr",
    "cpc",
    "cpm",
    "reach",
    "frequency",
    "actions",
    "cost_per_action_type",
  ].join(",");

  const url =
    `https://graph.facebook.com/v21.0/${adAccountId}/insights?` +
    `fields=${fields}` +
    `&level=ad` +
    `&time_range={"since":"${dateStr}","until":"${dateStr}"}` +
    `&limit=500` +
    `&access_token=${accessToken}`;

  const res = await fetch(url);
  const json = await res.json();

  if (json.error) {
    throw new Error(`Meta API error: ${json.error.message}`);
  }

  const data = json.data || [];

  // Transform to flat rows matching CONFIG.columns
  return data.map((ad) => {
    // Extract conversions — look for messaging_conversation_started_7d, onsite_conversion.messaging_conversation_started_7d, or lead
    const conversions = extractConversions(ad.actions);
    const costPerConversion = extractCostPerConversion(ad.cost_per_action_type);

    return [
      dateStr,                                          // Date
      ad.ad_id || "",                                   // Ad ID
      ad.ad_name || "",                                 // Ad Name
      ad.adset_name || "",                              // Ad Set Name
      ad.campaign_name || "",                           // Campaign Name
      parseFloat(ad.spend || 0).toFixed(2),             // Spend
      parseInt(ad.impressions || 0),                    // Impressions
      parseInt(ad.clicks || 0),                         // Clicks
      parseFloat(ad.ctr || 0).toFixed(2),               // CTR
      parseFloat(ad.cpc || 0).toFixed(2),               // CPC
      parseFloat(ad.cpm || 0).toFixed(2),               // CPM
      conversions,                                       // Conversions
      costPerConversion,                                 // Cost Per Conversion
      parseInt(ad.reach || 0),                           // Reach
      parseFloat(ad.frequency || 0).toFixed(2),          // Frequency
    ];
  });
}

/**
 * Extract conversion count from actions array
 * Priority: messaging_conversation_started_7d > lead > onsite_conversion
 */
function extractConversions(actions) {
  if (!actions || !Array.isArray(actions)) return 0;

  const priorities = [
    "messaging_conversation_started_7d",
    "onsite_conversion.messaging_conversation_started_7d",
    "lead",
    "onsite_conversion.lead_grouped",
    "offsite_conversion.fb_pixel_lead",
  ];

  for (const actionType of priorities) {
    const found = actions.find((a) => a.action_type === actionType);
    if (found) return parseInt(found.value || 0);
  }

  return 0;
}

/**
 * Extract cost per conversion from cost_per_action_type array
 */
function extractCostPerConversion(costPerAction) {
  if (!costPerAction || !Array.isArray(costPerAction)) return "0.00";

  const priorities = [
    "messaging_conversation_started_7d",
    "onsite_conversion.messaging_conversation_started_7d",
    "lead",
    "onsite_conversion.lead_grouped",
    "offsite_conversion.fb_pixel_lead",
  ];

  for (const actionType of priorities) {
    const found = costPerAction.find((a) => a.action_type === actionType);
    if (found) return parseFloat(found.value || 0).toFixed(2);
  }

  return "0.00";
}

module.exports = { fetchMetaAds };
