const fetch = require("node-fetch");
const CONFIG = require("./config");

/**
 * Ad Preview API — exact AARO approach
 * Step 1: Fetch all ads with creative details (NO status filter)
 * Step 2: Collect image hashes, batch-fetch full-res via adimages endpoint
 * Step 3: Build ad list with best available image
 */
async function fetchMetaAds() {
  const { accessToken, adAccountId } = CONFIG.meta;
  if (!accessToken || !adAccountId) return [];

  try {
    // Step 1: Get all ads with creative details
    const fields = [
      "name",
      "adset_name",
      "status",
      "effective_status",
      "creative{id,name,title,body,image_url,image_hash,thumbnail_url,call_to_action_type,object_story_spec,asset_feed_spec,effective_object_story_id}",
    ].join(",");

    let allAds = [];
    let url = `https://graph.facebook.com/v19.0/${adAccountId}/ads?fields=${fields}&limit=100&access_token=${accessToken}`;

    while (url) {
      const res = await fetch(url);
      const data = await res.json();
      if (data.error) {
        console.error("Meta Ads error:", JSON.stringify(data.error));
        return [];
      }
      if (data.data) allAds = allAds.concat(data.data);
      url = data.paging?.next || null;
    }

    console.log(`Meta: ${allAds.length} total ads found`);

    // Step 2: Collect all image hashes and batch-fetch full-res URLs
    const hashes = new Set();
    for (const ad of allAds) {
      const c = ad.creative || {};
      if (c.image_hash) hashes.add(c.image_hash);
      const lh = c.object_story_spec?.link_data?.image_hash;
      if (lh) hashes.add(lh);
    }

    const hashToUrl = {};
    if (hashes.size > 0) {
      try {
        const hashList = [...hashes].map(h => `"${h}"`).join(",");
        const imgRes = await fetch(
          `https://graph.facebook.com/v19.0/${adAccountId}/adimages?hashes=[${hashList}]&fields=hash,url,url_128,permalink_url&access_token=${accessToken}`
        );
        const imgData = await imgRes.json();
        if (imgData.data) {
          for (const img of imgData.data) {
            hashToUrl[img.hash] = img.permalink_url || img.url || "";
          }
        }
      } catch (e) {
        console.error("adimages fetch error:", e.message);
      }
    }

    console.log(`Meta: ${Object.keys(hashToUrl).length} full-res images resolved from ${hashes.size} hashes`);

    // Step 3: Build ad list
    const ads = [];
    for (const ad of allAds) {
      const creative = ad.creative || {};
      const story = creative.object_story_spec || {};
      const linkData = story.link_data || {};
      const videoData = story.video_data || {};

      let imageUrl = "";
      let caption = creative.body || videoData.message || linkData.message || "";
      let headline = creative.title || linkData.name || videoData.title || "";
      let description = linkData.description || "";
      let cta = creative.call_to_action_type || linkData.call_to_action?.type || "";
      let link = linkData.link || "";

      // Priority 1: Full-res from image hash
      const hash = creative.image_hash || linkData.image_hash;
      if (hash && hashToUrl[hash]) {
        imageUrl = hashToUrl[hash];
      }

      // Priority 2: For video ads, get video thumbnail at max width
      if (!imageUrl && videoData.video_id) {
        try {
          const vidRes = await fetch(
            `https://graph.facebook.com/v19.0/${videoData.video_id}?fields=thumbnails{uri,width,height}&access_token=${accessToken}`
          );
          const vidData2 = await vidRes.json();
          const thumbs = vidData2.thumbnails?.data || [];
          if (thumbs.length > 0) {
            const best = thumbs.reduce((a, b) => (b.width || 0) > (a.width || 0) ? b : a);
            imageUrl = best.uri || "";
          }
        } catch (e) {
          console.log("Video thumb fetch failed:", e.message);
        }
      }

      // Priority 3: Video cover image URL
      if (!imageUrl && videoData.image_url) {
        imageUrl = videoData.image_url;
      }

      // Priority 4: Creative image_url / thumbnail
      if (!imageUrl) imageUrl = creative.image_url || creative.thumbnail_url || "";

      // Priority 5: asset_feed_spec (carousel / dynamic)
      if (!imageUrl && creative.asset_feed_spec) {
        const images = creative.asset_feed_spec.images || [];
        if (images.length > 0) imageUrl = images[0].url || "";
        const bodies = creative.asset_feed_spec.bodies || [];
        if (bodies.length > 0 && !caption) caption = bodies[0].text || "";
        const titles = creative.asset_feed_spec.titles || [];
        if (titles.length > 0 && !headline) headline = titles[0].text || "";
      }

      // Upgrade fbcdn URLs to higher res
      if (imageUrl && imageUrl.includes('fbcdn')) {
        imageUrl = imageUrl.replace(/\/s\d+x\d+\//, '/s720x720/').replace(/\/p\d+x\d+\//, '/p720x720/');
      }

      ads.push({
        id: ad.id,
        name: ad.name || "",
        adsetName: ad.adset_name || "",
        status: ad.effective_status || ad.status || "",
        imageUrl,
        caption,
        headline,
        cta,
      });
    }

    return ads;
  } catch (err) {
    console.error("fetchMetaAds error:", err.message);
    return [];
  }
}

exports.handler = async (event) => {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "public, max-age=3600",
  };

  console.log("Fetching ad previews...");
  const ads = await fetchMetaAds();
  console.log(`Done: ${ads.length} ads`);

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({ ok: true, ads }),
  };
};
