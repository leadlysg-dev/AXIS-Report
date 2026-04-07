const fetch = require("node-fetch");
const CONFIG = require("./config");

/**
 * Fetch ad-level data from Meta Marketing API for a specific date
 * Output matches the exact column format from Meta Ads Manager export
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
    "reach",
    "frequency",
    "inline_link_clicks",
    "ctr",
    "cost_per_inline_link_click",
    "cpm",
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
    const leads = extractAction(ad.actions, "lead");
    const costPerLead = extractCostPerAction(ad.cost_per_action_type, "lead");
    const msgConv = extractAction(ad.actions, "messaging_conversation_started_7d") ||
                    extractAction(ad.actions, "onsite_conversion.messaging_conversation_started_7d");
    const costPerMsg = extractCostPerAction(ad.cost_per_action_type, "messaging_conversation_started_7d") ||
                       extractCostPerAction(ad.cost_per_action_type, "onsite_conversion.messaging_conversation_started_7d");

    return [
      dateStr,                                                      // Day
      ad.ad_id || "",                                                // Ad ID
      ad.ad_name || "",                                              // Ad name
      ad.adset_name || "",                                           // Ad set name
      ad.campaign_name || "",                                        // Campaign name
      parseFloat(ad.spend || 0).toFixed(2),                          // Amount spent (SGD)
      parseInt(ad.impressions || 0),                                 // Impressions
      parseInt(ad.reach || 0),                                       // Reach
      parseFloat(ad.frequency || 0).toFixed(2),                      // Frequency
      parseInt(ad.inline_link_clicks || 0),                          // Link clicks
      parseFloat(ad.ctr || 0).toFixed(8),                            // CTR (all)
      parseFloat(ad.cost_per_inline_link_click || 0).toFixed(8),     // CPC (cost per link click)
      parseFloat(ad.cpm || 0).toFixed(2),                            // CPM (cost per 1,000 impressions)
      leads,                                                          // Leads
      costPerLead,                                                    // Cost per lead
      msgConv,                                                        // Messaging conversations started
      costPerMsg,                                                     // Cost per messaging conversation started
    ];
  });
}

/**
 * Extract action count from actions array
 */
function extractAction(actions, actionType) {
  if (!actions || !Array.isArray(actions)) return "";
  const found = actions.find((a) => a.action_type === actionType);
  return found ? parseInt(found.value || 0) : "";
}

/**
 * Extract cost per action from cost_per_action_type array
 */
function extractCostPerAction(costPerAction, actionType) {
  if (!costPerAction || !Array.isArray(costPerAction)) return "";
  const found = costPerAction.find((a) => a.action_type === actionType);
  return found ? parseFloat(found.value || 0).toFixed(8) : "";
}

module.exports = { fetchMetaAds };
