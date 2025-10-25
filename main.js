let startDate, endDate;
let VIEW_GOAL; // Dùng cho chart breakdown
const CACHE = new Map();
const BATCH_SIZE = 20; 
const CONCURRENCY_LIMIT = 2; // max batch song song
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
  REPLIES: "onsite_conversion.messaging_conversation_replied_7d",
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
async function runBatchesWithLimit(tasks, limit = CONCURRENCY_LIMIT) {
  const results = [];
  let i = 0;

  async function worker() {
    while (i < tasks.length) {
      const idx = i++;
      try {
        results[idx] = await tasks[idx]();
      } catch (err) {
        console.warn(`⚠️ Batch ${idx} failed:`, err.message);
        results[idx] = null;
      }
    }
  }

  const pool = Array.from({ length: limit }, worker);
  await Promise.all(pool);
  return results;
}
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
  const key = url + JSON.stringify(options);
  if (CACHE.has(key)) return CACHE.get(key);

  try {
    const res = await fetch(url, options);
    const text = await res.text();

    if (!res.ok) {
      let msg = `HTTP ${res.status} - ${res.statusText}`;
      try {
        const errData = JSON.parse(text);
        if (errData.error) msg = `Meta API Error: ${errData.error.message} (Code: ${errData.error.code})`;

        // 🚨 Retry logic cho Code 4
        if (errData.error?.code === 4) {
          console.warn("⚠️ Rate limit reached. Waiting 5s then retry...");
          await new Promise(r => setTimeout(r, 5000));
          return fetchJSON(url, options);
        }
      } catch {}
      throw new Error(msg);
    }

    const data = JSON.parse(text);
    CACHE.set(key, data);
    return data;
  } catch (err) {
    console.error(`❌ Fetch failed: ${url}`, err);
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
  const url = `${BASE_URL}/act_${ACCOUNT_ID}/insights?level=adset&fields=adset_id,adset_name,campaign_id,campaign_name,optimization_goal&filtering=[{"field":"spend","operator":"GREATER_THAN","value":0}]&time_range={"since":"${startDate}","until":"${endDate}"}&access_token=${META_TOKEN}`;

  const data = await fetchJSON(url);
  console.log("✅ Adset fetched:", data.data?.length || 0);
  return data.data || [];
}

async function fetchAdsAndInsights(adsetIds, onBatchProcessedCallback) {
  if (!Array.isArray(adsetIds) || adsetIds.length === 0) return [];

  // ===== ⚙️ Config =====
  const headers = {
    "Content-Type": "application/json",
    "Prefer": "return=minimal",
  };
  const now = Date.now();
  // const CONCURRENCY = 4; // 👈 Đã bỏ (hoặc comment)
  const adsetChunks = chunkArray(adsetIds, BATCH_SIZE);
  const results = [];
  let batchCount = 0;

  console.time("⏱️ Total fetchAdsAndInsights");

  // ===== ⚡ Main Process =====
  await runBatchesWithLimit(
    adsetChunks.map((batch) => async () => {
      const startTime = performance.now();

      // === Build batch (gọn, không format string thừa) ===
      const fbBatch = new Array(batch.length);
      for (let i = 0; i < batch.length; i++) {
        const adsetId = batch[i];
        fbBatch[i] = {
          method: "GET",
          relative_url:
            `${adsetId}/ads?fields=id,name,effective_status,adset_id,` +
            `adset{end_time,daily_budget,lifetime_budget},` +
            `creative{thumbnail_url,instagram_permalink_url,effective_object_story_id},` +
            `insights.time_range({since:'${startDate}',until:'${endDate}'})` +
            `{spend,impressions,reach,actions,optimization_goal}`,
        };
      }

      // === Gọi API ===
      const adsResp = await fetchJSON(BASE_URL, {
        method: "POST",
        headers,
        body: JSON.stringify({ access_token: META_TOKEN, batch: fbBatch }),
      });

      // === Parse kết quả cực nhanh ===
      const processed = [];
      const respLen = adsResp.length;

      for (let i = 0; i < respLen; i++) {
        const item = adsResp[i];
        if (item?.code !== 200 || !item?.body) continue;

        let body;
        try {
          body = JSON.parse(item.body);
        } catch {
          continue;
        }

        const data = body.data;
        if (!Array.isArray(data) || data.length === 0) continue;
        for (let j = 0, len = data.length; j < len; j++) {
          const ad = data[j];
          const adset = ad.adset ?? {};
          const creative = ad.creative ?? {};
          const insights = ad.insights?.data?.[0] ?? {};

          const endTime = adset.end_time ? Date.parse(adset.end_time) : 0;
          const effective_status =
            endTime && endTime < now ? "COMPLETED" : ad.effective_status;
            processed.push({
              ad_id: ad.id,
              ad_name: ad.name,
              adset_id: ad.adset_id,
              effective_status,
              adset: {
                status: adset.status ?? null,
                daily_budget: adset.daily_budget != null ? adset.daily_budget : 0, // Kiểm tra null và undefined
                lifetime_budget: adset.lifetime_budget ?? null,
                end_time: adset.end_time ?? null,
              },
              creative: {
                thumbnail_url: creative.thumbnail_url ?? null,
                instagram_permalink_url: creative.instagram_permalink_url ?? null,
                facebook_post_url: creative.effective_object_story_id
                  ? `https://facebook.com/${creative.effective_object_story_id}`
                  : null,
              },
              insights: {
                spend: !isNaN(+insights.spend) ? +insights.spend : 0,
                impressions: +insights.impressions || 0,
                reach: +insights.reach || 0,
                actions: Array.isArray(insights.actions) ? insights.actions : [],
                optimization_goal: insights.optimization_goal || "",
              },
            });
        }
      }

      // === Stream về sớm (tránh nghẽn bộ nhớ) ===
      if (processed.length) {
        onBatchProcessedCallback?.(processed);
        results.push(...processed);
      }

      // === Perf log ===
      batchCount++;
      const elapsed = (performance.now() - startTime).toFixed(0);
      console.log(
        `✅ Batch #${batchCount} (${batch.length} adsets) done in ${elapsed}ms`
      );
    }),
    // --- THAY ĐỔI Ở ĐÂY ---
    CONCURRENCY_LIMIT // ✅ Sử dụng hằng số toàn cục (giá trị là 2)
    // ---------------------
  );

  console.timeEnd("⏱️ Total fetchAdsAndInsights");
  return results;
}
async function fetchDailySpendByAccount() {
  const url = `${BASE_URL}/act_${ACCOUNT_ID}/insights?fields=spend,impressions,reach,actions&time_increment=1&time_range[since]=${startDate}&time_range[until]=${endDate}&access_token=${META_TOKEN}`;
  const data = await fetchJSON(url);
  return data.data || [];
}

let DAILY_DATA = [];

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
  console.log(adsets);
  if (!Array.isArray(adsets) || adsets.length === 0) return [];

  const campaigns = Object.create(null);

  // ⚙️ Dùng map cache hành động -> tránh gọi find nhiều lần
  const safeGetActionValue = (actions, type) => {
    if (!Array.isArray(actions) || !actions.length) return 0;
    for (let i = 0; i < actions.length; i++) {
      const a = actions[i];
      if (a.action_type === type) return +a.value || 0;
    }
    return 0;
  };

  // ⚡ Duyệt qua tất cả adsets (1 vòng chính)
  for (let i = 0; i < adsets.length; i++) {
    const as = adsets[i];
    if (!as?.ads?.length) continue;

    const campId = as.campaign_id || as.campaignId || "unknown_campaign";
    const campName = as.campaign_name || as.campaignName || "Unknown";
    const goal = as.optimization_goal || as.optimizationGoal || "UNKNOWN";
    const asId = as.id || as.adset_id || as.adsetId || `adset_${i}`;

    // 🧱 Tạo campaign nếu chưa có
    let campaign = campaigns[campId];
    if (!campaign) {
      campaign = campaigns[campId] = {
        id: campId,
        name: campName,
        spend: 0,
        result: 0,
        reach: 0,
        impressions: 0,
        reactions: 0,
        lead: 0,
        message: 0,
        adsets: [],
        _adsetMap: Object.create(null),
      };
    }

    // 🔹 Cache adset trong campaign
    let adset = campaign._adsetMap[asId];
    console.log(adset);
    if (!adset) {
      adset = {
        id: asId,
        name: as.name || as.adset_name || as.adsetName || "Unnamed Adset",
        optimization_goal: goal,
        spend: 0,
        result: 0,
        reach: 0,
        impressions: 0,
        reactions: 0,
        lead: 0,
        message: 0,
        ads: [],
        end_time: as.ads?.[0]?.adset?.end_time || null,  // Adjusted this line to handle array-based access
        daily_budget: as.ads?.[0]?.adset?.daily_budget || 0,  // Adjusted this line to handle array-based access
        lifetime_budget: as.ads?.[0]?.adset?.lifetime_budget || 0,  // Adjusted this line to handle array-based access
        status: as.status || null,
      };
      campaign._adsetMap[asId] = adset;
      campaign.adsets.push(adset);
    }

    // 🔁 Lặp nhanh qua ads
    const ads = as.ads;
    for (let j = 0; j < ads.length; j++) {
      const ad = ads[j];
      if (!ad) continue;

      const ins = Array.isArray(ad.insights?.data)
        ? ad.insights.data[0]
        : Array.isArray(ad.insights)
        ? ad.insights[0]
        : ad.insights || {};

      const spend = +ins.spend || 0;
      const reach = +ins.reach || 0;
      const impressions = +ins.impressions || 0;
      const result = getResults(ins) || 0;
      const reactions = getReaction(ins) || 0;

      const actions = ins.actions;
      const messageCount = safeGetActionValue(
        actions,
        "onsite_conversion.messaging_conversation_started_7d"
      );
      const leadCount =
        safeGetActionValue(actions, "lead") +
        safeGetActionValue(actions, "onsite_conversion.lead_grouped");

      // ✅ Cộng dồn adset-level
      adset.spend += spend;
      adset.result += result;
      adset.reach += reach;
      adset.impressions += impressions;
      adset.reactions += reactions;
      adset.lead += leadCount;
      adset.message += messageCount;

      // ✅ Cộng dồn campaign-level
      campaign.spend += spend;
      campaign.result += result;
      campaign.reach += reach;
      campaign.impressions += impressions;
      campaign.reactions += reactions;
      campaign.lead += leadCount;
      campaign.message += messageCount;

      // 🖼️ Add ad summary
      adset.ads.push({
        id: ad.ad_id || ad.id || null,
        name: ad.ad_name || ad.name || "Unnamed Ad",
        status: ad.effective_status?.toUpperCase() || ad.status || "UNKNOWN",
        optimization_goal: ad.optimization_goal || goal || "UNKNOWN",
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
    }
  }

  // 🧹 Xoá map nội bộ, convert sang array
  return Object.values(campaigns).map((c) => {
    delete c._adsetMap;
    return c;
  });
}

function renderCampaignView(data) {
  console.log(data);
  const wrap = document.querySelector(".view_campaign_box");
  if (!wrap || !Array.isArray(data)) return;

  const now = Date.now();
  const activeLower = "active";

  let totalCampaignCount = data.length;
  let activeCampaignCount = 0;
  let totalAdsetCount = 0;
  let activeAdsetCount = 0;

  // ==== Đếm trạng thái tổng ====
  for (let i = 0; i < data.length; i++) {
    const c = data[i];
    let campaignActive = false;
    const adsets = c.adsets || [];
    totalAdsetCount += adsets.length;
    for (let j = 0; j < adsets.length; j++) {
      const as = adsets[j];
      const ads = as.ads || [];
      for (let k = 0; k < ads.length; k++) {
        if (ads[k].status?.toLowerCase() === activeLower) {
          activeAdsetCount++;
          campaignActive = true;
          break;
        }
      }
    }
    if (campaignActive) activeCampaignCount++;
  }

  // === Cập nhật UI tổng active ===
  const activeCpEls = document.querySelectorAll(".dom_active_cp");
if (activeCpEls.length >= 2) {
  // Xử lý Campaign
  const campEl = activeCpEls[0].querySelector("span:nth-child(2)");
  if (campEl) {
    const hasActiveCampaign = activeCampaignCount > 0; // Kiểm tra nếu campaign có hoạt động
    campEl.classList.toggle("inactive", !hasActiveCampaign); // Thêm class inactive nếu không có active campaign
    campEl.innerHTML = `<span class="live-dot"></span>${activeCampaignCount}/${totalCampaignCount}`;
  }

  // Xử lý Adset
  const adsetEl = activeCpEls[1].querySelector("span:nth-child(2)");
  if (adsetEl) {
    const hasActiveAdset = activeAdsetCount > 0; // Kiểm tra nếu adset có hoạt động
    adsetEl.classList.toggle("inactive", !hasActiveAdset); // Thêm class inactive nếu không có active adset
    adsetEl.innerHTML = `<span class="live-dot"></span>${activeAdsetCount}/${totalAdsetCount}`;
  }
}


  // === Ưu tiên campaign active ===
  data.sort((a, b) => {
    const aActive = a.adsets.some((as) =>
      as.ads.some((ad) => ad.status?.toLowerCase() === activeLower)
    );
    const bActive = b.adsets.some((as) =>
      as.ads.some((ad) => ad.status?.toLowerCase() === activeLower)
    );
    if (aActive !== bActive) return bActive - aActive;
    return b.spend - a.spend;
  });

  // === Render ===
  const htmlBuffer = [];

  for (let i = 0; i < data.length; i++) {
    const c = data[i];
    const adsets = c.adsets;
    let activeAdsetCount = 0;
    for (let j = 0; j < adsets.length; j++) {
      if (adsets[j].ads?.some((ad) => ad.status?.toLowerCase() === activeLower))
        activeAdsetCount++;
    }

    const hasActiveAdset = activeAdsetCount > 0;
    const campaignStatusClass = hasActiveAdset ? "active" : "inactive";
    const campaignStatusText = hasActiveAdset
      ? `${activeAdsetCount} ACTIVE`
      : "INACTIVE";

    const firstGoal = adsets?.[0]?.optimization_goal || "";
    const iconClass = getCampaignIcon(firstGoal);
    const campaignCpr =
      c.result > 0
        ? firstGoal === "REACH"
          ? (c.spend / c.result) * 1000
          : c.spend / c.result
        : 0;

    const campaignHtml = [];
    campaignHtml.push(`
      <div class="campaign_item ${campaignStatusClass}">
        <div class="campaign_main">
          <div class="ads_name">
            <div class="campaign_thumb campaign_icon_wrap ${
              hasActiveAdset ? "" : "inactive"
            }">
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
          <div class="ad_frequency">${calcFrequency(
            c.impressions,
            c.reach
          )}</div>
          <div class="ad_reaction">${formatNumber(c.reactions)}</div>
          <div class="campaign_view"><i class="fa-solid fa-angle-down"></i></div>
        </div>`);

    // === Render adset ===
    for (let j = 0; j < adsets.length; j++) {
      const as = adsets[j];
      const ads = as.ads;
      const activeAdsCount = ads.filter(
        (ad) => ad.status?.toLowerCase() === activeLower
      ).length;

      let adsetStatusClass = "inactive";
      let adsetStatusText = "INACTIVE";

      const endTime = as.end_time ? new Date(as.end_time).getTime() : null;
      const isEnded = endTime && endTime < now;
      const dailyBudget = +as.daily_budget || 0;
      const lifetimeBudget = +as.lifetime_budget || 0;
      const hasActiveAd = activeAdsCount > 0;
        console.log(dailyBudget);
      if (isEnded) {
        adsetStatusClass = "complete";
        adsetStatusText = `<span class="status-label">COMPLETE</span>`;
      } else if (hasActiveAd && dailyBudget > 0) {
        // ✅ chỉ hiện Daily Budget nếu có ad ACTIVE
        adsetStatusClass = "active dbudget";
        adsetStatusText = `
          <span class="status-label">Daily Budget</span>
          <span class="status-value">${dailyBudget.toLocaleString(
            "vi-VN"
          )}đ</span>`;
      } else if (hasActiveAd && lifetimeBudget > 0) {
        // ✅ chỉ hiện Lifetime Budget nếu có ad ACTIVE
        adsetStatusClass = "active budget";
        const d = as.end_time ? new Date(as.end_time) : null;
        const endDate = d
          ? `${String(d.getDate()).padStart(2, "0")}-${String(
              d.getMonth() + 1
            ).padStart(2, "0")}-${d.getFullYear()}`
          : "";
        adsetStatusText = `
          <span class="status-label">Lifetime Budget</span>
          <span class="status-value">${lifetimeBudget.toLocaleString(
            "vi-VN"
          )}đ</span>
          <span class="status-date">END ${endDate}</span>`;
      } else if (hasActiveAd) {
        adsetStatusClass = "active";
        adsetStatusText = `<span>ACTIVE</span>`;
      } else {
        adsetStatusClass = "inactive";
        adsetStatusText = `<span>INACTIVE</span>`;
      }
      const adsetCpr =
        as.result > 0
          ? as.optimization_goal === "REACH"
            ? (as.spend / as.result) * 1000
            : as.spend / as.result
          : 0;

      // Ads HTML (map nhanh)
      const adsHtml = new Array(ads.length);
      for (let k = 0; k < ads.length; k++) {
        const ad = ads[k];
        const isActive = ad.status?.toLowerCase() === activeLower;
        const adCpr =
          ad.result > 0
            ? as.optimization_goal === "REACH"
              ? (ad.spend / ad.result) * 1000
              : ad.spend / ad.result
            : 0;

        adsHtml[k] = `
          <div class="ad_item ${isActive ? "active" : "inactive"}">
            <div class="ads_name">
              <a>
                <img src="${ad.thumbnail}" data-ad-id-img="${ad.id}" />
                <p class="ad_name">ID: ${ad.id}</p>
              </a>
            </div>
            <div class="ad_status ${isActive ? "active" : "inactive"}">${
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
            <div class="ad_view"
              data-ad-id="${ad.id}"
              data-name="${as.name}"
              data-goal="${as.optimization_goal}"
              data-spend="${ad.spend}"
              data-reach="${ad.reach}"
              data-impressions="${ad.impressions}"
              data-result="${ad.result}"
              data-cpr="${adCpr}"
              data-thumb="${ad.thumbnail || ""}"
              data-post="${ad.post_url || ""}">
              <i class="fa-solid fa-magnifying-glass-chart"></i>
            </div>
          </div>`;
      }

      campaignHtml.push(`
        <div class="adset_item ${adsetStatusClass}">
     <div class="ads_name">
              <a href="javascript:;">
                <img src="${as.ads?.[0]?.thumbnail}" />
                <p class="ad_name">${as.name}</p>
              </a>
            </div>
          <div class="ad_status ${adsetStatusClass}">${adsetStatusText}</div>
          <div class="ad_spent">${formatMoney(as.spend)}</div>
          <div class="ad_result">${formatNumber(as.result)}</div>
          <div class="ad_cpr">
            <i class="${getCampaignIcon(
              as.optimization_goal
            )} adset_goal_icon"></i>
            <span>${as.optimization_goal}</span>
          </div>
          <div class="ad_cpm">${formatMoney(calcCpm(as.spend, as.reach))}</div>
          <div class="ad_reach">${formatNumber(as.reach)}</div>
          <div class="ad_frequency">${calcFrequency(
            as.impressions,
            as.reach
          )}</div>
          <div class="ad_reaction">${formatNumber(as.reactions)}</div>
          <div class="adset_view">
            <div class="campaign_view"><i class="fa-solid fa-angle-down"></i></div>
          </div>
        </div>
        <div class="ad_item_box">${adsHtml.join("")}</div>`);
    }

    campaignHtml.push(`</div>`);
    htmlBuffer.push(campaignHtml.join(""));
  }

  wrap.innerHTML = htmlBuffer.join("");
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
    const allAds = campaigns.flatMap((c) =>
      c.adsets.flatMap((as) =>
        (as.ads || []).map((ad) => ({
          optimization_goal: as.optimization_goal,
          insights: { spend: ad.spend || 0 },
        }))
      )
    );
    renderGoalChart(allAds);
    // updateSummaryUI(campaigns);
  } catch (err) {
    console.error("❌ Error in Flow 2 (Campaign List):", err);
  }
}


// 🧩 Chạy 1 lần khi load page
function initDashboard() {
  initDateSelector();
  setupDetailDailyFilter();
  setupDetailDailyFilter2();
  const { start, end } = getDateRange("this_week");
  startDate = start;
  endDate = end;

  // Có thể add thêm listener hoặc setup UI khác ở đây
  console.log("✅ Dashboard UI initialized");
}

// 🧠 Hàm chỉ để load lại data (gọi khi đổi account/filter)
async function loadDashboardData() {
  const domDate = document.querySelector(".dom_date");
  if (domDate) {
    const fmt = (d) => {
      const [y, m, day] = d.split("-");
      return `${day}/${m}/${y}`;
    };
    domDate.textContent = `${fmt(startDate)} - ${fmt(endDate)}`;
  }
  const loading = document.querySelector(".loading");
  if (loading) loading.classList.add("active");

  // 🔁 Chạy song song các luồng
  loadDailyChart();
  loadPlatformSummary();
  loadSpendPlatform();
  loadAgeGenderSpendChart();
  loadCampaignList().finally(() => {
    console.log("📊 Dashboard data loaded.");
    if (loading) loading.classList.remove("active");
  });
}

// 🚀 Hàm chính gọi khi load trang lần đầu
async function main() {
  initDashboard();        // chỉ chạy setup UI 1 lần
  await loadDashboardData(); // load data lần đầu
}

main()
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
  const reach = parseFloat(el.dataset.reach || 0);
  const impressions = parseFloat(el.dataset.impressions || 0);
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
  const freqWrap = document.querySelector(".dom_frequency");
  if (freqWrap && reach > 0) {
    const frequency = impressions / reach; // tần suất hiển thị trung bình
    const percent = Math.min((frequency / 4) * 100, 100); // ví dụ 3 = full bar

    // Cập nhật progress (dạng donut/bar)
    const donut = freqWrap.querySelector(".semi-donut");
    if (donut) donut.style.setProperty("--percentage", percent.toFixed(1));

    // Text hiển thị frequency
    const freqNum = freqWrap.querySelector(".frequency_number");
    if (freqNum)
      freqNum.querySelector("span:nth-child(1)").textContent =
        frequency.toFixed(1);

    // Impression & Reach labels
    const impLabel = freqWrap.querySelector(".dom_frequency_label_impression");
    const reachLabel = freqWrap.querySelector(".dom_frequency_label_reach");
    if (impLabel)
      impLabel.textContent = impressions.toLocaleString("vi-VN");
    if (reachLabel) reachLabel.textContent = reach.toLocaleString("vi-VN");
  }
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
function debounce(fn, delay = 500) {
  let timeout;
  return (...args) => {
    clearTimeout(timeout);
    timeout = setTimeout(() => fn(...args), delay);
  };
}

const filterInput = document.getElementById("filter");
const filterButton = document.getElementById("filter_button");

if (filterInput) {
  // 🧠 Khi nhấn Enter mới filter
  filterInput.addEventListener(
    "keydown",
    debounce((e) => {
      if (e.key === "Enter") {
        const keyword = e.target.value.trim().toLowerCase();
        applyCampaignFilter(keyword);
      } else if (e.target.value.trim() === "") {
        // 🧹 Nếu clear input → reset về mặc định
        applyCampaignFilter("");
      }
    }, 300)
  );

  // 👀 Khi clear input bằng tay (xóa hết text)
  filterInput.addEventListener(
    "input",
    debounce((e) => {
      if (e.target.value.trim() === "") {
        applyCampaignFilter("");
      }
    }, 300)
  );
}

if (filterButton) {
  // 🖱 Khi click nút tìm
  filterButton.addEventListener(
    "click",
    debounce(() => {
      const keyword = filterInput?.value?.trim().toLowerCase() || "";
      applyCampaignFilter(keyword);
    }, 300)
  );
}

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
  loadAgeGenderSpendChart(ids);
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
  const loading = document.querySelector(".loading");
  if (loading) loading.classList.add("active");
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
    if (loading) loading.classList.remove("active");
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
  if (!targetBox || !targeting) return;

  // === AGE RANGE ===
  let min = 18, max = 65;
  if (Array.isArray(targeting.age_range) && targeting.age_range.length === 2) {
    [min, max] = targeting.age_range;
  } else {
    min = targeting.age_min || 18;
    max = targeting.age_max || 65;
  }

  const ageDivs = targetBox.querySelectorAll(".detail_gender .age_text p");
  if (ageDivs.length >= 2) {
    ageDivs[0].textContent = min;
    ageDivs[1].textContent = max;
  }

  const ageBar = targetBox.querySelector(".detail_age_bar");
  if (ageBar) {
    const fullMin = 18, fullMax = 65;
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

  // === GENDER ===
  const genderWrap = targetBox.querySelector(".detail_gender_bar");
  if (genderWrap) {
    const genders = Array.isArray(targeting.genders) ? targeting.genders : [];
    const validGenders = genders
      .map(String)
      .filter((g) => ["male", "female", "other"].includes(g.toLowerCase()));
    genderWrap.innerHTML = validGenders.length
      ? validGenders.map((g) => `<p>${g}</p>`).join("")
      : `<p>Male</p><p>Female</p><p>Other</p>`;
  }

  // === LOCATIONS ===
  const locationWrap = targetBox.querySelector(".detail_location_bar");
  if (locationWrap) {
    let locations = [];
    const { geo_locations } = targeting || {};

    if (geo_locations?.cities)
      locations = geo_locations.cities.map(
        (c) => `${c.name} (${c.radius}${c.distance_unit || "km"})`
      );

    if (geo_locations?.regions)
      locations = locations.concat(geo_locations.regions.map((r) => r.name));

    if (geo_locations?.custom_locations)
      locations = locations.concat(
        geo_locations.custom_locations.map(
          (r) =>
            `${r.name} (${r.radius}${r.distance_unit || "km"})`
        )
      );

    if (geo_locations?.places)
      locations = locations.concat(
        geo_locations.places.map(
          (p) => `${p.name} (${p.radius}${p.distance_unit || "km"})`
        )
      );

    if (geo_locations?.countries)
      locations = locations.concat(geo_locations.countries);

    locationWrap.innerHTML = locations.length
      ? locations
          .slice(0, 5)
          .map(
            (c) =>
              `<p><i class="fa-solid fa-location-crosshairs"></i><span>${c}</span></p>`
          )
          .join("")
      : `<p><i class="fa-solid fa-location-crosshairs"></i><span>Việt Nam</span></p>`;
  }

  // === FLEXIBLE SPEC (Interests / Education / etc.) ===
  const freqWrap = targetBox.querySelector(".frequency_tag");
  if (freqWrap) {
    const tags = [];
    const flex = targeting.flexible_spec || [];

    flex.forEach((fs) => {
      for (const [key, arr] of Object.entries(fs)) {
        if (!Array.isArray(arr)) continue;
        arr.forEach((item) => {
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
      : `<p class="freq_tag_item"><span class="tag_dot"></span><span class="tag_name">Advantage targeting</span></p>`;
  }

  // === CUSTOM & LOOKALIKE AUDIENCES ===
  const audienceWrap = targetBox.querySelector(".detail_audience");
  if (audienceWrap) {
    const audiences = [];

    if (Array.isArray(targeting.custom_audiences)) {
      targeting.custom_audiences.forEach((a) =>
        audiences.push(`${a.name || a.id} (Custom Audience)`)
      );
    }

    if (Array.isArray(targeting.lookalike_spec)) {
      targeting.lookalike_spec.forEach((a) =>
        audiences.push(`${a.name || a.origin || a.id} (Lookalike Audience)`)
      );
    }

    audienceWrap.innerHTML = audiences.length
      ? audiences
          .map(
            (t) =>
            `<p class="freq_tag_item"><span class="tag_dot"></span><span class="tag_name">${t}</span></p>`
          )
          .join("")
      : `<p><span>No audience selected</span></p>`;
  }

  // === EXCLUDED AUDIENCES ===
  const excludeWrap = targetBox.querySelector(".detail_exclude");
  if (excludeWrap) {
    const excluded = [];
    const {
      excluded_custom_audiences,
      excluded_interests,
      excluded_behaviors,
      excluded_geo_locations,
    } = targeting || {};

    if (Array.isArray(excluded_custom_audiences))
      excluded_custom_audiences.forEach((e) =>
        excluded.push(`${e.name || e.id} (Custom Audience)`)
      );

    if (Array.isArray(excluded_interests))
      excluded_interests.forEach((e) =>
        excluded.push(`${e.name || e.id} (Interest)`)
      );

    if (Array.isArray(excluded_behaviors))
      excluded_behaviors.forEach((e) =>
        excluded.push(`${e.name || e.id} (Behavior)`)
      );

    if (excluded_geo_locations?.countries)
      excluded_geo_locations.countries.forEach((c) =>
        excluded.push(`${c} (Excluded Country)`)
      );

    excludeWrap.innerHTML = excluded.length
      ? excluded
          .map(
            (t) =>
            `<p class="freq_tag_item"><span class="tag_dot"></span><span class="tag_name">${t}</span></p>`
          )
          .join("")
      : `<p><span>No excluded audience</span></p>`;
  }

  // === LANGUAGES (Locales) ===
  const localeWrap = targetBox.querySelector(".detail_locale");
  if (localeWrap && Array.isArray(targeting.locales)) {
    const localeMap = {
      1: "English (US)",
      2: "Spanish",
      3: "French",
      6: "Vietnamese",
    };
    const langs = targeting.locales.map((l) => localeMap[l] || `Locale ID ${l}`);
    localeWrap.innerHTML = langs
      .map(
        (l) =>
          `<p><i class="fa-solid fa-language"></i><span>${l}</span></p>`
      )
      .join("");
  }

  // === PLACEMENT ===
  const placementWrap = targetBox.querySelector(".detail_placement");
  if (placementWrap) {
    const {
      publisher_platforms,
      facebook_positions,
      instagram_positions,
    } = targeting || {};
    const platforms = [
      ...(publisher_platforms || []),
      ...(facebook_positions || []),
      ...(instagram_positions || []),
    ];
    placementWrap.innerHTML = platforms.length
      ? platforms
          .map(
            (p) =>
              `<p><i class="fa-solid fa-bullhorn"></i><span>${p}</span></p>`
          )
          .join("")
      : `<p><i class="fa-solid fa-bullhorn"></i><span>Automatic placement</span></p>`;
  }

  // === ADVANTAGE AUDIENCE ===
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
      key: "onsite_conversion.post_save",
      label: "Saves",
      icon: "fa-solid fa-bookmark",
    },
    {
      key: "page_engagement",
      label: "Page Engaged",
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
      key: "like",
      label: "Follows",
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
  currentDetailDailyType = type; // Đảm bảo biến toàn cục được cập nhật

  const ctx = document.getElementById("detail_spent_chart");
  if (!ctx) return;

  const dates = Object.keys(dataByDate).sort();
  if (!dates.length) return;

  const chartData = dates.map((d) => {
    const item = dataByDate[d] || {};
    if (type === "spend") return item.spend || 0;
    if (type === "lead") return getResults(item); // Giả sử hàm này tồn tại
    if (type === "reach") return item.reach || 0;
    if (type === "message")
      return (
        item.actions["onsite_conversion.messaging_conversation_started_7d"] || 0
      );
    return 0;
  });

  // --- LOGIC MỚI: Tính toán các chỉ số để hiển thị ---
  // (Sử dụng hàm helper 'calculateIndicesToShow' từ câu trả lời trước)
  const displayIndices = calculateIndicesToShow(chartData, 5); 
  // ------------------------------------------------

  const maxValue = chartData.length ? Math.max(...chartData) : 0;
  const c2d = ctx.getContext("2d");

  // 🎨 Gradient
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

    // --- LOGIC MỚI: Cập nhật chỉ số hiển thị và tooltip ---
    chart.options.plugins.datalabels.displayIndices = displayIndices;
    chart.options.plugins.tooltip.callbacks.label = (c) =>
      `${c.dataset.label}: ${
        type === "spend" ? formatMoneyShort(c.raw) : c.raw
      }`;
    // ---------------------------------------------------

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
          // --- LOGIC MỚI: Lưu các chỉ số hiển thị ---
          displayIndices: displayIndices,
          // --------------------------------------
          anchor: "end",
          align: "end",
          offset: 4,
          font: { size: 10},
          color: "#666",
          // --- LOGIC MỚI: Cập nhật formatter ---
          formatter: (v, ctx) => {
            const indices = ctx.chart.options.plugins.datalabels.displayIndices;
            const index = ctx.dataIndex;

            // Kiểm tra xem index này có trong Set không
            if (v > 0 && indices.has(index)) {
              // Dùng 'currentDetailDailyType' để đảm bảo lấy đúng 'type' hiện tại
              return currentDetailDailyType === "spend"
                ? formatMoneyShort(v)
                : v;
            }
            return ""; // Ẩn tất cả các nhãn khác
          },
          // -------------------------------------
        },
      },
      scales: {
        x: {
          grid: {
            color: "rgba(0,0,0,0.03)",
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
          grid: {
            color: "rgba(0,0,0,0.03)",
            drawBorder: true,
          },
          border: { color: "rgba(0,0,0,0.15)" },
          beginAtZero: true,
          suggestedMax: maxValue * 1.1,
          ticks: { display: false },
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
/**
 * Hàm trợ giúp: Lấy các chỉ số rải đều từ một mảng chỉ số ứng viên.
 */
function getSpreadIndices(indexArray, numPoints) {
  const set = new Set();
  const len = indexArray.length;
  if (numPoints === 0 || len === 0) return set;
  if (numPoints >= len) return new Set(indexArray);

  const step = (len - 1) / (numPoints - 1);
  for (let i = 0; i < numPoints; i++) {
    const arrayIndex = Math.round(i * step);
    set.add(indexArray[arrayIndex]);
  }
  return set;
}

/**
 * Tính toán các chỉ số datalabel (tối đa maxPoints)
 * Ưu tiên rải đều ở "giữa" và luôn bao gồm điểm cao nhất.
 */
function calculateIndicesToShow(data, maxPoints = 5) {
  const dataLength = data.length;
  if (dataLength <= 2) return new Set(); 

  const maxData = Math.max(...data);
  const maxIndex = data.indexOf(maxData);

  const middleIndices = Array.from({ length: dataLength - 2 }, (_, i) => i + 1);
  const middleLength = middleIndices.length;

  if (middleLength === 0) return new Set();
  
  if (middleLength < maxPoints) {
    const indices = new Set(middleIndices);
    indices.add(maxIndex); 
    return indices; 
  }
  
  let pointsToPick = maxPoints;
  const isMaxInMiddle = (maxIndex > 0 && maxIndex < dataLength - 1);
  
  if (!isMaxInMiddle) {
    pointsToPick = maxPoints - 1;
  }
  
  const indicesToShow = getSpreadIndices(middleIndices, pointsToPick);

  if (isMaxInMiddle && !indicesToShow.has(maxIndex)) {
    let closestIndex = -1;
    let minDistance = Infinity;
    for (const index of indicesToShow) {
      const distance = Math.abs(index - maxIndex);
      if (distance < minDistance) {
        minDistance = distance;
        closestIndex = index;
      }
    }
    if (closestIndex !== -1) indicesToShow.delete(closestIndex);
    indicesToShow.add(maxIndex);
  }
  
  if (!isMaxInMiddle) {
    indicesToShow.add(maxIndex);
  }
  
  return indicesToShow;
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

  // --- LOGIC MỚI: TÍNH TOÁN CHỈ SỐ CHO MỖI DATASET ---
  const spentDisplayIndices = calculateIndicesToShow(spentData, 5);
  const resultDisplayIndices = calculateIndicesToShow(resultData, 5);
  // --------------------------------------------------

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
          // --- LOGIC MỚI: LƯU CẢ HAI SET CHỈ SỐ ---
          displayIndicesSpent: spentDisplayIndices,
          displayIndicesResult: resultDisplayIndices,
          // ---------------------------------------
          anchor: "end",
          align: "end",
          offset: 4,
          font: { size: 11 },
          color: "#666",
          // --- LOGIC MỚI: CẬP NHẬT FORMATTER ---
          formatter: (v, ctx) => {
            if (v <= 0) return ""; // Ẩn số 0

            const index = ctx.dataIndex;
            const datalabelOptions = ctx.chart.options.plugins.datalabels;

            // Kiểm tra xem đang ở dataset "Spent"
            if (ctx.dataset.label === "Spent") {
              if (datalabelOptions.displayIndicesSpent.has(index)) {
                return formatMoneyShort(v);
              }
            } 
            // Kiểm tra xem đang ở dataset "Result"
            else if (ctx.dataset.label === "Result") {
              if (datalabelOptions.displayIndicesResult.has(index)) {
                return v;
              }
            }
            
            return ""; // Ẩn tất cả các điểm khác
          },
          // -----------------------------------
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
          suggestedMax: maxSpent * 1.1, 
          ticks: { display: false },
        },
        yResult: {
          type: "linear",
          position: "right",
          grid: { drawOnChartArea: false },
          border: { color: "rgba(0,0,0,0.15)" },
          beginAtZero: true,
          suggestedMax: maxResult * 1.2, 
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

  const prettyName = (key) => {
    key = key.toLowerCase();
    if (key.includes("android")) return "Android";
    if (key.includes("iphone") || key.includes("ipad")) return "iPhone";
    if (key.includes("tablet")) return "Tablet";
    if (key.includes("desktop")) return "Desktop";
    return key.charAt(0).toUpperCase() + key.slice(1);
  };

  // ✅ Lấy device có result > 0
  const validEntries = Object.entries(dataByDevice)
    .map(([k, v]) => [prettyName(k), getResults(v) || 0])
    .filter(([_, val]) => val > 0);

  if (!validEntries.length) {
    if (window.chart_by_device_instance)
      window.chart_by_device_instance.destroy();
    return;
  }

  // 🔹 Sort giảm dần theo result
  validEntries.sort((a, b) => b[1] - a[1]);
  const labels = validEntries.map(([k]) => k);
  const resultData = validEntries.map(([_, v]) => v);

  // 🎨 Màu sắc: top 2 nổi bật
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

  // 🔢 Tính % cao nhất
  const total = resultData.reduce((a, b) => a + b, 0);
  const maxIndex = resultData.indexOf(Math.max(...resultData));
  const maxLabel = labels[maxIndex];
  const maxPercent = ((resultData[maxIndex] / total) * 100).toFixed(1);

  if (window.chart_by_device_instance)
    window.chart_by_device_instance.destroy();

  // 🎯 Plugin custom: show % giữa lỗ
  const centerTextPlugin = {
    id: "centerText",
    afterDraw(chart) {
      const { width, height } = chart;
      const ctx = chart.ctx;
      ctx.save();
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = "#333";
  
      // 🎯 Dịch text lên 10px cho đúng giữa lỗ donut
      const centerY = height / 2 - 18;
  
      ctx.font = "bold 18px sans-serif";
      ctx.fillText(`${maxPercent}%`, width / 2, centerY - 4);
  
      ctx.font = "12px sans-serif";
      ctx.fillText(maxLabel, width / 2, centerY + 18);
      ctx.restore();
    },
  };

  // 🎨 Render chart
  window.chart_by_device_instance = new Chart(c2d, {
    type: "doughnut",
    data: {
      labels,
      datasets: [
        {
          label: "Results",
          data: resultData,
          backgroundColor: colors,
          borderColor: "#fff",
          borderWidth: 2,
        },
      ],
    },
    options: {
      responsive: true,
      cutout: "70%", // 💫 tạo lỗ tròn
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: "bottom",
          labels: {
            color: "#333",
            boxWidth: 14,
            padding: 10,
          },
        },
        tooltip: {
          callbacks: {
            label: (ctx) =>
              `${ctx.label}: ${formatNumber(ctx.raw)} (${(
                (ctx.raw / total) *
                100
              ).toFixed(1)}%)`,
          },
        },
        datalabels: { display: false },
      },
      hoverOffset: 8,
    },
    plugins: [centerTextPlugin],
  });
}

function renderChartByRegion(dataByRegion) {
  console.log(dataByRegion);
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
  const minSpend = totalSpend * 0.02; 

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
    if (groupKey === "byAgeGender" || groupKey === "byRegion")
      return "https://raw.githubusercontent.com/DEV-trongphuc/DOM_MISA_IDEAS_CRM/refs/heads/main/DOM_MKT%20(2).png";

    if (k.includes("facebook"))
      return "https://upload.wikimedia.org/wikipedia/commons/0/05/Facebook_Logo_%282019%29.png";
    if (k.includes("instagram"))
      return "https://upload.wikimedia.org/wikipedia/commons/e/e7/Instagram_logo_2016.svg";

    return "https://raw.githubusercontent.com/DEV-trongphuc/DOM_MISA_IDEAS_CRM/refs/heads/main/DOM_MKT%20(2).png";
  };

  let hasData = false;

  for (const [groupKey, groupLabel] of Object.entries(sources)) {
    const group = allData[groupKey];
    if (!group) continue;

    const items = [];
    for (const [key, val] of Object.entries(group)) {
      const spend = +val.spend || 0;
      const result = getResults(val); // có thể = 0 hoặc undefined
      const goal = VIEW_GOAL;

      let cpr = 0;
      if (result && spend) {
        cpr = goal === "REACH" ? (spend / result) * 1000 : spend / result;
      }

      // ✅ Nếu có spend > 0 thì vẫn push, chỉ set result = 0
      if (spend > 0) items.push({ key, spend, result: result || 0, cpr, goal });
    }

    if (!items.length) continue;
    hasData = true;

    // ✅ Sắp xếp theo spend giảm dần trước
    items.sort((a, b) => b.spend - a.spend);

    // Tìm giá trị CPR min và max
    const cprValues = items.map((x) => x.cpr).filter((x) => x > 0);
    const minCPR = Math.min(...cprValues);
    const maxCPR = Math.max(...cprValues);

    // Divider group
    const divider = document.createElement("li");
    divider.className = "blank";
    divider.innerHTML = `<p><strong>${groupLabel}</strong></p>`;
    wrap.appendChild(divider);

    items.forEach((p) => {
      let color = "rgb(213,141,0)"; // mặc định vàng
      if (p.cpr === minCPR && p.result > 0) color = "rgb(2,116,27)"; // ✅ xanh cho CPR tốt nhất
      else if (p.cpr === maxCPR && p.result > 0) color = "rgb(215,0,0)"; // 🔴 đỏ cho CPR cao nhất
      const bg = color.replace("rgb", "rgba").replace(")", ",0.05)");

      const li = document.createElement("li");
      li.dataset.platform = p.key;
      li.className = p.cpr === minCPR ? "best-performer" : "";
      li.innerHTML = `
        <p>
          <img src="${getLogo(p.key, groupKey)}" alt="${p.key}" />
          <span>${formatName(p.key)}</span>
        </p>
        <p><span class="total_spent"><i class="fa-solid fa-money-bill"></i> ${p.spend.toLocaleString("vi-VN")}đ</span></p>
        <p><span class="total_result"><i class="fa-solid fa-bullseye"></i> ${
          p.result > 0 ? formatNumber(p.result) : "—"
        }</span></p>
        <p class="toplist_percent" style="color:${color};background:${bg}">
          ${p.result > 0 ? formatMoney(p.cpr) : "—"}
        </p>
      `;
      wrap.appendChild(li);
    });
  }

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
      if (p.cpr === minCPR) color = "rgb(2,116,27)";
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
  renderDetailDailyChart(byDate, "spend"); 
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
/**
 * Hàm trợ giúp: Lấy các chỉ số rải đều từ một mảng chỉ số ứng viên.
 * @param {number[]} indexArray - Mảng các chỉ số ứng viên (ví dụ: [1, 2, ... 28])
 * @param {number} numPoints - Số lượng điểm cần lấy.
 * @returns {Set<number>}
 */
function getSpreadIndices(indexArray, numPoints) {
  const set = new Set();
  const len = indexArray.length;
  if (numPoints === 0 || len === 0) return set;

  // Nếu cần nhiều điểm hơn số lượng hiện có, trả về tất cả
  if (numPoints >= len) {
    return new Set(indexArray);
  }

  // Tính toán bước nhảy để rải đều
  const step = (len - 1) / (numPoints - 1);
  for (let i = 0; i < numPoints; i++) {
    const arrayIndex = Math.round(i * step);
    set.add(indexArray[arrayIndex]);
  }
  return set;
}

/**
 * Tính toán các chỉ số datalabel (tối đa maxPoints)
 * Ưu tiên rải đều ở "giữa" (không lấy điểm đầu/cuối)
 * Luôn đảm bảo bao gồm điểm cao nhất (maxIndex).
 * @param {number[]} data - Mảng dữ liệu chart.
 * @param {number} maxPoints - Số điểm tối đa muốn hiển thị.
 * @returns {Set<number>}
 */
function calculateIndicesToShow(data, maxPoints = 5) {
  const dataLength = data.length;
  // Cần ít nhất 3 điểm mới có "điểm giữa"
  if (dataLength <= 2) return new Set(); 

  // 1. Tìm điểm cao nhất
  const maxData = Math.max(...data);
  const maxIndex = data.indexOf(maxData);

  // 2. Định nghĩa các ứng viên "ở giữa" (từ index 1 đến N-2)
  const middleIndices = Array.from({ length: dataLength - 2 }, (_, i) => i + 1);
  const middleLength = middleIndices.length;

  // Nếu không có điểm giữa (chỉ có 2 điểm), trả về set rỗng
  if (middleLength === 0) return new Set();
  
  // 3. Nếu số điểm giữa < 5, thì hiển thị hết điểm giữa
  if (middleLength < maxPoints) {
    const indices = new Set(middleIndices);
    indices.add(maxIndex); // Thêm điểm max (dù nó ở đâu)
    return indices; // Sẽ có <= maxPoints
  }
  
  // 4. Nếu có đủ điểm giữa (>= maxPoints)
  
  let pointsToPick = maxPoints;
  const isMaxInMiddle = (maxIndex > 0 && maxIndex < dataLength - 1);
  
  // Nếu max ở đầu/cuối, ta cần (maxPoints - 1) điểm ở giữa
  if (!isMaxInMiddle) {
    pointsToPick = maxPoints - 1;
  }
  
  // 5. Lấy các điểm rải đều ở giữa
  const indicesToShow = getSpreadIndices(middleIndices, pointsToPick);

  // 6. Nếu max ở giữa VÀ không được chọn, thay thế điểm gần nhất
  if (isMaxInMiddle && !indicesToShow.has(maxIndex)) {
    let closestIndex = -1;
    let minDistance = Infinity;

    for (const index of indicesToShow) {
      const distance = Math.abs(index - maxIndex);
      if (distance < minDistance) {
        minDistance = distance;
        closestIndex = index;
      }
    }
    
    if (closestIndex !== -1) {
      indicesToShow.delete(closestIndex);
    }
    indicesToShow.add(maxIndex); // Đảm bảo maxIndex nằm trong set
  }
  
  // 7. Nếu max ở đầu/cuối, thêm nó vào (bây giờ set sẽ đủ maxPoints)
  if (!isMaxInMiddle) {
    indicesToShow.add(maxIndex);
  }
  
  return indicesToShow;
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
    return getChartValue(item, type); // Giả sử hàm này tồn tại
  });

  // --- LOGIC MỚI SẼ TỰ ĐỘNG CHẠY Ở ĐÂY ---
  // Gọi hàm helper đã được cập nhật
  const displayIndices = calculateIndicesToShow(chartData, 5);
  // ----------------------------------------

  const gLine = ctx.getContext("2d").createLinearGradient(0, 0, 0, 400);
  gLine.addColorStop(0, "rgba(255,169,0,0.25)");
  gLine.addColorStop(1, "rgba(255,171,0,0.05)");

  if (window.detail_spent_chart_instance2) {
    const chart = window.detail_spent_chart_instance2;
    if (chart.data.labels.join(",") !== dates.join(",")) {
      chart.data.labels = dates;
    }
    chart.data.datasets[0].data = chartData;
    chart.data.datasets[0].label = type.charAt(0).toUpperCase() + type.slice(1);
    
    chart.options.plugins.tooltip.callbacks.label = (c) =>
      `${c.dataset.label}: ${
        type === "spend" ? formatMoneyShort(c.raw) : c.raw
      }`;

    // --- CẬP NHẬT CHỈ SỐ MỚI ---
    chart.options.plugins.datalabels.displayIndices = displayIndices;
    // ----------------------------

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
          // --- LƯU CHỈ SỐ LẦN ĐẦU ---
          displayIndices: displayIndices, 
          // --------------------------
          anchor: "end",
          align: "end",
          font: { size: 11 },
          color: "#555",
          // --- FORMATTER (KHÔNG ĐỔI) ---
          formatter: (v, ctx) => {
            const indices = ctx.chart.options.plugins.datalabels.displayIndices;
            const index = ctx.dataIndex;

            if (v > 0 && indices.has(index)) {
              return currentDetailDailyType === "spend" ? formatMoneyShort(v) : v;
            }
            
            return ""; 
          },
          // ---------------------------
        },
      },
      scales: {
        x: {
          grid: {
            color: "rgba(0,0,0,0.03)",
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
    const url = `${BASE_URL}/act_${ACCOUNT_ID}/insights?fields=spend,impressions,reach,actions&time_range={"since":"${startDate}","until":"${endDate}"}${filtering}&access_token=${META_TOKEN}`;

    const data = await fetchJSON(url);
    console.log(data.data);

    return data.data || [];
  } catch (err) {
    console.error("❌ Error fetching platform stats:", err);
    return [];
  }
}

function updatePlatformSummaryUI(data) {
  if (!data) return;

  // ⚠️ Trường hợp fetchPlatformStats trả về array
  if (Array.isArray(data)) data = data[0] || {};

  // Chuyển actions[] thành object để dễ truy cập key
  const act = {};
  (data.actions || []).forEach(({ action_type, value }) => {
    act[action_type] = (act[action_type] || 0) + (+value || 0);
  });

  const totalSpend = +data.spend || 0;
  const totalReach = +data.reach || 0;
  const totalImpression = +data.impressions || 0;

  const totalLike = act["like"] || 0;
  const totalFollow = act["page_follow"] || act["page_like"] || 0;
  const totalReaction = act["post_reaction"] || 0;
  const totalComment = act["comment"] || 0;
  const totalShare = act["post"] || act["share"] || 0;
  const totalClick = act["link_click"] || 0;
  const totalView = act["video_view"] || 0;
  const totalMessage =
    act["onsite_conversion.messaging_conversation_started_7d"] || 0;
  const totalLead =
    act["lead"] ||
    act["onsite_web_lead"] ||
    act["onsite_conversion.lead_grouped"] ||
    0;

  // --- Render UI ---
  document.querySelector(
    "#spent span"
  ).textContent = `${totalSpend.toLocaleString("vi-VN")}đ`;
  document.querySelector("#reach span").textContent =
    totalReach.toLocaleString("vi-VN");
  document.querySelector("#message span").textContent =
    totalMessage.toLocaleString("vi-VN");
  document.querySelector("#lead span").textContent =
    totalLead.toLocaleString("vi-VN");

  document.querySelector(".dom_interaction_reaction").textContent =
    totalReaction.toLocaleString("vi-VN");
  document.querySelector(".dom_interaction_like").textContent = (
    totalLike + totalFollow
  ).toLocaleString("vi-VN");
  document.querySelector(".dom_interaction_comment").textContent =
    totalComment.toLocaleString("vi-VN");
  document.querySelector(".dom_interaction_share").textContent =
    totalShare.toLocaleString("vi-VN");
  document.querySelector(".dom_interaction_click").textContent =
    totalClick.toLocaleString("vi-VN");
  document.querySelector(".dom_interaction_view").textContent =
    totalView.toLocaleString("vi-VN");
  
}

async function loadPlatformSummary(campaignIds = []) {
  const data = await fetchPlatformStats(campaignIds);
  updatePlatformSummaryUI(data);
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
async function fetchSpendByAgeGender(campaignIds = []) {
  try {
    if (!ACCOUNT_ID) throw new Error("ACCOUNT_ID is required");

    // Nếu có campaignIds thì filter, còn không thì query theo account
    const filtering = campaignIds.length
      ? `&filtering=${encodeURIComponent(
          JSON.stringify([
            { field: "campaign.id", operator: "IN", value: campaignIds },
          ])
        )}`
      : "";

    const url = `${BASE_URL}/act_${ACCOUNT_ID}/insights?fields=spend&breakdowns=age,gender&time_range={"since":"${startDate}","until":"${endDate}"}${filtering}&access_token=${META_TOKEN}`;

    const data = await fetchJSON(url);
    const results = data.data || [];

    return results;
  } catch (err) {
    console.error("❌ Error fetching spend by age_gender:", err);
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
async function loadAgeGenderSpendChart(campaignIds = []) {
  const data = await fetchSpendByAgeGender(campaignIds);
  renderAgeGenderChart(data);
}

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
        box.classList.add("show");
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

document.addEventListener("click", (e) => {
  const select = e.target.closest(".quick_filter_detail");
  const option = e.target.closest(".quick_filter_detail ul li");

  // ✅ Toggle dropdown khi click vào select (nhưng không phải chọn item)
  if (select && !option) {
    select.classList.toggle("active");
    return;
  }

  // ✅ Khi chọn 1 option
  if (option) {
    const parent = option.closest(".quick_filter_detail");
    if (!parent) return;

    const imgEl = option.querySelector("img");
    const nameEl = option.querySelector("span");
    const filterValue = option.dataset?.filter;

    // Nếu thiếu dữ liệu → không làm gì cả
    if (!imgEl || !nameEl || !filterValue) return;

    const imgSrc = imgEl.src;
    const name = nameEl.textContent.trim();
    const filter = filterValue.trim().toLowerCase();

    // Update UI
    const parentImg = parent.querySelector("img");
    const parentText = parent.querySelector(".dom_selected");
    if (parentImg) parentImg.src = imgSrc;
    if (parentText) parentText.textContent = name;

    parent.classList.remove("active");

    // Gọi hàm filter nếu tồn tại
    if (typeof applyCampaignFilter === "function") {
      applyCampaignFilter(filter);
    }
  }
});

function renderAgeGenderChart(rawData = []) {
  if (!Array.isArray(rawData) || !rawData.length) return;

  // 🚫 Bỏ gender unknown
  const data = rawData.filter(
    (d) => d.gender && d.gender.toLowerCase() !== "unknown"
  );
  if (!data.length) return;

  const ctx = document.getElementById("age_gender_total");
  if (!ctx) return;
  const c2d = ctx.getContext("2d");

  // ❌ Clear chart cũ
  if (window.chart_age_gender_total?.destroy) {
    window.chart_age_gender_total.destroy();
    window.chart_age_gender_total = null;
  }

  // 🔹 Gom theo độ tuổi + giới tính
  const ages = [...new Set(data.map((d) => d.age))].sort(
    (a, b) => parseInt(a) - parseInt(b)
  );

  const maleSpends = [];
  const femaleSpends = [];
  const totalByAge = {};

  ages.forEach((age) => {
    const male = data.find(
      (d) => d.age === age && d.gender.toLowerCase() === "male"
    );
    const female = data.find(
      (d) => d.age === age && d.gender.toLowerCase() === "female"
    );
    const maleSpend = male ? +male.spend : 0;
    const femaleSpend = female ? +female.spend : 0;
    maleSpends.push(maleSpend);
    femaleSpends.push(femaleSpend);
    totalByAge[age] = maleSpend + femaleSpend;
  });

  // 🔸 Xác định nhóm tuổi có tổng chi cao nhất
  const maxAge = Object.keys(totalByAge).reduce((a, b) =>
    totalByAge[a] > totalByAge[b] ? a : b
  );

  // 🎨 Màu
  const gradientGray = c2d.createLinearGradient(0, 0, 0, 300);
  gradientGray.addColorStop(0, "rgba(210,210,210,1)");
  gradientGray.addColorStop(1, "rgba(160,160,160,0.6)");

  const gradientGold = c2d.createLinearGradient(0, 0, 0, 300);
  gradientGold.addColorStop(0, "rgba(255,169,0,1)");
  gradientGold.addColorStop(1, "rgba(255,169,0,0.6)");

  const maleColors = ages.map((age) =>
    age === maxAge ? gradientGold : gradientGray
  );
  const femaleColors = ages.map((age) =>
    age === maxAge ? gradientGold : gradientGray
  );

  // ⚙️ Cấu hình Chart.js
  window.chart_age_gender_total = new Chart(c2d, {
    type: "bar",
    data: {
      labels: ages,
      datasets: [
        {
          label: "Male",
          data: maleSpends,
          backgroundColor: maleColors,
          borderRadius: 8,
          borderWidth: 0,
        },
        {
          label: "Female",
          data: femaleSpends,
          backgroundColor: femaleColors,
          borderRadius: 8,
          borderWidth: 0,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      layout: { padding: { left: 10, right: 10 } },
      animation: { duration: 700, easing: "easeOutQuart" },
      plugins: {
        legend: { display: false }, // ❌ bỏ chú thích
        tooltip: {
          callbacks: {
            title: (ctx) => `Age: ${ctx[0].label}`,
            label: (ctx) => `${ctx.dataset.label}: ${formatMoneyShort(ctx.raw)}`,
          },
        },
        datalabels: { display: false }, // ❌ bỏ label trên bar
      },
      scales: {
        x: {
          stacked: false,
          grid: {
            color: "rgba(0,0,0,0.03)",
            drawBorder: true,
            borderColor: "rgba(0,0,0,0.05)",
          },
          ticks: {
            color: "#555",
            font: { weight: "600", size: 11 },
          },
          title: { display: false},
        },
        y: {
          beginAtZero: true,
          grid: {
            color: "rgba(0,0,0,0.03)",
            drawBorder: true,
            borderColor: "rgba(0,0,0,0.05)",
          },
          ticks: { display: false },
          title: { display: false},
        },
      },
    },
    plugins: [ChartDataLabels],
  });
}
document.querySelectorAll('.dom_menu li').forEach(menuItem => {
  menuItem.addEventListener('click', function() {
    // Remove active class from all menu items
    document.querySelectorAll('.dom_menu li').forEach(item => item.classList.remove('active'));
    // Add active class to the clicked item
    menuItem.classList.add('active');

    // Get the data-view of the clicked item
    const view = menuItem.getAttribute('data-view');

    // Get the container div and update its classes
    const container = document.querySelector('.dom_container');
    
    // Remove all views from the container
    container.classList.remove('dashboard', 'ad_detail');
    
    // Add the relevant class based on the clicked item
    container.classList.add(view);
  });
});

// 🎯 Quick Filter Logic

const quickFilterBox = document.querySelector(".quick_filter");
if (quickFilterBox) {
  const selectedText = quickFilterBox.querySelector(".dom_selected");
  const listItems = quickFilterBox.querySelectorAll(".dom_select_show li");

  listItems.forEach((li) => {
    li.addEventListener("click", async (e) => {
      e.stopPropagation(); // 🧱 chặn sự kiện lan lên .quick_filter

      // Xóa highlight cũ
      listItems.forEach((x) => x.classList.remove("active"));
      li.classList.add("active");

      // Lấy label & data-view
      const label = li.querySelector("span:last-child")?.textContent || "";
      const view = li.querySelector(".radio_box")?.dataset.view || "";

      // Hiển thị text đã chọn
      selectedText.textContent = label;

      // --- 🔹 Active campaigns ---
      if (view === "active_ads") {
        const activeLower = "active";

        const activeCampaigns = window._ALL_CAMPAIGNS.filter((c) => {
          let campaignActive = false;
          for (const adset of c.adsets || []) {
            for (const ad of adset.ads || []) {
              if ((ad.status || "").toLowerCase() === activeLower) {
                campaignActive = true;
                break;
              }
            }
            if (campaignActive) break;
          }
          return campaignActive;
        });

        console.log(
          `🔹 Active campaigns found: ${activeCampaigns.length}/${window._ALL_CAMPAIGNS.length}`
        );

        renderCampaignView(activeCampaigns);
      }

      // --- 🔹 Reset filter ---
      else if (view === "reset") {
        selectedText.textContent = "Quick filter";
        renderCampaignView(window._ALL_CAMPAIGNS);
      }

      // ✅ Đóng dropdown ngay lập tức
      quickFilterBox.classList.remove("active");
    });
  });

  // Toggle mở dropdown
  quickFilterBox.addEventListener("click", (e) => {
    if (
      e.target.closest(".flex") ||
      e.target.classList.contains("fa-angle-down")
    ) {
      quickFilterBox.classList.toggle("active");
    }
  });

  // 🧠 Click ra ngoài dropdown → tự đóng luôn
  document.addEventListener("click", (e) => {
    if (!quickFilterBox.contains(e.target)) {
      quickFilterBox.classList.remove("active");
    }
  });
}


document.addEventListener("click", (e) => {
  const accountBox = e.target.closest(".dom_account_view");
  const option = e.target.closest(".dom_account_view ul li");

  // 🧩 Toggle dropdown khi click icon hoặc phần header
  if (accountBox && !option) {
    accountBox.classList.toggle("active");
    return;
  }

  // ✅ Khi chọn 1 tài khoản
  if (option) {
    const parent = option.closest(".dom_account_view");
    if (!parent) return;

    // Lấy data account
    const accId = option.dataset.acc;
    const imgEl = option.querySelector("img");
    const nameEl = option.querySelector("span");

    // Check đủ dữ liệu chưa
    if (!accId || !imgEl || !nameEl) return;

    // 🔹 Update UI
    const avatar = parent.querySelector(".account_item_avatar");
    const accName = parent.querySelector(".account_item_name");
    const accIdEl = parent.querySelector(".account_item_id");

    if (avatar) avatar.src = imgEl.src;
    if (accName) accName.textContent = nameEl.textContent.trim();
    if (accIdEl) accIdEl.textContent = accId;
    console.log(accId);
    // 🔹 Gán lại biến global
    ACCOUNT_ID = accId;
    console.log(`🔄 ACCOUNT_ID changed to: ${ACCOUNT_ID}`);

    // 🔹 Đóng dropdown
    parent.classList.remove("active");

   
    loadDashboardData();
  }

  // ✅ Click ra ngoài thì đóng dropdown
  if (!e.target.closest(".dom_account_view")) {
    document
      .querySelectorAll(".dom_account_view.active")
      .forEach((el) => el.classList.remove("active"));
  }
});
