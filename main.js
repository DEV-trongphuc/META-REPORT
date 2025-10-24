let startDate, endDate;
const BATCH_SIZE = 40; // Giới hạn của Meta là 50
let VIEW_GOAL; // Dùng cho chart breakdown
const API_VERSION = "v24.0";
const BASE_URL = `https://graph.facebook.com/${API_VERSION}`;

const goalMapping = {
  "Lead Form": ["LEAD_GENERATION", "QUALITY_LEAD"],
  Awareness: ["REACH", "AD_RECALL_LIFT", "IMPRESSIONS"],
  Engagement: ["POST_ENGAGEMENT", "THRUPLAY", "EVENT_RESPONSES"],
  Message: ["REPLIES"],
  Traffic: [
    "OFFSITE_CONVERSIONS",
    "LINK_CLICKS",
    "PROFILE_VISIT",
    "LANDING_PAGE_VIEWS",
  ],
  Pagelike: ["PAGE_LIKES"],
};

const resultMapping = {
  REACH: "reach",
  LEAD_GENERATION: "onsite_conversion.lead_grouped",
  QUALITY_LEAD: "onsite_conversion.lead_grouped",
  THRUPLAY: "video_view",
  POST_ENGAGEMENT: "post_engagement",
  PROFILE_VISIT: "link_click",
  LINK_CLICKS: "link_click",
  LANDING_PAGE_VIEWS: "link_click",
  REPLIES: "onsite_conversion.messaging_conversation_started_7d",
  IMPRESSIONS: "impressions",
  PAGE_LIKES: "follows",
  DEFAULT: "reach", // Fallback
};
// ================== Campaign Icon Mapping ==================
// Hằng số mới để map "loại goal" sang icon
const campaignIconMapping = {
  "Lead Form": "fa-solid fa-bullseye",
  Awareness: "fa-solid fa-eye",
  Engagement: "fa-solid fa-star",
  Message: "fa-solid fa-comments",
  Traffic: "fa-solid fa-mouse-pointer",
  Pagelike: "fa-solid fa-thumbs-up",
  DEFAULT: "fa-solid fa-crosshairs", // Icon dự phòng
};

/**
 * Hàm helper mới: Lấy class icon dựa trên optimization_goal
 * (Hàm này cần "goalMapping" đã có ở trên)
 */
function getCampaignIcon(optimizationGoal) {
  if (!optimizationGoal) {
    return campaignIconMapping.DEFAULT;
  }

  // Tìm xem goal này thuộc nhóm nào (Lead, Traffic,...)
  const goalGroup = Object.keys(goalMapping).find((key) =>
    goalMapping[key].includes(optimizationGoal)
  );

  // Trả về icon của nhóm đó, hoặc icon mặc định
  return campaignIconMapping[goalGroup] || campaignIconMapping.DEFAULT;
}
// ================== Helper ==================
function getAction(actions, type) {
  if (!actions || !Array.isArray(actions)) return 0;
  const found = actions.find((a) => a.action_type === type);
  return found ? +found.value || 0 : 0;
}

// ================== Nâng cấp getResults (Hợp nhất) ==================
/**
 * Hàm getResults thống nhất
 * - Xử lý 'item' từ ad/adset (có insights.actions là array)
 * - Xử lý 'item' từ breakdown (có actions là object)
 * - Ưu tiên goal từ VIEW_GOAL nếu có
 */
function getResults(item, goal) {
  if (!item) return 0; // 1. Tìm data insights (cho ad/adset) hoặc item (cho breakdown)

  const insights = item.insights?.data?.[0] || item.insights || item;
  if (!insights) return 0; // Thêm check an toàn // 2. Lấy optimization_goal

  const optimization_goal =
    goal ||
    VIEW_GOAL ||
    item.optimization_goal ||
    insights.optimization_goal ||
    ""; // 🎯 TỐI ƯU ĐỘ CHÍNH XÁC // Nếu goal là Reach hoặc Impressions, trả về metric gốc, không tìm trong actions

  if (optimization_goal === "REACH") {
    return +insights.reach || 0;
  }
  if (optimization_goal === "IMPRESSIONS") {
    return +insights.impressions || 0;
  } // Hết phần xử lý đặc biệt // 3. Lấy actions (có thể là Array hoặc Object)
  const actions = insights.actions || {}; // Mặc định là object cho an toàn // 4. Tìm goal chính

  const goalKey = Object.keys(goalMapping).find((key) =>
    goalMapping[key].includes(optimization_goal)
  ); // 5. Tìm action_type

  let resultType =
    resultMapping[optimization_goal] || // 🎯 ĐÃ SỬA LỖI TẠI ĐÂY (key -> goalKey)
    (goalKey ? resultMapping[goalMapping[goalKey][0]] : resultMapping.DEFAULT); // 6. Lấy giá trị

  if (Array.isArray(actions)) {
    // Dùng cho ad, adset (actions là array)
    const found = actions.find((a) => a.action_type === resultType);
    return found ? +found.value || 0 : 0;
  } else {
    // Dùng cho breakdown (actions là object)
    if (
      !actions[resultType] &&
      (resultType === "lead" || resultType === "quality_lead") &&
      actions["onsite_conversion.lead_grouped"]
    ) {
      resultType = "onsite_conversion.lead_grouped"; // Fallback cho chart
    }
    return actions[resultType] ? +actions[resultType] : 0;
  }
}
// ===================== UTILS =====================
async function fetchJSON(url, options = {}) {
  try {
    const res = await fetch(url, options);
    if (!res.ok) {
      try {
        const errData = await res.json();
        if (errData.error) {
          throw new Error(
            `Meta API Error: ${errData.error.message} (Code: ${errData.error.code})`
          );
        }
      } catch (e) {}
      throw new Error(`HTTP ${res.status} - ${res.statusText}`);
    }
    const data = await res.json();
    // Xử lý lỗi riêng lẻ trong batch
    if (options.method === "POST" && Array.isArray(data)) {
      data.forEach((item, index) => {
        if (item && item.code !== 200) {
          console.warn(
            `Batch item ${index} failed (Code: ${item.code}):`,
            item.body
          );
        }
      });
    } else if (data.error) {
      throw new Error(
        `Meta API Error: ${data.error.message} (Code: ${data.error.code})`
      );
    }
    return data;
  } catch (err) {
    console.error(`Fetch failed for ${url}:`, err);
    throw err;
  }
}

function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size)
    chunks.push(arr.slice(i, i + size));
  return chunks;
}

async function fetchAdsets() {
  const apiUrl = `${BASE_URL}/act_${ACCOUNT_ID}/insights?level=adset&fields=adset_id,adset_name,campaign_id,campaign_name,spend,optimization_goal&filtering=[{"field":"spend","operator":"GREATER_THAN","value":0}]&time_range={"since":"${startDate}","until":"${endDate}"}&limit=500&access_token=${META_TOKEN}`;

  const data = await fetchJSON(apiUrl);
  console.log(data.data);

  return data.data || [];
}

async function fetchAdsAndInsights(adsetIds, onBatchProcessedCallback) {
  if (!Array.isArray(adsetIds) || !adsetIds.length) return [];

  const batches = chunkArray(adsetIds, BATCH_SIZE);

  const allAdsLists = await Promise.all(
    batches.map(async (batch) => {
      // --- 1️⃣ Fetch ads song song ---
      const fbBatch1 = batch.map((adsetId) => ({
        method: "GET",
        relative_url: `${adsetId}/ads?fields=id,name,effective_status,adset_id,adset{end_time},creative{effective_object_story_id,thumbnail_url,instagram_permalink_url}`,
      }));

      const adsResp = await fetchJSON(BASE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ access_token: META_TOKEN, batch: fbBatch1 }),
      });

      const adsList = [];
      const now = new Date();

      for (const item of adsResp) {
        if (item?.code !== 200 || !item?.body) continue;
        const body = JSON.parse(item.body);
        if (!Array.isArray(body.data)) continue;

        body.data.forEach((ad) => {
          const endTime = ad.adset?.end_time
            ? new Date(ad.adset.end_time)
            : null;
          const isEnded = endTime && endTime < now;

          // 🔹 Nếu adset hết hạn thì tự chuyển thành COMPLETED
          let effectiveStatus = ad.effective_status;
          if (isEnded) effectiveStatus = "COMPLETED";

          adsList.push({
            id: ad.id,
            name: ad.name,
            adset_id: ad.adset_id,
            effective_status: effectiveStatus,
            adset: {
              status: ad.adset?.status || null,
              start_time: ad.adset?.start_time || null,
              end_time: ad.adset?.end_time || null,
            },
            creative: {
              body: ad.creative?.body || null,
              title: ad.creative?.title || null,
              thumbnail_url: ad.creative?.thumbnail_url || null,
              instagram_permalink_url:
                ad.creative?.instagram_permalink_url || null,
              object_story_id: ad.creative?.effective_object_story_id || null,
              facebook_post_url: ad.creative?.effective_object_story_id
                ? `https://facebook.com/${ad.creative.effective_object_story_id}`
                : null,
            },
          });
        });
      }

      if (!adsList.length) return [];

      // --- 2️⃣ Fetch insights song song ---
      const adIdChunks = chunkArray(
        adsList.map((a) => a.id),
        BATCH_SIZE
      );

      const insightPromises = adIdChunks.map((chunk) => {
        const fbBatch2 = chunk.map((adId) => ({
          method: "GET",
          relative_url: `${adId}/insights?fields=spend,impressions,reach,actions,optimization_goal&time_range[since]=${encodeURIComponent(
            startDate
          )}&time_range[until]=${encodeURIComponent(endDate)}`,
        }));

        return fetchJSON(BASE_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ access_token: META_TOKEN, batch: fbBatch2 }),
        });
      });

      const insightResponses = await Promise.allSettled(insightPromises);

      // --- 3️⃣ Map insights ---
      const insightsMap = new Map();
      insightResponses.forEach((settled, batchIndex) => {
        if (settled.status !== "fulfilled") return;
        const resp2 = settled.value;
        const chunk = adIdChunks[batchIndex];
        for (let i = 0; i < resp2.length; i++) {
          const r = resp2[i];
          const adId = chunk[i];
          if (r?.code === 200 && r?.body) {
            try {
              const body = JSON.parse(r.body);
              insightsMap.set(adId, body?.data?.[0] || null);
            } catch {
              insightsMap.set(adId, null);
            }
          } else {
            insightsMap.set(adId, null);
          }
        }
      });

      // --- 4️⃣ Merge insights ---
      const processedAdsBatch = adsList.map((ad) => {
        const insight = insightsMap.get(ad.id) || {
          spend: 0,
          impressions: 0,
          reach: 0,
          actions: [],
        };
        const optimizationGoal = insight?.optimization_goal || "UNKNOWN";

        return {
          ad_id: ad.id,
          ad_name: ad.name,
          adset_id: ad.adset_id,
          effective_status: ad.effective_status,
          optimization_goal: optimizationGoal, // 🧠 thêm dòng này
          adset: ad.adset,
          creative: ad.creative,
          insights: insight,
        };
      });

      onBatchProcessedCallback?.(processedAdsBatch);
      return processedAdsBatch;
    })
  );

  const allAds = allAdsLists.flat();
  renderGoalChart(allAds);
  return allAds;
}

async function fetchStoryMeta(object_story_ids) {
  const metaMap = new Map(); // Dùng Map để tra cứu O(1)
  const uniqueIds = [...new Set(object_story_ids.filter(Boolean))]; // Lọc ID rỗng và trùng
  const batches = chunkArray(uniqueIds, BATCH_SIZE);

  await Promise.all(
    batches.map(async (batch) => {
      const fbBatch = batch.map((id) => ({
        method: "GET",
        relative_url: `${id}?fields=full_picture,message,attachments{subattachments,media,url,description}`,
      }));

      const batchData = await fetchJSON(BASE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ access_token: META_TOKEN, batch: fbBatch }),
      });

      batch.forEach((storyId, idx) => {
        const body =
          batchData[idx]?.code === 200 && batchData[idx]?.body
            ? JSON.parse(batchData[idx].body)
            : null;
        if (body && !body.error) {
          metaMap.set(storyId, {
            full_picture:
              body.full_picture ||
              body.attachments?.data?.[0]?.media?.image?.src ||
              null,
            message_real: body.message || null,
            carousel:
              body.attachments?.data?.[0]?.subattachments?.data?.map((a) => ({
                url: a.url,
                media: a.media?.image?.src,
                desc: a.description,
              })) || null,
          });
        }
      });
    })
  );

  return metaMap;
}

async function fetchDailySpendByAccount() {
  try {
    if (!ACCOUNT_ID) throw new Error("ACCOUNT_ID is required");
    const url = `${BASE_URL}/act_${ACCOUNT_ID}/insights?fields=spend,impressions,reach,actions&time_increment=1&time_range[since]=${startDate}&time_range[until]=${endDate}&access_token=${META_TOKEN}`;
    const data = await fetchJSON(url);
    const results = data.data || [];
    console.log(results);

    return results;
  } catch (err) {
    console.error("❌ Error fetching daily spend for account", err);
    return null;
  }
}

let DAILY_DATA;

async function loadDailyChart() {
  try {
    console.log("Flow 1: Fetching daily data...");
    const dailyData = await fetchDailySpendByAccount();
    DAILY_DATA = dailyData;
    renderDetailDailyChart2(DAILY_DATA);
    console.log("✅ Flow 1: Daily chart rendered.");
  } catch (err) {
    console.error("❌ Error in Flow 1 (Daily Chart):", err);
  }
}
function groupByCampaign(adsets) {
  const campaigns = {};

  // helper: safe get action value
  const safeGetActionValue = (actions, type) =>
    +(actions?.find?.((a) => a.action_type === type)?.value || 0);

  adsets.forEach((rawAs) => {
    // --- Normalize adset fields (support various shapes) ---
    const as = { ...rawAs };
    as.id = as.id ?? as.adset_id ?? as.adsetId ?? null;
    as.name = as.name ?? as.adset_name ?? as.adsetName ?? null;
    as.campaign_id = as.campaign_id ?? as.campaignId ?? null;
    as.campaign_name = as.campaign_name ?? as.campaignName ?? null;
    as.optimization_goal = as.optimization_goal ?? as.optimizationGoal ?? null;
    as.ads = Array.isArray(as.ads) ? as.ads : [];

    // nếu không có ads thì vẫn có thể tạo adset entry (tuỳ nhu cầu)
    if (!as.ads.length) return;

    as.ads.forEach((ad) => {
      // insights có thể là object, array hoặc undefined
      let ins = ad.insights ?? ad.insights?.data ?? null;
      if (Array.isArray(ins)) ins = ins[0] ?? null;
      ins = ins ?? {};

      const campaignId = as.campaign_id ?? "unknown_campaign";
      const campaignName = as.campaign_name ?? "Unknown";

      const c = (campaigns[campaignId] ??= {
        id: campaignId,
        name: campaignName,
        spend: 0,
        result: 0,
        reach: 0,
        impressions: 0,
        reactions: 0,
        lead: 0,
        message: 0,
        adsets: [],
      });

      const spend = Number(ins.spend) || 0;
      const reach = Number(ins.reach) || 0;
      const impressions = Number(ins.impressions) || 0;
      const result = getResults(ins) || 0;
      const reactions = getReaction(ins) || 0;

      const actions = Array.isArray(ins.actions) ? ins.actions : [];

      const messageCount = safeGetActionValue(
        actions,
        "onsite_conversion.messaging_conversation_started_7d"
      );
      const leadCount =
        safeGetActionValue(actions, "lead") +
        safeGetActionValue(actions, "onsite_conversion.lead_grouped");

      // cộng vào campaign-level
      c.spend += spend;
      c.result += result;
      c.reach += reach;
      c.impressions += impressions;
      c.reactions += reactions;
      c.lead += leadCount;
      c.message += messageCount;

      // --- find or create adset bucket (normalize id/name there too) ---
      let adset = c.adsets.find((x) => x.id === as.id);
      if (!adset) {
        adset = {
          id: as.id,
          name: as.name,
          optimization_goal: as.optimization_goal,
          spend: 0,
          result: 0,
          reach: 0,
          impressions: 0,
          reactions: 0,
          lead: 0,
          message: 0,
          ads: [],
        };
        c.adsets.push(adset);
      }

      // cộng vào adset-level
      adset.spend += spend;
      adset.result += result;
      adset.reach += reach;
      adset.impressions += impressions;
      adset.reactions += reactions;
      adset.lead += leadCount;
      adset.message += messageCount;

      // push ad summary (safe access)
      adset.ads.push({
        id: ad.ad_id ?? ad.id ?? null,
        name: ad.ad_name ?? ad.name ?? null,
        status: ad.effective_status ?? ad.status ?? null,
        optimization_goal: ad.optimization_goal ?? "UNKNOWN",
        spend,
        result,
        reach,
        impressions,
        reactions,
        lead: leadCount,
        message: messageCount,
        cpr: result ? spend / result : 0,
        thumbnail:
          ad.creative?.thumbnail_url ||
          ad.creative?.full_picture ||
          "https://via.placeholder.com/64",
        post_url:
          ad.creative?.facebook_post_url ||
          ad.creative?.instagram_permalink_url ||
          "#",
      });
    });
  });

  // trả về mảng campaign — có thể sort nếu cần
  return Object.values(campaigns);
}

function renderCampaignView(data) {
  const wrap = document.querySelector(".view_campaign_box");
  if (!wrap || !Array.isArray(data)) return;

  const frag = document.createDocumentFragment();

  // === 💡 Đếm Active Campaign / Adset ngay đầu ===
  let totalCampaignCount = data.length;
  let activeCampaignCount = 0;
  let totalAdsetCount = 0;
  let activeAdsetCount = 0;

  data.forEach((c) => {
    let campaignActive = false;
    (c.adsets || []).forEach((as) => {
      totalAdsetCount++;
      const adsetActive = (as.ads || []).some(
        (ad) => ad.status?.toLowerCase() === "active"
      );
      if (adsetActive) {
        activeAdsetCount++;
        campaignActive = true;
      }
    });
    if (campaignActive) activeCampaignCount++;
  });

  // === ⚙️ Update Active Campaign / Adset UI ===
  const activeCpEls = document.querySelectorAll(".dom_active_cp");
  if (activeCpEls.length >= 2) {
    // Campaign
    const campEl = activeCpEls[0].querySelector("span:nth-child(2)");
    if (campEl)
      campEl.innerHTML = `<span class="live-dot"></span>${activeCampaignCount}/${totalCampaignCount}`;

    // Adset
    const adsetEl = activeCpEls[1].querySelector("span:nth-child(2)");
    if (adsetEl) {
      const hasActive = activeAdsetCount > 0;
      adsetEl.classList.toggle("inactive", !hasActive);
      adsetEl.innerHTML = `<span class="live-dot"></span>${activeAdsetCount}/${totalAdsetCount}`;
    }
  }

  // === 🧠 Ưu tiên Campaign ACTIVE trước khi render ===
  data.sort((a, b) => {
    const aActive = a.adsets.some((as) =>
      as.ads.some((ad) => ad.status?.toLowerCase() === "active")
    );
    const bActive = b.adsets.some((as) =>
      as.ads.some((ad) => ad.status?.toLowerCase() === "active")
    );
    if (aActive !== bActive) return bActive - aActive; // ACTIVE trước
    return b.spend - a.spend; // sau đó sort theo spend
  });

  // === 🧱 Render từng Campaign ===
  data.forEach((c) => {
    const adsets = [...c.adsets].sort((a, b) => {
      const aActive = a.ads.some((ad) => ad.status?.toLowerCase() === "active");
      const bActive = b.ads.some((ad) => ad.status?.toLowerCase() === "active");
      if (aActive !== bActive) return bActive - aActive;
      return b.spend - a.spend;
    });

    const activeAdsetsCount = adsets.filter((as) =>
      as.ads.some((ad) => ad.status?.toLowerCase() === "active")
    ).length;

    const hasActiveAdset = activeAdsetsCount > 0;
    const campaignStatusClass = hasActiveAdset ? "active" : "inactive";
    const campaignStatusText = hasActiveAdset
      ? `${activeAdsetsCount} ACTIVE`
      : `INACTIVE`;

    const firstAdsetGoal = adsets?.[0]?.optimization_goal || "";
    const iconClass = getCampaignIcon(firstAdsetGoal);

    const campaignCpr =
      c.result > 0
        ? firstAdsetGoal === "REACH"
          ? (c.spend / c.result) * 1000
          : c.spend / c.result
        : 0;

    const div = document.createElement("div");
    div.className = `campaign_item ${campaignStatusClass}`;

    const iconWrapClass = hasActiveAdset
      ? "campaign_thumb campaign_icon_wrap"
      : "campaign_thumb campaign_icon_wrap inactive";

    let html = `
      <div class="campaign_main">
        <div class="ads_name">
          <div class="${iconWrapClass}">
            <i class="${iconClass}"></i>
          </div>
          <p class="ad_name">${c.name}</p>
        </div>
        <div class="ad_status ${campaignStatusClass}">${campaignStatusText}</div>
        <div class="ad_spent">${formatMoney(c.spend)}</div>
        <div class="ad_result">${formatNumber(c.result)}</div>
        <div class="ad_cpr">${formatMoney(campaignCpr)}</div>
        <div class="ad_cpm">${formatMoney(calcCpm(c.spend, c.reach))}</div>
        <div class="ad_reach">${formatNumber(c.reach)}</div>
        <div class="ad_frequency">${calcFrequency(c.impressions, c.reach)}</div>
        <div class="ad_reaction">${formatNumber(c.reactions)}</div>
        <div class="campaign_view"><i class="fa-solid fa-angle-down"></i></div>
      </div>
    `;

    // === Render từng Adset & Ad ===
    adsets.forEach((as) => {
      const ads = [...as.ads].sort(
        (a, b) =>
          (b.status?.toLowerCase() === "active") -
          (a.status?.toLowerCase() === "active")
      );

      const adsetIconClass = getCampaignIcon(as.optimization_goal);
      const activeAdsCount = ads.filter(
        (ad) => ad.status?.toLowerCase() === "active"
      ).length;
      const adsetStatusClass = activeAdsCount > 0 ? "active" : "inactive";
      const adsetStatusText =
        activeAdsCount > 0 ? `${activeAdsCount} ACTIVE` : `INACTIVE`;

      const adsetCpr =
        as.result > 0
          ? as.optimization_goal === "REACH"
            ? (as.spend / as.result) * 1000
            : as.spend / as.result
          : 0;

      const adsHtml = ads
        .map((ad) => {
          const isActiveAd = ad.status?.toLowerCase() === "active";
          const adCpr =
            ad.result > 0
              ? as.optimization_goal === "REACH"
                ? (ad.spend / ad.result) * 1000
                : ad.spend / ad.result
              : 0;

          return `
            <div class="ad_item ${isActiveAd ? "active" : "inactive"}">
              <div class="ads_name">
                <a href="${ad.post_url}" target="_blank">
                  <img src="${ad.thumbnail}" data-ad-id-img="${ad.id}" />
                  <p class="ad_name">ID: ${ad.id}</p>
                </a>
              </div>
              <div class="ad_status ${isActiveAd ? "active" : "inactive"}">${
            ad.status
          }</div>
              <div class="ad_spent">${formatMoney(ad.spend)}</div>
              <div class="ad_result">${formatNumber(ad.result)}</div>
              <div class="ad_cpr">${formatMoney(adCpr)}</div>
              <div class="ad_cpm">${formatMoney(
                calcCpm(ad.spend, ad.reach)
              )}</div>
              <div class="ad_reach">${formatNumber(ad.reach)}</div>
              <div class="ad_frequency">${calcFrequency(
                ad.impressions,
                ad.reach
              )}</div>
              <div class="ad_reaction">${formatNumber(ad.reactions)}</div>
              <div 
                class="ad_view" 
                data-ad-id="${ad.id}" 
                data-name="${as.name}" 
                data-goal="${as.optimization_goal}" 
                data-spend="${ad.spend}" 
                data-result="${ad.result}" 
                data-cpr="${adCpr}"
                data-thumb="${ad.thumbnail || ""}"
                data-post="${ad.post_url || ""}"
              >
                <i class="fa-solid fa-magnifying-glass-chart"></i>
              </div>
            </div>`;
        })
        .join("");

      html += `
        <div class="adset_item ${adsetStatusClass}">
          <div class="ads_name"><p class="ad_name">${as.name}</p></div>
          <div class="ad_status ${adsetStatusClass}">${adsetStatusText}</div>
          <div class="ad_spent">${formatMoney(as.spend)}</div>
          <div class="ad_result">${formatNumber(as.result)}</div>
          <div class="ad_cpr">
            <i class="${adsetIconClass} adset_goal_icon"></i>
            <span>${as.optimization_goal}</span>
          </div>
          <div class="ad_cpm">${formatMoney(calcCpm(as.spend, as.reach))}</div>
          <div class="ad_reach">${formatNumber(as.reach)}</div>
          <div class="ad_frequency">${calcFrequency(
            as.impressions,
            as.reach
          )}</div>
          <div class="ad_reaction">${formatNumber(as.reactions)}</div>
          <div class="adset_view" 
            data-adset-id="${as.id}" 
            data-goal="${as.optimization_goal}" 
            data-spend="${as.spend}" 
            data-result="${as.result}" 
            data-cpr="${adsetCpr.toFixed(0)}">
            <div class="campaign_view"><i class="fa-solid fa-angle-down"></i></div>
          </div>
        </div>
        <div class="ad_item_box">${adsHtml}</div>
      `;
    });

    div.innerHTML = html + "</div>";
    frag.appendChild(div);
  });

  wrap.innerHTML = "";
  wrap.appendChild(frag);
  addListeners();
}

function buildGoalSpendData(data) {
  const goalSpendMap = {};

  data.forEach((c) => {
    c.adsets.forEach((as) => {
      const goal = as.optimization_goal || "UNKNOWN";
      goalSpendMap[goal] = (goalSpendMap[goal] || 0) + (as.spend || 0);
    });
  });

  // Chuẩn hóa sang dạng dataset Chart.js
  const labels = Object.keys(goalSpendMap);
  const values = Object.values(goalSpendMap);

  return { labels, values };
}
function renderGoalChart(data) {
  if (!data || !Array.isArray(data)) return;

  const ctx = document.getElementById("goal_chart");
  if (!ctx) return;
  const c2d = ctx.getContext("2d");

  // ❌ Xóa chart cũ
  if (window.goal_chart_instance) {
    window.goal_chart_instance.destroy();
    window.goal_chart_instance = null;
  }

  // 🔹 Gom tổng spend theo optimization_goal
  const goalSpend = {};
  data.forEach((ad) => {
    const goal = ad.optimization_goal?.trim();
    const spend = parseFloat(ad.insights?.spend || 0);
    if (!goal || goal.toUpperCase() === "UNKNOWN" || goal === "-") return;
    goalSpend[goal] = (goalSpend[goal] || 0) + spend;
  });

  const goals = Object.keys(goalSpend);
  const values = goals.map((g) => Math.round(goalSpend[g]));
  if (!goals.length) return;

  // 🔸 Goal cao nhất
  const [maxGoal] = Object.entries(goalSpend).reduce((a, b) =>
    a[1] > b[1] ? a : b
  );

  // 🎨 Gradient vàng & xám
  const gradientGold = c2d.createLinearGradient(0, 0, 0, 300);
  gradientGold.addColorStop(0, "rgba(255,169,0,1)");
  gradientGold.addColorStop(1, "rgba(255,169,0,0.4)");

  const gradientGray = c2d.createLinearGradient(0, 0, 0, 300);
  gradientGray.addColorStop(0, "rgba(210,210,210,0.9)");
  gradientGray.addColorStop(1, "rgba(160,160,160,0.4)");

  const bgColors = goals.map((g) =>
    g === maxGoal ? gradientGold : gradientGray
  );

  const isFew = goals.length < 3;
  const barWidth = isFew ? 0.35 : undefined;
  const catWidth = isFew ? 0.65 : undefined;

  window.goal_chart_instance = new Chart(c2d, {
    type: "bar",
    data: {
      labels: goals.map((g) => g.replace(/_/g, " ").toUpperCase()),
      datasets: [
        {
          label: "Spend",
          data: values,
          backgroundColor: bgColors,
          borderRadius: 8,
          borderWidth: 0,
          ...(isFew && {
            barPercentage: barWidth,
            categoryPercentage: catWidth,
          }),
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      layout: {
        padding: { left: 10, right: 10 },
      },
      animation: { duration: 600, easing: "easeOutQuart" },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (c) => `Spend: ${formatMoneyShort(c.raw)}`,
          },
        },
        datalabels: {
          anchor: "end",
          align: "end",
          offset: 2,
          font: { size: 11, weight: "600" },
          color: "#555",
          formatter: (v) => (v > 0 ? formatMoneyShort(v) : ""),
        },
      },
      scales: {
        x: {
          grid: {
            color: "rgba(0,0,0,0.03)", // ✅ lưới dọc nhẹ
            drawBorder: true,
            borderColor: "rgba(0,0,0,0.05)",
          },
          ticks: {
            color: "#666",
            font: { weight: "600", size: 9 },
            maxRotation: 0,
            minRotation: 0,
          },
        },
        y: {
          beginAtZero: true,
          grid: {
            color: "rgba(0,0,0,0.03)", // ✅ lưới ngang nhẹ
            drawBorder: true,
            borderColor: "rgba(0,0,0,0.05)",
          },
          ticks: { display: false }, // ❌ ẩn toàn bộ số ở trục Y
          suggestedMax: Math.max(...values) * 1.1,
        },
      },
    },
    plugins: [ChartDataLabels],
  });
}

async function loadCampaignList() {
  try {
    console.log("Flow 2: Fetching adsets...");
    const adsets = await fetchAdsets();
    if (!adsets || !adsets.length) throw new Error("No adsets found.");

    const adsetIds = adsets.map((as) => as.adset_id).filter(Boolean);
    const ads = await fetchAdsAndInsights(adsetIds);
    console.log(adsetIds);

    const adsetMap = new Map(
      adsets.map((as) => {
        as.ads = [];
        return [as.adset_id, as];
      })
    );
    console.log(adsetMap);
    ads.forEach((ad) => {
      const parentAdset = adsetMap.get(ad.adset_id);
      if (parentAdset) parentAdset.ads.push(ad);
    });

    const campaigns = groupByCampaign(adsets);

    // 🔹 Render UI
    window._ALL_CAMPAIGNS = campaigns;
    renderCampaignView(campaigns);
    // updateSummaryUI(campaigns);
  } catch (err) {
    console.error("❌ Error in Flow 2 (Campaign List):", err);
  }
}

async function main() {
  initDateSelector();
  setupDetailDailyFilter(); // 🔹 Hiển thị loading
  setupDetailDailyFilter2(); // 🔹 Hiển thị loading
  const { start, end } = getDateRange("this_week");
  startDate = start;
  endDate = end;
  const domDate = document.querySelector(".dom_date");
  if (domDate) {
    const fmt = (d) => {
      const [y, m, day] = d.split("-");
      return `${day}/${m}/${y}`;
    };
    domDate.textContent = `${fmt(startDate)} - ${fmt(endDate)}`;
  }
  const loading = document.querySelector(".loading");
  if (loading) loading.classList.add("active"); // Kích hoạt cả 2 luồng chạy song song, không await

  loadDailyChart();
  loadPlatformSummary();
  loadSpendPlatform();
  loadCampaignList().finally(() => {
    console.log("Main flow completed. Hiding loading.");
    if (loading) loading.classList.remove("active");
  });
}
const formatMoney = (v) =>
  v && !isNaN(v) ? Math.round(v).toLocaleString("vi-VN") + "đ" : "0đ";
const formatNumber = (v) =>
  v && !isNaN(v) ? Math.round(v).toLocaleString("vi-VN") : "0";
const calcCpm = (spend, reach) => (reach ? (spend / reach) * 1000 : 0);
const calcFrequency = (impr, reach) =>
  reach ? (impr / reach).toFixed(1) : "0.0";

const getReaction = (insights) => getAction(insights?.actions, "post_reaction");
const calcCpr = (insights) => {
  const spend = +insights?.spend || 0;
  const result = getResults(insights); // Dùng hàm getResults thống nhất
  return result ? spend / result : 0;
};

// ================== Event ==================
function addListeners() {
  // Toggle toàn bộ campaign (ẩn/hiện adset)
  document.querySelectorAll(".campaign_main").forEach((el) => {
    el.onclick = (e) => {
      const campaign = e.currentTarget.closest(".campaign_item");

      // Nếu campaign này đã mở => đóng lại
      if (campaign.classList.contains("show")) {
        campaign.classList.remove("show");
        return;
      }

      // Đóng tất cả campaign khác
      document
        .querySelectorAll(".campaign_item.show")
        .forEach((c) => c.classList.remove("show"));

      // Mở campaign hiện tại
      campaign.classList.add("show");
    };
  });

  // Toggle từng adset (ẩn/hiện danh sách ads)
  document.querySelectorAll(".adset_item").forEach((el) => {
    el.onclick = (e) => {
      // Ngăn chặn khi click vào nút view hoặc icon
      if (e.target.closest(".adset_view")) return;
      const adset = e.currentTarget;
      adset.classList.toggle("show");
    };
  });

  // Nút xem chi tiết adset
  // document.querySelectorAll(".adset_view").forEach((btn) => {
  //   btn.addEventListener("click", (e) => handleViewClick(e, "adset"));
  // });

  document.querySelectorAll(".ad_view").forEach((btn) => {
    btn.addEventListener("click", (e) => handleViewClick(e, "ad"));
  });
  document.addEventListener("click", (e) => {
    const overlay = e.target.closest(".dom_overlay");
    if (!overlay) return;

    const domDetail = document.querySelector("#dom_detail");
    if (domDetail) domDetail.classList.remove("active");
  });
}

// ================================================================
// ===================== BREAKDOWN FUNCTIONS ======================
// ================================================================
async function handleViewClick(e, type = "ad") {
  e.stopPropagation();

  const el = e.currentTarget;
  const id = type === "adset" ? el.dataset.adsetId : el.dataset.adId;
  if (!id) return;

  // --- Lấy dữ liệu từ dataset ---
  const spend = parseFloat(el.dataset.spend || 0);
  const goal = el.dataset.goal || "";
  const name = el.dataset.name || "";
  const result = parseFloat(el.dataset.result || 0);
  const cpr = parseFloat(el.dataset.cpr || 0);
  const thumb =
    el.dataset.thumb ||
    "https://upload.wikimedia.org/wikipedia/commons/a/ac/No_image_available.svg";
  const postUrl = el.dataset.post || "#";
  console.log(thumb);

  // --- Cập nhật quick stats ---
  const goalEl = document.querySelector("#detail_goal span");
  const resultEl = document.querySelector("#detail_result span");
  const spendEl = document.querySelector("#detail_spent span");
  const cprEl = document.querySelector("#detail_cpr span");

  if (goalEl) goalEl.textContent = goal;
  if (spendEl) spendEl.textContent = formatMoney(spend);
  if (resultEl) resultEl.textContent = formatNumber(result);
  if (cprEl) cprEl.textContent = result ? formatMoney(cpr) : "-";

  // --- Gán VIEW_GOAL toàn cục ---
  VIEW_GOAL = goal;

  // --- Hiển thị panel chi tiết ---
  const domDetail = document.querySelector("#dom_detail");
  if (domDetail) {
    domDetail.classList.add("active");

    // Cập nhật header
    const img = domDetail.querySelector(".dom_detail_header img");
    const idEl = domDetail.querySelector(".dom_detail_id");
    const viewPostBtn = domDetail.querySelector(".view_post_btn");

    if (img) img.src = thumb;
    if (idEl)
      idEl.innerHTML = `
    <span>${name}</span> <span> ID: ${id}</span>
   `;

    if (viewPostBtn) {
      viewPostBtn.href = postUrl;
      viewPostBtn.style.display = postUrl === "#" ? "none" : "inline-block";
    }
  }

  // --- Loading overlay ---
  const loadingEl = document.querySelector(".loading");
  if (loadingEl) loadingEl.classList.add("active");

  try {
    if (type === "ad") {
      await showAdDetail(id);
    } else {
      console.log("🔍 Xem chi tiết adset:", id, { spend, goal, result, cpr });
    }
  } catch (err) {
    console.error("❌ Lỗi khi load chi tiết:", err);
  } finally {
    if (loadingEl) loadingEl.classList.remove("active");
  }
}

// (Tất cả các hàm fetchAdset... (ByHour, ByAgeGender,...) giữ nguyên)
async function fetchAdsetTargeting(ad_id) {
  try {
    if (!ad_id) throw new Error("adset_id is required");
    const url = `${BASE_URL}/${ad_id}?fields=targeting&access_token=${META_TOKEN}`;
    const data = await fetchJSON(url);
    return data.targeting || {};
  } catch (err) {
    console.error(`Error fetching targeting for ad ${ad_id}:`, err);
    return {};
  }
}

async function fetchAdsetActionsByHour(ad_id) {
  try {
    if (!ad_id) throw new Error("ad_id is required");
    const url = `${BASE_URL}/${ad_id}/insights?fields=spend,impressions,reach,actions&breakdowns=hourly_stats_aggregated_by_advertiser_time_zone&time_range[since]=${startDate}&time_range[until]=${endDate}&access_token=${META_TOKEN}`;
    const data = await fetchJSON(url);
    const results = data.data || [];
    const byHour = {};

    results.forEach((item) => {
      const hour =
        item.hourly_stats_aggregated_by_advertiser_time_zone || "unknown";
      const spend = parseFloat(item.spend || 0);
      const impressions = parseInt(item.impressions || 0);
      const reach = parseInt(item.reach || 0);
      if (!byHour[hour]) {
        byHour[hour] = { spend: 0, impressions: 0, reach: 0, actions: {} };
      }
      byHour[hour].spend += spend;
      byHour[hour].impressions += impressions;
      byHour[hour].reach += reach;
      if (item.actions) {
        item.actions.forEach((a) => {
          const type = a.action_type;
          byHour[hour].actions[type] =
            (byHour[hour].actions[type] || 0) + parseInt(a.value);
        });
      }
    });
    return byHour;
  } catch (err) {
    console.error("❌ Error fetching hourly breakdown for ad_id", ad_id, err);
    return null;
  }
}

async function fetchAdsetActionsByAgeGender(ad_id) {
  try {
    const url = `${BASE_URL}/${ad_id}/insights?fields=spend,impressions,reach,actions&breakdowns=age,gender&time_range[since]=${startDate}&time_range[until]=${endDate}&access_token=${META_TOKEN}`;
    const data = await fetchJSON(url);
    const results = data.data || [];
    const byAgeGender = {};

    results.forEach((item) => {
      const key = `${item.age || "?"}_${item.gender || "?"}`;
      const spend = parseFloat(item.spend || 0);
      const impressions = parseInt(item.impressions || 0);
      const reach = parseInt(item.reach || 0);
      if (!byAgeGender[key])
        byAgeGender[key] = { spend: 0, impressions: 0, reach: 0, actions: {} };
      byAgeGender[key].spend += spend;
      byAgeGender[key].impressions += impressions;
      byAgeGender[key].reach += reach;
      if (item.actions) {
        item.actions.forEach((a) => {
          const type = a.action_type;
          byAgeGender[key].actions[type] =
            (byAgeGender[key].actions[type] || 0) + parseInt(a.value);
        });
      }
    });
    return byAgeGender;
  } catch (err) {
    console.error("❌ Error fetching breakdown age+gender:", err);
    return null;
  }
}
async function fetchAdsetActionsByRegion(ad_id) {
  try {
    const url = `${BASE_URL}/${ad_id}/insights?fields=spend,impressions,reach,actions&breakdowns=region&time_range[since]=${startDate}&time_range[until]=${endDate}&access_token=${META_TOKEN}`;
    const data = await fetchJSON(url);
    const results = data.data || [];
    const byRegion = {};

    results.forEach((item) => {
      const region = item.region || "unknown";
      const spend = parseFloat(item.spend || 0);
      const impressions = parseInt(item.impressions || 0);
      const reach = parseInt(item.reach || 0);
      if (!byRegion[region])
        byRegion[region] = { spend: 0, impressions: 0, reach: 0, actions: {} };
      byRegion[region].spend += spend;
      byRegion[region].impressions += impressions;
      byRegion[region].reach += reach;
      if (item.actions) {
        item.actions.forEach((a) => {
          const type = a.action_type;
          byRegion[region].actions[type] =
            (byRegion[region].actions[type] || 0) + parseInt(a.value);
        });
      }
    });
    return byRegion;
  } catch (err) {
    console.error("❌ Error fetching breakdown region:", err);
    return null;
  }
}
async function fetchAdsetActionsByPlatformPosition(ad_id) {
  try {
    const url = `${BASE_URL}/${ad_id}/insights?fields=spend,impressions,reach,actions&breakdowns=publisher_platform,platform_position&time_range[since]=${startDate}&time_range[until]=${endDate}&access_token=${META_TOKEN}`;
    const data = await fetchJSON(url);
    const results = data.data || [];
    const byPlatform = {};

    results.forEach((item) => {
      const key = `${item.publisher_platform}_${item.platform_position}`;
      const spend = parseFloat(item.spend || 0);
      const impressions = parseInt(item.impressions || 0);
      const reach = parseInt(item.reach || 0);
      if (!byPlatform[key])
        byPlatform[key] = { spend: 0, impressions: 0, reach: 0, actions: {} };
      byPlatform[key].spend += spend;
      byPlatform[key].impressions += impressions;
      byPlatform[key].reach += reach;
      if (item.actions) {
        item.actions.forEach((a) => {
          const type = a.action_type;
          byPlatform[key].actions[type] =
            (byPlatform[key].actions[type] || 0) + parseInt(a.value);
        });
      }
    });
    return byPlatform;
  } catch (err) {
    console.error("❌ Error fetching breakdown platform_position:", err);
    return null;
  }
}
async function fetchAdsetActionsByDevice(ad_id) {
  try {
    const url = `${BASE_URL}/${ad_id}/insights?fields=spend,impressions,reach,actions&breakdowns=impression_device&time_range[since]=${startDate}&time_range[until]=${endDate}&access_token=${META_TOKEN}`;
    const data = await fetchJSON(url);
    const results = data.data || [];
    const byDevice = {};
    results.forEach((item) => {
      const device = item.impression_device || "unknown";
      const spend = parseFloat(item.spend || 0);
      const impressions = parseInt(item.impressions || 0);
      const reach = parseInt(item.reach || 0);
      if (!byDevice[device])
        byDevice[device] = { spend: 0, impressions: 0, reach: 0, actions: {} };
      byDevice[device].spend += spend;
      byDevice[device].impressions += impressions;
      byDevice[device].reach += reach;
      if (item.actions) {
        item.actions.forEach((a) => {
          const type = a.action_type;
          byDevice[device].actions[type] =
            (byDevice[device].actions[type] || 0) + parseInt(a.value);
        });
      }
    });
    return byDevice;
  } catch (err) {
    console.error("❌ Error fetching breakdown device:", err);
    return null;
  }
}

async function fetchAdDailyInsights(ad_id) {
  try {
    if (!ad_id) throw new Error("ad_id is required");
    const url = `${BASE_URL}/${ad_id}/insights?fields=spend,impressions,reach,actions&time_increment=1&time_range[since]=${startDate}&time_range[until]=${endDate}&access_token=${META_TOKEN}`;
    const data = await fetchJSON(url);
    const results = data.data || [];
    const byDate = {};

    results.forEach((item) => {
      const date = item.date_start;
      const spend = parseFloat(item.spend || 0);
      const impressions = parseInt(item.impressions || 0);
      const reach = parseInt(item.reach || 0);
      if (!byDate[date]) {
        byDate[date] = { spend: 0, impressions: 0, reach: 0, actions: {} };
      }
      byDate[date].spend += spend;
      byDate[date].impressions += impressions;
      byDate[date].reach += reach;
      if (item.actions) {
        item.actions.forEach((a) => {
          const type = a.action_type;
          byDate[date].actions[type] =
            (byDate[date].actions[type] || 0) + parseInt(a.value);
        });
      }
    });
    return byDate;
  } catch (err) {
    console.error("❌ Error fetching daily breakdown for ad", ad_id, err);
    return null;
  }
}

// ===================== HIỂN THỊ CHI TIẾT AD =====================
async function showAdDetail(ad_id) {
  if (!ad_id) return;
  const detailBox = document.querySelector(".dom_detail");
  if (!detailBox) return;
  detailBox.classList.add("active");

  // Hủy chart cũ
  if (window.detail_spent_chart_instance)
    window.detail_spent_chart_instance.destroy();
  if (window.chart_by_hour_chart) window.chart_by_hour_chart.destroy();
  if (window.chart_by_age_gender_chart)
    window.chart_by_age_gender_chart.destroy();
  if (window.chart_by_region_chart) window.chart_by_region_chart.destroy();
  if (window.chart_by_device_chart) window.chart_by_device_chart.destroy();
  if (window.chart_by_platform_chart) window.chart_by_platform_chart.destroy();
  window.detail_spent_chart_instance = null;

  try {
    // ================== Fetch all API ==================
    const [
      targeting,
      byHour,
      byAgeGender,
      byRegion,
      byPlatform,
      byDevice,
      byDate,
    ] = await Promise.all([
      fetchAdsetTargeting(ad_id),
      fetchAdsetActionsByHour(ad_id),
      fetchAdsetActionsByAgeGender(ad_id),
      fetchAdsetActionsByRegion(ad_id),
      fetchAdsetActionsByPlatformPosition(ad_id),
      fetchAdsetActionsByDevice(ad_id),
      fetchAdDailyInsights(ad_id),
    ]);

    // ================== Tổng số liệu ==================
    // const totalSpend = calcTotal(byDate, "spend");
    // const totalResult = getResults(byDate);
    // const cpr = totalResult ? totalSpend / totalResult : 0;

    // // --- Gán vào DOM ---
    // const goalEl = document.querySelector("#detail_goal span");
    // const resultEl = document.querySelector("#detail_result span");
    // const cprEl = document.querySelector("#detail_cpr span");

    // if (goalEl) goalEl.textContent = VIEW_GOAL;

    // if (resultEl)
    //   resultEl.textContent = totalResult ? formatNumber(totalResult) : "0";

    // if (cprEl) cprEl.textContent = totalResult ? formatMoney(cpr) : "-";

    // ================== Render Targeting ==================
    renderTargetingToDOM(targeting);

    // ================== Render Interaction ==================
    renderInteraction(byDevice);
    window.dataByDate = byDate;

    // ================== Render Chart ==================
    renderCharts({
      byHour,
      byAgeGender,
      byRegion,
      byPlatform,
      byDevice,
      byDate,
    });

    renderChartByPlatform({
      byAgeGender,
      byRegion,
      byPlatform,
      byDevice,
      // byDate,
    });
  } catch (err) {
    console.error("❌ Error loading ad detail:", err);
  }
}
// ================== LỌC THEO TỪ KHÓA ==================
document.getElementById("filter").addEventListener("input", (e) => {
  const keyword = e.target.value.trim().toLowerCase();
  applyCampaignFilter(keyword);
});

async function applyCampaignFilter(keyword) {
  if (!window._ALL_CAMPAIGNS || !Array.isArray(window._ALL_CAMPAIGNS)) return;

  // 🔹 Lọc campaign theo tên (không phân biệt hoa thường)
  const filtered = keyword
    ? window._ALL_CAMPAIGNS.filter((c) =>
        (c.name || "").toLowerCase().includes(keyword)
      )
    : window._ALL_CAMPAIGNS;

  // 🔹 Render lại danh sách và tổng quan
  renderCampaignView(filtered);
  // updateSummaryUI(filtered);

  // 🔹 Lấy ID campaign hợp lệ để gọi API (lọc bỏ null)
  const ids = filtered.map((c) => c.id).filter(Boolean);
  loadPlatformSummary(ids);
  loadSpendPlatform(ids);
  const dailyData = ids.length ? await fetchDailySpendByCampaignIDs(ids) : [];
  renderDetailDailyChart2(dailyData, "spend");

  // 🔹 Render lại goal chart (dựa theo ad-level)
  const allAds = filtered.flatMap((c) =>
    c.adsets.flatMap((as) =>
      (as.ads || []).map((ad) => ({
        optimization_goal: as.optimization_goal,
        insights: { spend: ad.spend || 0 },
      }))
    )
  );
  renderGoalChart(allAds);
}

// ================== CẬP NHẬT TỔNG UI ==================
function updateSummaryUI(campaigns) {
  let totalSpend = 0,
    totalReach = 0,
    totalMessage = 0,
    totalLead = 0;

  if (!Array.isArray(campaigns)) return;

  campaigns.forEach((c) => {
    (c.adsets || []).forEach((as) => {
      totalSpend += +as.spend || 0;
      totalReach += +as.reach || 0;
      totalMessage += +as.message || 0;
      totalLead += +as.lead || 0;
    });
  });

  document.querySelector(
    "#spent span"
  ).textContent = `${totalSpend.toLocaleString("vi-VN")}đ`;
  document.querySelector(
    "#reach span"
  ).textContent = `${totalReach.toLocaleString("vi-VN")}`;
  document.querySelector(
    "#message span"
  ).textContent = `${totalMessage.toLocaleString("vi-VN")}`;
  document.querySelector(
    "#lead span"
  ).textContent = `${totalLead.toLocaleString("vi-VN")}`;
}

// ================== TẠO DỮ LIỆU THEO NGÀY ==================
function buildDailyDataFromCampaigns(campaigns) {
  const mapByDate = {};
  (campaigns || []).forEach((c) => {
    (c.adsets || []).forEach((as) => {
      const spend = +as.spend || 0;
      const dateKey = as.date_start || "Tổng";
      if (!mapByDate[dateKey])
        mapByDate[dateKey] = { date_start: dateKey, spend: 0 };
      mapByDate[dateKey].spend += spend;
    });
  });
  return Object.values(mapByDate);
}

// ================== LẤY DAILY SPEND THEO CAMPAIGN ==================
async function fetchDailySpendByCampaignIDs(campaignIds) {
  try {
    if (!Array.isArray(campaignIds) || campaignIds.length === 0)
      throw new Error("Campaign IDs are required");
    if (!ACCOUNT_ID) throw new Error("ACCOUNT_ID is required");

    const filtering = encodeURIComponent(
      JSON.stringify([
        { field: "campaign.id", operator: "IN", value: campaignIds },
      ])
    );

    const url = `${BASE_URL}/act_${ACCOUNT_ID}/insights?fields=spend,impressions,reach,actions,campaign_name,campaign_id&time_increment=1&filtering=${filtering}&time_range={"since":"${startDate}","until":"${endDate}"}&access_token=${META_TOKEN}`;

    const data = await fetchJSON(url);
    const results = data.data || [];

    console.log("📊 Daily spend filtered by campaign IDs:", results);
    return results;
  } catch (err) {
    console.error("❌ Error fetching daily spend by campaign IDs", err);
    return [];
  }
}

// ================== Tổng hợp dữ liệu ==================
function calcTotal(data, key) {
  if (!data) return 0;
  return Object.values(data).reduce((sum, d) => sum + (d[key] || 0), 0);
}
function calcTotalAction(data, type) {
  if (!data) return 0;
  return Object.values(data).reduce(
    (sum, d) => sum + (d.actions?.[type] || 0),
    0
  );
}

// ================== Render Targeting ==================
function renderTargetingToDOM(targeting) {
  const targetBox = document.getElementById("detail_targeting");
  if (!targetBox) return;

  // === Age ===
  const ageDivs = targetBox.querySelectorAll(".detail_gender .age_text p");
  if (ageDivs.length >= 2) {
    ageDivs[0].textContent = targeting.age_min || 18;
    ageDivs[1].textContent = targeting.age_max || 65;
  }

  const ageBar = targetBox.querySelector(".detail_age_bar");
  if (ageBar) {
    const min = Number(targeting.age_min || 18);
    const max = Number(targeting.age_max || 65);
    const fullMin = 18;
    const fullMax = 65;

    const leftPercent = ((min - fullMin) / (fullMax - fullMin)) * 100;
    const widthPercent = ((max - min) / (fullMax - fullMin)) * 100;

    let rangeEl = ageBar.querySelector(".age_range");
    if (!rangeEl) {
      rangeEl = document.createElement("div");
      rangeEl.className = "age_range";
      ageBar.appendChild(rangeEl);
    }
    rangeEl.style.left = `${leftPercent}%`;
    rangeEl.style.width = `${widthPercent}%`;
  }

  // === Gender ===
  const genderWrap = targetBox.querySelector(".detail_gender_bar");
  if (genderWrap) {
    const genders = Array.isArray(targeting.genders) ? targeting.genders : [];
    const validGenders = genders
      .map(String)
      .filter((g) => ["male", "female", "other"].includes(g.toLowerCase()));

    if (validGenders.length) {
      genderWrap.innerHTML = validGenders.map((g) => `<p>${g}</p>`).join("");
    } else {
      genderWrap.innerHTML = `<p>Male</p><p>Female</p><p>Other</p>`;
    }
  }

  // === Locations ===
  const locationWrap = targetBox.querySelector(".detail_location_bar");
  if (locationWrap) {
    let locations = [];

    if (targeting.geo_locations?.cities) {
      locations = targeting.geo_locations.cities.map(
        (c) => `${c.name} (${c.radius}km)`
      );
    }

    if (targeting.geo_locations?.regions) {
      locations = locations.concat(
        targeting.geo_locations.regions.map((r) => r.name)
      );
    }
    if (targeting.geo_locations?.custom_locations) {
      locations = locations.concat(
        targeting.geo_locations.custom_locations.map((r) => r.name)
      );
    }
    if (targeting.geo_locations?.places) {
      locations = locations.concat(
        targeting.geo_locations.places.map((r) => r.name)
      );
    }

    if (locations.length) {
      locationWrap.innerHTML = locations
        .slice(0, 5)
        .map(
          (c) =>
            `<p><i class="fa-solid fa-location-crosshairs"></i><span>${c}</span></p>`
        )
        .join("");
    } else {
      locationWrap.innerHTML = `<p><i class="fa-solid fa-location-crosshairs"></i><span>Việt Nam</span></p>`;
    }
  }

  // === Frequency Tags (Interests / Education / Industries / Behaviour) ===
  // === Frequency Tags (tổng hợp toàn bộ flexible_spec) ===
  const freqWrap = targetBox.querySelector(".frequency_tag");
  if (freqWrap) {
    const tags = [];

    const flex = targeting.flexible_spec || [];
    flex.forEach((fs) => {
      for (const [key, arr] of Object.entries(fs)) {
        if (!Array.isArray(arr)) continue;
        arr.forEach((item) => {
          // Ưu tiên name, nếu không có thì hiển thị giá trị trực tiếp
          const name = item?.name || item;
          const cleanKey = key
            .replace(/_/g, " ")
            .replace(/\b\w/g, (c) => c.toUpperCase());
          tags.push(`${name} (${cleanKey})`);
        });
      }
    });

    freqWrap.innerHTML = tags.length
      ? tags
          .map(
            (t) =>
              `<p class="freq_tag_item"><span class="tag_dot"></span><span class="tag_name">${t}</span></p>`
          )
          .join("")
      : `<p class="freq_tag_item"><span class="tag_dot"></span><span class="tag_name">Automatic Target</span></p>`;
  }

  // === Advantage Audience ===
  const optimizeWrap = targetBox.querySelector(".detail_optimize");
  if (optimizeWrap) {
    const adv =
      targeting.targeting_automation?.advantage_audience === 0
        ? "No Advantage Audience"
        : "Advantage Audience";
    optimizeWrap.textContent = adv;
  }
}

// ================== Render Interaction ==================
function renderInteraction(byDate) {
  const wrap = document.querySelector(".interaction");
  if (!wrap) return;

  const metrics = [
    {
      key: "post_reaction",
      label: "Reactions",
      icon: "fa-solid fa-heart",
    },
    {
      key: "comment",
      label: "Comments",
      icon: "fa-solid fa-comment",
    },
    {
      key: "post",
      label: "Shares",
      icon: "fa-solid fa-share-nodes",
    },

    {
      key: "post_save",
      label: "Saves",
      icon: "fa-solid fa-bookmark",
    },
    {
      key: "page_engagement",
      label: "Page Engage",
      icon: "fa-solid fa-bolt",
    },
    {
      key: "link_click",
      label: "Link Clicks",
      icon: "fa-solid fa-link",
    },
    {
      key: "video_view",
      label: "Video Views",
      icon: "fa-solid fa-video",
    },
    {
      key: "photo_view",
      label: "Photo Views",
      icon: "fa-solid fa-video",
    },
    {
      key: "onsite_conversion.messaging_conversation_started_7d",
      label: "Messages",
      icon: "fa-solid fa-message",
    },
  ];

  // Tính tổng từng hành động
  const totals = {};
  metrics.forEach((m) => {
    totals[m.key] = calcTotalAction(byDate, m.key);
  });

  // Render UI
  const html = `
      <div class="interaction_list">
        ${metrics
          .map(
            (m) => `
            <div class="dom_interaction_note">
                    <span class="metric_label">${m.label}</span>
              <span class="metric_value">${formatNumber(
                totals[m.key] || 0
              )}</span>
                  </div>
          `
          )
          .join("")}
    </div>
  `;

  wrap.innerHTML = html;
}
// function getResult(item) { ... } // <--- ĐÃ XÓA, gộp vào getResults(item)

function formatMoneyShort(v) {
  if (v >= 1_000_000) {
    const m = Math.floor(v / 1_000_000);
    const k = Math.floor((v % 1_000_000) / 10000); // Lấy 2 số
    return k > 0 ? `${m}.${k.toString().padStart(2, "0")}M` : `${m}M`; // 1.25M
  }
  if (v >= 1_000) {
    const k = Math.floor(v / 1_000);
    return `${k}k`;
  }
  return v ? v.toString() : "0";
}

// ================== Vẽ chart ==================
// ----------------- Line Chart: detail_spent_chart -----------------
let currentDetailDailyType = "spend"; // default

function renderDetailDailyChart(dataByDate, type = currentDetailDailyType) {
  if (!dataByDate) return;
  currentDetailDailyType = type;

  const ctx = document.getElementById("detail_spent_chart");
  if (!ctx) return;

  const dates = Object.keys(dataByDate).sort();
  if (!dates.length) return;

  const chartData = dates.map((d) => {
    const item = dataByDate[d] || {};
    if (type === "spend") return item.spend || 0;
    if (type === "lead") return getResults(item);
    if (type === "reach") return item.reach || 0;
    if (type === "message")
      return (
        item.actions["onsite_conversion.messaging_conversation_started_7d"] || 0
      );
    return 0;
  });

  const maxValue = chartData.length ? Math.max(...chartData) : 0;
  const c2d = ctx.getContext("2d");

  // 🎨 Gradient tone IDEAS
  const gLine = c2d.createLinearGradient(0, 0, 0, 400);
  if (type === "spend") {
    gLine.addColorStop(0, "rgba(255,169,0,0.2)");
    gLine.addColorStop(1, "rgba(255,171,0,0.05)");
  } else {
    gLine.addColorStop(0, "rgba(38,42,83,0.2)");
    gLine.addColorStop(1, "rgba(38,42,83,0.05)");
  }

  // 🌀 Nếu đã có chart → update
  if (window.detail_spent_chart_instance) {
    const chart = window.detail_spent_chart_instance;
    chart.data.labels = dates;
    chart.data.datasets[0].data = chartData;
    chart.data.datasets[0].label = type.charAt(0).toUpperCase() + type.slice(1);
    chart.data.datasets[0].borderColor =
      type === "spend" ? "#ffab00" : "#262a53";
    chart.data.datasets[0].backgroundColor = gLine;
    chart.options.scales.y.suggestedMax = maxValue * 1.1;
    chart.update("active");
    return;
  }

  // 🆕 Nếu chưa có chart → tạo mới
  window.detail_spent_chart_instance = new Chart(ctx, {
    type: "line",
    data: {
      labels: dates,
      datasets: [
        {
          label: type.charAt(0).toUpperCase() + type.slice(1),
          data: chartData,
          backgroundColor: gLine,
          borderColor: type === "spend" ? "#ffab00" : "#262a53",
          fill: true,
          tension: 0.3,
          pointRadius: 3,
          pointBackgroundColor:
            type === "spend" ? "#ffab00" : "rgba(38,42,83,0.9)",
          borderWidth: 3,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 600, easing: "easeOutQuart" },
      layout: { padding: { left: 20, right: 20, top: 10, bottom: 10 } },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (c) =>
              `${c.dataset.label}: ${
                type === "spend" ? formatMoneyShort(c.raw) : c.raw
              }`,
          },
        },
        datalabels: {
          anchor: "end",
          align: "end",
          offset: 4,
          font: { size: 11, weight: "600" },
          color: "#444",
          formatter: (v) =>
            v > 0 ? (type === "spend" ? formatMoneyShort(v) : v) : "",
        },
      },
      scales: {
        x: {
          grid: {
            color: "rgba(0,0,0,0.03)", // ✅ lưới nhẹ
            drawBorder: true,
          },
          border: { color: "rgba(0,0,0,0.15)" },
          ticks: { display: false }, // ❌ ẩn label ngày
        },
        y: {
          grid: {
            color: "rgba(0,0,0,0.03)", // ✅ lưới nhẹ
            drawBorder: true,
          },
          border: { color: "rgba(0,0,0,0.15)" },
          beginAtZero: true,
          suggestedMax: maxValue * 1.1, // ✅ scale cao hơn
          ticks: { display: false }, // ❌ ẩn số tick
        },
      },
    },
    plugins: [ChartDataLabels],
  });
}

// ----------------- xử lý filter -----------------
function setupDetailDailyFilter2() {
  const qualitySelect = document.querySelector(".dom_select.daily_total");
  if (!qualitySelect) return;

  const list = qualitySelect.querySelector("ul.dom_select_show");
  const selectedEl = qualitySelect.querySelector(".dom_selected");
  const allItems = list.querySelectorAll("li");

  // 🧩 Toggle dropdown
  qualitySelect.onclick = (e) => {
    e.stopPropagation();
    const isActive = list.classList.contains("active");
    document
      .querySelectorAll(".dom_select_show.active")
      .forEach((ul) => ul.classList.remove("active"));
    list.classList.toggle("active", !isActive);
  };

  // 🧠 Chọn loại hiển thị
  allItems.forEach((li) => {
    li.onclick = (e) => {
      e.stopPropagation();
      const type = li.dataset.view?.trim(); // <-- lấy data-view chuẩn

      if (!type) return;

      // Nếu đã active thì chỉ đóng dropdown
      if (li.classList.contains("active")) {
        list.classList.remove("active");
        return;
      }

      // reset trạng thái
      allItems.forEach((el) => el.classList.remove("active"));
      list
        .querySelectorAll(".radio_box")
        .forEach((r) => r.classList.remove("active"));

      // set active cho item mới
      li.classList.add("active");
      const radio = li.querySelector(".radio_box");
      if (radio) radio.classList.add("active");

      // đổi text hiển thị
      const textEl = li.querySelector("span:nth-child(2)");
      if (textEl) selectedEl.textContent = textEl.textContent.trim();
      console.log(type);

      // 🎯 render chart với type mới (nếu có data)
      if (typeof renderDetailDailyChart2 === "function" && DAILY_DATA) {
        renderDetailDailyChart2(DAILY_DATA, type);
      }

      // đóng dropdown
      list.classList.remove("active");
    };
  });

  // 🔒 Click ra ngoài → đóng dropdown
  document.addEventListener("click", (e) => {
    if (!qualitySelect.contains(e.target)) {
      list.classList.remove("active");
    }
  });
}

// ----------------- Generic Bar Chart with 2 Y axes -----------------
function renderBarChart(id, data) {
  if (!data) return;
  const ctx = document.getElementById(id);
  if (!ctx) return;
  const c2d = ctx.getContext("2d");

  const labels = Object.keys(data);
  const spentData = labels.map((l) => data[l].spend || 0);
  const resultData = labels.map((l) => getResults(data[l])); // <--- SỬA Ở ĐÂY

  if (window[`${id}_chart`]) window[`${id}_chart`].destroy(); // Hủy chart cũ

  window[`${id}_chart`] = new Chart(c2d, {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: "Spent",
          data: spentData,
          backgroundColor: "rgba(255,171,0,0.9)",
          borderColor: "rgba(255,171,0,1)",
          borderWidth: 1,
          yAxisID: "ySpent",
        },
        {
          label: "Result",
          data: resultData,
          backgroundColor: "rgba(38,42,83,0.9)",
          borderColor: "rgba(38,42,83,1)",
          borderWidth: 1,
          yAxisID: "yResult",
        },
      ],
    },
    options: {
      responsive: true,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (c) => {
              const val = c.raw || 0;
              return `${c.dataset.label}: ${
                c.dataset.label === "Spent" ? formatMoneyShort(val) : val
              }`;
            },
          },
        },
        datalabels: {
          anchor: "end",
          align: "end",
          font: { weight: "bold", size: 12 },
          color: "#666",
          formatter: (v) => (v > 0 ? formatMoneyShort(v) : ""), // Dùng format short
        },
      },
      scales: {
        x: { grid: { color: "rgba(0,0,0,0.05)" }, ticks: { color: "#444" } },
        ySpent: {
          type: "linear",
          position: "left",
          beginAtZero: true,
          ticks: { callback: (v) => formatMoneyShort(v), color: "#ffab00" }, // Dùng format short
          grid: { drawOnChartArea: true, color: "rgba(0,0,0,0.05)" },
        },
        yResult: {
          type: "linear",
          position: "right",
          beginAtZero: true,
          ticks: { callback: (v) => v, color: "#262a53" },
          grid: { drawOnChartArea: false },
        },
      },
    },
    plugins: [ChartDataLabels],
  });
}
function renderChartByHour(dataByHour) {
  if (!dataByHour) return;

  const ctx = document.getElementById("chart_by_hour");
  if (!ctx) return;

  const hourKeys = Object.keys(dataByHour).sort(
    (a, b) => parseInt(a.slice(0, 2)) - parseInt(b.slice(0, 2))
  );
  const labels = hourKeys.map((h) => parseInt(h.slice(0, 2), 10) + "h");

  const spentData = hourKeys.map((h) => dataByHour[h].spend || 0);
  const resultData = hourKeys.map((h) => getResults(dataByHour[h]));

  const maxSpent = Math.max(...spentData) || 1;
  const maxResult = Math.max(...resultData) || 1;

  const c2d = ctx.getContext("2d");

  // 🎨 Gradient
  const gSpent = c2d.createLinearGradient(0, 0, 0, 300);
  gSpent.addColorStop(0, "rgba(255,169,0,0.2)");
  gSpent.addColorStop(1, "rgba(255,169,0,0.05)");

  const gResult = c2d.createLinearGradient(0, 0, 0, 300);
  gResult.addColorStop(0, "rgba(38,42,83,0.2)");
  gResult.addColorStop(1, "rgba(38,42,83,0.05)");

  if (window.chartByHourInstance) window.chartByHourInstance.destroy();

  window.chartByHourInstance = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "Spent",
          data: spentData,
          backgroundColor: gSpent,
          borderColor: "#ffab00",
          fill: true,
          tension: 0.4,
          pointRadius: 3,
          pointBackgroundColor: "#ffab00",
          borderWidth: 2,
          yAxisID: "ySpent",
        },
        {
          label: "Result",
          data: resultData,
          backgroundColor: gResult,
          borderColor: "#262a53",
          fill: true,
          tension: 0.4,
          pointRadius: 3,
          pointBackgroundColor: "#262a53",
          borderWidth: 2,
          yAxisID: "yResult",
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 600, easing: "easeOutQuart" },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (c) =>
              `${c.dataset.label}: ${
                c.dataset.label === "Spent" ? formatMoneyShort(c.raw) : c.raw
              }`,
          },
        },
        datalabels: {
          anchor: "end",
          align: "end",
          offset: 4,
          font: { size: 11 },
          color: "#666",
          formatter: (v, ctx) =>
            ctx.dataset.label === "Spent"
              ? formatMoneyShort(v)
              : v > 0
              ? v
              : "",
        },
      },
      scales: {
        x: {
          grid: { color: "rgba(0,0,0,0.03)", drawBorder: true },
          border: { color: "rgba(0,0,0,0.15)" },
          ticks: {
            color: "#444",
            font: { size: 11 },
            maxRotation: 0,
            minRotation: 0,
          },
        },
        ySpent: {
          type: "linear",
          position: "left",
          grid: { color: "rgba(0,0,0,0.03)", drawBorder: true },
          border: { color: "rgba(0,0,0,0.15)" },
          beginAtZero: true,
          suggestedMax: maxSpent * 1.1, // 🔹 tăng nhẹ cho spent
          ticks: { display: false },
        },
        yResult: {
          type: "linear",
          position: "right",
          grid: { drawOnChartArea: false },
          border: { color: "rgba(0,0,0,0.15)" },
          beginAtZero: true,
          suggestedMax: maxResult * 1.2, // 🔥 nâng riêng result 1.2x
          ticks: { display: false },
        },
      },
    },
    plugins: [ChartDataLabels],
  });
}

function renderChartByDevice(dataByDevice) {
  if (!dataByDevice) return;

  const ctx = document.getElementById("chart_by_device");
  if (!ctx) return;
  const c2d = ctx.getContext("2d");

  // Chuẩn hoá tên thiết bị
  const prettyName = (key) => {
    key = key.toLowerCase();
    if (key.includes("android")) return "Android";
    if (key.includes("iphone")) return "iPhone";
    if (key.includes("ipad")) return "iPad";
    if (key.includes("tablet")) return "Tablet";
    if (key.includes("desktop")) return "Desktop";
    return key.charAt(0).toUpperCase() + key.slice(1);
  };

  // Lọc chỉ giữ thiết bị có result > 0
  const validEntries = Object.entries(dataByDevice)
    .map(([k, v]) => [prettyName(k), getResults(v) || 0])
    .filter(([_, val]) => val > 0);

  // Nếu không có dữ liệu hợp lệ thì thoát
  if (!validEntries.length) {
    if (window.chart_by_device_instance)
      window.chart_by_device_instance.destroy();
    return;
  }

  // Sắp xếp giảm dần theo result
  validEntries.sort((a, b) => b[1] - a[1]);

  const labels = validEntries.map(([k]) => k);
  const resultData = validEntries.map(([_, v]) => v);

  // Màu: 2 cái lớn nhất nổi bật, còn lại nhạt hơn
  const highlightColors = [
    "rgba(255,171,0,0.9)", // vàng
    "rgba(38,42,83,0.9)", // xanh đậm
  ];
  const fallbackColors = [
    "rgba(156,163,175,0.7)",
    "rgba(0, 59, 59, 0.7)",
    "rgba(0, 71, 26, 0.7)",
    "rgba(153, 0, 0, 0.7)",
  ];

  const colors = resultData.map((_, i) =>
    i < 2 ? highlightColors[i] : fallbackColors[i - 2] || "#ccc"
  );

  if (window.chart_by_device_instance)
    window.chart_by_device_instance.destroy();

  window.chart_by_device_instance = new Chart(c2d, {
    type: "pie",
    data: {
      labels,
      datasets: [
        {
          label: "Result",
          data: resultData,
          backgroundColor: colors,
          borderColor: "#fff",
          borderWidth: 2,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false, // Không set width/height
      plugins: {
        legend: {
          position: "bottom",
          labels: { color: "#333", boxWidth: 14, padding: 12 },
        },
        tooltip: {
          callbacks: {
            label: (c) => `${c.label}: ${c.raw}`,
          },
        },
        datalabels: {
          color: "#fff",
          font: { weight: "bold", size: 11 },
          formatter: (v, ctx) => {
            const total = ctx.chart.data.datasets[0].data.reduce(
              (a, b) => a + b,
              0
            );
            const pct = total ? ((v / total) * 100).toFixed(1) + "%" : "";
            return pct;
          },
        },
      },
      hoverOffset: 10, // hiệu ứng nổi khi hover
    },
    plugins: [ChartDataLabels],
  });
}
function renderChartByRegion(dataByRegion) {
  if (!dataByRegion) return;

  const ctx = document.getElementById("chart_by_region");
  if (!ctx) return;
  const c2d = ctx.getContext("2d");

  const prettyName = (key) =>
    key
      .replace(/province/gi, "")
      .trim()
      .replace(/^\w/, (c) => c.toUpperCase());

  // Chuẩn hóa & tính tổng spend
  const entries = Object.entries(dataByRegion).map(([k, v]) => ({
    name: prettyName(k),
    spend: v.spend || 0,
    result: getResults(v) || 0,
  }));

  const totalSpend = entries.reduce((acc, e) => acc + e.spend, 0);
  const minSpend = totalSpend * 0.02; // lọc 2%

  const filtered = entries.filter((r) => r.spend >= minSpend);
  if (!filtered.length) {
    if (window.chart_by_region_instance)
      window.chart_by_region_instance.destroy();
    return;
  }

  filtered.sort((a, b) => b.spend - a.spend);
  const labels = filtered.map((e) => e.name);
  const spentData = filtered.map((e) => e.spend);
  const resultData = filtered.map((e) => e.result);

  if (window.chart_by_region_instance)
    window.chart_by_region_instance.destroy();

  // 🎨 Gradient đẹp
  const gradientSpent = c2d.createLinearGradient(0, 0, 0, 300);
  gradientSpent.addColorStop(0, "rgba(255,193,7,1)");
  gradientSpent.addColorStop(1, "rgba(255,171,0,0.8)");

  const gradientResult = c2d.createLinearGradient(0, 0, 0, 300);
  gradientResult.addColorStop(0, "rgba(38,42,83,1)");
  gradientResult.addColorStop(1, "rgba(38,42,83,0.8)");

  window.chart_by_region_instance = new Chart(c2d, {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: "Spent",
          data: spentData,
          backgroundColor: gradientSpent,
          borderWidth: 0,
          borderRadius: 6,
          yAxisID: "ySpend",
        },
        {
          label: "Result",
          data: resultData,
          backgroundColor: gradientResult,
          borderWidth: 0,
          borderRadius: 6,
          yAxisID: "yResult",
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      layout: {
        padding: { left: 10, right: 10 },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) =>
              `${ctx.dataset.label}: ${
                ctx.dataset.label === "Spent"
                  ? formatMoneyShort(ctx.raw)
                  : ctx.raw
              }`,
          },
        },
        datalabels: {
          anchor: "end",
          align: "end",
          offset: 2,
          font: { weight: "600", size: 11 },
          color: "#666",
          formatter: (value, ctx) =>
            ctx.dataset.label === "Spent"
              ? formatMoneyShort(value)
              : value > 0
              ? value
              : "",
        },
      },
      scales: {
        x: {
          grid: {
            color: "rgba(0,0,0,0.03)", // ✅ grid mảnh
            drawBorder: true,
          },
          border: { color: "rgba(0,0,0,0.15)" }, // ✅ trục X rõ nhẹ
          ticks: {
            color: "#444",
            font: { weight: "600", size: 11 },
            maxRotation: 0,
            minRotation: 0,
          },
        },
        ySpend: {
          type: "linear",
          position: "left",
          grid: {
            color: "rgba(0,0,0,0.03)",
            drawBorder: true,
          },
          border: { color: "rgba(0,0,0,0.15)" },
          beginAtZero: true,
          suggestedMax: Math.max(...spentData) * 1.1,
          ticks: { display: false }, // ❌ không hiện số
        },
        yResult: {
          type: "linear",
          position: "right",
          grid: { drawOnChartArea: false },
          beginAtZero: true,
          suggestedMax: Math.max(...resultData) * 1.1,
          ticks: { display: false }, // ❌ không hiện số
        },
      },
      animation: { duration: 600, easing: "easeOutQuart" },
    },
    plugins: [ChartDataLabels],
  });
}

function renderChartByAgeGender(dataByAgeGender) {
  if (!dataByAgeGender) return;

  const ctx = document.getElementById("chart_by_age_gender");
  if (!ctx) return;
  const c2d = ctx.getContext("2d");

  const ageGroups = {};

  // 🔹 Gom dữ liệu theo age & gender (kể cả Unknown)
  for (const [key, val] of Object.entries(dataByAgeGender)) {
    const lowerKey = key.toLowerCase();

    let gender = "unknown";
    if (lowerKey.includes("female")) gender = "female";
    else if (lowerKey.includes("male")) gender = "male";

    const age = key
      .replace(/_/g, " ")
      .replace(/male|female|unknown/gi, "")
      .trim()
      .toUpperCase();

    if (!ageGroups[age]) ageGroups[age] = { male: 0, female: 0, unknown: 0 };
    ageGroups[age][gender] = getResults(val) || 0;
  }

  const ages = Object.keys(ageGroups);
  const maleData = ages.map((a) => ageGroups[a].male);
  const femaleData = ages.map((a) => ageGroups[a].female);
  const unknownData = ages.map((a) => ageGroups[a].unknown);

  if (window.chart_by_age_gender_instance)
    window.chart_by_age_gender_instance.destroy();

  // 🎨 Gradient màu cho từng giới tính
  const gradientMale = c2d.createLinearGradient(0, 0, 0, 300);
  gradientMale.addColorStop(0, "rgba(255,169,0,1)");
  gradientMale.addColorStop(1, "rgba(255,169,0,0.8)");

  const gradientFemale = c2d.createLinearGradient(0, 0, 0, 300);
  gradientFemale.addColorStop(0, "rgba(38,42,83,1)");
  gradientFemale.addColorStop(1, "rgba(38,42,83,0.8)");

  const gradientUnknown = c2d.createLinearGradient(0, 0, 0, 300);
  gradientUnknown.addColorStop(0, "rgba(180,180,180,1)");
  gradientUnknown.addColorStop(1, "rgba(150,150,150,0.8)");

  window.chart_by_age_gender_instance = new Chart(c2d, {
    type: "bar",
    data: {
      labels: ages,
      datasets: [
        {
          label: "Male",
          data: maleData,
          backgroundColor: gradientMale,
          borderWidth: 0,
          borderRadius: 5,
        },
        {
          label: "Female",
          data: femaleData,
          backgroundColor: gradientFemale,
          borderWidth: 0,
          borderRadius: 5,
        },
        {
          label: "Unknown",
          data: unknownData,
          backgroundColor: gradientUnknown,
          borderWidth: 0,
          borderRadius: 5,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      layout: {
        padding: { left: 10, right: 10 },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) => `${ctx.dataset.label}: ${ctx.raw}`,
          },
        },
        datalabels: {
          anchor: "end",
          align: "end",
          offset: 2,
          font: { weight: "600", size: 11 },
          color: "#666",
          formatter: (v) => (v > 0 ? v : ""),
        },
      },
      scales: {
        x: {
          display: true, // ✅ giữ label độ tuổi
          grid: {
            color: "rgba(0,0,0,0.03)", // ✅ thêm lưới mảnh
            drawBorder: true, // ✅ hiện trục X
          },
          border: { color: "rgba(0,0,0,0.15)" }, // ✅ line trục X rõ nhẹ
          ticks: {
            color: "#444",
            font: { weight: "600", size: 11 },
            maxRotation: 0,
            minRotation: 0,
          },
        },
        y: {
          display: true, // ✅ hiện trục & grid
          grid: {
            color: "rgba(0,0,0,0.03)", // ✅ lưới mảnh nhẹ
            drawBorder: true, // ✅ trục Y
          },
          border: { color: "rgba(0,0,0,0.15)" }, // ✅ line trục Y
          beginAtZero: true,
          suggestedMax:
            Math.max(...maleData, ...femaleData, ...unknownData) * 1.1,
          ticks: {
            display: false, // ❌ không hiển thị số
          },
        },
      },
      animation: { duration: 600, easing: "easeOutQuart" },
    },
    plugins: [ChartDataLabels],
  });
}

function renderChartByPlatform(allData) {
  const wrap = document.querySelector("#chart_by_platform .dom_toplist");
  if (!wrap || !allData) return;
  wrap.innerHTML = "";

  const formatName = (key) =>
    key
      .replace(/[_-]/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .trim();

  const sources = {
    byPlatform: "By Platform",
    byDevice: "By Device",
    byAgeGender: "By Age & Gender",
    byRegion: "By Region",
  };

  const getLogo = (key, groupKey = "") => {
    const k = key.toLowerCase();
    if (groupKey === "byDevice") {
      if (k.includes("iphone") || k.includes("ios"))
        return "https://upload.wikimedia.org/wikipedia/commons/f/fa/Apple_logo_black.svg";
      if (k.includes("android") || k.includes("mobile"))
        return "https://upload.wikimedia.org/wikipedia/commons/d/d7/Android_robot.svg";
      if (k.includes("desktop") || k.includes("pc"))
        return "https://ms.codes/cdn/shop/articles/this-pc-computer-display-windows-11-icon.png?v=1709255180";
    }
    if (groupKey === "byAgeGender") {
      return "https://i.sstatic.net/l60Hf.png";
    }
    if (groupKey === "byRegion") {
      return "https://i.sstatic.net/l60Hf.png";
    }
    if (k.includes("facebook"))
      return "https://upload.wikimedia.org/wikipedia/commons/0/05/Facebook_Logo_%282019%29.png";

    if (k.includes("instagram"))
      return "https://upload.wikimedia.org/wikipedia/commons/e/e7/Instagram_logo_2016.svg";
    return "https://i.sstatic.net/l60Hf.png";
  };

  let hasData = false;

  // 🧩 Duyệt tất cả nhóm data
  for (const [groupKey, groupLabel] of Object.entries(sources)) {
    const group = allData[groupKey];
    if (!group) continue;

    const items = [];
    for (const [key, val] of Object.entries(group)) {
      const spend = +val.spend || 0;
      const result = getResults(val);
      if (!spend || !result) continue;

      const goal = VIEW_GOAL;
      const cpr = goal === "REACH" ? (spend / result) * 1000 : spend / result;

      items.push({ key, spend, result, cpr, goal });
    }

    if (!items.length) continue;
    hasData = true;

    // Sort theo CPR tăng dần (tốt nhất → tệ nhất)
    items.sort((a, b) => a.cpr - b.cpr);
    const minCPR = items[0].cpr;
    const maxCPR = items[items.length - 1].cpr;

    // Divider group
    const divider = document.createElement("li");
    divider.className = "blank";
    divider.innerHTML = `<p><strong>${groupLabel}</strong></p>`;
    wrap.appendChild(divider);

    // Render từng dòng
    items.forEach((p) => {
      let color = "rgb(255,169,0)";
      if (p.cpr === minCPR) color = "rgb(0,133,29)";
      else if (p.cpr === maxCPR) color = "rgb(240,57,57)";
      const bg = color.replace("rgb", "rgba").replace(")", ",0.08)");

      const li = document.createElement("li");
      li.dataset.platform = p.key;
      li.innerHTML = `
        <p>
          <img src="${getLogo(p.key, groupKey)}" alt="${p.key}" />
          <span>${formatName(p.key)}</span>
        </p>
        <p><span class="total_spent"><i class="fa-solid fa-money-bill"></i> ${p.spend.toLocaleString()}đ</span></p>
        <p><span class="total_result"><i class="fa-solid fa-bullseye"></i> ${formatNumber(
          p.result
        )}</span></p>
        <p class="toplist_percent" style="color:${color};background:${bg}">
          ${formatMoney(p.cpr)}
        </p>
      `;
      wrap.appendChild(li);
    });
  }

  // Nếu rỗng toàn bộ
  if (!hasData) {
    wrap.innerHTML = `<li><p>Không có dữ liệu hợp lệ để hiển thị.</p></li>`;
  }
}

function renderDeepCPR(allData) {
  const wrap = document.querySelector("#deep_cpr .dom_toplist");
  if (!wrap) return;
  wrap.innerHTML = "";

  const sources = {
    byAgeGender: "By Age & Gender",
    byRegion: "By Region",
    byPlatform: "By Platform",
    byDevice: "By Device",
  };

  for (const [groupKey, groupName] of Object.entries(sources)) {
    const group = allData[groupKey];
    if (!group) continue;

    const groupItems = [];
    for (const [key, val] of Object.entries(group)) {
      const spend = +val.spend || 0;
      const result = getResults(val);
      if (!spend || !result) continue;
      const goal = VIEW_GOAL;
      // ✅ Chỉ nhân *1000 nếu goal = REACH
      const cpr = goal === "REACH" ? (spend / result) * 1000 : spend / result;
      groupItems.push({ key, spend, result, cpr, goal });
    }

    if (!groupItems.length) continue;

    groupItems.sort((a, b) => a.cpr - b.cpr);

    const divider = document.createElement("li");
    divider.className = "blank";
    divider.innerHTML = `<p><strong>${groupName}</strong></p>`;
    wrap.appendChild(divider);

    const minCPR = groupItems[0].cpr;
    const maxCPR = groupItems[groupItems.length - 1].cpr;

    groupItems.forEach((p) => {
      let color = "rgb(255,169,0)";
      if (p.cpr === minCPR) color = "rgb(0,133,29)";
      else if (p.cpr === maxCPR) color = "rgb(240,57,57)";
      const bg = color.replace("rgb", "rgba").replace(")", ",0.08)");

      const li = document.createElement("li");
      li.innerHTML = `
        <p><strong>${formatDeepName(p.key)}</strong></p>
        <p class="toplist_percent" style="color:${color};background:${bg}">
          ${formatMoney(p.cpr)} ${p.goal === "REACH" ? "" : ""}
        </p>
      `;
      wrap.appendChild(li);
    });
  }

  if (!wrap.children.length) {
    wrap.innerHTML = `<li><p>Không có dữ liệu đủ để phân tích.</p></li>`;
  }
}

// --- format tên key đẹp hơn ---

// --- format tên key đẹp hơn ---
function formatDeepName(key) {
  if (!key) return "-";
  return key
    .replace(/_/g, " ")
    .replace(/\bprovince\b/gi, "")
    .replace(/\bmale\b/gi, "Male")
    .replace(/\bfemale\b/gi, "Female")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// ----------------- Main function gọi các chart -----------------
function renderCharts({
  byHour,
  byAgeGender,
  byRegion,
  byPlatform,
  byDevice,
  byDate,
}) {
  renderDetailDailyChart(byDate, "spend"); // Render lần đầu với 'spend'
  renderChartByHour(byHour);
  renderChartByAgeGender(byAgeGender);
  renderChartByRegion(byRegion);
  renderChartByDevice(byDevice);
  // renderChartByPlatform(byPlatform);
}

// Khởi chạy
// let currentDetailDailyType = "spend";
// --- Hàm lấy giá trị cho chart từ item và type ---
function getChartValue(item, type) {
  const actions = item.actions || [];

  const typeMap = {
    lead: ["lead", "onsite_conversion.lead_grouped"],
    message: ["onsite_conversion.messaging_conversation_started_7d"],
    like: ["like"],
    spend: ["spend"],
    reach: ["reach"],
  };

  const keys = Array.isArray(typeMap[type]) ? typeMap[type] : [typeMap[type]];

  for (const k of keys) {
    if (k === "spend" && item.spend !== undefined) return +item.spend;
    if (k === "reach" && item.reach !== undefined) return +item.reach;

    const act = actions.find((a) => a.action_type === k);
    if (act) return +act.value;
  }

  return 0;
}

// --- Hàm vẽ chart chi tiết ---
function renderDetailDailyChart2(dataByDate, type = currentDetailDailyType) {
  if (!dataByDate) return;
  currentDetailDailyType = type;

  const ctx = document.getElementById("leadTrendChart");
  if (!ctx) return;

  const dates = Array.isArray(dataByDate)
    ? dataByDate.map((item) => item.date_start)
    : Object.keys(dataByDate);
  if (!dates.length) return;

  const dateMap = Array.isArray(dataByDate)
    ? Object.fromEntries(dataByDate.map((i) => [i.date_start, i]))
    : dataByDate;

  const chartData = dates.map((d) => {
    const item = dateMap[d] || {};
    return getChartValue(item, type);
  });

  const gLine = ctx.getContext("2d").createLinearGradient(0, 0, 0, 400);
  gLine.addColorStop(0, "rgba(255,169,0,0.25)");
  gLine.addColorStop(1, "rgba(255,171,0,0.05)");

  if (window.detail_spent_chart_instance2) {
    const chart = window.detail_spent_chart_instance2;
    if (chart.data.labels.join(",") !== dates.join(",")) {
      chart.data.labels = dates;
    }
    chart.data.datasets[0].data = chartData;
    chart.update({ duration: 500, easing: "easeOutCubic" });
    return;
  }

  window.detail_spent_chart_instance2 = new Chart(ctx, {
    type: "line",
    data: {
      labels: dates,
      datasets: [
        {
          label: type.charAt(0).toUpperCase() + type.slice(1),
          data: chartData,
          backgroundColor: gLine,
          borderColor: "#ffab00",
          fill: true,
          tension: 0.3,
          pointRadius: 3,
          pointBackgroundColor: "#ffab00",
          borderWidth: 2,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 500, easing: "easeOutCubic" },
      layout: {
        padding: { left: 20, right: 20, top: 10, bottom: 10 },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (c) =>
              `${c.dataset.label}: ${
                type === "spend" ? formatMoneyShort(c.raw) : c.raw
              }`,
          },
        },
        datalabels: {
          anchor: "end",
          align: "end",
          font: { size: 11 },
          color: "#555",
          formatter: (v) => (v > 0 ? formatMoneyShort(v) : ""),
        },
      },
      scales: {
        x: {
          grid: {
            color: "rgba(0,0,0,0.03)", // ✅ kẻ nhẹ
            drawBorder: true,
            borderColor: "rgba(0,0,0,0.05)",
          },
          ticks: {
            color: "#555",
            font: { size: 10 },
            autoSkip: true,
            maxRotation: 0,
            minRotation: 0,
          },
        },
        y: {
          beginAtZero: true,
          grid: {
            color: "rgba(0,0,0,0.03)",
            drawBorder: true,
            borderColor: "rgba(0,0,0,0.05)",
          },
          ticks: { display: false },
          afterDataLimits: (scale) => {
            if (scale.max != null) scale.max = scale.max * 1.1;
          },
        },
      },
    },
    plugins: [ChartDataLabels],
  });
}

function setupDetailDailyFilter() {
  const qualitySelect = document.querySelector(".dom_select.daily");
  if (!qualitySelect) return;

  const list = qualitySelect.querySelector("ul.dom_select_show");
  const selectedEl = qualitySelect.querySelector(".dom_selected");
  const allItems = list.querySelectorAll("li");

  // toggle dropdown
  qualitySelect.onclick = (e) => {
    e.stopPropagation();
    const isActive = list.classList.contains("active");
    document
      .querySelectorAll(".dom_select_show")
      .forEach((ul) => ul !== list && ul.classList.remove("active"));
    list.classList.toggle("active", !isActive);
  };

  // chọn type
  allItems.forEach((li) => {
    li.onclick = (e) => {
      e.stopPropagation();
      const type = li.dataset.type;

      // nếu click vào item đang active → đóng dropdown
      if (li.classList.contains("active")) {
        list.classList.remove("active");
        return;
      }

      // reset active
      allItems.forEach((el) => el.classList.remove("active"));
      list
        .querySelectorAll(".radio_box")
        .forEach((r) => r.classList.remove("active"));

      // đánh dấu item được chọn
      li.classList.add("active");
      li.querySelector(".radio_box").classList.add("active");

      // cập nhật label
      selectedEl.textContent = li.textContent.trim();

      // render chart
      renderDetailDailyChart(window.dataByDate, type);

      // đóng dropdown
      list.classList.remove("active");
    };
  });

  // click ra ngoài → đóng dropdown
  document.addEventListener("click", (e) => {
    if (!qualitySelect.contains(e.target)) list.classList.remove("active");
  });
}

async function fetchPlatformStats(campaignIds = []) {
  try {
    if (!ACCOUNT_ID) throw new Error("ACCOUNT_ID is required");

    const filtering = campaignIds.length
      ? `&filtering=${encodeURIComponent(
          JSON.stringify([
            { field: "campaign.id", operator: "IN", value: campaignIds },
          ])
        )}`
      : "";

    const url = `${BASE_URL}/act_${ACCOUNT_ID}/insights?fields=spend,impressions,reach,actions&level=ad&time_range={"since":"${startDate}","until":"${endDate}"}${filtering}&access_token=${META_TOKEN}`;

    const data = await fetchJSON(url);
    return data.data || [];
  } catch (err) {
    console.error("❌ Error fetching platform stats:", err);
    return [];
  }
}
function summarizePlatformStats(data) {
  const platforms = {};

  data.forEach((item) => {
    const platform = item.platform_position || "Other";
    if (!platforms[platform]) {
      platforms[platform] = {
        spend: 0,
        reach: 0,
        impressions: 0,
        actions: {},
      };
    }

    platforms[platform].spend += +item.spend || 0;
    platforms[platform].reach += +item.reach || 0;
    platforms[platform].impressions += +item.impressions || 0;

    (item.actions || []).forEach((a) => {
      const key = a.action_type;
      platforms[platform].actions[key] =
        (platforms[platform].actions[key] || 0) + (+a.value || 0);
    });
  });

  return platforms;
}

function updatePlatformSummaryUI(platforms) {
  let totalSpend = 0,
    totalReach = 0,
    totalImpression = 0,
    totalLike = 0,
    totalReaction = 0,
    totalFollow = 0,
    totalComment = 0,
    totalShare = 0,
    totalClick = 0,
    totalView = 0,
    totalMessage = 0,
    totalLead = 0;

  Object.values(platforms).forEach((p) => {
    totalSpend += p.spend || 0;
    totalReach += p.reach || 0;
    totalImpression += p.impressions || 0;

    const act = p.actions || {};
    totalLike += act["like"] || 0;
    totalFollow += act["page_follow"] || act["page_like"] || 0;
    totalReaction += act["post_reaction"] || 0;
    totalComment += act["comment"] || 0;
    totalShare += act["post_share"] || act["share"] || 0;
    totalClick += act["link_click"] || 0;
    totalView += act["video_view"] || 0;
    totalMessage +=
      act["onsite_conversion.messaging_conversation_started_7d"] || 0;
    totalLead += act["lead"] || 0;
  });

  // --- Cập nhật các chỉ số tổng ---
  document.querySelector(
    "#spent span"
  ).textContent = `${totalSpend.toLocaleString("vi-VN")}đ`;
  document.querySelector(
    "#reach span"
  ).textContent = `${totalReach.toLocaleString("vi-VN")}`;
  document.querySelector(
    "#message span"
  ).textContent = `${totalMessage.toLocaleString("vi-VN")}`;
  document.querySelector(
    "#lead span"
  ).textContent = `${totalLead.toLocaleString("vi-VN")}`;

  // --- Interaction ---
  document.querySelector(
    ".dom_interaction_reaction"
  ).textContent = `${totalReaction.toLocaleString("vi-VN")}`;
  document.querySelector(".dom_interaction_like").textContent = `${(
    totalLike + totalFollow
  ).toLocaleString("vi-VN")}`;
  document.querySelector(
    ".dom_interaction_comment"
  ).textContent = `${totalComment.toLocaleString("vi-VN")}`;
  document.querySelector(
    ".dom_interaction_share"
  ).textContent = `${totalShare.toLocaleString("vi-VN")}`;
  document.querySelector(
    ".dom_interaction_click"
  ).textContent = `${totalClick.toLocaleString("vi-VN")}`;
  document.querySelector(
    ".dom_interaction_view"
  ).textContent = `${totalView.toLocaleString("vi-VN")}`;

  // --- Frequency ---
  const freqWrap = document.querySelector(".dom_frequency");
  if (freqWrap) {
    const frequency = totalReach > 0 ? totalImpression / totalReach : 0;
    const percent = Math.min((frequency / 3) * 100, 100); // ví dụ 3 lần = full bar

    // Cập nhật donut
    const donut = freqWrap.querySelector(".semi-donut");
    if (donut) donut.style.setProperty("--percentage", percent.toFixed(1));

    // Text chính: % và frequency
    const freqNum = freqWrap.querySelector(".frequency_number");
    if (freqNum) {
      freqNum.querySelector(
        "span:nth-child(1)"
      ).textContent = `${frequency.toFixed(1)}`;
      // freqNum.querySelector(
      //   "span:nth-child(2)"
      // ).textContent = `(${frequency.toFixed(2)})`;
    }

    // Nhãn Impression & Reach %
    const impLabel = freqWrap.querySelector(".dom_frequency_label_impression");
    const reachLabel = freqWrap.querySelector(".dom_frequency_label_reach");
    if (impLabel)
      impLabel.textContent = `${totalImpression.toLocaleString("vi-VN")}`;
    if (reachLabel)
      reachLabel.textContent = `${totalReach.toLocaleString("vi-VN")}`;
  }
}

async function loadPlatformSummary(campaignIds = []) {
  const data = await fetchPlatformStats(campaignIds);
  const platforms = summarizePlatformStats(data);
  updatePlatformSummaryUI(platforms);
}
async function fetchSpendByPlatform(campaignIds = []) {
  try {
    if (!ACCOUNT_ID) throw new Error("ACCOUNT_ID is required");

    const filtering = campaignIds.length
      ? `&filtering=${encodeURIComponent(
          JSON.stringify([
            { field: "campaign.id", operator: "IN", value: campaignIds },
          ])
        )}`
      : "";

    const url = `${BASE_URL}/act_${ACCOUNT_ID}/insights?fields=spend&breakdowns=publisher_platform&time_range={"since":"${startDate}","until":"${endDate}"}${filtering}&access_token=${META_TOKEN}`;
    const data = await fetchJSON(url);
    return data.data || [];
  } catch (err) {
    console.error("❌ Error fetching spend by platform:", err);
    return [];
  }
}
function summarizeSpendByPlatform(data) {
  const result = {
    facebook: 0,
    instagram: 0,
    other: 0,
  };

  data.forEach((item) => {
    const platform = (item.publisher_platform || "other").toLowerCase();
    const spend = +item.spend || 0;
    if (platform.includes("facebook")) result.facebook += spend;
    else if (platform.includes("instagram")) result.instagram += spend;
    else result.other += spend;
  });

  return result;
}
function renderPlatformSpendUI(summary) {
  if (!summary) return;

  // --- Cập nhật text ---
  document.querySelector("#facebook_spent").textContent = formatMoney(
    summary.facebook
  );
  document.querySelector("#instagram_spent").textContent = formatMoney(
    summary.instagram
  );
  document.querySelector("#other_spent").textContent = formatMoney(
    summary.other
  );

  const total = summary.facebook + summary.instagram + summary.other;
  if (total <= 0) return;

  const ctx = document.getElementById("platform_chart");
  if (!ctx) return;
  const c2d = ctx.getContext("2d");

  if (window.platformChartInstance) window.platformChartInstance.destroy();

  const values = [summary.facebook, summary.instagram, summary.other];
  const labels = ["Facebook", "Instagram", "Other"];
  const maxIndex = values.indexOf(Math.max(...values));
  const maxLabel = labels[maxIndex];
  const maxPercent = ((values[maxIndex] / total) * 100).toFixed(1);

  // 🧠 Plugin custom để hiện % giữa lỗ
  const centerPercentPlugin = {
    id: "centerPercent",
    afterDraw(chart) {
      const { width, height } = chart;
      const ctx = chart.ctx;
      ctx.save();
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = "#333";
      ctx.font = "bold 18px sans-serif";
      ctx.fillText(`${maxPercent}%`, width / 2, height / 2 - 5);
      ctx.font = "12px sans-serif";
      ctx.fillText(maxLabel, width / 2, height / 2 + 15);
      ctx.restore();
    },
  };

  window.platformChartInstance = new Chart(c2d, {
    type: "doughnut",
    data: {
      labels,
      datasets: [
        {
          data: values,
          backgroundColor: [
            "rgba(255, 169, 0, 0.9)", // Facebook
            "rgba(200, 200, 200, 0.8)", // Other
            "rgba(0, 30, 165, 0.9)", // Instagram
          ],
          borderColor: "#fff",
          borderWidth: 2,
        },
      ],
    },
    options: {
      responsive: true,
      cutout: "70%",
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) =>
              `${ctx.label}: ${formatMoneyShort(ctx.raw)} (${(
                (ctx.raw / total) *
                100
              ).toFixed(1)}%)`,
          },
        },
        datalabels: { display: false }, // ❌ ẩn % trong từng miếng
      },
    },
    plugins: [centerPercentPlugin],
  });
}

async function loadSpendPlatform(campaignIds = []) {
  const data = await fetchSpendByPlatform(campaignIds);
  const summary = summarizeSpendByPlatform(data);
  renderPlatformSpendUI(summary);
}

main();

function initDateSelector() {
  const selectBox = document.querySelector(".dom_select.time");
  if (!selectBox) return;

  const selectedText = selectBox.querySelector(".dom_selected");
  const list = selectBox.querySelector(".dom_select_show");
  const items = list.querySelectorAll("li[data-date]");
  const applyBtn = list.querySelector(".apply_custom_date");
  const startInput = list.querySelector("#start");
  const endInput = list.querySelector("#end");

  // 🧩 Toggle dropdown
  selectBox.addEventListener("click", (e) => {
    if (!e.target.closest("ul")) {
      list.classList.toggle("active");
    }
  });

  // 🧠 Chọn preset date
  items.forEach((item) => {
    item.addEventListener("click", (e) => {
      e.stopPropagation();
      const type = item.dataset.date;

      if (type === "custom_range") {
        const box = item.querySelector(".custom_date");
        box.classList.toggle("active");
        return;
      }

      // Reset active
      items.forEach((i) => i.classList.remove("active"));
      item.classList.add("active");

      const range = getDateRange(type);
      startDate = range.start;
      endDate = range.end;
      selectedText.textContent = item.textContent.trim();
      list.classList.remove("active");

      // 🔥 Refresh dashboard
      reloadDashboard();
    });
  });

  // 🧾 Apply custom date
  applyBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const start = startInput.value;
    const end = endInput.value;
    if (!start || !end) {
      alert("⛔ Vui lòng chọn đầy đủ ngày!");
      return;
    }

    const s = new Date(start);
    const eD = new Date(end);
    if (eD < s) {
      alert("⚠️ Ngày kết thúc phải sau ngày bắt đầu!");
      return;
    }

    selectedText.textContent = `${start} → ${end}`;
    list.classList.remove("active");

    // 💡 Update global
    startDate = start;
    endDate = end;

    // 🚀 Reload dashboard
    reloadDashboard();
  });
}

// =================== PRESET RANGE ===================
function getDateRange(type) {
  const today = new Date();
  const start = new Date(today);
  const end = new Date(today);

  switch (type) {
    case "today":
      break;
    case "yesterday":
      start.setDate(today.getDate() - 1);
      end.setDate(today.getDate() - 1);
      break;
    case "last_7days":
      start.setDate(today.getDate() - 6);
      break;
    case "this_week": {
      const day = today.getDay() || 7;
      start.setDate(today.getDate() - day + 1);
      break;
    }
    case "last_week": {
      const day = today.getDay() || 7;
      end.setDate(today.getDate() - day);
      start.setDate(today.getDate() - day - 6);
      break;
    }
    case "this_month":
      start.setDate(1);
      break;
  }

  const fmt = (d) => d.toISOString().slice(0, 10);
  return { start: fmt(start), end: fmt(end) };
}

// =================== RELOAD DASHBOARD ===================
function reloadDashboard() {
  const loading = document.querySelector(".loading");
  if (loading) loading.classList.add("active");

  // 💡 Cập nhật text range đang chọn (VD: "01/06/2025 - 28/06/2025")
  const domDate = document.querySelector(".dom_date");
  if (domDate) {
    const fmt = (d) => {
      const [y, m, day] = d.split("-");
      return `${day}/${m}/${y}`;
    };
    domDate.textContent = `${fmt(startDate)} - ${fmt(endDate)}`;
  }
  loadDailyChart();
  loadPlatformSummary();
  loadSpendPlatform();
  loadCampaignList().finally(() => {
    console.log("Main flow completed. Hiding loading.");
    if (loading) loading.classList.remove("active");
  });
}

// =================== MAIN INIT ===================
