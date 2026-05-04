const fetch = require("node-fetch");
const CONFIG = require("./config");

/**
 * Ad Preview API — pulls active ad creatives from Meta
 * Returns structured data: image, caption, headline, ad name, status
 *
 * GET /api/ad-preview
 */
exports.handler = async (event) => {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "public, max-age=3600", // cache 1 hour
  };

  try {
    const { accessToken, adAccountId } = CONFIG.meta;
    if (!accessToken || !adAccountId) {
      return resp(400, headers, { ok: false, error: "Missing Meta credentials" });
    }

    // Fetch all ads (active + paused) with creative details
    const fields = [
      "name",
      "adset_name",
      "status",
      "effective_status",
      "creative{id,name,title,body,image_url,thumbnail_url,call_to_action_type,object_story_spec,asset_feed_spec,effective_object_story_id}",
    ].join(",");

    let allAds = [];
    let url = `https://graph.facebook.com/v21.0/${adAccountId}/ads?fields=${fields}&limit=100&access_token=${accessToken}`;

    while (url) {
      const res = await fetch(url);
      const data = await res.json();
      if (data.error) {
        console.error("Meta Ads error:", JSON.stringify(data.error));
        break;
      }
      if (data.data) allAds = allAds.concat(data.data);
      url = data.paging?.next || null;
    }

    console.log(`Meta: ${allAds.length} ads found`);

    const ads = [];
    for (const ad of allAds) {
      const creative = ad.creative || {};
      const story = creative.object_story_spec || {};
      const linkData = story.link_data || {};
      const videoData = story.video_data || {};

      let imageUrl = "";
      let caption = creative.body || videoData.message || linkData.message || "";
      let headline = creative.title || linkData.name || videoData.title || "";
      let cta = creative.call_to_action_type || linkData.call_to_action?.type || "";

      // 1. Try effective_object_story_id for full-res image
      if (!imageUrl && creative.effective_object_story_id) {
        try {
          const postRes = await fetch(
            `https://graph.facebook.com/v21.0/${creative.effective_object_story_id}?fields=full_picture,attachments{media{image{src}}}&access_token=${accessToken}`
          );
          const postData = await postRes.json();
          // Try attachments first (highest quality)
          const attach = postData?.attachments?.data?.[0];
          if (attach?.media?.image?.src) {
            imageUrl = attach.media.image.src;
          } else if (postData.full_picture) {
            imageUrl = postData.full_picture;
          }
        } catch (e) {
          console.log("Post fetch failed:", e.message);
        }
      }

      // 2. Try image_url from creative
      if (!imageUrl && creative.image_url) imageUrl = creative.image_url;

      // 3. Try link_data picture
      if (!imageUrl && linkData.picture) imageUrl = linkData.picture;

      // 4. Try video_data image
      if (!imageUrl && videoData.image_url) imageUrl = videoData.image_url;

      // 5. Try video thumbnail at high res
      if (!imageUrl && videoData.video_id) {
        try {
          const vidRes = await fetch(
            `https://graph.facebook.com/v21.0/${videoData.video_id}?fields=thumbnails{uri,height,width}&access_token=${accessToken}`
          );
          const vidData = await vidRes.json();
          const thumbs = vidData?.thumbnails?.data || [];
          const best = thumbs.sort((a, b) => (b.height || 0) - (a.height || 0))[0];
          if (best?.uri) imageUrl = best.uri;
        } catch (e) {}
      }

      // 6. Try asset_feed_spec (carousel / dynamic ads)
      if (!imageUrl && creative.asset_feed_spec) {
        const images = creative.asset_feed_spec.images || [];
        if (images.length > 0) imageUrl = images[0].url || "";
        const bodies = creative.asset_feed_spec.bodies || [];
        if (bodies.length > 0 && !caption) caption = bodies[0].text || "";
        const titles = creative.asset_feed_spec.titles || [];
        if (titles.length > 0 && !headline) headline = titles[0].text || "";
      }

      // 7. Last resort: thumbnail
      if (!imageUrl && creative.thumbnail_url) imageUrl = creative.thumbnail_url;

      // Upscale fbcdn URLs if possible
      if (imageUrl && imageUrl.includes("fbcdn") && imageUrl.includes("/s128x128/")) {
        imageUrl = imageUrl.replace("/s128x128/", "/s720x720/");
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

    return resp(200, headers, { ok: true, ads });
  } catch (err) {
    console.error("Ad preview failed:", err);
    return resp(500, headers, { ok: false, error: err.message });
  }
};

function resp(code, h, body) {
  return { statusCode: code, headers: h, body: JSON.stringify(body) };
}
