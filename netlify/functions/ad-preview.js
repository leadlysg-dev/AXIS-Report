const fetch = require("node-fetch");
const CONFIG = require("./config");

/**
 * Ad Preview — Debug version
 * Logs every step, returns raw API responses so we can see what's failing
 */
exports.handler = async (event) => {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  };

  const { accessToken, adAccountId } = CONFIG.meta;
  const debug = [];

  if (!accessToken) {
    return resp(400, headers, { error: "No META_ACCESS_TOKEN", debug });
  }
  if (!adAccountId) {
    return resp(400, headers, { error: "No META_AD_ACCOUNT_ID", debug });
  }

  debug.push(`Token: ${accessToken.substring(0, 15)}...`);
  debug.push(`Ad Account: ${adAccountId}`);

  try {
    // Step 0: Verify token works
    const meRes = await fetch(`https://graph.facebook.com/v19.0/me?access_token=${accessToken}`);
    const meData = await meRes.json();
    debug.push(`Token check: ${JSON.stringify(meData).substring(0, 200)}`);

    // Step 1: Verify ad account access
    const acctRes = await fetch(`https://graph.facebook.com/v19.0/${adAccountId}?fields=name,account_status&access_token=${accessToken}`);
    const acctData = await acctRes.json();
    debug.push(`Ad account: ${JSON.stringify(acctData).substring(0, 200)}`);

    // Step 2: Try fetching campaigns first (simpler)
    const campRes = await fetch(`https://graph.facebook.com/v19.0/${adAccountId}/campaigns?fields=name,status&limit=5&access_token=${accessToken}`);
    const campData = await campRes.json();
    debug.push(`Campaigns: ${JSON.stringify(campData).substring(0, 500)}`);

    // Step 3: Try fetching ads with minimal fields
    const adsRes = await fetch(`https://graph.facebook.com/v19.0/${adAccountId}/ads?fields=name,status&limit=5&access_token=${accessToken}`);
    const adsData = await adsRes.json();
    debug.push(`Ads (minimal): ${JSON.stringify(adsData).substring(0, 500)}`);

    // Step 4: If ads found, try with creative fields
    let adsWithCreative = [];
    if (adsData.data && adsData.data.length > 0) {
      const creativeRes = await fetch(`https://graph.facebook.com/v19.0/${adAccountId}/ads?fields=name,status,effective_status,creative{id,title,body,image_url,thumbnail_url,image_hash,object_story_spec}&limit=5&access_token=${accessToken}`);
      const creativeData = await creativeRes.json();
      debug.push(`Ads (with creative): ${JSON.stringify(creativeData).substring(0, 1000)}`);
      adsWithCreative = creativeData.data || [];
    }

    // Step 5: If we got creative data with image hashes, try adimages
    const hashes = new Set();
    for (const ad of adsWithCreative) {
      const c = ad.creative || {};
      if (c.image_hash) hashes.add(c.image_hash);
      const lh = c.object_story_spec?.link_data?.image_hash;
      if (lh) hashes.add(lh);
    }

    if (hashes.size > 0) {
      const hashList = [...hashes].map(h => `"${h}"`).join(",");
      const imgRes = await fetch(`https://graph.facebook.com/v19.0/${adAccountId}/adimages?hashes=[${hashList}]&fields=hash,url,permalink_url&access_token=${accessToken}`);
      const imgData = await imgRes.json();
      debug.push(`Adimages: ${JSON.stringify(imgData).substring(0, 500)}`);
    } else {
      debug.push(`No image hashes found`);
    }

    // Build final ads array if we have data
    const ads = adsWithCreative.map(ad => {
      const c = ad.creative || {};
      const story = c.object_story_spec || {};
      const linkData = story.link_data || {};
      const videoData = story.video_data || {};

      return {
        id: ad.id,
        name: ad.name || "",
        status: ad.effective_status || ad.status || "",
        imageUrl: c.image_url || c.thumbnail_url || linkData.picture || videoData.image_url || "",
        caption: c.body || videoData.message || linkData.message || "",
        headline: c.title || linkData.name || videoData.title || "",
      };
    });

    return resp(200, headers, { ok: true, ads, debug });

  } catch (err) {
    debug.push(`Error: ${err.message}`);
    return resp(500, headers, { ok: false, error: err.message, debug });
  }
};

function resp(code, h, body) {
  return { statusCode: code, headers: h, body: JSON.stringify(body) };
}
