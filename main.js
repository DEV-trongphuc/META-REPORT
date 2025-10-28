let monthlyChartInstance = null;
// Nhãn tháng (dùng chung)
const MONTH_LABELS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
let startDate, endDate;
let VIEW_GOAL; // Dùng cho chart breakdown
const CACHE = new Map();
let DAILY_DATA = [];
const BATCH_SIZE = 10;
const CONCURRENCY_LIMIT = 40;
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
const campaignIconMapping = {
  "Lead Form": "fa-solid fa-bullseye",
  Awareness: "fa-solid fa-eye",
  Engagement: "fa-solid fa-star",
  Message: "fa-solid fa-comments",
  Traffic: "fa-solid fa-mouse-pointer",
  Pagelike: "fa-solid fa-thumbs-up",
  DEFAULT: "fa-solid fa-crosshairs", // Icon dự phòng
};

// ⭐ TỐI ƯU: Tạo reverse lookup map cho goal group
// Thay vì dùng Object.keys().find() mỗi lần, ta tạo map này 1 lần
// { "LEAD_GENERATION": "Lead Form", "REACH": "Awareness", ... }
const GOAL_GROUP_LOOKUP = Object.create(null);
for (const group in goalMapping) {
  for (const goal of goalMapping[group]) {
    GOAL_GROUP_LOOKUP[goal] = group;
  }
}

/**
 * Hàm helper mới: Lấy class icon dựa trên optimization_goal
 */
function getCampaignIcon(optimizationGoal) {
  if (!optimizationGoal) {
    return campaignIconMapping.DEFAULT;
  }
  // ⭐ TỐI ƯU: Dùng O(1) lookup thay vì find()
  const goalGroup = GOAL_GROUP_LOOKUP[optimizationGoal];
  return campaignIconMapping[goalGroup] || campaignIconMapping.DEFAULT;
}
// ================== Helper ==================

/**
 * ⭐ TỐI ƯU: Thay thế .find() bằng for loop
 * Hàm này được gọi trong getReaction, vốn được gọi nhiều lần trong groupByCampaign
 */
function getAction(actions, type) {
  if (!actions || !Array.isArray(actions)) return 0;
  for (let i = 0; i < actions.length; i++) {
    const a = actions[i];
    if (a.action_type === type) {
      return +a.value || 0;
    }
  }
  return 0;
}

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
  if (!item) return 0;
  const insights = item.insights?.data?.[0] || item.insights || item;
  if (!insights) return 0;

  const optimization_goal =
    goal ||
    VIEW_GOAL ||
    item.optimization_goal ||
    insights.optimization_goal ||
    "";

  if (optimization_goal === "REACH") {
    return +insights.reach || 0;
  }
  if (optimization_goal === "IMPRESSIONS") {
    return +insights.impressions || 0;
  }

  const actions = insights.actions || {};

  // ⭐ TỐI ƯU: Dùng O(1) lookup thay vì Object.keys().find()
  const goalKey = GOAL_GROUP_LOOKUP[optimization_goal];

  let resultType =
    resultMapping[optimization_goal] ||
    (goalKey ? resultMapping[goalMapping[goalKey][0]] : resultMapping.DEFAULT);

  if (Array.isArray(actions)) {
    // Dùng for loop thay vì find() để tối ưu performance
    for (let i = 0; i < actions.length; i++) {
      const a = actions[i];
      if (a.action_type === resultType) {
        return +a.value || 0;
      }
    }
    return 0;
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
  if (CACHE.has(key)) return CACHE.get(key); // Trả về cache nếu có

  try {
    const res = await fetch(url, options);
    const text = await res.text();
    if (!res.ok) {
      let msg = `HTTP ${res.status} - ${res.statusText}`;
      try {
        const errData = JSON.parse(text);
        if (errData.error)
          msg = `Meta API Error: ${errData.error.message} (Code: ${errData.error.code})`;

        // Retry logic
        if (errData.error?.code === 4) {
          console.warn("⚠️ Rate limit reached. Waiting 5s then retry...");
          await new Promise((r) => setTimeout(r, 5000));
          return fetchJSON(url, options); // Thử lại sau khi bị giới hạn tốc độ
        }
      } catch {}
      throw new Error(msg);
    }
    const data = JSON.parse(text);
    CACHE.set(key, data); // Lưu vào cache sau khi lấy dữ liệu
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
  let allData = []; // Mảng chứa tất cả dữ liệu
  let nextPageUrl = `${BASE_URL}/act_${ACCOUNT_ID}/insights?level=adset&fields=adset_id,adset_name,campaign_id,campaign_name,optimization_goal&filtering=[{"field":"spend","operator":"GREATER_THAN","value":0}]&time_range={"since":"${startDate}","until":"${endDate}"}&access_token=${META_TOKEN}&limit=10000`;

  // Tiến hành lặp lại việc gọi API cho đến khi không còn cursor tiếp theo
  while (nextPageUrl) {
    const data = await fetchJSON(nextPageUrl);
    console.log(data);

    if (data.data) {
      allData = allData.concat(data.data); // Thêm dữ liệu vào mảng allData
    }

    nextPageUrl = data.paging && data.paging.next ? data.paging.next : null;
  }

  return allData;
}

async function fetchAdsAndInsights(adsetIds, onBatchProcessedCallback) {
  if (!Array.isArray(adsetIds) || adsetIds.length === 0) return [];

  const headers = {
    "Content-Type": "application/json",
    Prefer: "return=minimal",
  };
  const now = Date.now();
  const results = [];
  let batchCount = 0;

  console.time("⏱️ Total fetchAdsAndInsights");

  // Chia adsetIds thành các batch
  const adsetChunks = chunkArray(adsetIds, BATCH_SIZE);

  // Giảm số lượng batch song song để tối ưu hóa hiệu suất
  await runBatchesWithLimit(
    adsetChunks.map((batch) => async () => {
      const startTime = performance.now();

      // Xây dựng batch API
      const fbBatch = batch.map((adsetId) => ({
        method: "GET",
        relative_url:
          `${adsetId}/ads?fields=id,name,effective_status,adset_id,` +
          `adset{end_time,daily_budget,lifetime_budget},` +
          `creative{thumbnail_url,instagram_permalink_url,effective_object_story_id},` +
          `insights.time_range({since:'${startDate}',until:'${endDate}'}){spend,impressions,reach,actions,optimization_goal}`,
      }));

      // Gọi API
      let adsResp;
      try {
        adsResp = await fetchJSON(BASE_URL, {
          method: "POST",
          headers,
          body: JSON.stringify({ access_token: META_TOKEN, batch: fbBatch }),
        });
      } catch (error) {
        console.error("Error fetching data:", error);
        return; // Nếu có lỗi, bỏ qua batch này
      }

      // Xử lý kết quả từ API
      const processed = [];
      for (const item of adsResp) {
        if (item?.code !== 200 || !item?.body) continue;

        let body;
        try {
          body = JSON.parse(item.body);
        } catch {
          continue;
        }

        const data = body.data;
        if (!Array.isArray(data) || data.length === 0) continue;
        // Duyệt qua từng ad trong dữ liệu trả về và xử lý
        for (const ad of data) {
          const adset = ad.adset ?? {};
          const creative = ad.creative ?? {};
          const insights = ad.insights?.data?.[0] ?? {};
          const endTime = adset.end_time ? Date.parse(adset.end_time) : 0;

          const effective_status =
            ad.effective_status === "ACTIVE" && endTime && endTime < now
              ? "COMPLETED"
              : ad.effective_status;

          // Chỉ lấy thông tin cần thiết từ insights
          processed.push({
            ad_id: ad.id,
            ad_name: ad.name,
            adset_id: ad.adset_id,
            effective_status,
            adset: {
              status: adset.status ?? null,
              daily_budget: adset.daily_budget || 0,
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

      // Stream kết quả sớm để tránh nghẽn bộ nhớ
      if (processed.length) {
        onBatchProcessedCallback?.(processed);
        results.push(...processed);
      }

      // Perf log
      batchCount++;
      const elapsed = (performance.now() - startTime).toFixed(0);
    }),
    CONCURRENCY_LIMIT // Giới hạn số lượng batch song song
  );

  console.timeEnd("⏱️ Total fetchAdsAndInsights");
  return results;
}

async function fetchDailySpendByAccount() {
  const url = `${BASE_URL}/act_${ACCOUNT_ID}/insights?fields=spend,impressions,reach,actions&time_increment=1&time_range[since]=${startDate}&time_range[until]=${endDate}&access_token=${META_TOKEN}`;
  const data = await fetchJSON(url);
  return data.data || [];
}

async function loadDailyChart() {
  try {
    const dailyData = await fetchDailySpendByAccount();
    DAILY_DATA = dailyData;
    renderDetailDailyChart2(DAILY_DATA);
  } catch (err) {
    console.error("❌ Error in Flow 1 (Daily Chart):", err);
  }
}
function groupByCampaign(adsets) {
  if (!Array.isArray(adsets) || adsets.length === 0) return [];

  const campaigns = Object.create(null); // ⚙️ Dùng map cache hành động -> tránh gọi find nhiều lần

  const safeGetActionValue = (actions, type) => {
    if (!Array.isArray(actions) || !actions.length) return 0;
    for (let i = 0; i < actions.length; i++) {
      const a = actions[i];
      if (a.action_type === type) return +a.value || 0;
    }
    return 0;
  }; // ⚡ Duyệt qua tất cả adsets (1 vòng chính)

  for (let i = 0; i < adsets.length; i++) {
    const as = adsets[i];
    if (!as?.ads?.length) continue;

    const campId = as.campaign_id || as.campaignId || "unknown_campaign";
    const campName = as.campaign_name || as.campaignName || "Unknown";
    const goal = as.optimization_goal || as.optimizationGoal || "UNKNOWN";
    const asId = as.id || as.adset_id || as.adsetId || `adset_${i}`; // 🧱 Tạo campaign nếu chưa có

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
        // Thêm status cho campaign (lấy từ ad đầu tiên, giả định chúng giống nhau)
        // Mặc dù vậy, `ad.effective_status` vẫn đáng tin cậy hơn
      };
    } // 🔹 Cache adset trong campaign

    let adset = campaign._adsetMap[asId];
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
        end_time: as.ads?.[0]?.adset?.end_time || null,
        daily_budget: as.ads?.[0]?.adset?.daily_budget || 0,
        lifetime_budget: as.ads?.[0]?.adset?.lifetime_budget || 0,
      };
      campaign._adsetMap[asId] = adset;
      campaign.adsets.push(adset);
    } // 🔁 Lặp nhanh qua ads

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
      const result = getResults(ins) || 0; // (Cần hàm này)
      const reactions = getReaction(ins) || 0; // (Cần hàm này)

      const actions = ins.actions;
      const messageCount = safeGetActionValue(
        actions,
        "onsite_conversion.messaging_conversation_replied_7d"
      );
      const leadCount =
        safeGetActionValue(actions, "lead") +
        safeGetActionValue(actions, "onsite_conversion.lead_grouped"); // ✅ Cộng dồn adset-level

      adset.spend += spend;
      adset.result += result;
      adset.reach += reach;
      adset.impressions += impressions;
      adset.reactions += reactions;
      adset.lead += leadCount;
      adset.message += messageCount; // ✅ Cộng dồn campaign-level

      campaign.spend += spend;
      campaign.result += result;
      campaign.reach += reach;
      campaign.impressions += impressions;
      campaign.reactions += reactions;
      campaign.lead += leadCount;
      campaign.message += messageCount; // 🖼️ Add ad summary

      adset.ads.push({
        id: ad.ad_id || ad.id || null,
        name: ad.ad_name || ad.name || "Unnamed Ad", // ⭐ QUAN TRỌNG: Đây là status đáng tin cậy nhất
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
  } // 🧹 Xoá map nội bộ, convert sang array

  return Object.values(campaigns).map((c) => {
    // Gán status cho campaign dựa trên adset đầu tiên
    // (Lưu ý: Logic này có thể cần xem lại nếu campaign có nhiều adset với status khác nhau)
    if (c.adsets.length > 0) {
      c.status = c.adsets[0].status;
    }

    delete c._adsetMap;
    return c;
  });
}

function renderCampaignView(data) {
  const wrap = document.querySelector(".view_campaign_box");
  if (!wrap || !Array.isArray(data)) return;

  const now = Date.now();
  const activeLower = "active";

  let totalCampaignCount = data.length;
  let activeCampaignCount = 0;
  let totalAdsetCount = 0;
  let activeAdsetCount = 0;

  // ==== ⭐ TỐI ƯU 1: Vòng lặp tiền xử lý (Pre-processing) ====
  // Tính toán cờ `isActive` và số lượng active MỘT LẦN.
  // Thêm các thuộc tính tạm thời (transient) vào object `data`
  for (let i = 0; i < data.length; i++) {
    const c = data[i];
    const adsets = c.adsets || [];
    c._isActive = false; // Cờ tạm thời cho campaign
    c._activeAdsetCount = 0; // Cờ tạm thời cho số adset active
    totalAdsetCount += adsets.length;

    for (let j = 0; j < adsets.length; j++) {
      const as = adsets[j];
      // Tính toán trạng thái và số lượng ads active cho adset
      as._activeAdsCount = 0;
      as._isActive = false;
      const ads = as.ads || [];

      // ==== ⭐ CẬP NHẬT: Sắp xếp ads (active lên trước, rồi theo spend) ====
      ads.sort((a, b) => {
        const aIsActive = a.status?.toLowerCase() === activeLower;
        const bIsActive = b.status?.toLowerCase() === activeLower;

        if (aIsActive !== bIsActive) {
          return bIsActive - aIsActive; // true (1) đi trước false (0)
        }
        // Nếu cả hai cùng trạng thái, sắp xếp theo spend
        return b.spend - a.spend;
      });
      // =================================================================

      // Duyệt qua các ads và tính toán trạng thái active của adset
      for (let k = 0; k < ads.length; k++) {
        if (ads[k].status?.toLowerCase() === activeLower) {
          as._activeAdsCount++;
          as._isActive = true;
        }
      }

      // Nếu adset active, cập nhật trạng thái của campaign
      if (as._isActive) {
        c._isActive = true;
        c._activeAdsetCount++;
        activeAdsetCount++; // Đếm số adset active trong tổng
      }
    } // <-- Hết vòng lặp adset (j)

    // ==== ⭐ THÊM MỚI: Sắp xếp adset trong campaign ====
    // Sắp xếp các adset: active lên trước, sau đó theo spend
    adsets.sort((a, b) => {
      if (a._isActive !== b._isActive) {
        return b._isActive - a._isActive; // true (1) đi trước false (0)
      }
      // Nếu cả hai cùng trạng thái, sắp xếp theo spend
      return b.spend - a.spend;
    });
    // ===============================================

    // Nếu campaign có ít nhất 1 adset active, campaign được đánh dấu là active
    if (c._isActive) {
      activeCampaignCount++;
    }
  }

  // === Cập nhật UI tổng active (dùng cờ đã tính) ===
  const activeCpEls = document.querySelectorAll(".dom_active_cp");
  if (activeCpEls.length >= 2) {
    // Cập nhật trạng thái campaign
    const campEl = activeCpEls[0].querySelector("span:nth-child(2)");
    if (campEl) {
      const hasActiveCampaign = activeCampaignCount > 0;
      campEl.classList.toggle("inactive", !hasActiveCampaign);
      campEl.innerHTML = `<span class="live-dot"></span>${activeCampaignCount}/${totalCampaignCount}`;
    }

    // Cập nhật trạng thái adset
    const adsetEl = activeCpEls[1].querySelector("span:nth-child(2)");
    if (adsetEl) {
      const hasActiveAdset = activeAdsetCount > 0;
      adsetEl.classList.toggle("inactive", !hasActiveAdset);
      adsetEl.innerHTML = `<span class="live-dot"></span>${activeAdsetCount}/${totalAdsetCount}`;
    }
  }

  // === ⭐ TỐI ƯU 2: Sắp xếp (Sort) ===
  // Dùng cờ `_isActive` đã tính toán
  data.sort((a, b) => {
    if (a._isActive !== b._isActive) return b._isActive - a._isActive;
    return b.spend - a.spend;
  });

  // === ⭐ TỐI ƯU 3: Render (dùng cờ đã tính) ===
  const htmlBuffer = [];

  for (let i = 0; i < data.length; i++) {
    const c = data[i];
    const adsets = c.adsets; // adsets lúc này đã được sắp xếp

    // Dùng cờ `_isActive` và `_activeAdsetCount` đã tính
    const hasActiveAdset = c._isActive;
    const activeAdsetCountForDisplay = c._activeAdsetCount;

    const campaignStatusClass = hasActiveAdset ? "active" : "inactive";
    const campaignStatusText = hasActiveAdset
      ? `${activeAdsetCountForDisplay} ACTIVE`
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
          <div class="ad_cpr">${
            campaignCpr > 0 ? formatMoney(campaignCpr) : "-"
          }</div>
          <div class="ad_cpm">${formatMoney(calcCpm(c.spend, c.reach))}</div>
          <div class="ad_reach">${formatNumber(c.reach)}</div>
          <div class="ad_frequency">${calcFrequency(
            c.impressions,
            c.reach
          )}</div>
          <div class="ad_reaction">${formatNumber(c.reactions)}</div>
          <div class="campaign_view"><i class="fa-solid fa-angle-down"></i></div>
        </div>`);

    // === Render adset (dùng cờ đã tính) ===
    for (let j = 0; j < adsets.length; j++) {
      const as = adsets[j];
      const ads = as.ads; // ads lúc này cũng đã được sắp xếp

      // Dùng cờ `_isActive` và `_activeAdsCount` đã tính
      const hasActiveAd = as._isActive;
      const activeAdsCount = as._activeAdsCount;

      let adsetStatusClass = "inactive";
      let adsetStatusText = "INACTIVE";

      const endTime = as.end_time ? new Date(as.end_time).getTime() : null;
      const isEnded = endTime && endTime < now;
      const dailyBudget = +as.daily_budget || 0;
      const lifetimeBudget = +as.lifetime_budget || 0;

      if (isEnded) {
        adsetStatusClass = "complete";
        adsetStatusText = `<span class="status-label">COMPLETE</span>`;
      } else if (hasActiveAd && dailyBudget > 0) {
        adsetStatusClass = "active dbudget";
        adsetStatusText = `
          <span class="status-label">Daily Budget</span>
          <span class="status-value">${dailyBudget.toLocaleString(
            "vi-VN"
          )}đ</span>`;
      } else if (hasActiveAd && lifetimeBudget > 0) {
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

      const adsHtml = new Array(ads.length);
      for (let k = 0; k < ads.length; k++) {
        const ad = ads[k];
        const isActive = ad.status?.toLowerCase() === activeLower;
        const adCpr =
          ad.result > 0
            ? as.optimization_goal === "REACH"
              ? (ad.spend / ad.result) * 1000
              : ad.spend / ad.result
            : "-";

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
            <div class="ad_cpr">${adCpr > 0 ? formatMoney(adCpr) : "-"}</div>
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
            <a>
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
    const adsets = await fetchAdsets();
    if (!adsets || !adsets.length) throw new Error("No adsets found.");

    const adsetIds = adsets.map((as) => as.adset_id).filter(Boolean);
    const ads = await fetchAdsAndInsights(adsetIds);

    const adsetMap = new Map(
      adsets.map((as) => {
        as.ads = [];
        return [as.adset_id, as];
      })
    );
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
  setupFilterDropdown();
  setupYearDropdown();

  // ⭐ TỐI ƯU: Gọi addListeners MỘT LẦN DUY NHẤT
  addListeners();

  const { start, end } = getDateRange("last_7days");
  startDate = start;
  endDate = end;

  // Có thể add thêm listener hoặc setup UI khác ở đây
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
  loadRegionSpendChart();
  initializeYearData();
  fetchAdAccountInfo();
  resetYearDropdownToCurrentYear();
  resetFilterDropdownTo("spend");
  loadCampaignList().finally(() => {
    if (loading) loading.classList.remove("active");
  });
}

// 🚀 Hàm chính gọi khi load trang lần đầu
async function main() {
  renderYears();
  initDashboard(); // <-- addListeners() được gọi bên trong hàm này
  initializeYearData();
  fetchAdAccountInfo();
  await loadDashboardData();
}

main();
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

/**
 * ⭐ TỐI ƯU: Sử dụng Event Delegation.
 * Thay vì gán N listener, ta gán 1 listener duy nhất cho container cha.
 * Hàm này chỉ cần chạy 1 lần lúc initDashboard.
 */
function addListeners() {
  const wrap = document.querySelector(".view_campaign_box");
  if (!wrap) {
    console.warn(
      "Không tìm thấy container .view_campaign_box để gán listener."
    );
    return;
  }

  // 1. Listener chính cho clicks bên trong .view_campaign_box
  wrap.addEventListener("click", (e) => {
    // 1a. Xử lý click vào Campaign (mở Adset)
    const campaignMain = e.target.closest(".campaign_main");
    if (campaignMain) {
      e.stopPropagation();
      const campaignItem = campaignMain.closest(".campaign_item");
      if (!campaignItem) return;

      if (campaignItem.classList.contains("show")) {
        campaignItem.classList.remove("show");
        return;
      }
      // Đóng tất cả campaign khác
      wrap
        .querySelectorAll(".campaign_item.show")
        .forEach((c) => c.classList.remove("show"));
      // Mở campaign hiện tại
      campaignItem.classList.add("show");
      return; // Đã xử lý xong, không cần check thêm
    }

    // 1b. Xử lý click vào Adset (mở Ad)
    const adsetItem = e.target.closest(".adset_item");
    if (adsetItem) {
      // Ngăn chặn khi click vào nút view
      if (e.target.closest(".adset_view")) return;

      e.stopPropagation();
      adsetItem.classList.toggle("show");
      return; // Đã xử lý xong
    }

    // 1c. Xử lý click vào nút "View Ad Detail"
    const adViewBtn = e.target.closest(".ad_view");
    if (adViewBtn) {
      e.stopPropagation();
      handleViewClick(e, "ad"); // Gọi hàm xử lý cũ
      return; // Đã xử lý xong
    }

    // (Nếu có logic cho .adset_view, thêm vào đây)
    // const adsetViewBtn = e.target.closest(".adset_view");
    // if (adsetViewBtn) {
    //   e.stopPropagation();
    //   handleViewClick(e, "adset");
    //   return;
    // }
  });

  // 2. Listener cho việc đóng popup chi tiết
  // (Listener này đã tối ưu, giữ nguyên)
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
  const el = e.target.closest(".ad_item"); // Sử dụng closest để tìm phần tử cha .ad_item
  if (!el) {
    console.error("Không tìm thấy phần tử .ad_item");
    return;
  }

  // Lấy phần tử .ad_view từ trong el (ad_item)
  const adViewEl = el.querySelector(".ad_view"); // Tìm .ad_view bên trong .ad_item

  if (!adViewEl) {
    console.error("Không tìm thấy phần tử .ad_view bên trong .ad_item");
    return;
  }

  // Lấy ID từ dataset của .ad_view
  const id =
    type === "adset" ? adViewEl.dataset.adsetId : adViewEl.dataset.adId;
  if (!id) return;

  // --- Lấy dữ liệu từ dataset của .ad_view ---
  const spend = parseFloat(adViewEl.dataset.spend || 0);
  const reach = parseFloat(adViewEl.dataset.reach || 0);
  const impressions = parseFloat(adViewEl.dataset.impressions || 0);
  const goal = adViewEl.dataset.goal || "";
  const name = adViewEl.dataset.name || "";
  const result = parseFloat(adViewEl.dataset.result || 0);
  const cpr = parseFloat(adViewEl.dataset.cpr || 0);
  const thumb =
    adViewEl.dataset.thumb ||
    "https://upload.wikimedia.org/wikipedia/commons/a/ac/No_image_available.svg";
  const postUrl = adViewEl.dataset.post || "#";

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
    if (impLabel) impLabel.textContent = impressions.toLocaleString("vi-VN");
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

  // Hủy các chart cũ chỉ một lần
  const chartsToDestroy = [
    window.detail_spent_chart_instance,
    window.chart_by_hour_chart,
    window.chart_by_age_gender_chart,
    window.chart_by_region_chart,
    window.chart_by_device_chart,
    window.chart_by_platform_chart,
  ];

  chartsToDestroy.forEach((chart) => chart?.destroy());
  window.detail_spent_chart_instance = null;
  // Gán lại null cho tất cả các instance đã destroy
  window.chart_by_hour_chart = null;
  window.chart_by_age_gender_chart = null;
  window.chart_by_region_chart = null;
  window.chart_by_device_chart = null;
  window.chart_by_platform_chart = null;

  try {
    // Fetch tất cả API song song
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

    // Kiểm tra xem dữ liệu đã sẵn sàng chưa
    if (
      !targeting ||
      !byHour ||
      !byAgeGender ||
      !byRegion ||
      !byPlatform ||
      !byDevice ||
      !byDate
    ) {
      console.error("❌ Missing required data for ad_id:", ad_id);
      return;
    }

    // ================== Render Targeting ==================
    renderTargetingToDOM(targeting);

    // ================== Render Interaction ==================
    renderInteraction(byDevice); // Note: Original code uses byDevice, but byDate seems more correct for total interactions. Keeping as-is.
    window.dataByDate = byDate; // Lưu trữ dữ liệu cho việc vẽ chart

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
        const filtered = keyword
          ? window._ALL_CAMPAIGNS.filter((c) =>
              (c.name || "").toLowerCase().includes(keyword)
            )
          : window._ALL_CAMPAIGNS;

        // 🔹 Render lại danh sách và tổng quan
        renderCampaignView(filtered);
      } else if (e.target.value.trim() === "") {
        // 🧹 Nếu clear input → reset về mặc định
        renderCampaignView(window._ALL_CAMPAIGNS);
      }
    }, 300)
  );

  // 👀 Khi clear input bằng tay (xóa hết text)
  filterInput.addEventListener(
    "input",
    debounce((e) => {
      if (e.target.value.trim() === "") {
        renderCampaignView(window._ALL_CAMPAIGNS);
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
      const filtered = keyword
        ? window._ALL_CAMPAIGNS.filter((c) =>
            (c.name || "").toLowerCase().includes(keyword)
          )
        : window._ALL_CAMPAIGNS;

      // 🔹 Render lại danh sách và tổng quan
      renderCampaignView(filtered);
    }, 300)
  );
}

async function applyCampaignFilter(keyword) {
  if (!window._ALL_CAMPAIGNS || !Array.isArray(window._ALL_CAMPAIGNS)) return;

  // 🚩 Nếu filter = "RESET" thì load full data
  if (keyword && keyword.toUpperCase() === "RESET") {
    renderCampaignView(window._ALL_CAMPAIGNS); // FULL_CAMPAIGN
    await reloadFullData(); // gọi 1 hàm load lại toàn bộ
    return;
  }

  // 🔹 Lọc campaign theo tên (không phân biệt hoa thường)
  const filtered = keyword
    ? window._ALL_CAMPAIGNS.filter((c) =>
        (c.name || "").toLowerCase().includes(keyword.toLowerCase())
      )
    : window._ALL_CAMPAIGNS;

  // 🔹 Render lại danh sách và tổng quan
  renderCampaignView(filtered);

  // 🔹 Lấy ID campaign hợp lệ để gọi API (lọc bỏ null)
  const ids = filtered.map((c) => c.id).filter(Boolean);
  loadPlatformSummary(ids);
  loadSpendPlatform(ids);
  loadRegionSpendChart(ids);
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
async function fetchDailySpendByCampaignIDs(campaignIds = []) {
  const loading = document.querySelector(".loading");
  if (loading) loading.classList.add("active");
  try {
    if (!ACCOUNT_ID) throw new Error("ACCOUNT_ID is required");

    const filtering = encodeURIComponent(
      JSON.stringify([
        { field: "campaign.id", operator: "IN", value: campaignIds },
      ])
    );

    const url = `${BASE_URL}/act_${ACCOUNT_ID}/insights?fields=spend,impressions,reach,actions,campaign_name,campaign_id&time_increment=1&filtering=${filtering}&time_range={"since":"${startDate}","until":"${endDate}"}&access_token=${META_TOKEN}`;

    const data = await fetchJSON(url);
    const results = data.data || [];

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
  let min = 18,
    max = 65;
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
    const fullMin = 18,
      fullMax = 65;
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
          (r) => `${r.name} (${r.radius}${r.distance_unit || "km"})`
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
    const langs = targeting.locales.map(
      (l) => localeMap[l] || `Locale ID ${l}`
    );
    localeWrap.innerHTML = langs
      .map(
        (l) => `<p><i class="fa-solid fa-language"></i><span>${l}</span></p>`
      )
      .join("");
  }

  // === PLACEMENT ===
  const placementWrap = targetBox.querySelector(".detail_placement");
  if (placementWrap) {
    const { publisher_platforms, facebook_positions, instagram_positions } =
      targeting || {};
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
  // Original was byDevice, changed to byDate as it seems more logical
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
      label: "Media Views",
      icon: "fa-solid fa-video",
    },
    {
      key: "like",
      label: "Follows",
      icon: "fa-solid fa-video", // Icon was fa-video, assuming typo, kept as-is
    },
    {
      key: "onsite_conversion.messaging_conversation_replied_7d",
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
  const isMaxInMiddle = maxIndex > 0 && maxIndex < dataLength - 1;

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
    if (type === "lead") return getResults(item);
    if (type === "reach") return item.reach || 0;
    if (type === "message")
      return (
        item.actions["onsite_conversion.messaging_conversation_replied_7d"] || 0
      );
    return 0;
  });

  const displayIndices = calculateIndicesToShow(chartData, 5);
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

    chart.options.plugins.datalabels.displayIndices = displayIndices;
    chart.options.plugins.tooltip.callbacks.label = (c) =>
      `${c.dataset.label}: ${
        type === "spend" ? formatMoneyShort(c.raw) : c.raw
      }`;

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
          displayIndices: displayIndices,
          anchor: "end",
          align: "end",
          offset: 4,
          font: { size: 10 },
          color: "#666",
          formatter: (v, ctx) => {
            const indices = ctx.chart.options.plugins.datalabels.displayIndices;
            const index = ctx.dataIndex;

            if (v > 0 && indices.has(index)) {
              return currentDetailDailyType === "spend"
                ? formatMoneyShort(v)
                : v;
            }
            return ""; // Ẩn tất cả các nhãn khác
          },
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
  const resultData = labels.map((l) => getResults(data[l]));

  if (window[`${id}_chart`]) window[`${id}_chart`].destroy(); // Hủy chart cũ
  window[`${id}_chart`] = null; // Gán null

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

  const spentDisplayIndices = calculateIndicesToShow(spentData, 5);
  const resultDisplayIndices = calculateIndicesToShow(resultData, 5);

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
  window.chartByHourInstance = null; // Gán null

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
        tooltip: {
          callbacks: {
            label: (c) =>
              `${c.dataset.label}: ${
                c.dataset.label === "Spent" ? formatMoneyShort(c.raw) : c.raw
              }`,
          },
        },
        datalabels: {
          displayIndicesSpent: spentDisplayIndices,
          displayIndicesResult: resultDisplayIndices,
          anchor: "end",
          align: "end",
          offset: 4,
          font: { size: 11 },
          color: "#666",
          formatter: (v, ctx) => {
            if (v <= 0) return ""; // Ẩn số 0

            const index = ctx.dataIndex;
            const datalabelOptions = ctx.chart.options.plugins.datalabels;

            if (ctx.dataset.label === "Spent") {
              if (datalabelOptions.displayIndicesSpent.has(index)) {
                return formatMoneyShort(v);
              }
            } else if (ctx.dataset.label === "Result") {
              if (datalabelOptions.displayIndicesResult.has(index)) {
                return v;
              }
            }

            return ""; // Ẩn tất cả các điểm khác
          },
        },
      },
      scales: {
        x: {
          grid: { color: "rgba(0,0,0,0.03)", drawBorder: true },
          border: { color: "rgba(0,0,0,0.15)" },
          ticks: {
            color: "#444",
            font: { size: 11 },
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
    return key
      .replace(/_/g, " ") // chuyển _ thành space
      .replace(
        /\w\S*/g,
        (w) => w[0].toUpperCase() + w.substring(1).toLowerCase()
      );
  };

  const validEntries = Object.entries(dataByDevice)
    .map(([k, v]) => [prettyName(k), getResults(v) || 0])
    .filter(([_, val]) => val > 0);

  if (window.chart_by_device_instance) {
    window.chart_by_device_instance.destroy();
    window.chart_by_device_instance = null; // Gán null
  }

  if (!validEntries.length) {
    return; // Không có data, không vẽ chart
  }

  validEntries.sort((a, b) => b[1] - a[1]);
  const labels = validEntries.map(([k]) => k);
  const resultData = validEntries.map(([_, v]) => v);

  const highlightColors = [
    "rgba(255,171,0,0.9)", // vàng

    "rgba(156,163,175,0.7)",
  ];
  const fallbackColors = [
    "rgba(38,42,83,0.9)", // xanh đậm
    "rgba(0, 59, 59, 0.7)",
    "rgba(0, 71, 26, 0.7)",
    "rgba(153, 0, 0, 0.7)",
  ];
  const colors = resultData.map((_, i) =>
    i < 2 ? highlightColors[i] : fallbackColors[i - 2] || "#ccc"
  );

  const total = resultData.reduce((a, b) => a + b, 0);
  const maxIndex = resultData.indexOf(Math.max(...resultData));
  const maxLabel = labels[maxIndex];
  const maxPercent = ((resultData[maxIndex] / total) * 100).toFixed(1);

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
  if (!dataByRegion) return;

  const ctx = document.getElementById("chart_by_region");
  if (!ctx) return;
  const c2d = ctx.getContext("2d");

  const prettyName = (key) =>
    key
      .replace(/province/gi, "")
      .trim()
      .replace(/^\w/, (c) => c.toUpperCase());

  const entries = Object.entries(dataByRegion).map(([k, v]) => ({
    name: prettyName(k),
    spend: v.spend || 0,
    result: getResults(v) || 0,
  }));

  const totalSpend = entries.reduce((acc, e) => acc + e.spend, 0);
  const minSpend = totalSpend * 0.02;

  const filtered = entries.filter((r) => r.spend >= minSpend);

  if (window.chart_by_region_instance) {
    window.chart_by_region_instance.destroy();
    window.chart_by_region_instance = null;
  }

  if (!filtered.length) return;

  filtered.sort((a, b) => b.spend - a.spend);

  const labels = filtered.map((e) => e.name);
  const spentData = filtered.map((e) => e.spend);
  const resultData = filtered.map((e) => e.result);

  // 🎯 Highlight theo Result
  const maxResultIndex = resultData.indexOf(Math.max(...resultData));

  // ✨ Gradient vàng quyền lực
  const gradientGold = c2d.createLinearGradient(0, 0, 0, 300);
  gradientGold.addColorStop(0, "rgba(255,169,0,1)");
  gradientGold.addColorStop(1, "rgba(255,169,0,0.4)");

  // 🌫 Gradient xám thanh lịch
  const gradientGray = c2d.createLinearGradient(0, 0, 0, 300);
  gradientGray.addColorStop(0, "rgba(210,210,210,0.9)");
  gradientGray.addColorStop(1, "rgba(160,160,160,0.4)");

  // ✅ Apply màu theo chỉ số maxResultIndex
  const spentColors = labels.map((_, i) =>
    i === maxResultIndex ? gradientGold : gradientGray
  );

  const resultColors = labels.map((_, i) =>
    i === maxResultIndex ? gradientGold : gradientGray
  );

  window.chart_by_region_instance = new Chart(c2d, {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: "Spent",
          data: spentData,
          backgroundColor: spentColors,
          borderWidth: 0,
          borderRadius: 6,
          yAxisID: "ySpend",
        },
        {
          label: "Result",
          data: resultData,
          backgroundColor: resultColors,
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
      layout: { padding: { left: 10, right: 10 } },
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
          color: "#555",
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
            color: "rgba(0,0,0,0.03)",
            drawBorder: true,
          },
          ticks: {
            color: "#444",
            font: { weight: "600", size: 11 },
            maxRotation: 0,
            minRotation: 0,
            autoSkip: false,
          },
        },
        ySpend: {
          type: "linear",
          position: "left",
          grid: { color: "rgba(0,0,0,0.03)" },
          beginAtZero: true,
          ticks: { display: false },
          suggestedMax: Math.max(...spentData) * 1.1,
        },
        yResult: {
          type: "linear",
          position: "right",
          grid: { drawOnChartArea: false },
          beginAtZero: true,
          ticks: { display: false },
          suggestedMax: Math.max(...resultData) * 1.1,
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

  // ✅ Chỉ gom Male + Female
  for (const [key, val] of Object.entries(dataByAgeGender)) {
    const lowerKey = key.toLowerCase();

    let gender = null;
    if (lowerKey.includes("female")) gender = "female";
    else if (lowerKey.includes("male")) gender = "male";
    else continue;

    const age = key
      .replace(/_|male|female/gi, "")
      .trim()
      .toUpperCase();

    if (!ageGroups[age]) ageGroups[age] = { male: 0, female: 0 };
    ageGroups[age][gender] = getResults(val) || 0;
  }

  const ages = Object.keys(ageGroups);
  const maleData = ages.map((a) => ageGroups[a].male);
  const femaleData = ages.map((a) => ageGroups[a].female);

  // ✅ Highlight theo tổng result
  const totals = ages.map((a) => ageGroups[a].male + ageGroups[a].female);
  const maxTotalIndex = totals.indexOf(Math.max(...totals));

  // ✨ Gradient vàng quyền lực
  const gradientGold = c2d.createLinearGradient(0, 0, 0, 300);
  gradientGold.addColorStop(0, "rgba(255,169,0,1)");
  gradientGold.addColorStop(1, "rgba(255,169,0,0.4)");

  // 🌫 Gradient xám thanh lịch
  const gradientGray = c2d.createLinearGradient(0, 0, 0, 300);
  gradientGray.addColorStop(0, "rgba(210,210,210,0.9)");
  gradientGray.addColorStop(1, "rgba(160,160,160,0.4)");

  const maleColors = ages.map((_, i) =>
    i === maxTotalIndex ? gradientGold : gradientGray
  );
  const femaleColors = ages.map((_, i) =>
    i === maxTotalIndex ? gradientGold : gradientGray
  );

  if (window.chart_by_age_gender_instance) {
    window.chart_by_age_gender_instance.destroy();
    window.chart_by_age_gender_instance = null;
  }

  window.chart_by_age_gender_instance = new Chart(c2d, {
    type: "bar",
    data: {
      labels: ages,
      datasets: [
        {
          label: "Male",
          data: maleData,
          backgroundColor: maleColors,
          borderRadius: 6,
          borderWidth: 0,
        },
        {
          label: "Female",
          data: femaleData,
          backgroundColor: femaleColors,
          borderRadius: 6,
          borderWidth: 0,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      layout: { padding: { left: 10, right: 10 } },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) =>
              `${ctx.dataset.label}: ${formatMoneyShort(ctx.raw)}`,
          },
        },
        datalabels: {
          anchor: "end",
          align: "end",
          offset: 2,
          font: { weight: "600", size: 11 },
          color: "#555",
          formatter: (v) => (v > 0 ? formatMoneyShort(v) : ""),
        },
      },
      scales: {
        x: {
          grid: { color: "rgba(0,0,0,0.03)", drawBorder: true },
          ticks: {
            color: "#444",
            font: { weight: "600", size: 11 },
            maxRotation: 0,
            minRotation: 0,
            autoSkip: false,
          },
        },
        y: {
          beginAtZero: true,
          grid: { color: "rgba(0,0,0,0.03)", drawBorder: true },
          ticks: { display: false },
          suggestedMax: Math.max(...totals) * 1.1,
        },
      },
      animation: { duration: 600, easing: "easeOutQuart" },
    },
    plugins: [ChartDataLabels],
  });
}

const getLogo = (key, groupKey = "") => {
  const k = key.toLowerCase();
  if (groupKey === "byDevice") {
    if (
      k.includes("iphone") ||
      k.includes("ipod") ||
      k.includes("ipad") ||
      k.includes("macbook")
    )
      return "https://raw.githubusercontent.com/DEV-trongphuc/META-REPORT/refs/heads/main/logo_ip%20(1).png";
    if (k.includes("android") || k.includes("mobile"))
      return "https://upload.wikimedia.org/wikipedia/commons/d/d7/Android_robot.svg";
    if (k.includes("desktop") || k.includes("pc"))
      return "https://ms.codes/cdn/shop/articles/this-pc-computer-display-windows-11-icon.png?v=1709255180";
  }
  if (groupKey === "byAgeGender" || groupKey === "byRegion")
    return "https://raw.githubusercontent.com/DEV-trongphuc/DOM_MISA_IDEAS_CRM/refs/heads/main/DOM_MKT%20(2).png";

  if (k.includes("facebook"))
    return "https://upload.wikimedia.org/wikipedia/commons/0/05/Facebook_Logo_%282019%29.png";
  if (k.includes("messenger"))
    return "https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcRemnhxz7XnQ1BiDuwUlmdQoYO9Wyko5-uOGQ&s";
  if (k.includes("instagram"))
    return "https://upload.wikimedia.org/wikipedia/commons/e/e7/Instagram_logo_2016.svg";

  return "https://raw.githubusercontent.com/DEV-trongphuc/DOM_MISA_IDEAS_CRM/refs/heads/main/DOM_MKT%20(2).png";
};
const formatName = (key) =>
  key
    .replace(/[_-]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();

function renderChartByPlatform(allData) {
  const wrap = document.querySelector("#chart_by_platform .dom_toplist");
  if (!wrap || !allData) return;
  wrap.innerHTML = "";

  const sources = {
    byPlatform: "By Platform",
    byDevice: "By Device",
    byAgeGender: "By Age & Gender",
    byRegion: "By Region",
  };

  let hasData = false;
  const fragment = document.createDocumentFragment(); // ⭐ TỐI ƯU: Dùng Fragment

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

      if (spend > 0) items.push({ key, spend, result: result || 0, cpr, goal });
    }

    if (!items.length) continue;
    hasData = true;

    items.sort((a, b) => b.spend - a.spend);

    const cprValues = items.map((x) => x.cpr).filter((x) => x > 0);
    const minCPR = cprValues.length ? Math.min(...cprValues) : 0;
    const maxCPR = cprValues.length ? Math.max(...cprValues) : 0;

    // Divider group
    const divider = document.createElement("li");
    divider.className = "blank";
    divider.innerHTML = `<p><strong>${groupLabel}</strong></p>`;
    fragment.appendChild(divider);

    items.forEach((p) => {
      let color = "rgb(213,141,0)"; // mặc định vàng
      if (p.cpr > 0 && p.cpr === minCPR)
        color = "rgb(2,116,27)"; // ✅ xanh cho CPR tốt nhất
      else if (p.cpr > 0 && p.cpr === maxCPR) color = "rgb(215,0,0)"; // 🔴 đỏ cho CPR cao nhất
      const bg = color.replace("rgb", "rgba").replace(")", ",0.05)");

      const li = document.createElement("li");
      li.dataset.platform = p.key;
      li.className = p.cpr > 0 && p.cpr === minCPR ? "best-performer" : "";
      li.innerHTML = `
        <p>
          <img src="${getLogo(p.key, groupKey)}" alt="${p.key}" />
          <span>${formatName(p.key)}</span>
        </p>
        <p><span class="total_spent"><i class="fa-solid fa-money-bill"></i> ${p.spend.toLocaleString(
          "vi-VN"
        )}đ</span></p>
        <p><span class="total_result"><i class="fa-solid fa-bullseye"></i> ${
          p.result > 0 ? formatNumber(p.result) : "—"
        }</span></p>
        <p class="toplist_percent" style="color:${color};background:${bg}">
          ${p.result > 0 ? formatMoney(p.cpr) : "—"}
        </p>
      `;
      fragment.appendChild(li);
    });
  }

  if (!hasData) {
    wrap.innerHTML = `<li><p>Không có dữ liệu hợp lệ để hiển thị.</p></li>`;
  } else {
    wrap.appendChild(fragment); // ⭐ TỐI ƯU: Thêm vào DOM 1 lần
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

  const fragment = document.createDocumentFragment(); // ⭐ TỐI ƯU: Dùng Fragment
  let hasData = false; // Cờ kiểm tra

  for (const [groupKey, groupName] of Object.entries(sources)) {
    const group = allData[groupKey];
    if (!group) continue;

    const groupItems = [];
    for (const [key, val] of Object.entries(group)) {
      const spend = +val.spend || 0;
      const result = getResults(val);
      if (!spend || !result) continue;
      const goal = VIEW_GOAL;
      const cpr = goal === "REACH" ? (spend / result) * 1000 : spend / result;
      groupItems.push({ key, spend, result, cpr, goal });
    }

    if (!groupItems.length) continue;
    hasData = true; // Đánh dấu là có dữ liệu

    groupItems.sort((a, b) => a.cpr - b.cpr);

    const divider = document.createElement("li");
    divider.className = "blank";
    divider.innerHTML = `<p><strong>${groupName}</strong></p>`;
    fragment.appendChild(divider);

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
      fragment.appendChild(li);
    });
  }

  if (!hasData) {
    wrap.innerHTML = `<li><p>Không có dữ liệu đủ để phân tích.</p></li>`;
  } else {
    wrap.appendChild(fragment); // ⭐ TỐI ƯU: Thêm vào DOM 1 lần
  }
}

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
  // renderChartByPlatform(byPlatform); // Hàm này đã được gọi riêng
}

// Khởi chạy
// let currentDetailDailyType = "spend";
// --- Hàm lấy giá trị cho chart từ item và type ---
function getChartValue(item, type) {
  const actions = item.actions || [];

  const typeMap = {
    lead: ["lead", "onsite_conversion.lead_grouped"],
    message: ["onsite_conversion.messaging_conversation_replied_7d"],
    like: ["like"],
    spend: ["spend"],
    reach: ["reach"],
  };

  const keys = Array.isArray(typeMap[type]) ? typeMap[type] : [typeMap[type]];

  for (const k of keys) {
    if (k === "spend" && item.spend !== undefined) return +item.spend;
    if (k === "reach" && item.reach !== undefined) return +item.reach;

    // Tối ưu: dùng for loop thay vì find()
    for (let i = 0; i < actions.length; i++) {
      if (actions[i].action_type === k) {
        return +actions[i].value;
      }
    }
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
    return getChartValue(item, type); // Giả sử hàm này tồn tại
  });

  const displayIndices = calculateIndicesToShow(chartData, 5);
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

    chart.options.plugins.datalabels.displayIndices = displayIndices;
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
          displayIndices: displayIndices,
          anchor: "end",
          align: "end",
          font: { size: 11 },
          color: "#555",
          formatter: (v, ctx) => {
            const indices = ctx.chart.options.plugins.datalabels.displayIndices;
            const index = ctx.dataIndex;

            if (v > 0 && indices.has(index)) {
              return currentDetailDailyType === "spend"
                ? formatMoneyShort(v)
                : v;
            }

            return "";
          },
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
  const totalView = act["video_view"] || act["photo_view"] || 0;
  const totalMessage =
    act["onsite_conversion.messaging_conversation_replied_7d"] || 0;
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

    const url = `${BASE_URL}/act_${ACCOUNT_ID}/insights?fields=spend&breakdowns=publisher_platform,platform_position&time_range={"since":"${startDate}","until":"${endDate}"}${filtering}&access_token=${META_TOKEN}`;
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
async function fetchSpendByRegion(campaignIds = []) {
  try {
    if (!ACCOUNT_ID) throw new Error("ACCOUNT_ID is required");

    const filtering = campaignIds.length
      ? `&filtering=${encodeURIComponent(
          JSON.stringify([
            { field: "campaign.id", operator: "IN", value: campaignIds },
          ])
        )}`
      : "";

    const url = `${BASE_URL}/act_${ACCOUNT_ID}/insights?fields=spend&breakdowns=region&time_range={"since":"${startDate}","until":"${endDate}"}${filtering}&access_token=${META_TOKEN}`;

    const data = await fetchJSON(url);
    const results = data.data || [];

    return results;
  } catch (err) {
    console.error("❌ Error fetching spend by region:", err);
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
function formatNamePst(publisher, position) {
  // 🧩 Convert về lowercase để dễ check
  const pub = (publisher || "").toLowerCase();
  const pos = (position || "").toLowerCase();

  // 🚫 Nếu position đã chứa tên platform rồi thì bỏ nối
  let name;
  if (pos.includes(pub)) {
    name = position;
  } else {
    name = `${publisher}_${position}`;
  }

  // 🔤 Làm đẹp text
  name = name
    .replace(/[_-]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();

  return name;
}
function renderPlatformPosition(data) {
  const wrap = document.querySelector(".dom_platform_abs .dom_toplist");
  if (!wrap || !Array.isArray(data)) return;
  wrap.innerHTML = "";

  const positionMap = {};
  let totalSpend = 0;

  data.forEach((item) => {
    const publisher = item.publisher_platform || "other";
    const position = item.platform_position || "unknown";
    const key = `${publisher}_${position}`;
    const spend = +item.spend || 0;

    totalSpend += spend;
    if (!positionMap[key]) positionMap[key] = { spend: 0, publisher, position };
    positionMap[key].spend += spend;
  });

  const positions = Object.entries(positionMap).sort(
    (a, b) => b[1].spend - a[1].spend
  );
  const fragment = document.createDocumentFragment();

  positions.forEach(([key, val]) => {
    const { publisher, position, spend } = val;
    const percent = totalSpend > 0 ? (spend / totalSpend) * 100 : 0;
    const li = document.createElement("li");

    li.innerHTML = `
      <p>
        <img src="${getLogo(publisher)}" alt="${publisher}" />
        <span>${formatNamePst(publisher, position)}</span>
      </p>
      <p><span class="total_spent"><i class="fa-solid fa-money-bill"></i> ${spend.toLocaleString(
        "vi-VN"
      )}đ</span></p>
      <p class="toplist_percent" style="color:rgb(226, 151, 0);background:rgba(254,169,0,0.05)">
        ${percent.toFixed(1)}%
      </p>
    `;
    fragment.appendChild(li);
  });

  if (!positions.length) {
    wrap.innerHTML = `<li><p>Không có dữ liệu để hiển thị.</p></li>`;
  } else {
    wrap.appendChild(fragment);
  }
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

  const ctx = document.getElementById("platform_chart");
  if (!ctx) return;
  const c2d = ctx.getContext("2d");

  if (window.platformChartInstance) {
    window.platformChartInstance.destroy();
    window.platformChartInstance = null; // Gán null
  }

  if (total <= 0) return; // Nếu total = 0, chỉ destroy chart cũ và return

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
            "rgba(0, 30, 165, 0.9)", // Instagram (Đảo màu cho đúng)
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
  console.log(data);
  const summary = summarizeSpendByPlatform(data);
  renderPlatformSpendUI(summary); // cũ
  renderPlatformPosition(data); // mới
}
async function loadRegionSpendChart(campaignIds = []) {
  const data = await fetchSpendByRegion(campaignIds);
  renderRegionChart(data);
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
      resetUIFilter();
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
    resetUIFilter();
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
  const selectedText = document.querySelector(".quick_filter .dom_selected");
  selectedText.textContent = "Quick filter"; // Đặt lại text filter về mặc định
  // Gọi các hàm load dữ liệu
  loadDailyChart();
  loadPlatformSummary();
  loadSpendPlatform();
  loadCampaignList().finally(() => {
    if (loading) loading.classList.remove("active");
  });
}

// =================== MAIN INIT ===================

function renderAgeGenderChart(rawData = []) {
  if (!Array.isArray(rawData) || !rawData.length) return;

  // 🚫 Bỏ gender unknown
  const data = rawData.filter(
    (d) => d.gender && d.gender.toLowerCase() !== "unknown"
  );

  const ctx = document.getElementById("age_gender_total");
  if (!ctx) return;
  const c2d = ctx.getContext("2d");

  // ❌ Clear chart cũ
  if (window.chart_age_gender_total?.destroy) {
    window.chart_age_gender_total.destroy();
    window.chart_age_gender_total = null;
  }

  if (!data.length) return; // Nếu không có data (sau khi filter) thì return

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
            label: (ctx) =>
              `${ctx.dataset.label}: ${formatMoneyShort(ctx.raw)}`,
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
          title: { display: false },
        },
        y: {
          beginAtZero: true,
          grid: {
            color: "rgba(0,0,0,0.03)",
            drawBorder: true,
            borderColor: "rgba(0,0,0,0.05)",
          },
          ticks: { display: false },
          title: { display: false },
        },
      },
    },
    plugins: [ChartDataLabels],
  });
}
function renderRegionChart(data = []) {
  if (!Array.isArray(data) || !data.length) return;

  const ctx = document.getElementById("region_chart");
  if (!ctx) return;
  const c2d = ctx.getContext("2d");

  if (window.chart_region_total instanceof Chart) {
    try {
      window.chart_region_total.destroy();
    } catch (err) {
      console.warn("⚠️ Chart destroy error:", err);
    }
  }
  window.chart_region_total = null;

  const regionSpend = {};
  data.forEach((d) => {
    let region = (d.region || "").trim();
    if (!region || region.toUpperCase() === "UNKNOWN") return;

    region = region
      .replace(/\b(province|city|region|state|district|area|zone)\b/gi, "")
      .replace(/\b(tỉnh|thành phố|tp|quận|huyện)\b/gi, "")
      .replace(/\s+/g, " ")
      .trim();

    const spend = parseFloat(d.spend || 0);
    if (spend <= 0) return;

    const key = region.toLowerCase();
    regionSpend[key] = (regionSpend[key] || 0) + spend;
  });

  const totalSpend = Object.values(regionSpend).reduce((a, b) => a + b, 0);
  if (totalSpend === 0) return;

  // ✅ Lọc xuống đây
  const filtered = Object.entries(regionSpend).filter(
    ([_, v]) => (v / totalSpend) * 100 >= 2
  );
  if (!filtered.length) return;

  // ✅ Chuẩn hoá label
  const regions = filtered.map(([r]) =>
    r
      .toLowerCase()
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .normalize("NFC")
      .trim()
  );

  const values = filtered.map(([_, v]) => Math.round(v));

  const [maxRegion] = filtered.reduce((a, b) => (a[1] > b[1] ? a : b));

  const gradientGold = c2d.createLinearGradient(0, 0, 0, 300);
  gradientGold.addColorStop(0, "rgba(255,169,0,1)");
  gradientGold.addColorStop(1, "rgba(255,169,0,0.4)");

  const gradientGray = c2d.createLinearGradient(0, 0, 0, 300);
  gradientGray.addColorStop(0, "rgba(210,210,210,0.9)");
  gradientGray.addColorStop(1, "rgba(160,160,160,0.4)");

  const bgColors = filtered.map(([r]) =>
    r === maxRegion ? gradientGold : gradientGray
  );

  const isFew = regions.length < 3;
  const barWidth = isFew ? 0.35 : undefined;
  const catWidth = isFew ? 0.65 : undefined;

  window.chart_region_total = new Chart(c2d, {
    type: "bar",
    data: {
      labels: regions,
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
      layout: { padding: { left: 10, right: 10 } },
      animation: { duration: 600, easing: "easeOutQuart" },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: (ctx) => `${ctx[0].label}`,
            label: (ctx) => `Spend: ${formatMoneyShort(ctx.raw)}`,
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
            color: "rgba(0,0,0,0.03)",
            drawBorder: true,
            borderColor: "rgba(0,0,0,0.05)",
          },
          ticks: {
            color: "#666",
            font: { weight: "600", size: 9 },
            maxRotation: 0,
            minRotation: 0,
            autoSkip: false, // ✅ không bỏ label nữa
            maxTicksLimit: regions.length, // ✅ bắn full
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
          suggestedMax: Math.max(...values) * 1.1,
        },
      },
    },
    plugins: [ChartDataLabels],
  });
}

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
      const label = li.querySelector("span:last-child")?.innerHTML || "";
      const view = li.querySelector(".view_quick")?.dataset.view || "";

      // Hiển thị text đã chọn
      selectedText.innerHTML = label;

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

        renderCampaignView(activeCampaigns);
      }

      // --- 🔹 Lead Ads (Optimization Goal) ---
      else if (view === "lead_ads_goal") {
        const leadAdsCampaigns = window._ALL_CAMPAIGNS.filter((c) =>
          c.adsets?.some(
            (adset) =>
              adset.optimization_goal &&
              adset.optimization_goal.toLowerCase().includes("lead")
          )
        );

        renderCampaignView(leadAdsCampaigns);
      }

      // --- 🔹 Message Ads (Optimization Goal) ---
      else if (view === "mess_ads_goal") {
        const messageAdsCampaigns = window._ALL_CAMPAIGNS.filter((c) =>
          c.adsets?.some(
            (adset) =>
              adset.optimization_goal &&
              adset.optimization_goal.toLowerCase() === "replies"
          )
        );

        renderCampaignView(messageAdsCampaigns);
      }

      // --- 🔹 Engagement Ads (Optimization Goal) ---
      else if (view === "engage_ads_goal") {
        const engageAdsCampaigns = window._ALL_CAMPAIGNS.filter((c) =>
          c.adsets?.some((adset) =>
            [
              "post_engagement",
              "thruplay",
              "event_responses",
              "page_likes",
            ].includes(adset.optimization_goal.toLowerCase())
          )
        );

        renderCampaignView(engageAdsCampaigns);
      }

      // --- 🔹 Brand Awareness (Optimization Goal) ---
      else if (view === "ba_ads_goal") {
        const awarenessAdsCampaigns = window._ALL_CAMPAIGNS.filter((c) =>
          c.adsets?.some((adset) =>
            ["reach", "ad_recall_lift", "impressions"].includes(
              adset.optimization_goal.toLowerCase()
            )
          )
        );

        renderCampaignView(awarenessAdsCampaigns);
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
document.addEventListener("DOMContentLoaded", () => {
  const menuItems = document.querySelectorAll(".dom_menu li");
  const container = document.querySelector(".dom_container");
  const mobileMenu = document.querySelector("#mobile_menu");
  const domSidebar = document.querySelector(".dom_sidebar");

  const btnPlatform = document.querySelectorAll(".dom_title_button.platform");
  const btnRegion = document.querySelectorAll(".dom_title_button.region");
  const inner = document.querySelector(".dom_platform_inner");
  const region = document.querySelector(".dom_region_inner");

  if (btnPlatform && inner) {
    btnPlatform.forEach((btn) => {
      btn.addEventListener("click", () => {
        inner.classList.toggle("active");
      });
    });
  }
  if (btnRegion && region) {
    btnRegion.forEach((btn) => {
      btn.addEventListener("click", () => {
        region.classList.toggle("active");
      });
    });
  }
  // Toggle Sidebar on mobile menu click
  mobileMenu.addEventListener("click", () => {
    domSidebar.classList.toggle("active");
  });

  // Handle menu item click to switch views
  menuItems.forEach((li) => {
    li.addEventListener("click", () => {
      // Remove active class from all items
      menuItems.forEach((item) => item.classList.remove("active"));

      // Add active to the clicked item
      li.classList.add("active");

      // Remove old view classes from container
      container.classList.forEach((cls) => {
        if (["dashboard", "ad_detail", "account"].includes(cls)) {
          container.classList.remove(cls);
        }
      });

      // Add new view class based on the clicked item
      const view = li.getAttribute("data-view");
      container.classList.add(view);

      // Close the sidebar on mobile after a menu click
      domSidebar.classList.remove("active");
    });
  });

  // Handle account dropdown selection
  document.addEventListener("click", (e) => {
    const accountBox = e.target.closest(".dom_account_view");
    const option = e.target.closest(".dom_account_view ul li");

    if (accountBox && !option) {
      accountBox.classList.toggle("active");
      return;
    }

    if (option) {
      const parent = option.closest(".dom_account_view");
      if (!parent) return;

      const accId = option.dataset.acc;
      const imgEl = option.querySelector("img");
      const nameEl = option.querySelector("span");

      if (!accId || !imgEl || !nameEl) return;

      const avatar = parent.querySelector(".account_item_avatar");
      const accName = parent.querySelector(".account_item_name");
      const accIdEl = parent.querySelector(".account_item_id");

      if (avatar) avatar.src = imgEl.src;
      if (accName) accName.textContent = nameEl.textContent.trim();
      if (accIdEl) accIdEl.textContent = accId;

      // Update global variable and close dropdown
      ACCOUNT_ID = accId;
      parent.classList.remove("active");

      // Load dashboard data after account change
      loadDashboardData();
    }

    // Close dropdown if clicked outside
    if (!e.target.closest(".dom_account_view")) {
      document
        .querySelectorAll(".dom_account_view.active")
        .forEach((el) => el.classList.remove("active"));
    }
  });

  // Handle quick filter dropdown
  document.addEventListener("click", (e) => {
    const select = e.target.closest(".quick_filter_detail");
    const option = e.target.closest(".quick_filter_detail ul li");

    // Toggle dropdown
    if (select && !option) {
      select.classList.toggle("active");
      return;
    }

    if (option) {
      const parent = option.closest(".quick_filter_detail");
      if (!parent) return;

      const imgEl = option.querySelector("img");
      const nameEl = option.querySelector("span");
      const filterValue = option.dataset?.filter;

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

      // Apply campaign filter if function exists
      if (typeof applyCampaignFilter === "function") {
        applyCampaignFilter(filter);
      }
    }
  });
});

async function fetchAdAccountInfo() {
  const url = `${BASE_URL}/act_${ACCOUNT_ID}?fields=id,funding_source_details,name,balance,currency,amount_spent&access_token=${META_TOKEN}`;

  try {
    const data = await fetchJSON(url);

    // Lấy thông tin cần thiết từ dữ liệu trả về
    const balance = data.balance || 0;
    const amountSpent = data.amount_spent || 0;
    const paymentMethod = data.funding_source_details
      ? data.funding_source_details.display_string
      : "No payment method available";

    // Tính toán VAT (10%) từ số dư
    const vat = (balance * 1.1).toFixed(0);

    // Kiểm tra phương thức thanh toán và thêm logo tương ứng
    let paymentMethodDisplay = paymentMethod;
    if (paymentMethod.includes("Mastercard")) {
      paymentMethodDisplay = `<img src="https://ampersand-reports-dom.netlify.app/DOM-img/mastercard.png" alt="Mastercard" style="width:20px; margin-right: 5px;"> ${paymentMethod}`;
    } else if (paymentMethod.includes("VISA")) {
      paymentMethodDisplay = `<img src="https://ampersand-reports-dom.netlify.app/DOM-img/visa.png" alt="Visa" style="width:20px; margin-right: 5px;"> ${paymentMethod}`;
    }

    // Cập nhật thông tin vào DOM
    document.getElementById("detail_balance").innerHTML = `${(
      balance * 1
    ).toLocaleString("vi-VN")}đ`;
    document.getElementById("detail_vat").innerHTML = `${(
      vat * 1
    ).toLocaleString("vi-VN")}đ`;
    document.getElementById("detail_method").innerHTML = paymentMethodDisplay;
    document.getElementById("detail_paid").innerHTML = `${(
      amountSpent * 1
    ).toLocaleString("vi-VN")}đ`;

    return data;
  } catch (error) {
    console.error("❌ Error fetching Ad Account info:", error);
    return null;
  }
}

function getYears() {
  const currentYear = new Date().getFullYear();
  return [currentYear - 2, currentYear - 1, currentYear];
}

/**
 * Render các năm vào dropdown #yearSelect.
 */
function renderYears() {
  const years = getYears();
  const currentYear = years[years.length - 1]; // Năm hiện tại là phần tử cuối
  const yearSelect = document.getElementById("yearSelect");
  if (!yearSelect) return;

  const fragment = document.createDocumentFragment(); // Dùng fragment để tối ưu DOM

  years.forEach((year) => {
    const li = document.createElement("li");
    li.dataset.type = year;
    li.innerHTML = `<span class="radio_box"></span><span>${year}</span>`;

    // Mặc định chọn năm hiện tại
    if (year === currentYear) {
      li.classList.add("active");
      li.querySelector(".radio_box").classList.add("active");
    }
    fragment.appendChild(li);
  });

  yearSelect.appendChild(fragment);

  // Cập nhật text hiển thị năm mặc định
  const selectedYearElement = document.getElementById("selectedYear");
  if (selectedYearElement) {
    selectedYearElement.textContent = currentYear;
  }
}

let DATA_YEAR;
async function fetchAdAccountData(year) {
  // 1. Gọi API trực tiếp
  const start = `${year}-01-01`;
  const end = `${year}-12-31`;
  const url = `${BASE_URL}/act_${ACCOUNT_ID}/insights?fields=spend,impressions,reach,actions,date_start&time_range[since]=${start}&time_range[until]=${end}&time_increment=monthly&access_token=${META_TOKEN}`;

  try {
    const data = await fetchJSON(url); // fetchJSON đã bao gồm cache
    const insightsData = data && data.data ? data.data : [];
    DATA_YEAR = insightsData;
    return insightsData;
  } catch (error) {
    console.error(`❌ Error fetching Ad Account data for ${year}:`, error);
    return []; // Trả về mảng rỗng nếu lỗi
  }
}

/**
 * Xử lý dữ liệu thô từ API thành dữ liệu 12 tháng.
 */
function processMonthlyData(data) {
  if (!Array.isArray(data)) {
    console.error("Dữ liệu không hợp lệ:", data);
    return [];
  }

  // Khởi tạo 12 tháng với giá trị 0
  const monthsData = Array(12)
    .fill(null)
    .map(() => ({
      spend: 0,
      impressions: 0,
      reach: 0,
      lead: 0,
      message: 0,
      likepage: 0,
    }));

  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth(); // 0-11

  data.forEach((item) => {
    const itemDate = new Date(item.date_start);
    const month = itemDate.getMonth(); // 0-11
    const year = itemDate.getFullYear();

    // Bỏ qua dữ liệu của các tháng tương lai trong năm hiện tại
    if (year === currentYear && month > currentMonth) return;

    // Cộng dồn dữ liệu
    monthsData[month].spend += parseFloat(item.spend || 0);
    monthsData[month].impressions += parseInt(item.impressions || 0);
    monthsData[month].reach += parseInt(item.reach || 0);

    if (item.actions) {
      item.actions.forEach((action) => {
        const value = parseInt(action.value || 0);
        switch (action.action_type) {
          case "onsite_conversion.lead_grouped":
            monthsData[month].lead += value;
            break;
          case "onsite_conversion.messaging_conversation_replied_7d":
            monthsData[month].message += value;
            break;
          case "like":
            monthsData[month].likepage += value;
            break;
        }
      });
    }
  });

  return monthsData;
}

/**
 * Vẽ hoặc cập nhật biểu đồ theo tháng.
 */
function renderMonthlyChart(data, filter) {
  const ctx = document.getElementById("detail_account_year")?.getContext("2d");
  if (!ctx) {
    console.error("Không tìm thấy canvas #detail_account_year");
    return;
  }

  // Lấy mảng giá trị trực tiếp từ key (filter)
  const values = data.map((monthData) => monthData[filter] || 0);
  const maxValue = Math.max(0, ...values); // Đảm bảo maxValue >= 0

  // Tạo màu (Gradients)
  const gradientBlue = ctx.createLinearGradient(0, 0, 0, 300);
  gradientBlue.addColorStop(0, "rgba(255,169,0,1)");
  gradientBlue.addColorStop(1, "rgba(255,169,0,0.4)");
  const gradientGray = ctx.createLinearGradient(0, 0, 0, 300);
  gradientGray.addColorStop(0, "rgba(210,210,210,0.9)");
  gradientGray.addColorStop(1, "rgba(160,160,160,0.4)");

  const backgroundColors = values.map((value) =>
    value === maxValue && value > 0 ? gradientBlue : gradientGray
  );

  const chartLabel = filter.charAt(0).toUpperCase() + filter.slice(1);

  if (monthlyChartInstance) {
    // --- Cập nhật biểu đồ đã có ---
    const chart = monthlyChartInstance;
    chart.data.labels = MONTH_LABELS;
    chart.data.datasets[0].data = values;
    chart.data.datasets[0].backgroundColor = backgroundColors;
    chart.data.datasets[0].label = `${chartLabel} by Month`;
    chart.options.scales.y.suggestedMax = maxValue * 1.1; // Cập nhật trục Y
    chart.options.plugins.tooltip.callbacks.label = (c) =>
      `${chartLabel}: ${
        filter === "spend" ? formatMoneyShort(c.raw) : formatNumber(c.raw)
      }`;

    chart.options.plugins.datalabels.formatter = (v) =>
      v > 0 ? (filter === "spend" ? formatMoneyShort(v) : formatNumber(v)) : "";

    chart.update({
      duration: 600,
      easing: "easeOutQuart",
    });
  } else {
    // --- Tạo biểu đồ mới ---
    monthlyChartInstance = new Chart(ctx, {
      type: "bar",
      data: {
        labels: MONTH_LABELS,
        datasets: [
          {
            label: `${chartLabel} by Month`,
            data: values,
            backgroundColor: backgroundColors,
            borderRadius: 8,
            borderWidth: 0,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        layout: { padding: { left: 10, right: 10 } },
        animation: { duration: 600, easing: "easeOutQuart" },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (c) =>
                `${chartLabel}: ${
                  filter === "spend"
                    ? formatMoneyShort(c.raw)
                    : formatNumber(c.raw)
                }`,
            },
          },
          datalabels: {
            anchor: "end",
            align: "end",
            offset: 2,
            font: { size: 11, weight: "600" },
            color: "#555",
            formatter: (v) =>
              v > 0
                ? filter === "spend"
                  ? formatMoneyShort(v)
                  : formatNumber(v)
                : "",
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
              color: "#666",
              font: { weight: "600", size: 9 },
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
            ticks: { display: false }, // ❌ ẩn toàn bộ số ở trục Y
            suggestedMax: maxValue * 1.1,
          },
        },
      },
      plugins: [ChartDataLabels], // Giả định plugin này đã được import
    });
  }
}

/**
 * Hàm khởi tạo: Lấy dữ liệu năm hiện tại và vẽ biểu đồ.
 */
async function initializeYearData() {
  const selectedYear = new Date().getFullYear();
  const filter = "spend"; // Mặc định

  try {
    const data = await fetchAdAccountData(selectedYear);
    const processedData = processMonthlyData(data);
    renderMonthlyChart(processedData, filter);
  } catch (error) {
    console.error("Lỗi khi khởi tạo dữ liệu:", error);
    renderMonthlyChart(processMonthlyData([]), filter);
  }
}

/**
 * Gán sự kiện cho dropdown chọn filter (spend, lead,...)
 */
function setupFilterDropdown() {
  const actionFilter = document.querySelector(".dom_select.year_filter");
  if (!actionFilter) return;

  const actionList = actionFilter.querySelector("ul.dom_select_show");
  const selectedAction = actionFilter.querySelector(".dom_selected");
  const actionItems = actionList.querySelectorAll("li");

  // Xử lý đóng/mở
  actionFilter.addEventListener("click", (e) => {
    e.stopPropagation();
    const isActive = actionList.classList.contains("active");
    document.querySelectorAll(".dom_select_show.active").forEach((ul) => {
      if (ul !== actionList) ul.classList.remove("active");
    });
    actionList.classList.toggle("active", !isActive);
  });

  // Xử lý chọn item
  actionItems.forEach((li) => {
    li.addEventListener("click", (e) => {
      e.stopPropagation();
      const actionType = li.dataset.type;

      if (li.classList.contains("active")) {
        actionList.classList.remove("active");
        return;
      }

      // Cập nhật UI
      actionItems.forEach((el) => el.classList.remove("active"));
      actionList
        .querySelectorAll(".radio_box")
        .forEach((r) => r.classList.remove("active"));
      li.classList.add("active");
      li.querySelector(".radio_box").classList.add("active");
      selectedAction.textContent = li.textContent.trim();

      // Lấy năm hiện tại từ DOM (từ dropdown năm)
      const yearEl = document.querySelector(".dom_select.year .dom_selected");
      const year = parseInt(yearEl.textContent, 10);

      if (isNaN(year)) {
        console.error("Không thể lấy năm hiện tại");
        return;
      }

      // ⭐ TỐI ƯU: Chỉ cần xử lý DATA_YEAR, không cần fetch lại
      const processedData = processMonthlyData(DATA_YEAR);
      renderMonthlyChart(processedData, actionType);

      actionList.classList.remove("active");
    });
  });

  // Đóng khi click ra ngoài
  document.addEventListener("click", (e) => {
    if (!actionFilter.contains(e.target)) {
      actionList.classList.remove("active");
    }
  });
}

/**
 * Gán sự kiện cho dropdown chọn năm.
 */
function setupYearDropdown() {
  const yearFilter = document.querySelector(".dom_select.year");
  if (!yearFilter) return;

  const yearList = yearFilter.querySelector("ul.dom_select_show");
  const selectedYearEl = yearFilter.querySelector(".dom_selected");
  const yearItems = yearList.querySelectorAll("li");

  // Xử lý đóng/mở
  yearFilter.addEventListener("click", (e) => {
    e.stopPropagation();
    const isActive = yearList.classList.contains("active");
    document.querySelectorAll(".dom_select_show.active").forEach((ul) => {
      if (ul !== yearList) ul.classList.remove("active");
    });
    yearList.classList.toggle("active", !isActive);
  });

  // Xử lý chọn năm
  yearItems.forEach((li) => {
    li.addEventListener("click", (e) => {
      e.stopPropagation();
      const selectedYearValue = parseInt(li.dataset.type, 10);

      if (li.classList.contains("active")) {
        yearList.classList.remove("active");
        return;
      }

      // Cập nhật UI
      yearItems.forEach((el) => el.classList.remove("active"));
      yearList
        .querySelectorAll(".radio_box")
        .forEach((r) => r.classList.remove("active"));
      li.classList.add("active");
      li.querySelector(".radio_box").classList.add("active");
      selectedYearEl.textContent = li.textContent.trim();

      // Reset filter về "spend"
      const filter = "spend";
      resetFilterDropdownTo(filter);
      const loading = document.querySelector(".loading");
      if (loading) loading.classList.add("active");

      // Gọi API (sẽ dùng cache nếu có)
      fetchAdAccountData(selectedYearValue)
        .then((data) => {
          // data đã được gán vào DATA_YEAR bên trong fetchAdAccountData
          const processedData = processMonthlyData(data);
          renderMonthlyChart(processedData, filter);
          loading.classList.remove("active");
        })
        .catch((error) => {
          loading.classList.remove("active");
          console.error("Lỗi khi fetch dữ liệu năm mới:", error);
          renderMonthlyChart(processMonthlyData([]), filter); // Vẽ biểu đồ rỗng
        });

      yearList.classList.remove("active");
    });
  });

  // Đóng khi click ra ngoài
  document.addEventListener("click", (e) => {
    if (!yearFilter.contains(e.target)) {
      yearList.classList.remove("active");
    }
  });
}

/**
 * Hàm helper: Reset dropdown filter về một giá trị cụ thể.
 */
function resetFilterDropdownTo(filterType) {
  const filterDropdown = document.querySelector(".dom_select.year_filter");
  if (!filterDropdown) return;

  const filterList = filterDropdown.querySelector("ul.dom_select_show");
  const filterItems = filterList.querySelectorAll("li");

  filterItems.forEach((el) => {
    const isTarget = el.dataset.type === filterType;
    el.classList.toggle("active", isTarget);
    el.querySelector(".radio_box").classList.toggle("active", isTarget);

    if (isTarget) {
      filterDropdown.querySelector(".dom_selected").textContent =
        el.textContent.trim();
    }
  });
}
/**
 * Reset dropdown năm về năm hiện tại.
 */
function resetYearDropdownToCurrentYear() {
  const yearFilter = document.querySelector(".dom_select.year");
  if (!yearFilter) return;

  const yearList = yearFilter.querySelector("ul.dom_select_show");
  const selectedYearEl = yearFilter.querySelector(".dom_selected");
  const yearItems = yearList.querySelectorAll("li");

  // Lấy năm hiện tại
  const currentYear = new Date().getFullYear();

  // Cập nhật UI cho năm hiện tại
  yearItems.forEach((li) => {
    const yearValue = parseInt(li.dataset.type, 10);

    if (yearValue === currentYear) {
      li.classList.add("active");
      li.querySelector(".radio_box").classList.add("active");
      selectedYearEl.textContent = li.textContent.trim();
    } else {
      li.classList.remove("active");
      li.querySelector(".radio_box").classList.remove("active");
    }
  });

  // Đóng dropdown năm
  yearList.classList.remove("active");
}
async function reloadFullData() {
  const ids = []; // rỗng => full data
  loadPlatformSummary(ids);
  loadSpendPlatform(ids);
  loadAgeGenderSpendChart(ids);
  loadRegionSpendChart(ids);
  const dailyData = await fetchDailySpendByCampaignIDs(ids);
  renderDetailDailyChart2(dailyData, "spend");

  // render lại chart mục tiêu
  const allAds = window._ALL_CAMPAIGNS.flatMap((c) =>
    c.adsets.flatMap((as) =>
      (as.ads || []).map((ad) => ({
        optimization_goal: as.optimization_goal,
        insights: { spend: ad.spend || 0 },
      }))
    )
  );
  renderGoalChart(allAds);
}
function resetUIFilter() {
  // ✅ 1. Reset quick filter dropdown về Ampersand
  const quickFilter = document.querySelector(".quick_filter_detail");
  if (quickFilter) {
    const selectedEl = quickFilter.querySelector(".dom_selected");
    const imgEl = quickFilter.querySelector("img");
    const ul = quickFilter.querySelector(".dom_select_show");

    // Đổi ảnh & text về Ampersand
    if (imgEl) imgEl.src = "./adset/ampersand/ampersand_img.jpg";
    if (selectedEl) selectedEl.textContent = "Ampersand";

    // Xóa trạng thái active trên list item
    if (ul) {
      ul.querySelectorAll("li").forEach((li) => li.classList.remove("active"));
    }
  }
}
