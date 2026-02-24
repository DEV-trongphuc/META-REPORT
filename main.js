
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
// =================== DATE PICKER STATE ===================
let calendarCurrentMonth = new Date().getMonth();
let calendarCurrentYear = new Date().getFullYear();
let tempStartDate = null;
let tempEndDate = null;
let VIEW_GOAL; // Dùng cho chart breakdown
const CACHE = new Map();
let DAILY_DATA = [];
let CURRENT_CAMPAIGN_FILTER = ""; // 👈 Lưu bộ lọc hiện tại (dùng cho Brand filter)
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
  REPLIES: "onsite_conversion.total_messaging_connection",
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
      } catch { }
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

/**
 * 👤 Lấy danh sách tài khoản quảng cáo từ API
 */
async function fetchMyAdAccounts() {
  const url = `${BASE_URL}/me/adaccounts?fields=name,account_id,id,business{profile_picture_uri}&limit=50&access_token=${META_TOKEN}`;
  try {
    const res = await fetchJSON(url);
    return res.data || [];
  } catch (err) {
    console.error("❌ Lỗi khi lấy danh sách tài khoản:", err);
    return [];
  }
}

/**
 * 🎨 Khởi tạo bộ chọn tài khoản (render động)
 */
async function initAccountSelector() {
  const accounts = await fetchMyAdAccounts();
  const dropdownUl = document.querySelector(".dom_account_view ul");
  const selectedInfo = document.querySelector(".dom_account_view_block .account_item");

  if (!dropdownUl || !selectedInfo) return;

  // Xóa danh sách cũ (hardcoded)
  dropdownUl.innerHTML = "";

  // 🚩 Lọc danh sách nếu có setup ALLOWED_ACCOUNTS
  const allowedIds = window.ALLOWED_ACCOUNTS;
  const filteredAccounts = (Array.isArray(allowedIds) && allowedIds.length > 0)
    ? accounts.filter(acc => allowedIds.includes(acc.account_id))
    : accounts;

  filteredAccounts.forEach(acc => {
    const li = document.createElement("li");
    li.dataset.acc = acc.account_id;

    // Sử dụng ảnh business profile pic hoặc ảnh mặc định
    const avatarUrl = acc.business?.profile_picture_uri || "./logo.png";

    li.innerHTML = `
      <img src="${avatarUrl}" />
      <p><span> ${acc.name}</span></p>
    `;
    dropdownUl.appendChild(li);

    // Cập nhật thông tin hiển thị nếu đây là tài khoản đang chọn
    if (acc.account_id === ACCOUNT_ID) {
      updateSelectedAccountUI(acc.name, acc.account_id, avatarUrl);
    }
  });

  // Nếu ACCOUNT_ID hiện tại không khớp với bất kỳ acc nào trong danh sách (trường hợp id lạ)
  // Thực hiện fetch chi tiết riêng cho ACCOUNT_ID đó
  const isCurrentAccountInList = accounts.some(a => a.account_id === ACCOUNT_ID);
  if (!isCurrentAccountInList && ACCOUNT_ID) {
    fetchSingleAccountInfo(ACCOUNT_ID);
  }
}

/**
 * 🛠️ Cập nhật UI tài khoản đang chọn
 */
function updateSelectedAccountUI(name, id, avatarUrl) {
  const selectedInfo = document.querySelector(".dom_account_view_block .account_item");
  if (!selectedInfo) return;

  const avatar = selectedInfo.querySelector(".account_item_avatar");
  const nameEl = selectedInfo.querySelector(".account_item_name");
  const idEl = selectedInfo.querySelector(".account_item_id");

  if (avatar) avatar.src = avatarUrl || "./logo.png";
  if (nameEl) nameEl.textContent = name;
  if (idEl) idEl.textContent = id;
}

/**
 * 🔍 Fetch thông tin 1 tài khoản cụ thể (nếu ko có trong list /me/adaccounts)
 */
async function fetchSingleAccountInfo(accId) {
  const url = `${BASE_URL}/act_${accId}?fields=name,account_id,business{profile_picture_uri}&access_token=${META_TOKEN}`;
  try {
    const acc = await fetchJSON(url);
    if (acc) {
      updateSelectedAccountUI(acc.name, acc.account_id, acc.business?.profile_picture_uri);
    }
  } catch (err) {
    console.error("❌ Lỗi khi lấy thông tin tài khoản lẻ:", err);
  }
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
          `adset{end_time,start_time,daily_budget,lifetime_budget},` +
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
              start_time: adset.start_time ?? null,
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
        link_clicks: 0,
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
        link_clicks: 0,
        ads: [],
        end_time: as.ads?.[0]?.adset?.end_time || null,
        start_time: as.ads?.[0]?.adset?.start_time || null,
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
        "onsite_conversion.total_messaging_connection"
      );
      const leadCount =
        safeGetActionValue(actions, "lead") +
        safeGetActionValue(actions, "onsite_conversion.lead_grouped"); // ✅ Cộng dồn adset-level

      const linkClicks = safeGetActionValue(actions, "link_click"); // Extract link_click

      adset.spend += spend;
      adset.result += result;
      adset.reach += reach;
      adset.impressions += impressions;
      adset.reactions += reactions;
      adset.lead += leadCount;
      adset.message += messageCount; // ✅ Cộng dồn campaign-level
      adset.link_clicks += linkClicks;

      campaign.spend += spend;
      campaign.result += result;
      campaign.reach += reach;
      campaign.impressions += impressions;
      campaign.reactions += reactions;
      campaign.lead += leadCount;
      campaign.message += messageCount; // 🖼️ Add ad summary
      campaign.link_clicks += linkClicks;

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
            <div class="campaign_thumb campaign_icon_wrap ${hasActiveAdset ? "" : "inactive"
      }">
              <i class="${iconClass}"></i>
            </div>
            <p class="ad_name">${c.name}</p>
          </div>
          <div class="ad_status ${campaignStatusClass}">${campaignStatusText}</div>
          <div class="ad_spent">${formatMoney(c.spend)}</div>
          <div class="ad_result">${formatNumber(c.result)}</div>
          <div class="ad_cpr">${campaignCpr > 0 ? formatMoney(campaignCpr) : "-"
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

      const formatDate = (dateStr) => {
        if (!dateStr) return "";
        const d = new Date(dateStr);
        return `${String(d.getDate()).padStart(2, "0")}-${String(
          d.getMonth() + 1
        ).padStart(2, "0")}-${d.getFullYear()}`;
      };
      const startDate = formatDate(as.start_time);
      const endDate = formatDate(as.end_time);
      let label = "";
      let value = "";
      let timeText = "";
      if (isEnded) {
        adsetStatusClass = "complete budget";
        // adsetStatusText = `<span class="status-label">COMPLETE</span>`;
        // adsetStatusClass = "active budget";
        label = `<span class="status-label"></span>`;
        value = `<span class="status-value">COMPLETE</span>`;
        timeText = `<i class="fa-regular fa-clock" style="opacity: 0.5"></i> ${startDate} to ${endDate}`;

        adsetStatusText = `
          ${label}
          ${value}
          ${timeText ? `<span class="status-date">${timeText}</span>` : ""}
        `;
      } else if (hasActiveAd && (dailyBudget > 0 || lifetimeBudget > 0)) {
        adsetStatusClass = "active budget";


        if (dailyBudget > 0) {
          label = `<span class="status-label">Daily Budget</span>`;
          value = `<span class="status-value">${dailyBudget.toLocaleString(
            "vi-VN"
          )}đ</span>`;
          timeText = endDate
            ? `<i class="fa-regular fa-clock" style="opacity: 0.5"></i> ${startDate} to ${endDate}`
            : `<i class="fa-regular fa-clock" style="opacity: 0.5"></i> START: ${startDate}`;
        } else if (lifetimeBudget > 0) {
          label = `<span class="status-label">Lifetime Budget</span>`;
          value = `<span class="status-value">${lifetimeBudget.toLocaleString(
            "vi-VN"
          )}đ</span>`;
          timeText = `<i class="fa-regular fa-clock" style="opacity: 0.5"></i> ${startDate} to ${endDate}`;
        }

        adsetStatusText = `
          ${label}
          ${value}
          ${timeText ? `<span class="status-date">${timeText}</span>` : ""}
        `;
      } else if (hasActiveAd) {
        adsetStatusClass = "active";
        adsetStatusText = `<span>ACTIVE</span>`;
      } else {
        adsetStatusClass = "inactive budget";

        label = `<span class="status-label"></span>`;
        value = `<span class="status-value">INACTIVE</span>`;
        timeText = `<i class="fa-regular fa-clock" style="opacity: 0.5"></i> ${startDate} to ${endDate}`;
        adsetStatusText = `
          ${label}
          ${value}
          ${timeText ? `<span class="status-date">${timeText}</span>` : ""}
        `;
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
                <img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" data-src="${ad.thumbnail}" data-ad-id-img="${ad.id}" />
                <p class="ad_name">ID: ${ad.id}</p>
              </a>
            </div>
            <div class="ad_status ${isActive ? "active" : "inactive"}">${ad.status
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
              <img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" data-src="${as.ads?.[0]?.thumbnail}" />
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
            <div class="adset_insight_btn"
              data-adset-id="${as.id}"
              data-name="${as.name}"
              data-goal="${as.optimization_goal}"
              data-spend="${as.spend}"
              data-reach="${as.reach}"
              data-impressions="${as.impressions}"
              data-result="${as.result}"
              data-cpr="${adsetCpr}"
              title="Xem insight adset">
              <i class="fa-solid fa-magnifying-glass-chart"></i>
            </div>
          </div>
        </div>
        <div class="ad_item_box">${adsHtml.join("")}</div>`);
    }

    campaignHtml.push(`</div>`);
    htmlBuffer.push(campaignHtml.join(""));
  }

  wrap.innerHTML = htmlBuffer.join("");

  // === Empty state handling ===
  const emptyState = document.querySelector(".view_campaign_empty");
  if (emptyState) {
    emptyState.style.display = data.length === 0 ? "flex" : "none";
  }

  // Lazy load images
  loadLazyImages(wrap);
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
  /* Fix: Initialize default date range if missing */
  if (typeof startDate === 'undefined' || !startDate) {
    const defaultRange = getDateRange("last_7days");
    startDate = defaultRange.start;
    endDate = defaultRange.end;
  }
  initDateSelector();
  setupDetailDailyFilter();
  setupDetailDailyFilter2();
  setupFilterDropdown();
  setupYearDropdown();
  addListeners();
  setupAIReportModal();
  const { start, end } = getDateRange("last_7days");
  startDate = start;
  endDate = end;
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
  // loadDailyChart();
  // loadPlatformSummary();
  // loadSpendPlatform();
  // loadAgeGenderSpendChart();
  // loadRegionSpendChart();
  loadAllDashboardCharts();
  initializeYearData();

  resetYearDropdownToCurrentYear();
  resetFilterDropdownTo("spend");
  loadCampaignList().finally(() => {
    if (loading) loading.classList.remove("active");
  });
}

// 🚀 Hàm chính gọi khi load trang lần đầu
async function main() {
  renderYears();
  initDashboard();
  await initAccountSelector(); // 👈 Khởi tạo chọn tài khoản động
  await loadDashboardData();

  // 🖱️ Lắng nghe sự kiện Reset All Filters từ Empty Card
  document.addEventListener("click", (e) => {
    if (e.target.classList.contains("btn_reset_all")) {
      resetAllFilters();
    }
  });

  // 🤖 AI Summary button
  const aiBtn = document.getElementById("ai_summary_btn");
  if (aiBtn) aiBtn.addEventListener("click", openAiSummaryModal);

  const aiClose = document.getElementById("ai_modal_close");
  if (aiClose) aiClose.addEventListener("click", closeAiSummaryModal);

  const aiCopy = document.getElementById("ai_copy_btn");
  if (aiCopy) aiCopy.addEventListener("click", () => {
    const content = document.getElementById("ai_summary_content");
    if (content) {
      navigator.clipboard.writeText(content.innerText || "");
      aiCopy.innerHTML = '<i class="fa-solid fa-check"></i> Đã sao chép';
      setTimeout(() => { aiCopy.innerHTML = '<i class="fa-solid fa-copy"></i> Sao chép'; }, 2000);
    }
  });

  const aiRegen = document.getElementById("ai_regenerate_btn");
  if (aiRegen) aiRegen.addEventListener("click", runAiSummary);

  // Close modal khi click overlay
  const overlay = document.getElementById("ai_summary_modal");
  if (overlay) overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeAiSummaryModal();
  });
}

function openAiSummaryModal() {
  const modal = document.getElementById("ai_summary_modal");
  if (modal) modal.style.display = "flex";
  updateAiHistoryBadge();
  switchAiTab("home");
  // Pre-select "Hiện tại" pill
  setAiDatePreset("current", document.querySelector(".ai_date_pill"));
}

function switchAiTab(tab) {
  const allPanels = ["home", "result", "compare", "history"];
  allPanels.forEach(p => {
    const el = document.getElementById(`ai_panel_${p}`);
    if (el) el.style.display = "none";
    const ft = document.getElementById(`ai_footer_${p}`);
    if (ft) ft.style.display = "none";
  });

  const panel = document.getElementById(`ai_panel_${tab}`);
  if (panel) {
    // home panel is a flex container (2-column grid)
    panel.style.display = tab === "home" ? "flex" : "block";
  }
  const footer = document.getElementById(`ai_footer_${tab}`);
  if (footer) footer.style.display = "flex";

  if (tab === "history") renderAiHistory();
  if (tab === "compare") renderCompareCampaigns();
}

// ─── Date Preset for Home panel ───────────────────────────────

let _aiDatePreset = "current";

function setAiDatePreset(preset, btn) {
  _aiDatePreset = preset;
  document.querySelectorAll(".ai_date_pill").forEach(b => b.classList.remove("active"));
  if (btn) btn.classList.add("active");
  const customRow = document.getElementById("ai_custom_date_row");
  if (customRow) customRow.style.display = preset === "custom" ? "flex" : "none";
  // Pre-fill custom inputs với ngày hiện tại của app
  if (preset === "custom") {
    const cf = document.getElementById("ai_custom_from");
    const ct = document.getElementById("ai_custom_to");
    if (cf && !cf.value) cf.value = document.getElementById("date_from")?.value || "";
    if (ct && !ct.value) ct.value = document.getElementById("date_to")?.value || "";
  }
}

function getAiDateRange() {
  const today = new Date();
  const fmt = d => d.toISOString().slice(0, 10);
  if (_aiDatePreset === "7d") return { from: fmt(new Date(today - 7 * 864e5)), to: fmt(today) };
  if (_aiDatePreset === "14d") return { from: fmt(new Date(today - 14 * 864e5)), to: fmt(today) };
  if (_aiDatePreset === "30d") return { from: fmt(new Date(today - 30 * 864e5)), to: fmt(today) };
  if (_aiDatePreset === "custom") return {
    from: document.getElementById("ai_custom_from")?.value || "",
    to: document.getElementById("ai_custom_to")?.value || "",
  };
  // "current" — dùng filter hiện tại
  return {
    from: document.getElementById("date_from")?.value || "",
    to: document.getElementById("date_to")?.value || "",
  };
}

function runAiSummaryFromHome() {
  const { from, to } = getAiDateRange();
  if (_aiDatePreset !== "current" && from && to) {
    const df = document.getElementById("date_from");
    const dt = document.getElementById("date_to");
    if (df) df.value = from;
    if (dt) dt.value = to;
  }
  switchAiTab("result");
  runAiSummary();
}

// ─── Campaign Compare Feature ──────────────────────────────────

function renderCompareCampaigns() {
  const list = document.getElementById("ai_compare_list");
  if (!list) return;
  const campaigns = (window._FILTERED_CAMPAIGNS ?? window._ALL_CAMPAIGNS) || [];
  if (!campaigns.length) {
    list.innerHTML = `<div class="ai_compare_empty">
      <i class="fa-solid fa-triangle-exclamation"></i>
      Chưa có dữ liệu campaign. Hãy tải dữ liệu trước.
    </div>`;
    return;
  }

  const fmt = n => Math.round(n || 0).toLocaleString("vi-VN");
  const fmtShort = n => {
    n = Math.round(n || 0);
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
    if (n >= 1_000) return (n / 1_000).toFixed(0) + "K";
    return n.toString();
  };

  // Tính % chi phí tương đối để vẽ bar
  const maxSpend = Math.max(...campaigns.map(c => c.spend || 0), 1);

  list.innerHTML = campaigns.map((c, i) => {
    const adsets = c.adsets || [];
    const adsetCnt = adsets.length;
    const spend = fmt(c.spend);
    const reach = fmtShort(c.reach);
    const result = fmt(c.result);
    const cpr = c.result > 0 ? fmt(c.spend / c.result) + "đ" : "N/A";
    const spendPct = Math.round((c.spend / maxSpend) * 100);

    // Top adset theo chi phí
    const topAdset = [...adsets].sort((a, b) => (b.spend || 0) - (a.spend || 0))[0];
    const topName = topAdset ? topAdset.name.replace(/^[^_]+_/, "") : null;

    // Goal badge
    const goals = [...new Set(adsets.map(a => a.optimization_goal).filter(Boolean))];
    const goalBadge = goals.slice(0, 2).map(g =>
      `<span class="ai_cmp_goal">${g}</span>`
    ).join("") + (goals.length > 2 ? `<span class="ai_cmp_goal">+${goals.length - 2}</span>` : "");

    return `
    <label class="ai_compare_item" data-name="${(c.name || "").toLowerCase()}" data-idx="${i}">
      <div class="ai_cmp_checkbox">
        <input type="checkbox" class="ai_compare_cb" value="${i}" id="cmp_cb_${i}" onchange="updateCompareCount()">
        <i class="fa-solid fa-check"></i>
      </div>
      <div class="ai_compare_item_body">
        <div class="ai_cmp_top_row">
          <div class="ai_compare_item_name">${c.name || "Campaign " + (i + 1)}</div>
        </div>
        <div class="ai_cmp_spend_bar_wrap">
          <div class="ai_cmp_spend_bar" style="width:${spendPct}%"></div>
        </div>
        <div class="ai_compare_item_stats">
          <span class="ai_cmp_stat spend"><i class="fa-solid fa-sack-dollar"></i> ${spend}đ</span>
          <span class="ai_cmp_stat"><i class="fa-solid fa-users"></i> ${reach}</span>
          <span class="ai_cmp_stat"><i class="fa-solid fa-bullseye"></i> ${result} KQ</span>
          <span class="ai_cmp_stat"><i class="fa-solid fa-tag"></i> ${cpr}</span>
          <span class="ai_cmp_stat"><i class="fa-solid fa-layer-group"></i> ${adsetCnt} adset</span>
        </div>
      </div>
    </label>`;
  }).join("");

  // Sync real checkbox với custom UI
  document.querySelectorAll(".ai_compare_item").forEach(label => {
    label.addEventListener("click", e => {
      if (e.target.closest(".ai_cmp_checkbox") || e.target.classList.contains("ai_compare_cb")) return;
      const cb = label.querySelector(".ai_compare_cb");
      if (cb) { cb.checked = !cb.checked; updateCompareCount(); }
    });
  });

  updateCompareCount();
}


function filterCompareCampaigns(query) {
  const q = query.toLowerCase().trim();
  document.querySelectorAll(".ai_compare_item").forEach(el => {
    const name = el.dataset.name || "";
    el.style.display = (!q || name.includes(q)) ? "" : "none";
  });
}

function selectAllCompareCampaigns(checked) {
  document.querySelectorAll(".ai_compare_cb").forEach(cb => {
    const item = cb.closest(".ai_compare_item");
    if (item && item.style.display !== "none") cb.checked = checked;
  });
  updateCompareCount();
}

function updateCompareCount() {
  const selected = document.querySelectorAll(".ai_compare_cb:checked").length;
  const countEl = document.getElementById("ai_compare_count");
  const runBtn = document.getElementById("ai_compare_run_btn");
  if (countEl) countEl.textContent = `${selected} đã chọn`;
  if (runBtn) runBtn.disabled = selected < 2;
  // Đổi màu count
  if (countEl) countEl.style.color = selected >= 2 ? "var(--mainClr)" : "#aaa";
}

async function runAiCompare() {
  const campaigns = (window._FILTERED_CAMPAIGNS ?? window._ALL_CAMPAIGNS) || [];
  const checked = [...document.querySelectorAll(".ai_compare_cb:checked")];
  if (checked.length < 2) return;

  const selected = checked.map(cb => campaigns[parseInt(cb.value)]).filter(Boolean);

  // Chuyển sang tab kết quả và show loading
  switchAiTab("result");
  const loading = document.getElementById("ai_summary_loading");
  const content = document.getElementById("ai_summary_content");
  const emptyBox = document.getElementById("ai_empty_state");
  const copyBtn = document.getElementById("ai_copy_btn");
  const regenBtn = document.getElementById("ai_regenerate_btn");
  const wordBtn = document.getElementById("ai_export_word_btn");

  if (loading) loading.style.display = "block";
  if (emptyBox) emptyBox.style.display = "none";
  if (content) content.innerHTML = "";
  if (copyBtn) copyBtn.style.display = "none";
  if (regenBtn) regenBtn.style.display = "none";
  if (wordBtn) wordBtn.style.display = "none";

  const fmt = n => Math.round(n || 0).toLocaleString("vi-VN");
  const fmtMoney = n => fmt(n) + "đ";

  const blocks = selected.map((c, idx) => {
    const adsetLines = (c.adsets || []).map(as =>
      `  · ${as.name}: chi phí=${fmtMoney(as.spend)}, reach=${fmt(as.reach)}, kết quả=${fmt(as.result)}, CPR=${as.result > 0 ? fmtMoney(as.spend / as.result) : "N/A"}, goal=${as.optimization_goal || "N/A"}`
    ).join("\n");
    return `
[Campaign ${idx + 1}] ${c.name}
- Chi phí: ${fmtMoney(c.spend)}
- Reach: ${fmt(c.reach)}
- Kết quả: ${fmt(c.result)}
- CPR TB: ${c.result > 0 ? fmtMoney(c.spend / c.result) : "N/A"}
- Impressions: ${fmt(c.impressions)}
- Mục tiêu: ${c.objective || "N/A"}
- Adsets (${(c.adsets || []).length}):
${adsetLines || "  (không có dữ liệu adset)"}`;
  }).join("\n\n─────────────────────────\n");

  const prompt = `Bạn là chuyên gia phân tích quảng cáo Facebook Ads. Hãy so sánh CHI TIẾT và TOÀN DIỆN ${selected.length} chiến dịch sau đây.

DỮ LIỆU CÁC CHIẾN DỊCH CẦN SO SÁNH:
═══════════════════════════════════════
${blocks}
═══════════════════════════════════════

YÊU CẦU PHÂN TÍCH SO SÁNH:

## 1. Bảng tổng quan so sánh
- Tạo bảng so sánh các chỉ số chính: Chi phí, Reach, Kết quả, CPR, Impressions
- Xếp hạng từng campaign theo từng chỉ số

## 2. Phân tích điểm mạnh - điểm yếu từng campaign
- Với mỗi campaign: nêu rõ 2-3 điểm mạnh và 2-3 điểm yếu dựa trên số liệu

## 3. Campaign hiệu quả nhất
- Kết luận campaign nào tốt nhất và tại sao (dựa trên CPR, reach, chi phí)

## 4. Đề xuất tối ưu
- Gợi ý cụ thể để cải thiện campaign kém hiệu quả hơn
- Ngân sách nên phân bổ như thế nào giữa các campaign

⚠️ QUY TẮC: Dùng bảng markdown cho phần so sánh số liệu, viết bằng tiếng Việt, có số liệu cụ thể.`;

  try {
    const resp = await fetch("https://automation.ideas.edu.vn/dom.php", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data?.error || `Proxy error: ${resp.status}`);
    const text = data?.text || "Không nhận được phản hồi.";

    if (loading) loading.style.display = "none";
    if (content) content.innerHTML = simpleMarkdown(text);
    if (copyBtn) copyBtn.style.display = "flex";
    if (regenBtn) regenBtn.style.display = "none";  // Regen không áp dụng cho compare
    if (wordBtn) wordBtn.style.display = "flex";

    const hLabel = `So sánh: ${selected.map(c => c.name).join(" vs ")}`;
    saveAiHistory(content.innerHTML, hLabel);

  } catch (err) {
    if (loading) loading.style.display = "none";
    if (content) content.innerHTML = `<div style="color:#ef4444;padding:2rem;text-align:center;">
      <i class="fa-solid fa-circle-exclamation" style="font-size:2rem;margin-bottom:1rem;display:block;"></i>
      ❌ Lỗi: ${err.message}
    </div>`;
    console.error("❌ AI Compare error:", err);
  }
}


// ── localStorage history helpers ──

function exportAiToWord() {
  const content = document.getElementById("ai_summary_content");
  if (!content || !content.innerHTML.trim()) return;

  const modalTitle = document.querySelector(".ai_modal_header span")?.innerText || "Báo cáo AI";
  const dateRange = document.getElementById("ai_date_range")?.innerText || "";
  const timestamp = new Date().toLocaleString("vi-VN");

  const wordHtml = `
    <!DOCTYPE html>
    <html xmlns:o="urn:schemas-microsoft-com:office:office"
          xmlns:w="urn:schemas-microsoft-com:office:word"
          xmlns="http://www.w3.org/TR/REC-html40">
    <head>
      <meta charset="utf-8">
      <title>${modalTitle}</title>
      <!--[if gte mso 9]>
      <xml><w:WordDocument><w:View>Print</w:View><w:Zoom>100</w:Zoom></w:WordDocument></xml>
      <![endif]-->
      <style>
        body { font-family: Arial, sans-serif; font-size: 11pt; color: #222; margin: 2.5cm 2cm; line-height: 1.55; }
        h1 { font-size: 16pt; font-weight: bold; color: #111; border-bottom: 2pt solid #333; padding-bottom: 5pt; margin-bottom: 10pt; }
        h2 { font-size: 13pt; font-weight: bold; color: #111; border-left: 4pt solid #555; padding-left: 8pt; margin-top: 18pt; margin-bottom: 4pt; text-transform: uppercase; letter-spacing: 0.03em; }
        h3 { font-size: 11.5pt; font-weight: bold; color: #222; margin-top: 12pt; margin-bottom: 3pt; }
        h4 { font-size: 11pt; font-weight: bold; color: #444; margin-top: 8pt; margin-bottom: 2pt; }
        p  { margin: 4pt 0; color: #333; }
        ul { margin: 4pt 0 4pt 14pt; padding: 0; }
        ul li { margin: 2pt 0; color: #333; }
        ol { margin: 6pt 0 6pt 14pt; padding: 0; }
        ol li { margin: 4pt 0; color: #222; padding: 2pt 0; }
        strong { font-weight: bold; color: #111; }
        em { font-style: italic; color: #555; }
        table { border-collapse: collapse; width: 100%; margin: 10pt 0; font-size: 10pt; }
        table th { background: #ebebeb; font-weight: bold; text-transform: uppercase; padding: 5pt 8pt; border: 1pt solid #aaa; color: #333; text-align: left; }
        table td { padding: 4pt 8pt; border: 1pt solid #ccc; color: #222; }
        table tr:nth-child(even) td { background: #f7f7f7; }
        .report-meta { color: #666; font-size: 10pt; margin-bottom: 12pt; padding-bottom: 8pt; border-bottom: 1pt solid #ccc; }
        hr { border: none; border-top: 1pt solid #ddd; margin: 10pt 0; }
      </style>
    </head>
    <body>
      <h1>${modalTitle}</h1>
      <div class="report-meta">
        ${dateRange ? `<p><strong>Khoảng thời gian:</strong> ${dateRange}</p>` : ""}
        <p><strong>Xuất lúc:</strong> ${timestamp}</p>
      </div>
      ${content.innerHTML}
    </body>
    </html>
  `;

  const blob = new Blob(["\ufeff", wordHtml], { type: "application/msword;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  const fileName = `bao-cao-ai-${new Date().toISOString().slice(0, 10)}.doc`;
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);

  // Feedback visual
  const btn = document.getElementById("ai_export_word_btn");
  if (btn) {
    const orig = btn.innerHTML;
    btn.innerHTML = '<i class="fa-solid fa-check"></i> Đã xuất!';
    setTimeout(() => { btn.innerHTML = orig; }, 2000);
  }
}


const AI_HISTORY_KEY = "dom_ai_summary_history";
const AI_HISTORY_MAX = 10;

function loadAiHistory() {
  try { return JSON.parse(localStorage.getItem(AI_HISTORY_KEY) || "[]"); }
  catch { return []; }
}

function saveAiHistory(html, label) {
  const history = loadAiHistory();
  const dateFrom = document.getElementById("date_from")?.value || "";
  const dateTo = document.getElementById("date_to")?.value || "";
  const entry = {
    id: Date.now(),
    timestamp: new Date().toLocaleString("vi-VN"),
    label: label || "Tóm tắt chiến dịch",
    dateRange: (dateFrom && dateTo) ? `${dateFrom} — ${dateTo}` : "N/A",
    html,
    preview: document.getElementById("ai_summary_content")?.innerText?.slice(0, 120) || ""
  };
  history.unshift(entry);
  if (history.length > AI_HISTORY_MAX) history.splice(AI_HISTORY_MAX);
  try { localStorage.setItem(AI_HISTORY_KEY, JSON.stringify(history)); } catch { }
  updateAiHistoryBadge();
}

function confirmDeleteAiHistory(id) {
  const overlay = document.createElement("div");
  overlay.id = "ai_delete_confirm";
  overlay.style.cssText = `
    position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:99999;
    display:flex;align-items:center;justify-content:center;
  `;
  overlay.innerHTML = `
    <div style="
      background:#fff;border-radius:16px;padding:3.2rem 3.6rem;
      max-width:42rem;width:90%;text-align:center;
      box-shadow:0 20px 60px rgba(0,0,0,0.18);
      animation: fadeInScale .18s ease;
    ">
      <div style="font-size:3.6rem;margin-bottom:1.2rem;">🗑️</div>
      <h3 style="font-size:1.8rem;font-weight:700;color:#111;margin:0 0 0.8rem;">Xóa bản tóm tắt?</h3>
      <p style="color:#64748b;font-size:1.4rem;margin:0 0 2.4rem;">Hành động này không thể hoàn tác. Bản tóm tắt này sẽ bị xóa vĩnh viễn.</p>
      <div style="display:flex;gap:1.2rem;justify-content:center;">
        <button onclick="document.getElementById('ai_delete_confirm').remove()" style="
          padding:0.9rem 2.4rem;border-radius:10px;border:1.5px solid #e2e8f0;
          background:#fff;color:#64748b;font-size:1.4rem;font-weight:600;
          cursor:pointer;transition:all .2s;
        ">Hủy</button>
        <button onclick="_doDeleteAiHistory(${id});document.getElementById('ai_delete_confirm').remove()" style="
          padding:0.9rem 2.4rem;border-radius:10px;border:none;
          background:#ef4444;color:#fff;font-size:1.4rem;font-weight:600;
          cursor:pointer;transition:all .2s;
        "><i class='fa-solid fa-trash'></i> Xóa</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.addEventListener("click", e => { if (e.target === overlay) overlay.remove(); });
}

function _doDeleteAiHistory(id) {
  const history = loadAiHistory().filter(e => e.id !== id);
  try { localStorage.setItem(AI_HISTORY_KEY, JSON.stringify(history)); } catch { }
  updateAiHistoryBadge();
  renderAiHistory();
}

function loadAiHistoryItem(id) {
  const entry = loadAiHistory().find(e => e.id === id);
  if (!entry) return;
  const content = document.getElementById("ai_summary_content");
  const emptyBox = document.getElementById("ai_empty_state");
  if (content) content.innerHTML = entry.html;
  if (emptyBox) emptyBox.style.display = "none";
  const copyBtn = document.getElementById("ai_copy_btn");
  const regenBtn = document.getElementById("ai_regenerate_btn");
  const wordBtn = document.getElementById("ai_export_word_btn");
  if (copyBtn) copyBtn.style.display = "flex";
  if (regenBtn) regenBtn.style.display = "flex";
  if (wordBtn) wordBtn.style.display = "flex";
  switchAiTab("result");
}

function updateAiHistoryBadge() {
  const count = loadAiHistory().length;
  const badge = document.getElementById("ai_history_badge");
  if (!badge) return;
  badge.textContent = count;
  badge.style.display = count > 0 ? "inline-block" : "none";
}

function renderAiHistory() {
  const list = document.getElementById("ai_history_list");
  if (!list) return;
  const history = loadAiHistory();
  if (!history.length) {
    list.innerHTML = `<div class="ai_history_empty"><i class="fa-solid fa-clock-rotate-left"></i>Chưa có bản tóm tắt nào được lưu.</div>`;
    return;
  }
  list.innerHTML = history.map(e => `
    <div class="ai_history_item">
      <!-- Status bar bên trong từng card -->
      <div class="ai_status_bar">
        <div class="ai_status_left">
          <span>Chiến dịch phân tích:</span>
          <div class="ai_badge_orange"><i class="fa-solid fa-bolt"></i> ${e.label}</div>
          ${e.dateRange ? `<div class="ai_badge_gray"><i class="fa-solid fa-calendar-days"></i> ${e.dateRange}</div>` : ""}
        </div>
        <div class="ai_status_right">
          <i class="fa-solid fa-circle" style="font-size:0.7rem"></i> ĐÃ HOÀN THÀNH
        </div>
      </div>
      <!-- Footer card: thời gian + actions -->
      <div class="ai_history_item_header">
        <div class="ai_history_meta">
          <span class="ai_history_time"><i class="fa-regular fa-clock"></i> ${e.timestamp}</span>
        </div>
        <div class="ai_history_actions">
          <button class="ai_history_btn primary" onclick="loadAiHistoryItem(${e.id})"><i class="fa-solid fa-eye"></i> Xem</button>
          <button class="ai_history_btn" onclick="confirmDeleteAiHistory(${e.id})"><i class="fa-solid fa-trash"></i></button>
        </div>
      </div>
      <div class="ai_history_preview">${e.preview}</div>
    </div>
  `).join("");
}

// Abort controller cho request AI đang chạy
let _aiController = null;

function closeAiSummaryModal() {
  // Huỷ request đang chạy (nếu có)
  if (_aiController) {
    _aiController.abort();
    _aiController = null;
  }
  const modal = document.getElementById("ai_summary_modal");
  if (modal) modal.style.display = "none";
}

async function runAiSummary() {
  // Chuyển sang tab kết quả khi bắt đầu
  switchAiTab("result");
  const loading = document.getElementById("ai_summary_loading");
  const content = document.getElementById("ai_summary_content");
  const emptyBox = document.getElementById("ai_empty_state");
  const copyBtn = document.getElementById("ai_copy_btn");
  const regenBtn = document.getElementById("ai_regenerate_btn");
  const dateBadge = document.getElementById("ai_date_range");

  // Hiển thị dải ngày thực tế (nếu có trong app)
  if (dateBadge) {
    const start = document.getElementById("date_from")?.value || "N/A";
    const end = document.getElementById("date_to")?.value || "N/A";
    dateBadge.innerText = `${start} — ${end}`;
  }

  if (loading) loading.style.display = "block";
  if (emptyBox) emptyBox.style.display = "none";
  if (content) content.innerHTML = "";
  if (copyBtn) copyBtn.style.display = "none";
  if (regenBtn) regenBtn.style.display = "none";
  const wordBtn = document.getElementById("ai_export_word_btn");
  if (wordBtn) wordBtn.style.display = "none";

  try {
    // Dùng _FILTERED_CAMPAIGNS nếu đang lọc, fallback về _ALL_CAMPAIGNS
    const isFiltered = window._FILTERED_CAMPAIGNS
      && window._FILTERED_CAMPAIGNS !== window._ALL_CAMPAIGNS
      && window._FILTERED_CAMPAIGNS.length < (window._ALL_CAMPAIGNS || []).length;

    const campaigns = (window._FILTERED_CAMPAIGNS ?? window._ALL_CAMPAIGNS) || [];
    if (!campaigns.length) {
      if (content) content.innerHTML = "<p>⚠️ Chưa có dữ liệu campaign. Vui lòng load dữ liệu trước.</p>";
      if (loading) loading.style.display = "none";
      return;
    }

    // Cập nhật tiêu đề modal hiển thị filter context
    const brandFilter = document.querySelector(".dom_selected")?.textContent?.trim() || "Tất cả";
    const modalTitle = document.querySelector(".ai_modal_header span");
    if (modalTitle) {
      modalTitle.innerHTML = `AI Tóm tắt${isFiltered ? ` — ${brandFilter}` : " chiến dịch"}`;
    }

    // ====== Xây dựng dữ liệu chi tiết từng campaign + adset ======
    const fmt = (n) => Math.round(n || 0).toLocaleString("vi-VN");
    const fmtMoney = (n) => fmt(n) + "đ";
    const fmtCpr = (spend, result) => result > 0 ? fmtMoney(spend / result) : "N/A";

    const campaignBlocks = campaigns.map((c) => {
      const cFreq = c.reach > 0 ? (c.impressions / c.reach).toFixed(2) : "N/A";
      const cCpr = fmtCpr(c.spend, c.result);
      const cCpm = c.impressions > 0 ? fmtMoney((c.spend / c.impressions) * 1000) : "N/A";

      const adsetLines = (c.adsets || []).map((as) => {
        const freq = as.reach > 0 ? (as.impressions / as.reach).toFixed(2) : "N/A";
        const cpr = fmtCpr(as.spend, as.result);
        const cpm = as.impressions > 0 ? fmtMoney((as.spend / as.impressions) * 1000) : "N/A";
        const budget = as.daily_budget > 0
          ? `daily ${fmtMoney(as.daily_budget)}`
          : as.lifetime_budget > 0 ? `lifetime ${fmtMoney(as.lifetime_budget)}` : "N/A";
        return `    • Adset: "${as.name}" | Goal: ${as.optimization_goal} | Spent: ${fmtMoney(as.spend)} | Reach: ${fmt(as.reach)} | Impressions: ${fmt(as.impressions)} | Freq: ${freq} | Results: ${as.result} | CPR: ${cpr} | CPM: ${cpm} | Clicks: ${fmt(as.link_clicks || 0)} | Reactions: ${fmt(as.reactions || 0)} | Budget: ${budget}`;
      }).join("\n");

      return `Campaign: "${c.name}"
  Status: ${c.status || "N/A"} | Spent: ${fmtMoney(c.spend)} | Reach: ${fmt(c.reach)} | Impressions: ${fmt(c.impressions)} | Freq: ${cFreq} | Results: ${c.result} | CPR: ${cCpr} | CPM: ${cCpm} | Reactions: ${fmt(c.reactions || 0)} | Messages: ${fmt(c.message || 0)} | Leads: ${fmt(c.lead || 0)}
${adsetLines}`;
    });

    const dateRange = document.querySelector(".dom_date")?.textContent?.trim() || "N/A";
    const filterNote = isFiltered
      ? `Brand đang lọc: **${brandFilter}** (${campaigns.length}/${(window._ALL_CAMPAIGNS || []).length} campaign)`
      : `Toàn bộ tài khoản — ${campaigns.length} campaign`;

    // Tổng hợp nhanh toàn account
    const totalSpend = campaigns.reduce((s, c) => s + (c.spend || 0), 0);
    const totalReach = campaigns.reduce((s, c) => s + (c.reach || 0), 0);
    const totalResult = campaigns.reduce((s, c) => s + (c.result || 0), 0);

    const prompt = `Bạn là chuyên gia phân tích quảng cáo Facebook Ads cao cấp. Hãy phân tích toàn diện và chi tiết dữ liệu sau, viết bằng tiếng Việt chuyên nghiệp.

═══════════════════════════════
THÔNG TIN CHUNG
═══════════════════════════════
- Khoảng thời gian: ${dateRange}
- ${filterNote}
- Tổng chi phí: ${fmtMoney(totalSpend)} | Tổng reach: ${fmt(totalReach)} | Tổng kết quả: ${fmt(totalResult)}
- CPR trung bình toàn account: ${fmtCpr(totalSpend, totalResult)}

═══════════════════════════════
DỮ LIỆU CHI TIẾT THEO CAMPAIGN & ADSET
═══════════════════════════════
${campaignBlocks.join("\n\n")}

═══════════════════════════════
YÊU CẦU PHÂN TÍCH (đầy đủ, chi tiết, có số liệu cụ thể)
═══════════════════════════════
## 1. Tổng quan hiệu suất
- Tổng hợp spend/reach/result/CPR/CPM toàn bộ
- So sánh hiệu quả giữa các mục tiêu tối ưu (optimization goal)

## 2. Phân tích Campaign & Adset nổi bật
- Top 3 adset hiệu quả nhất (lý do: CPR thấp / reach cao / kết quả tốt)
- Top 3 adset kém nhất cần xem xét (lý do cụ thể)
- Campaign nào chi nhiều nhất nhưng kết quả không tương xứng?

## 3. Phân tích theo Optimization Goal
- So sánh hiệu quả giữa các nhóm: Awareness / Consideration / Conversion
- Goal nào đang cho ROI tốt nhất? Goal nào chi phí quá cao?

## 4. Phân tích Frequency & CPM
- Adset nào có frequency cao (>3) — nguy cơ banner blindness?
- CPM nào bất thường (quá cao hoặc quá thấp)?

## 5. Điểm mạnh & điểm cần cải thiện
- Liệt kê vài điểm mạnh với dẫn chứng số liệu
- Liệt kê vài điểm yếu cụ thể cần khắc phục

## 6. Đề xuất hành động
- 5-7 gợi ý hành động cụ thể, có ưu tiên (cao/trung/thấp)
- Đề xuất phân bổ ngân sách tối ưu hơn nếu có thể

⚠️ QUY TẮC ĐỊNH DẠNG OUTPUT (bắt buộc tuân thủ):
- Dùng ## cho section headers (ví dụ: ## 1. Tổng quan hiệu suất)
- Dùng ### cho sub-section nếu cần
- Dùng **bold** cho số liệu và từ khóa quan trọng
- Dùng bullet points (-) cho danh sách, indent 2 dấu cách cho sub-bullet
- KHÔNG dùng ký tự đặc biệt như ═══ hay ───
- Có thể dùng markdown table (|---|) cho các phần so sánh dữ liệu hoặc phân đoạn khách hàng để báo cáo chuyên nghiệp hơn.
- Viết bằng tiếng Việt, súc tích, có số liệu cụ thể từ dữ liệu được cung cấp.`;

    // ── Huỷ request cũ nếu còn đang chạy ──
    if (_aiController) _aiController.abort();
    _aiController = new AbortController();
    const signal = _aiController.signal;

    // ── Gọi qua PHP proxy (API key ẩn phía server) ──
    const PROXY_URL = "https://automation.ideas.edu.vn/dom.php";

    const resp = await fetch(PROXY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt }),
      signal,
    });

    const data = await resp.json();
    if (!resp.ok) throw new Error(data?.error || `Proxy error: ${resp.status}`);
    const text = data?.text || "Không nhận được phản hồi từ AI.";

    // Render markdown
    if (content) content.innerHTML = simpleMarkdown(text);
    if (copyBtn) copyBtn.style.display = "flex";
    if (regenBtn) regenBtn.style.display = "flex";
    const wordBtnFinal = document.getElementById("ai_export_word_btn");
    if (wordBtnFinal) wordBtnFinal.style.display = "flex";

    // Lưu vào lịch sử
    const hBrand = document.querySelector(".dom_selected")?.textContent?.trim() || "";
    const hDate = document.querySelector(".dom_date")?.textContent?.trim() || "";
    const hLabel = `${hDate}${hBrand && hBrand !== "Ampersand" ? " — " + hBrand : ""}`;
    saveAiHistory(content.innerHTML, hLabel || "Tóm tắt chiến dịch");

  } catch (err) {
    if (err.name === "AbortError") {
      // Request bị huỷ chủ động (user đóng modal) — im lặng
      console.log("⏹ AI request bị huỷ.");
      return;
    }
    console.error("❌ AI Summary error:", err);
    if (content) content.innerHTML = `<p style="color:#e05c1a">❌ Lỗi: ${err.message}</p>`;
  } finally {
    if (loading) loading.style.display = "none";
    _aiController = null;
  }
}

/**
 * Chuyển markdown sang HTML — với table support
 */
function simpleMarkdown(text) {
  let html = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/^#### (.+)$/gm, "<h4>$1</h4>")
    .replace(/^### (.+)$/gm, "<h3>$1</h3>")
    .replace(/^## (.+)$/gm, "<h2>$1</h2>")
    .replace(/^# (.+)$/gm, "<h1>$1</h1>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/`(.+?)`/g, "<code>$1</code>")
    .replace(/^---$/gm, "<hr>");

  const lines = html.split("\n");
  const out = [];
  let inUl = false, depth = 0;
  let tblRows = [];

  const closeUl = (d) => { while (depth > d) { out.push("</ul>"); depth--; } };

  const flushTable = () => {
    if (!tblRows.length) return;
    const isSep = r => /^\|[\s\-:| ]+\|$/.test(r);
    const parse = r => r.replace(/^\||\|$/g, "").split("|").map(c => c.trim());
    const dataRows = tblRows.filter(r => !isSep(r));
    if (!dataRows.length) { tblRows = []; return; }
    const hdr = parse(dataRows[0]);
    const body = dataRows.slice(1);
    let t = `<table class="ai_tbl"><thead><tr>`;
    hdr.forEach(h => t += `<th>${h}</th>`);
    t += `</tr></thead><tbody>`;
    body.forEach(r => {
      const cells = parse(r);
      t += `<tr>`;
      hdr.forEach((_, i) => t += `<td>${cells[i] || ""}</td>`);
      t += `</tr>`;
    });
    t += `</tbody></table>`;
    out.push(t);
    tblRows = [];
  };

  for (const line of lines) {
    const trimmed = line.trim();

    // Table row
    if (/^\|.+\|$/.test(trimmed)) {
      closeUl(0);
      if (inUl) { out.push("</ul>"); inUl = false; }
      tblRows.push(trimmed);
      continue;
    }
    flushTable();

    // Sub-list (2+ leading spaces)
    if (/^ {2,}[-*] (.+)$/.test(line)) {
      const content = line.replace(/^ +[-*] /, "");
      if (!inUl) { out.push("<ul>"); inUl = true; depth = 0; }
      if (depth < 1) { out.push("<ul class='ai_sub'>"); depth = 1; }
      out.push(`<li>${content}</li>`);
      continue;
    }

    // Top-level bullet
    if (/^[-*] (.+)$/.test(line)) {
      const content = line.replace(/^[-*] /, "");
      closeUl(0);
      if (!inUl) { out.push("<ul>"); inUl = true; }
      out.push(`<li>${content}</li>`);
      continue;
    }

    // Non-list / non-table
    closeUl(0);
    if (inUl) { out.push("</ul>"); inUl = false; }
    if (/^<h[1-4]|^<hr/.test(line)) {
      out.push(line);
    } else if (line.trim()) {
      out.push(`<p>${line}</p>`);
    }
  }
  flushTable();
  closeUl(0);
  if (inUl) out.push("</ul>");

  return out.join("\n").replace(/<p><\/p>/g, "");
}

/**
 * 🧹 Reset toàn bộ filter về trạng thái mặc định
 */
function resetAllFilters() {
  // Dùng applyCampaignFilter("RESET") để đồng bộ: list + charts + dropdown
  if (typeof applyCampaignFilter === "function") {
    applyCampaignFilter("RESET");
  } else {
    // Fallback nếu hàm chưa sẵn
    const campaignSearch = document.getElementById("campaign_filter");
    if (campaignSearch) campaignSearch.value = "";
    resetUIFilter();
    loadAllDashboardCharts();
  }
  // Xóa empty state dashboard
  document.querySelector(".dom_container")?.classList.remove("is-empty");
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

/**
 * Hàm helper để load ảnh lazy khi click mở rộng
 */
function loadLazyImages(container) {
  if (!container) return;
  const lazyImages = container.querySelectorAll("img[data-src]");
  lazyImages.forEach((img) => {
    img.src = img.dataset.src;
    img.removeAttribute("data-src");
  });
}

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
      // Toggle campaign hiện tại (cho phép mở nhiều campaign cùng lúc)
      campaignItem.classList.toggle("show");
      if (campaignItem.classList.contains("show")) {
        loadLazyImages(campaignItem);
      }
      return;
    }

    // 1b-extra. Click vào nút insight của adset (PHẢI check trước .adset_item)
    const adsetInsightBtn = e.target.closest(".adset_insight_btn");
    if (adsetInsightBtn) {
      e.stopPropagation();
      handleAdsetInsightClick(adsetInsightBtn);
      return;
    }

    // 1b. Xử lý click vào Adset (mở/đóng danh sách Ad)
    const adsetItem = e.target.closest(".adset_item");
    if (adsetItem) {
      e.stopPropagation();
      adsetItem.classList.toggle("show");
      if (adsetItem.classList.contains("show")) {
        const adItemBox = adsetItem.nextElementSibling;
        if (adItemBox && adItemBox.classList.contains("ad_item_box")) {
          loadLazyImages(adItemBox);
        }
      }
      return;
    }

    // 1c. Xử lý click vào nút "View Ad Detail"
    const adViewBtn = e.target.closest(".ad_view");
    if (adViewBtn) {
      e.stopPropagation();
      handleViewClick(e, "ad");
      return;
    }
  }); // ⎯⎯ end campaign list listener

  // 2. Listener cho việc đóng popup chi tiết
  document.addEventListener("click", (e) => {
    const overlay = e.target.closest(".dom_overlay");
    if (!overlay) return;
    const domDetail = document.querySelector("#dom_detail");
    if (domDetail) domDetail.classList.remove("active");
  });

  // 3. Listener cho nút Export CSV
  const exportBtn = document.getElementById("export_csv_btn");
  if (exportBtn) {
    exportBtn.addEventListener("click", () => {
      if (typeof exportAdsToCSV === "function") exportAdsToCSV();
    });
  }
}

// ================================================================
// ===================== ADSET INSIGHT HANDLER ====================
// ================================================================
async function handleAdsetInsightClick(btn) {
  const adsetId = btn.dataset.adsetId;
  if (!adsetId) return;

  const name = btn.dataset.name || "Adset";
  const goal = btn.dataset.goal || "";
  const spend = parseFloat(btn.dataset.spend || 0);
  const reach = parseFloat(btn.dataset.reach || 0);
  const impressions = parseFloat(btn.dataset.impressions || 0);
  const result = parseFloat(btn.dataset.result || 0);
  const cpr = parseFloat(btn.dataset.cpr || 0);

  // Cập nhật quick stats
  const goalEl = document.querySelector("#detail_goal span");
  const resultEl = document.querySelector("#detail_result span");
  const spendEl = document.querySelector("#detail_spent span");
  const cprEl = document.querySelector("#detail_cpr span");
  if (goalEl) goalEl.textContent = goal;
  if (spendEl) spendEl.textContent = formatMoney(spend);
  if (resultEl) resultEl.textContent = formatNumber(result);
  if (cprEl) cprEl.textContent = result ? formatMoney(cpr) : "-";

  VIEW_GOAL = goal;

  // Cập nhật frequency widget
  const freqWrap = document.querySelector(".dom_frequency");
  if (freqWrap && reach > 0) {
    const frequency = impressions / reach;
    const percent = Math.min((frequency / 4) * 100, 100);
    const donut = freqWrap.querySelector(".semi-donut");
    if (donut) donut.style.setProperty("--percentage", percent.toFixed(1));
    const freqNum = freqWrap.querySelector(".frequency_number");
    if (freqNum) freqNum.querySelector("span:nth-child(1)").textContent = frequency.toFixed(1);
    const impLabel = freqWrap.querySelector(".dom_frequency_label_impression");
    const reachLabel = freqWrap.querySelector(".dom_frequency_label_reach");
    if (impLabel) impLabel.textContent = impressions.toLocaleString("vi-VN");
    if (reachLabel) reachLabel.textContent = reach.toLocaleString("vi-VN");
  }

  // Mở panel
  const domDetail = document.querySelector("#dom_detail");
  if (domDetail) {
    domDetail.classList.add("active");
    // Ẩn Quick Preview — adset không có thẻ quảng cáo
    const previewBox = domDetail.querySelector("#preview_box");
    const previewBtn = domDetail.querySelector("#preview_button");
    if (previewBox) { previewBox.innerHTML = ""; previewBox.style.display = "none"; }
    if (previewBtn) previewBtn.style.display = "none";

    // Cập nhật header
    const img = domDetail.querySelector(".dom_detail_header img");
    const idEl = domDetail.querySelector(".dom_detail_id");
    if (img) img.src = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
    if (idEl) idEl.innerHTML = `<span>${name}</span> <span>ID: ${adsetId}</span>`;
  }

  const loadingEl = document.querySelector(".loading");
  if (loadingEl) loadingEl.classList.add("active");

  try {
    await showAdsetDetail(adsetId);
  } catch (err) {
    console.error("❌ Lỗi khi load chi tiết adset:", err);
  } finally {
    if (loadingEl) loadingEl.classList.remove("active");
  }
}

async function showAdsetDetail(adset_id) {
  if (!adset_id) return;

  // Hủy chart cũ
  [
    window.detail_spent_chart_instance,
    window.chartByHourInstance,
    window.chart_by_age_gender_instance,
    window.chart_by_region_instance,
    window.chart_by_device_instance,
  ].forEach((c) => { if (c && typeof c.destroy === "function") { try { c.destroy(); } catch (e) { } } });
  window.detail_spent_chart_instance = null;
  window.chartByHourInstance = null;
  window.chart_by_age_gender_instance = null;
  window.chart_by_region_instance = null;
  window.chart_by_device_instance = null;

  try {
    const timeRangeParam = `&time_range[since]=${startDate}&time_range[until]=${endDate}`;
    const batchRequests = [
      { method: "GET", name: "targeting", relative_url: `${adset_id}?fields=targeting` },
      { method: "GET", name: "byHour", relative_url: `${adset_id}/insights?fields=spend,impressions,reach,actions&breakdowns=hourly_stats_aggregated_by_advertiser_time_zone${timeRangeParam}` },
      { method: "GET", name: "byAgeGender", relative_url: `${adset_id}/insights?fields=spend,impressions,reach,actions&breakdowns=age,gender${timeRangeParam}` },
      { method: "GET", name: "byRegion", relative_url: `${adset_id}/insights?fields=spend,impressions,reach,actions&breakdowns=region${timeRangeParam}` },
      { method: "GET", name: "byPlatform", relative_url: `${adset_id}/insights?fields=spend,impressions,reach,actions&breakdowns=publisher_platform,platform_position${timeRangeParam}` },
      { method: "GET", name: "byDevice", relative_url: `${adset_id}/insights?fields=spend,impressions,reach,actions&breakdowns=impression_device${timeRangeParam}` },
      { method: "GET", name: "byDate", relative_url: `${adset_id}/insights?fields=spend,impressions,reach,actions&time_increment=1${timeRangeParam}` },
    ];

    const batchResponse = await fetchJSON(BASE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ access_token: META_TOKEN, batch: batchRequests, include_headers: false }),
    });

    if (!Array.isArray(batchResponse)) throw new Error("Invalid batch response");

    const results = {};
    batchResponse.forEach((item, i) => {
      const name = batchRequests[i].name;
      if (item && item.code === 200) {
        try {
          const parsed = JSON.parse(item.body);
          // targeting trả về object, còn insights trả về { data: [...] }
          results[name] = parsed.data ?? parsed;
        } catch (e) {
          results[name] = name === "targeting" ? {} : [];
        }
      } else {
        results[name] = name === "targeting" ? {} : [];
      }
    });

    // Render targeting (age, gender, location)
    const targeting = results.targeting?.targeting || results.targeting || {};
    renderTargetingToDOM(targeting);

    const processBreakdown = (arr, k1, k2 = null) => {
      const out = {};
      (arr || []).forEach((item) => {
        let key = item[k1] || "unknown";
        if (k2) key = `${key}_${item[k2] || "unknown"}`;
        if (!out[key]) out[key] = { spend: 0, impressions: 0, reach: 0, actions: {} };
        out[key].spend += parseFloat(item.spend || 0);
        out[key].impressions += parseInt(item.impressions || 0);
        out[key].reach += parseInt(item.reach || 0);
        (item.actions || []).forEach((a) => {
          out[key].actions[a.action_type] = (out[key].actions[a.action_type] || 0) + parseInt(a.value || 0);
        });
      });
      return out;
    };

    const processedByDate = {};
    (results.byDate || []).forEach((item) => {
      if (item.date_start) {
        processedByDate[item.date_start] = {
          spend: parseFloat(item.spend || 0),
          impressions: parseInt(item.impressions || 0),
          reach: parseInt(item.reach || 0),
          actions: item.actions ? Object.fromEntries(item.actions.map((a) => [a.action_type, parseInt(a.value || 0)])) : {},
        };
      }
    });

    const processedByHour = processBreakdown(results.byHour, "hourly_stats_aggregated_by_advertiser_time_zone");
    const processedByAgeGender = processBreakdown(results.byAgeGender, "age", "gender");
    const processedByRegion = processBreakdown(results.byRegion, "region");
    const processedByPlatform = processBreakdown(results.byPlatform, "publisher_platform", "platform_position");
    const processedByDevice = processBreakdown(results.byDevice, "impression_device");

    renderInteraction(processedByDate);
    window.dataByDate = processedByDate;

    renderCharts({
      byHour: processedByHour,
      byAgeGender: processedByAgeGender,
      byRegion: processedByRegion,
      byPlatform: processedByPlatform,
      byDevice: processedByDevice,
      byDate: processedByDate,
    });

    renderChartByPlatform({
      byAgeGender: processedByAgeGender,
      byRegion: processedByRegion,
      byPlatform: processedByPlatform,
      byDevice: processedByDevice,
    });

    window.processedByDate = processedByDate;
    window.processedByHour = processedByHour;
    window.processedByAgeGender = processedByAgeGender;
    window.processedByRegion = processedByRegion;
    window.processedByPlatform = processedByPlatform;
  } catch (err) {
    console.error("❌ Lỗi khi fetch adset detail:", err);
  }
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
    const frequency = impressions / reach;
    const percent = Math.min((frequency / 4) * 100, 100);
    const donut = freqWrap.querySelector(".semi-donut");
    if (donut) donut.style.setProperty("--percentage", percent.toFixed(1));
    const freqNum = freqWrap.querySelector(".frequency_number");
    if (freqNum)
      freqNum.querySelector("span:nth-child(1)").textContent = frequency.toFixed(1);
    const impLabel = freqWrap.querySelector(".dom_frequency_label_impression");
    const reachLabel = freqWrap.querySelector(".dom_frequency_label_reach");
    if (impLabel) impLabel.textContent = impressions.toLocaleString("vi-VN");
    if (reachLabel) reachLabel.textContent = reach.toLocaleString("vi-VN");
  }

  // --- Hiển thị panel chi tiết ---
  const domDetail = document.querySelector("#dom_detail");
  if (domDetail) {
    domDetail.classList.add("active");
    // Đảm bảo preview_box và preview_button hiện lại khi xem Ad (không phải Adset)
    const previewBox = domDetail.querySelector("#preview_box");
    const previewBtn = domDetail.querySelector("#preview_button");
    if (previewBox) previewBox.style.display = "";
    if (previewBtn) previewBtn.style.display = "";

    const img = domDetail.querySelector(".dom_detail_header img");
    const idEl = domDetail.querySelector(".dom_detail_id");
    if (img) img.src = thumb;
    if (idEl) idEl.innerHTML = `<span>${name}</span> <span> ID: ${id}</span>`;
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
// ===================== HIỂN THỊ CHI TIẾT AD (ĐÃ SỬA ĐỔI) =====================
async function showAdDetail(ad_id) {
  if (!ad_id) return;

  const detailBox = document.querySelector(".dom_detail");
  if (!detailBox) return;
  // Không cần add active ở đây nữa, vì handleViewClick đã làm rồi

  // Hủy các chart cũ (Giữ nguyên)
  // --- 1. Hủy các chart cũ ---
  const chartsToDestroy = [
    window.detail_spent_chart_instance, // Chart daily trend trong detail
    window.chartByHourInstance, // Chart theo giờ (sửa tên biến)
    window.chart_by_age_gender_instance, // Chart tuổi/giới tính
    window.chart_by_region_instance, // Chart vùng miền
    window.chart_by_device_instance, // Chart thiết bị (doughnut)
  ];

  chartsToDestroy.forEach((chart) => {
    if (chart && typeof chart.destroy === "function") {
      try {
        chart.destroy();
      } catch (e) {
        console.warn("Lỗi khi hủy chart:", e);
      }
    }
  });

  // Gán lại null cho các instance đã hủy
  window.detail_spent_chart_instance = null;
  window.chartByHourInstance = null;
  window.chart_by_age_gender_instance = null;
  window.chart_by_region_instance = null;
  window.chart_by_device_instance = null;

  try {
    // ⭐ THAY ĐỔI CHÍNH: Gọi hàm batch MỘT LẦN ở đây
    const results = await fetchAdDetailBatch(ad_id);
    console.log(results);

    // Bóc tách kết quả từ object 'results'
    const {
      targeting,
      byHour,
      byAgeGender,
      byRegion,
      byPlatform,
      byDevice,
      byDate,
      adPreview,
    } = results;

    // Kiểm tra dữ liệu CƠ BẢN
    // if (
    //   !targeting ||
    //   !byHour ||
    //   !byAgeGender ||
    //   !byRegion ||
    //   !byPlatform ||
    //   !byDevice ||
    //   !byDate
    // ) {
    //   console.error(
    //     "❌ Dữ liệu chi tiết ad bị thiếu sau khi fetch batch:",
    //     ad_id
    //   );
    //   // Có thể hiển thị thông báo lỗi phù hợp hơn
    //   return;
    // }

    // ⭐ Render Ad Preview
    const previewBox = document.getElementById("preview_box");
    if (previewBox) {
      previewBox.innerHTML = adPreview || "";
    }

    // ================== Render Targeting ==================
    renderTargetingToDOM(targeting);

    const processedByDate = {};
    (byDate || []).forEach((item) => {
      const date = item.date_start;
      if (date) {
        processedByDate[date] = {
          spend: parseFloat(item.spend || 0),
          impressions: parseInt(item.impressions || 0),
          reach: parseInt(item.reach || 0),
          actions: item.actions
            ? Object.fromEntries(
              item.actions.map((a) => [a.action_type, parseInt(a.value || 0)])
            )
            : {},
        };
      }
    });

    // Chuyển đổi các breakdown khác về dạng object {key: {spend, actions...}}
    const processBreakdown = (dataArray, keyField1, keyField2 = null) => {
      console.log();

      const result = {};
      (dataArray || []).forEach((item) => {
        let key = item[keyField1] || "unknown";
        if (keyField2) {
          key = `${key}_${item[keyField2] || "unknown"}`;
        }
        if (!result[key]) {
          result[key] = { spend: 0, impressions: 0, reach: 0, actions: {} };
        }
        result[key].spend += parseFloat(item.spend || 0);
        result[key].impressions += parseInt(item.impressions || 0);
        result[key].reach += parseInt(item.reach || 0);
        if (item.actions) {
          item.actions.forEach((a) => {
            result[key].actions[a.action_type] =
              (result[key].actions[a.action_type] || 0) +
              parseInt(a.value || 0);
          });
        }
      });
      return result;
    };

    const processedByHour = processBreakdown(
      byHour,
      "hourly_stats_aggregated_by_advertiser_time_zone"
    );

    const processedByAgeGender = processBreakdown(byAgeGender, "age", "gender");
    const processedByRegion = processBreakdown(byRegion, "region");
    const processedByPlatform = processBreakdown(
      byPlatform,
      "publisher_platform",
      "platform_position"
    );
    console.log(processedByAgeGender);

    const processedByDevice = processBreakdown(byDevice, "impression_device");

    renderInteraction(processedByDate); // Truyền dữ liệu đã xử lý
    window.dataByDate = processedByDate; // Lưu data đã xử lý

    // ================== Render Chart ==================
    // Truyền dữ liệu đã xử lý vào hàm render
    renderCharts({
      byHour: processedByHour,
      byAgeGender: processedByAgeGender,
      byRegion: processedByRegion,
      byPlatform: processedByPlatform, // Dữ liệu này có thể chưa được xử lý đúng dạng object mong đợi bởi renderChartByPlatform
      byDevice: processedByDevice,
      byDate: processedByDate,
    });

    // Hàm này cần dữ liệu đã được xử lý thành object, KHÔNG phải array raw
    renderChartByPlatform({
      // Hàm này render list, không phải chart
      byAgeGender: processedByAgeGender,
      byRegion: processedByRegion,
      byPlatform: processedByPlatform,
      byDevice: processedByDevice,
    });
    // ✅ Lưu toàn bộ data vào global để Deep Report AI sử dụng
    window.campaignSummaryData = {
      spend: Object.values(processedByDate).reduce((t, d) => t + d.spend, 0),
      impressions: Object.values(processedByDate).reduce(
        (t, d) => t + d.impressions,
        0
      ),
      reach: Object.values(processedByDate).reduce((t, d) => t + d.reach, 0),
      // ✅ Lấy results chủ lực từ actions
      results: Object.values(processedByDate).reduce(
        (t, d) =>
          t +
          (d.actions?.["onsite_conversion.lead_grouped"] ||
            d.actions?.["onsite_conversion.total_messaging_connection"] ||
            0),
        0
      ),
    };

    window.targetingData = targeting;
    window.processedByDate = processedByDate;
    window.processedByHour = processedByHour;

    window.processedByAgeGender = processedByAgeGender;
    window.processedByRegion = processedByRegion;
    window.processedByPlatform = processedByPlatform;
  } catch (err) {
    console.error("❌ Lỗi khi load/render chi tiết ad (batch):", err);
  }
  // Phần finally tắt loading nằm trong handleViewClick
}
/**
 * ⭐ TỐI ƯU: Hàm Batch Request mới.
 * Thay thế 8 hàm fetch...() riêng lẻ khi xem chi tiết ad.
 */
async function fetchAdDetailBatch(ad_id) {
  if (!ad_id) throw new Error("ad_id is required for batch fetch");

  // 1. Chuẩn bị các tham số chung
  const timeRangeParam = `&time_range[since]=${startDate}&time_range[until]=${endDate}`;

  // 2. Định nghĩa 8 "yêu cầu con" (relative URLs)
  const batchRequests = [
    // 2.1. Targeting
    {
      method: "GET",
      name: "targeting",
      relative_url: `${ad_id}?fields=targeting`,
    },
    // 2.2. Insights: By Hour
    {
      method: "GET",
      name: "byHour",
      relative_url: `${ad_id}/insights?fields=spend,impressions,reach,actions&breakdowns=hourly_stats_aggregated_by_advertiser_time_zone${timeRangeParam}`,
    },
    // 2.3. Insights: By Age/Gender
    {
      method: "GET",
      name: "byAgeGender",
      relative_url: `${ad_id}/insights?fields=spend,impressions,reach,actions&breakdowns=age,gender${timeRangeParam}`,
    },
    // 2.4. Insights: By Region
    {
      method: "GET",
      name: "byRegion",
      relative_url: `${ad_id}/insights?fields=spend,impressions,reach,actions&breakdowns=region${timeRangeParam}`,
    },
    // 2.5. Insights: By Platform/Position
    {
      method: "GET",
      name: "byPlatform",
      relative_url: `${ad_id}/insights?fields=spend,impressions,reach,actions&breakdowns=publisher_platform,platform_position${timeRangeParam}`,
    },
    // 2.6. Insights: By Device
    {
      method: "GET",
      name: "byDevice",
      relative_url: `${ad_id}/insights?fields=spend,impressions,reach,actions&breakdowns=impression_device${timeRangeParam}`,
    },
    // 2.7. Insights: By Date (Daily)
    {
      method: "GET",
      name: "byDate",
      relative_url: `${ad_id}/insights?fields=spend,impressions,reach,actions&time_increment=1${timeRangeParam}`,
    },
    // 2.8. Ad Preview
    {
      method: "GET",
      name: "adPreview",
      relative_url: `${ad_id}/previews?ad_format=DESKTOP_FEED_STANDARD`,
    },
  ];

  // 3. Gửi Batch Request
  const headers = { "Content-Type": "application/json" };
  const fbBatchBody = {
    access_token: META_TOKEN,
    batch: batchRequests,
    include_headers: false,
  };

  try {
    const batchResponse = await fetchJSON(BASE_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(fbBatchBody),
    });

    // 4. Bóc tách kết quả
    const results = {};
    if (!Array.isArray(batchResponse)) {
      throw new Error("Batch response (ad detail) was not an array");
    }

    batchResponse.forEach((item, index) => {
      const name = batchRequests[index].name; // Lấy tên đã định danh
      console.log(name);

      // Mặc định giá trị rỗng
      const defaultEmpty =
        name === "targeting" || name === "adPreview" ? null : [];
      results[name] = defaultEmpty;

      if (item && item.code === 200) {
        try {
          const body = JSON.parse(item.body);

          // Xử lý các cấu trúc trả về khác nhau
          if (name === "targeting") {
            results[name] = body.targeting || {};
          } else if (name === "adPreview") {
            results[name] = body.data?.[0]?.body || null; // Đây là chuỗi HTML
          } else {
            // Tất cả các 'insights' call khác

            results[name] = body.data || [];
          }
        } catch (e) {
          console.warn(`⚠️ Failed to parse batch response for ${name}`, e);
        }
      } else {
        console.warn(`⚠️ Batch request for ${name} failed.`, item);
      }
    });

    return results;
  } catch (err) {
    console.error("❌ Fatal error during ad detail batch fetch:", err);
    // Trả về cấu trúc rỗng
    return {
      targeting: null,
      byHour: [],
      byAgeGender: [],
      byRegion: [],
      byPlatform: [],
      byDevice: [],
      byDate: [],
      adPreview: null,
    };
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

  CURRENT_CAMPAIGN_FILTER = keyword || ""; // 👈 Luôn lưu lại bộ lọc cuối cùng

  // 🚩 Nếu filter = "RESET" thì load full data
  if (keyword && keyword.toUpperCase() === "RESET") {
    window._FILTERED_CAMPAIGNS = window._ALL_CAMPAIGNS; // 👈 lưu lại
    renderCampaignView(window._ALL_CAMPAIGNS); // FULL_CAMPAIGN
    const allAds = window._ALL_CAMPAIGNS.flatMap((c) =>
      c.adsets.flatMap((as) =>
        (as.ads || []).map((ad) => ({
          optimization_goal: as.optimization_goal,
          insights: { spend: ad.spend || 0 },
        }))
      )
    );
    renderGoalChart(allAds);
    resetUIFilter(); // 👈 Reset cả giao diện dropdown Brand
    await loadAllDashboardCharts();
    return;
  }

  // 🔹 Lọc campaign theo tên (không phân biệt hoa thường)
  const filtered = keyword
    ? window._ALL_CAMPAIGNS.filter((c) =>
      (c.name || "").toLowerCase().includes(keyword.toLowerCase())
    )
    : window._ALL_CAMPAIGNS;

  // 🔹 Render lại danh sách campaign
  window._FILTERED_CAMPAIGNS = filtered; // 👈 lưu lại cho AI Summary
  renderCampaignView(filtered);

  // 🚩 Nếu không có campaign nào khớp → show empty state dashboard ngay
  if (filtered.length === 0) {
    window._FILTERED_CAMPAIGNS = [];
    document.querySelector(".dom_container")?.classList.add("is-empty");
    return;
  }

  // Remove empty state nếu có data
  document.querySelector(".dom_container")?.classList.remove("is-empty");

  // 🔹 Lấy ID campaign hợp lệ để gọi API
  const ids = filtered.map((c) => c.id).filter(Boolean);
  await loadAllDashboardCharts(ids);

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
      key: "onsite_conversion.total_messaging_connection",
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
      return item.actions["onsite_conversion.total_messaging_connection"] || 0;
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
      `${c.dataset.label}: ${type === "spend" ? formatMoneyShort(c.raw) : c.raw
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
              `${c.dataset.label}: ${type === "spend" ? formatMoneyShort(c.raw) : c.raw
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
              return `${c.dataset.label}: ${c.dataset.label === "Spent" ? formatMoneyShort(val) : val
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
              `${c.dataset.label}: ${c.dataset.label === "Spent" ? formatMoneyShort(c.raw) : c.raw
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

  // 🎯 Plugin custom: show % giữa lỗ — dùng chartArea để tính tâm chính xác
  const centerTextPlugin = {
    id: "centerText",
    afterDraw(chart) {
      const { width, ctx } = chart;
      const { top, bottom } = chart.chartArea;
      const centerX = width / 2;
      const centerY = (top + bottom) / 2; // ← tâm thực sự của vùng chart

      ctx.save();
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = "#333";

      ctx.font = "bold 18px sans-serif";
      ctx.fillText(`${maxPercent}%`, centerX, centerY - 11);

      ctx.font = "12px sans-serif";
      ctx.fillText(maxLabel, centerX, centerY + 11);
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
      maintainAspectRatio: true,
      aspectRatio: 1, // Fix hình tròn không bị méo
      cutout: "70%", // 💫 tạo lỗ tròn
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

  // ✅ Top 5 cao nhất
  filtered.sort((a, b) => b.spend - a.spend);
  const top5 = filtered.slice(0, 5);

  // ✅ Helper rút gọn tên vùng
  const shortenName = (name) => {
    let s = name
      .replace(/\b(tỉnh|thành phố|tp\.|tp|province|city|region|state|district|area|zone)\b/gi, "")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^\w/, (c) => c.toUpperCase());
    return s.length > 12 ? s.slice(0, 11) + "…" : s;
  };

  const labels = top5.map((e) => shortenName(e.name));
  const fullNamesDetail = top5.map((e) => e.name);
  const spentData = top5.map((e) => e.spend);
  const resultData = top5.map((e) => e.result);

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
            title: (ctx) => fullNamesDetail[ctx[0].dataIndex] || ctx[0].label,
            label: (ctx) =>
              `${ctx.dataset.label}: ${ctx.dataset.label === "Spent"
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
    divider.innerHTML = `<p><b>${groupLabel}</b></p>`;
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
        <p><span class="total_result"><i class="fa-solid fa-bullseye"></i> ${p.result > 0 ? formatNumber(p.result) : "—"
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
    divider.innerHTML = `<p><b>${groupName}</b></p>`;
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
        <p><b>${formatDeepName(p.key)}</b></p>
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
    message: ["onsite_conversion.total_messaging_connection"],
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
  gLine.addColorStop(0, "rgba(255,169,0,0.15)");
  gLine.addColorStop(1, "rgba(255,171,0,0.01)");

  if (window.detail_spent_chart_instance2) {
    const chart = window.detail_spent_chart_instance2;
    if (chart.data.labels.join(",") !== dates.join(",")) {
      chart.data.labels = dates;
    }
    chart.data.datasets[0].data = chartData;
    chart.data.datasets[0].label = type.charAt(0).toUpperCase() + type.slice(1);

    chart.options.plugins.tooltip.callbacks.label = (c) =>
      `${c.dataset.label}: ${type === "spend" ? formatMoneyShort(c.raw) : c.raw
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
              `${c.dataset.label}: ${type === "spend" ? formatMoneyShort(c.raw) : c.raw
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

/**
 * Cập nhật UI tóm tắt tổng quan, bao gồm so sánh với kỳ trước.
 */
function updatePlatformSummaryUI(currentData, previousData = []) {
  // Thêm previousData và giá trị mặc định
  // --- Helper function để xử lý một object/array data ---

  const processData = (data) => {
    // Đảm bảo data là object, lấy phần tử đầu nếu là array
    const insights = Array.isArray(data) ? data[0] || {} : data || {};

    // Chuyển actions array thành object để dễ truy cập
    const actionsObj = {};
    (insights.actions || []).forEach(({ action_type, value }) => {
      actionsObj[action_type] = (actionsObj[action_type] || 0) + (+value || 0);
    });

    // Trích xuất các chỉ số chính
    return {
      spend: +insights.spend || 0,
      reach: +insights.reach || 0,
      message: actionsObj["onsite_conversion.total_messaging_connection"] || 0,
      lead: actionsObj["onsite_conversion.lead_grouped"] || 0,
      // Các chỉ số phụ (nếu cần tính toán so sánh sau này)
      like:
        (actionsObj["like"] || 0) +
        (actionsObj["page_follow"] || 0) +
        (actionsObj["page_like"] || 0),
      reaction: actionsObj["post_reaction"] || 0,
      comment: actionsObj["comment"] || 0,
      share: (actionsObj["post"] || 0) + (actionsObj["share"] || 0),
      click: actionsObj["link_click"] || 0,
      view: (actionsObj["video_view"] || 0) + (actionsObj["photo_view"] || 0),
    };
  };

  // --- Xử lý dữ liệu cho kỳ hiện tại và kỳ trước ---
  const currentMetrics = processData(currentData);
  const previousMetrics = processData(previousData);
  console.log(previousMetrics);

  // --- Helper function tính toán % thay đổi và xác định trạng thái ---
  const calculateChange = (current, previous) => {
    const change = ((current - previous) / previous) * 100;
    let type = "equal";
    let icon = "fa-solid fa-equals";
    let colorClass = "equal";

    if (change > 0) {
      type = "increase";
      icon = "fa-solid fa-caret-up";
      colorClass = "increase";
    } else if (change < 0) {
      type = "decrease";
      icon = "fa-solid fa-caret-down";
      colorClass = "decrease";
    }

    return { percentage: change, type, icon, colorClass };
  };

  // --- Helper function để render một chỉ số và % thay đổi ---
  const renderMetric = (
    id,
    currentValue,
    previousValue,
    isCurrency = false
  ) => {
    console.log(previousValue);
    console.log(previousData);

    let titleText = ` ${previousValue.toLocaleString("vi-VN")} - (${previousData?.[0]?.date_start
      } to ${previousData?.[0]?.date_stop})`;
    const valueEl = document.querySelector(`#${id} span:first-child`);
    const changeEl = document.querySelector(`#${id} span:last-child`);
    changeEl.setAttribute("title", titleText);
    if (!valueEl || !changeEl) {
      console.warn(`Không tìm thấy element cho ID: ${id}`);
      return;
    }

    // Định dạng giá trị hiện tại
    valueEl.textContent = isCurrency
      ? formatMoney(currentValue)
      : formatNumber(currentValue);

    // Tính toán và hiển thị thay đổi
    const changeInfo = calculateChange(currentValue, previousValue);

    changeEl.textContent = ""; // Xóa nội dung cũ
    changeEl.className = ""; // Xóa class cũ

    let percentageText = "";
    if (changeInfo.type === "new") {
      percentageText = "Mới"; // Hoặc để trống nếu muốn
    } else if (changeInfo.percentage !== null) {
      percentageText = `${changeInfo.percentage >= 0 ? "+" : ""
        }${changeInfo.percentage.toFixed(1)}%`;
    } else {
      percentageText = "N/A"; // Trường hợp cả 2 là 0
    }

    changeEl.appendChild(document.createTextNode(` ${percentageText}`)); // Thêm khoảng trắng

    // Thêm class màu sắc
    changeEl.classList.add(changeInfo.colorClass);
  };

  // --- Render các chỉ số chính với so sánh ---
  renderMetric("spent", currentMetrics.spend, previousMetrics.spend, true); // true vì là tiền tệ
  renderMetric("reach", currentMetrics.reach, previousMetrics.reach);
  renderMetric("message", currentMetrics.message, previousMetrics.message);
  renderMetric("lead", currentMetrics.lead, previousMetrics.lead);

  // --- Render các chỉ số phụ (không cần so sánh theo UI mới) ---
  document.querySelector(".dom_interaction_reaction").textContent =
    formatNumber(currentMetrics.reaction);
  document.querySelector(".dom_interaction_like").textContent = formatNumber(
    currentMetrics.like
  ); // Đã gộp like+follow trong processData
  document.querySelector(".dom_interaction_comment").textContent = formatNumber(
    currentMetrics.comment
  );
  document.querySelector(".dom_interaction_share").textContent = formatNumber(
    currentMetrics.share
  );
  document.querySelector(".dom_interaction_click").textContent = formatNumber(
    currentMetrics.click
  );
  document.querySelector(".dom_interaction_view").textContent = formatNumber(
    currentMetrics.view
  );
}

// --- Các hàm format cũ (giữ nguyên hoặc đảm bảo chúng tồn tại) ---
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

//  batch
async function fetchDashboardInsightsBatch(campaignIds = []) {
  if (!ACCOUNT_ID) throw new Error("ACCOUNT_ID is required");

  // --- 1. TÍNH KHOẢNG THỜI GIAN TRƯỚC ---
  const currentStartDate = new Date(startDate + "T00:00:00");
  const currentEndDate = new Date(endDate + "T00:00:00");
  const durationMillis = currentEndDate.getTime() - currentStartDate.getTime();
  const durationDays = durationMillis / (1000 * 60 * 60 * 24) + 1;

  const previousEndDate = new Date(currentStartDate);
  previousEndDate.setDate(previousEndDate.getDate());

  const previousStartDate = new Date(previousEndDate);
  previousStartDate.setDate(previousStartDate.getDate() - durationDays + 1);

  const formatDate = (date) => date.toISOString().slice(0, 10);
  const prevStartDateStr = formatDate(previousStartDate);
  const prevEndDateStr = formatDate(previousEndDate);

  console.log(`Current Range: ${startDate} to ${endDate}`);
  console.log(
    `Previous Range for Stats: ${prevStartDateStr} to ${prevEndDateStr}`
  );
  // --- KẾT THÚC BƯỚC 1 ---

  const filtering = campaignIds.length
    ? `&filtering=${encodeURIComponent(
      JSON.stringify([
        { field: "campaign.id", operator: "IN", value: campaignIds },
      ])
    )}`
    : "";
  const commonEndpoint = `act_${ACCOUNT_ID}/insights`;

  // Time range strings
  const currentTimeRange = `&time_range={"since":"${startDate}","until":"${endDate}"}`;
  const previousTimeRange = `&time_range={"since":"${prevStartDateStr}","until":"${prevEndDateStr}"}`; // <<< DÙNG NGÀY TRƯỚC

  // --- 2. ĐỊNH NGHĨA REQUESTS (Chỉ thêm platformStats_previous) ---
  const batchRequests = [
    // --- Dữ liệu kỳ hiện tại (Giữ nguyên) ---
    {
      method: "GET",
      name: "platformStats",
      relative_url: `${commonEndpoint}?fields=spend,impressions,reach,actions${currentTimeRange}${filtering}`,
    },
    {
      method: "GET",
      name: "spendByPlatform",
      relative_url: `${commonEndpoint}?fields=spend&breakdowns=publisher_platform,platform_position${currentTimeRange}${filtering}`,
    },
    {
      method: "GET",
      name: "spendByAgeGender",
      relative_url: `${commonEndpoint}?fields=spend&breakdowns=age,gender${currentTimeRange}${filtering}`,
    },
    {
      method: "GET",
      name: "spendByRegion",
      relative_url: `${commonEndpoint}?fields=spend&breakdowns=region${currentTimeRange}${filtering}`,
    },
    {
      method: "GET",
      name: "dailySpend",
      relative_url: `${commonEndpoint}?fields=spend,impressions,reach,actions,campaign_name,campaign_id&time_increment=1${currentTimeRange}${filtering}`,
    },

    // --- Dữ liệu kỳ trước (Chỉ thêm platformStats) ---
    {
      method: "GET",
      name: "platformStats_previous",
      relative_url: `${commonEndpoint}?fields=spend,impressions,reach,actions${previousTimeRange}${filtering}`,
    }, // <<< CHỈ THÊM CÁI NÀY
  ];
  // --- KẾT THÚC BƯỚC 2 ---

  const fbBatchBody = {
    access_token: META_TOKEN,
    batch: batchRequests,
    include_headers: false,
  };
  const headers = { "Content-Type": "application/json" };

  try {
    const batchResponse = await fetchJSON(BASE_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(fbBatchBody),
    });

    if (!Array.isArray(batchResponse)) {
      throw new Error(
        "Batch response (insights + prev stats) was not an array"
      );
    }

    // --- 3. XỬ LÝ KẾT QUẢ ---
    const results = {};
    batchResponse.forEach((item, index) => {
      const requestName = batchRequests[index].name;
      if (item && item.code === 200) {
        try {
          const body = JSON.parse(item.body);
          results[requestName] = body.data || [];
        } catch (e) {
          console.warn(
            `⚠️ Failed to parse batch response for ${requestName}`,
            e
          );
          results[requestName] = [];
        }
      } else {
        console.warn(
          `⚠️ Batch request for ${requestName} failed with code ${item?.code}`
        );
        results[requestName] = [];
      }
    });
    // --- KẾT THÚC BƯỚC 3 ---
    console.log("Batch Results (Current & Previous Stats):", results);
    return results;
  } catch (err) {
    console.error(
      "❌ Fatal error during dashboard insights batch fetch (with prev stats):",
      err
    );
    // Trả về cấu trúc rỗng
    return {
      platformStats: [],
      spendByPlatform: [],
      spendByAgeGender: [],
      spendByRegion: [],
      dailySpend: [],
      platformStats_previous: [], // << Thêm key rỗng cho trường hợp lỗi
    };
  }
}
/**
 * Hàm workflow mới:
 * 1. Gọi fetchDashboardInsightsBatch MỘT LẦN.
 * 2. Phân phối kết quả cho các hàm RENDER (thay vì các hàm load... riêng lẻ).
 */
async function loadAllDashboardCharts(campaignIds = []) {
  // 1. Hiển thị loading (nếu cần)
  const loading = document.querySelector(".loading");
  if (loading) loading.classList.add("active");

  try {
    // 2. Gọi HÀM BATCH MỚI (1 request duy nhất)
    const results = await fetchDashboardInsightsBatch(campaignIds);

    // 🚩 CHECK EMPTY STATE: Nếu tổng spend = 0, hiện Empty Card
    const insights = Array.isArray(results.platformStats) ? results.platformStats[0] || {} : results.platformStats || {};
    const totalSpend = +insights.spend || 0;
    const dashboard = document.querySelector(".dom_dashboard");

    if (totalSpend === 0) {
      document.querySelector(".dom_container")?.classList.add("is-empty");
      console.log("Empty Dashboard - Showing No Data Found");
      return; // Dừng render các chart khác
    } else {
      document.querySelector(".dom_container")?.classList.remove("is-empty");
    }

    // 3. Phân phối data đến các hàm RENDER/UPDATE UI (không fetch nữa)
    // 3.1. Platform Stats (Summary)
    updatePlatformSummaryUI(
      results.platformStats,
      results.platformStats_previous
    );
    DAILY_DATA = results.dailySpend;
    // 3.2. Spend by Platform
    const summary = summarizeSpendByPlatform(results.spendByPlatform);
    renderPlatformSpendUI(summary);
    renderPlatformPosition(results.spendByPlatform);

    // 3.3. Spend by Age/Gender
    renderAgeGenderChart(results.spendByAgeGender);

    // 3.4. Spend by Region
    renderRegionChart(results.spendByRegion);

    // 3.5. Daily Spend
    // Lưu ý: hàm fetchDailySpendByAccount của bạn giờ cũng được thay thế
    // bằng results.dailySpend (khi campaignIds rỗng)
    renderDetailDailyChart2(results.dailySpend, "spend"); // "spend" là default
  } catch (err) {
    console.error("❌ Lỗi khi tải dữ liệu charts dashboard:", err);
  } finally {
    if (loading) loading.classList.remove("active");
  }
}

async function loadSpendPlatform(campaignIds = []) {
  const data = await fetchSpendByPlatform(campaignIds);
  console.log(data);
  const summary = summarizeSpendByPlatform(data);
  renderPlatformSpendUI(summary); // cũ
  renderPlatformPosition(data); // mới
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
      const { width, ctx } = chart;
      const { top, bottom } = chart.chartArea;
      const centerX = width / 2;
      const centerY = (top + bottom) / 2;

      ctx.save();
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = "#333";
      ctx.font = "bold 18px sans-serif";
      ctx.fillText(`${maxPercent}%`, centerX, centerY - 11);
      ctx.font = "12px sans-serif";
      ctx.fillText(maxLabel, centerX, centerY + 11);
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
      maintainAspectRatio: true,
      aspectRatio: 1,
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

async function loadRegionSpendChart(campaignIds = []) {
  const data = await fetchSpendByRegion(campaignIds);
  renderRegionChart(data);
}

async function loadAgeGenderSpendChart(campaignIds = []) {
  const data = await fetchSpendByAgeGender(campaignIds);
  renderAgeGenderChart(data);
}

// =================== DATE PICKER LOGIC (FB ADS STYLE) ===================
// =================== DATE PICKER LOGIC (FB ADS STYLE) ===================
// Variables moved to top to avoid TDZ error

function initDateSelector() {
  const selectBox = document.querySelector(".dom_select.time");
  if (!selectBox) return;

  const selectedText = selectBox.querySelector(".dom_selected");
  const panel = selectBox.querySelector(".time_picker_panel");
  const presetItems = panel.querySelectorAll(".time_picker_sidebar li[data-date]");
  const updateBtn = panel.querySelector(".btn_update");
  const cancelBtn = panel.querySelector(".btn_cancel");
  const startInput = panel.querySelector("#start_date_val");
  const endInput = panel.querySelector("#end_date_val");

  // Initial display sync
  if (startDate && endDate) {
    startInput.value = startDate;
    endInput.value = endDate;
    tempStartDate = startDate;
    tempEndDate = endDate;
  }

  // Prevent duplicate listeners
  if (selectBox.dataset.initialized) {
    return;
  }
  selectBox.dataset.initialized = "true";

  // Prevent clicks inside the panel from bubbling effectively
  panel.addEventListener("click", (e) => {
    e.stopPropagation();
  });

  // Toggle dropdown
  selectBox.addEventListener("click", (e) => {
    // If clicking inside panel (though handled above, safety check) use return
    if (e.target.closest(".time_picker_panel")) return;

    // Stop propagation to prevent document listeners from closing it immediately
    e.stopPropagation();

    const isActive = panel.classList.contains("active");
    // Close all other dropdowns
    document.querySelectorAll(".dom_select_show").forEach(p => p.classList.remove("active"));

    if (!isActive) {
      panel.classList.add("active");
      renderCalendar();
    }
  });

  // Handle sidebar presets
  presetItems.forEach((item) => {
    item.addEventListener("click", (e) => {
      e.stopPropagation();
      const type = item.dataset.date;

      // Reset active state
      presetItems.forEach((i) => i.classList.remove("active"));
      item.classList.add("active");

      if (type === "custom_range") {
        // Just focus on the calendar
        return;
      }

      const range = getDateRange(type);
      startDate = range.start;
      endDate = range.end;
      tempStartDate = startDate;
      tempEndDate = endDate;

      startInput.value = startDate;
      endInput.value = endDate;

      selectedText.textContent = item.querySelector('span:last-child').textContent.trim();
      panel.classList.remove("active");

      // Update calendar highlights
      renderCalendar();

      // Refresh dashboard
      reloadDashboard();
    });
  });

  // Cancel button
  if (cancelBtn) {
    cancelBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      panel.classList.remove("active");
      // Reset temp to match actual global
      tempStartDate = startDate;
      tempEndDate = endDate;
    });
  }

  // Update button
  if (updateBtn) {
    updateBtn.addEventListener("click", (e) => {
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

      const fmt = (d) => {
        const [y, m, da] = d.split("-");
        return `${da}/${m}/${y}`;
      };

      startDate = start;
      endDate = end;
      selectedText.textContent = `${fmt(start)} - ${fmt(end)}`;
      panel.classList.remove("active");

      reloadDashboard();
    });
  }

  // Handle manual input changes
  startInput.addEventListener('change', () => {
    tempStartDate = startInput.value;
    renderCalendar();
  });
  endInput.addEventListener('change', () => {
    tempEndDate = endInput.value;
    renderCalendar();
  });
}

// Helper to format date in Local Time (YYYY-MM-DD)
function formatDateLocal(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function renderCalendar() {
  const container = document.getElementById("calendar_left");
  if (!container) return;

  const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

  const firstDayOfMonth = new Date(calendarCurrentYear, calendarCurrentMonth, 1).getDay();
  const daysInMonth = new Date(calendarCurrentYear, calendarCurrentMonth + 1, 0).getDate();

  let html = `
    <div class="calendar_nav">
      <button onclick="changeMonth(-1)"><i class="fa-solid fa-chevron-left"></i></button>
      <span>${monthNames[calendarCurrentMonth]} ${calendarCurrentYear}</span>
      <button onclick="changeMonth(1)"><i class="fa-solid fa-chevron-right"></i></button>
    </div>
    <div class="calendar_grid">
      <div class="calendar_day_name">Su</div>
      <div class="calendar_day_name">Mo</div>
      <div class="calendar_day_name">Tu</div>
      <div class="calendar_day_name">We</div>
      <div class="calendar_day_name">Th</div>
      <div class="calendar_day_name">Fr</div>
      <div class="calendar_day_name">Sa</div>
  `;

  // Empty slots for previous month
  for (let i = 0; i < firstDayOfMonth; i++) {
    html += `<div class="calendar_day empty"></div>`;
  }

  const todayStr = formatDateLocal(new Date());
  const start = tempStartDate ? new Date(tempStartDate) : null;
  const end = tempEndDate ? new Date(tempEndDate) : null;

  for (let day = 1; day <= daysInMonth; day++) {
    const curDate = new Date(calendarCurrentYear, calendarCurrentMonth, day);
    const curDateStr = formatDateLocal(curDate);

    let classes = ["calendar_day"];
    if (curDateStr === todayStr) classes.push("today");

    if (start && curDateStr === tempStartDate) classes.push("selected");
    if (end && curDateStr === tempEndDate) classes.push("selected");

    if (start && end && curDate > start && curDate < end) {
      classes.push("in_range");
    }

    html += `<div class="${classes.join(' ')}" onclick="selectCalendarDay('${curDateStr}')">${day}</div>`;
  }

  html += `</div>`;
  container.innerHTML = html;
}

// Attach these to window so they're accessible from inline onclick if needed
// or better, use standard listeners. I'll use standard but for quick iteration here:
window.changeMonth = (dir) => {
  calendarCurrentMonth += dir;
  if (calendarCurrentMonth < 0) {
    calendarCurrentMonth = 11;
    calendarCurrentYear--;
  } else if (calendarCurrentMonth > 11) {
    calendarCurrentMonth = 0;
    calendarCurrentYear++;
  }
  renderCalendar();
};

window.selectCalendarDay = (dateStr) => {
  const startInput = document.getElementById("start_date_val");
  const endInput = document.getElementById("end_date_val");

  if (!tempStartDate || (tempStartDate && tempEndDate)) {
    // Start fresh selection
    tempStartDate = dateStr;
    tempEndDate = null;
    startInput.value = dateStr;
    endInput.value = "";
  } else {
    // Selecting the end date
    if (dateStr === tempStartDate) {
      // Deselect if clicking the same day twice when no end date set
      tempStartDate = null;
      startInput.value = "";
    } else {
      const s = new Date(tempStartDate);
      const e = new Date(dateStr);

      if (e < s) {
        tempEndDate = tempStartDate;
        tempStartDate = dateStr;
      } else {
        tempEndDate = dateStr;
      }

      startInput.value = tempStartDate;
      endInput.value = tempEndDate;
    }
  }

  // Highlight "Custom Date" in sidebar
  const presetItems = document.querySelectorAll(".time_picker_sidebar li[data-date]");
  presetItems.forEach(i => i.classList.remove("active"));
  const customLi = document.querySelector('li[data-date="custom_range"]');
  if (customLi) customLi.classList.add("active");

  renderCalendar();
};

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
    case "last_30days":
      start.setDate(today.getDate() - 29);
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
    case "last_month":
      start.setMonth(today.getMonth() - 1, 1);
      const lastDayPrevMonth = new Date(today.getFullYear(), today.getMonth(), 0).getDate();
      end.setMonth(today.getMonth() - 1, lastDayPrevMonth);
      break;
  }

  // Use local formatter instead of UTC
  const fmt = (d) => formatDateLocal(d);
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
  if (selectedText) selectedText.textContent = "Quick filter"; // Đặt lại text filter bảng về mặc định

  // Gọi các hàm load dữ liệu
  // Nếu có bộ lọc, applyCampaignFilter sẽ tự gọi loadAllDashboardCharts(ids) sau khi load list xong
  if (!CURRENT_CAMPAIGN_FILTER || CURRENT_CAMPAIGN_FILTER.toUpperCase() === "RESET") {
    loadAllDashboardCharts();
  }

  loadCampaignList().finally(() => {
    // 🚩 Nếu đang có bộ lọc thì áp dụng lại để lọc danh sách và cập nhật dashboard
    if (CURRENT_CAMPAIGN_FILTER && CURRENT_CAMPAIGN_FILTER.toUpperCase() !== "RESET") {
      applyCampaignFilter(CURRENT_CAMPAIGN_FILTER);
    }
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

  // ✅ Top 5 cao nhất
  const allEntries = Object.entries(regionSpend).filter(([_, v]) => v > 0);
  allEntries.sort((a, b) => b[1] - a[1]);
  const filtered = allEntries.slice(0, 5);
  if (!filtered.length) return;

  // ✅ Helper rút gọn tên
  const shortenRegion = (name) => {
    let s = name
      .replace(/\b(tỉnh|thành phố|thành phố trực thuộc trung ương|tp\.|tp|province|city|region|state|district|area|zone)\b/gi, "")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .normalize("NFC");
    return s.length > 12 ? s.slice(0, 11) + "…" : s;
  };

  // ✅ Chuẩn hoá label
  const regions = filtered.map(([r]) => shortenRegion(r));
  const fullNames = filtered.map(([r]) =>
    r.replace(/\b\w/g, (c) => c.toUpperCase()).normalize("NFC").trim()
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
            title: (ctx) => fullNames[ctx[0].dataIndex] || ctx[0].label,
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
  // --- 📅 Initialize Date Selector ---
  const defaultRange = getDateRange("last_7days");
  startDate = defaultRange.start;
  endDate = defaultRange.end;
  initDateSelector();

  const previewBtn = document.getElementById("preview_button");

  if (previewBtn) {
    previewBtn.addEventListener("click", () => {
      const header = previewBtn.closest(".dom_detail_header");
      if (header) {
        header.classList.toggle("active");

        // Option: đổi hướng icon cho có vibe animation
        previewBtn.classList.toggle("rotated");
      }
    });
  }
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

      // 👉 Nếu là nút account thì mới fetch
      if (view === "account") {
        fetchAdAccountInfo();
      }

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
      // data-filter="" = Ampersand (all), không undefined
      const filterValue = option.dataset?.filter ?? null;
      const isReset = filterValue === null ? false : filterValue.trim() === "";

      if (!imgEl || !nameEl) return;

      const imgSrc = imgEl.src;
      const name = nameEl.textContent.trim();
      const filter = isReset ? "" : filterValue.trim().toLowerCase();

      // Update UI
      const parentImg = parent.querySelector("img");
      const parentText = parent.querySelector(".dom_selected");
      if (parentImg) parentImg.src = imgSrc;
      if (parentText) parentText.textContent = name;

      parent.classList.remove("active");
      parent.querySelectorAll("li").forEach((li) => li.classList.remove("active"));
      option.classList.add("active");

      // Apply brand/campaign filter
      if (typeof applyCampaignFilter === "function") {
        applyCampaignFilter(isReset ? "RESET" : filter);
      }
    }
  });
});

async function fetchAdAccountInfo() {
  const url = `${BASE_URL}/act_${ACCOUNT_ID}?fields=id,funding_source_details,name,balance,amount_spent,business_name,business_street,business_street2,business_city,business_state,business_zip,business_country_code,tax_id&access_token=${META_TOKEN}`;

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

    // Cập nhật Business Info
    const rawAddressParts = [
      data.business_street,
      data.business_street2,
      data.business_city,
      data.business_state,
      data.business_zip,
      data.business_country_code
    ].filter(p => p && p.trim().length > 0 && p.trim().toLowerCase() !== 'vn' && p.trim().toLowerCase() !== 'vietnam').map(p => p.trim());

    // Deduplicate address parts cleverly (favoring longer strings)
    const uniqueParts = [];
    rawAddressParts.forEach(p => {
      let skip = false;
      for (let i = 0; i < uniqueParts.length; i++) {
        const up = uniqueParts[i];
        if (up.toLowerCase().includes(p.toLowerCase())) {
          skip = true; // Current is shorter or same as existing, skip it
          break;
        }
        if (p.toLowerCase().includes(up.toLowerCase())) {
          uniqueParts[i] = p; // Current is longer, replace existing
          skip = true;
          break;
        }
      }
      if (!skip) uniqueParts.push(p);
    });

    const businessHtml = `
      <div class="business_info_box">
        <p class="b_name"><i class="fa-solid fa-building"></i> ${data.business_name || "N/A"}</p>
        <p class="b_addr"><i class="fa-solid fa-map-marker-alt"></i> ${uniqueParts.join(', ')}</p>
        <p class="b_tax"><i class="fa-solid fa-id-card"></i> Tax ID: ${data.tax_id || "N/A"}</p>
      </div>
    `;
    const businessLi = document.querySelector("#detail_total_report .dom_total_report.balance ul li:nth-child(3)");
    if (businessLi) {
      businessLi.innerHTML = `
        <span class="b_title"><i class="fa-solid fa-circle-info"></i> Business Info</span>
        ${businessHtml}
      `;
    }

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
          case "onsite_conversion.total_messaging_connection":
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
      `${chartLabel}: ${filter === "spend" ? formatMoneyShort(c.raw) : formatNumber(c.raw)
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
                `${chartLabel}: ${filter === "spend"
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
  console.log(actionFilter);

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
      console.log(li);

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
// async function reloadFullData() {
//   const ids = []; // rỗng => full data
//   loadPlatformSummary(ids);
//   loadSpendPlatform(ids);
//   loadAgeGenderSpendChart(ids);
//   loadRegionSpendChart(ids);
//   const dailyData = await fetchDailySpendByCampaignIDs(ids);
//   renderDetailDailyChart2(dailyData, "spend");

//   // render lại chart mục tiêu
//   const allAds = window._ALL_CAMPAIGNS.flatMap((c) =>
//     c.adsets.flatMap((as) =>
//       (as.ads || []).map((ad) => ({
//         optimization_goal: as.optimization_goal,
//         insights: { spend: ad.spend || 0 },
//       }))
//     )
//   );
//   renderGoalChart(allAds);
// }
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

  // ✅ 2. Reset ô search input
  const searchInput = document.getElementById("campaign_filter");
  if (searchInput) searchInput.value = "";
}

// === Reset button inside campaign empty state ===
document.addEventListener("click", (e) => {
  const btn = e.target.closest(".view_campaign_empty .btn_reset_all");
  if (!btn) return;
  if (typeof applyCampaignFilter === "function") {
    applyCampaignFilter("RESET");
  }
});

// === Safe setup for campaign filter UI ===
(function initCampaignFilterSafe() {
  // Guard: ensure DOM exists
  const filterInputC = document.getElementById("campaign_filter");
  const filterBox = document.querySelector(".dom_campaign_filter");
  const filterList = filterBox?.querySelector("ul");
  const filterBtn = document.getElementById("filter_button");

  // If core DOM parts missing, bail out gracefully
  if (!filterInputC || !filterBox || !filterList) {
    console.warn(
      "[campaign-filter] Required DOM elements not found — skipping setup."
    );
    return;
  }

  // Guard: ensure helpers exist (provide no-op fallbacks)
  const safeGetCampaignIcon =
    typeof getCampaignIcon === "function"
      ? getCampaignIcon
      : () => "fa-solid fa-bullseye"; // fallback icon class

  const safeApplyCampaignFilter =
    typeof applyCampaignFilter === "function"
      ? applyCampaignFilter
      : async (k) => {
        console.warn(
          "[campaign-filter] applyCampaignFilter missing. Keyword:",
          k
        );
      };

  const safeDebounce =
    typeof debounce === "function"
      ? debounce
      : (fn, d = 500) => {
        let t;
        return (...a) => {
          clearTimeout(t);
          t = setTimeout(() => fn(...a), d);
        };
      };

  // ✅ Render 1 campaign <li>
  function formatCampaignHTML(c) {
    const thumb = c?.adsets?.[0]?.ads?.[0]?.thumbnail || "";
    const optGoal = c?.adsets?.[0]?.ads?.[0]?.optimization_goal;
    const iconClass = safeGetCampaignIcon(optGoal);
    const isActiveClass = c._isActive ? "active" : "";

    // escape name/id to avoid injection (basic)
    const safeName = String(c?.name ?? "")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    const safeId = String(c?.id ?? "")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

    return `
      <li data-id="${safeId}">
        <p>
          <img src="${thumb}" alt="${safeName}" />
          <span>
            <span>${safeName}</span>
            <span>ID:${safeId}</span>
          </span>
        </p>
        <p>
          <i class="${iconClass} ${isActiveClass}"></i>
          ${optGoal || "Unknown"}
        </p>
      </li>
    `;
  }

  // ✅ Render danh sách hoặc trả "No results"
  function renderFilteredCampaigns(list = []) {
    try {
      if (!Array.isArray(list) || list.length === 0) {
        filterList.innerHTML = `<li style="color:#999;padding:10px;text-align:center;">No results found</li>`;
        filterBox.classList.add("active");
        return;
      }

      filterList.innerHTML = list.map(formatCampaignHTML).join("");
      filterBox.classList.add("active");
    } catch (err) {
      console.error("[campaign-filter] renderFilteredCampaigns error:", err);
    }
  }

  // ✅ Lọc theo _ALL_CAMPAIGNS (safe)
  function filterCampaigns() {
    try {
      const keyword = filterInputC.value.trim().toLowerCase();

      if (!keyword) {
        filterList.innerHTML = "";
        filterBox.classList.remove("active");
        // call RESET only if applyCampaignFilter exists (we use safeApply)
        safeApplyCampaignFilter("RESET");
        return;
      }

      const all = Array.isArray(window._ALL_CAMPAIGNS)
        ? window._ALL_CAMPAIGNS
        : [];
      const filtered = all.filter((c) =>
        String(c?.name || "")
          .toLowerCase()
          .includes(keyword)
      );

      renderFilteredCampaigns(filtered);
    } catch (err) {
      console.error("[campaign-filter] filterCampaigns error:", err);
    }
  }

  // ✅ Debounced search (safe)
  const debouncedSearch = safeDebounce(filterCampaigns, 500);

  // --- Listeners ---
  filterInputC.addEventListener("input", (e) => {
    const keyword = e.target.value.trim();
    if (keyword === "") {
      // immediate reset when input cleared
      filterList.innerHTML = "";
      filterBox.classList.remove("active");
      safeApplyCampaignFilter("RESET");
      return;
    }
    debouncedSearch();
  });

  if (filterBtn) {
    filterBtn.addEventListener("click", filterCampaigns);
  }

  filterInputC.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      // prevent accidental form submit if inside a form
      e.preventDefault();
      filterCampaigns();
    }
  });

  // Click on list item => apply filter by the campaign's name (safe)
  filterList.addEventListener("click", (e) => {
    const li = e.target.closest("li[data-id]");
    if (!li) return;

    const id = li.getAttribute("data-id");
    if (!id) return;

    // find campaign safely
    const all = Array.isArray(window._ALL_CAMPAIGNS)
      ? window._ALL_CAMPAIGNS
      : [];
    const campaign = all.find((c) => String(c?.id) === String(id));
    if (!campaign) {
      console.warn(
        "[campaign-filter] clicked campaign not found in _ALL_CAMPAIGNS:",
        id
      );
      return;
    }

    // UX: close list, set input, and apply filter by campaign name
    try {
      filterBox.classList.remove("active");
      filterList.innerHTML = "";
      filterInputC.value = campaign.name || "";
      safeApplyCampaignFilter(campaign.name || "");
    } catch (err) {
      console.error("[campaign-filter] error on campaign click:", err);
    }
  });

  // Optional: click outside to close
  document.addEventListener("click", (e) => {
    if (!filterBox.contains(e.target)) {
      filterBox.classList.remove("active");
    }
  });

  // Done
  console.debug("[campaign-filter] initialized safely");
})();

async function fetchAdPreview(adId) {
  try {
    if (!adId || !META_TOKEN) throw new Error("Missing adId or token");

    const url = `${BASE_URL}/${adId}/previews?ad_format=DESKTOP_FEED_STANDARD&access_token=${META_TOKEN}`;
    const res = await fetch(url);
    const data = await res.json();

    if (!data || !data.data?.length) {
      console.warn("⚠️ No preview data found for this ad.");
      return null;
    }

    // 📋 Preview HTML (iframe)
    const html = data.data[0].body;
    console.log("✅ Preview HTML:", html);

    const previewBox = document.getElementById("preview_box");
    if (previewBox) {
      previewBox.innerHTML = html; // Meta trả về HTML iframe tự render
    }

    return html;
  } catch (err) {
    console.error("❌ Error fetching ad preview:", err);
    return null;
  }
}

/**
 * ===================================================================
 * HÀM PHÂN TÍCH CHUYÊN SÂU (PHIÊN BẢN NÂNG CẤP)
 * Tập trung vào Phễu, Mâu thuẫn & Cơ hội, thay vì liệt kê Top 3.
 * ===================================================================
 */

/**
 * ===================================================================
 * HÀM PHÂN TÍCH CHUYÊN SÂU (PHIÊN BẢN NÂNG CẤP V2)
 * ===================================================================
 * - Giữ lại Top 3 Spend, Top 3 Result, Top 3 Best CPR.
 * - Loại bỏ hoàn toàn "Worst CPR" (CPR Kém nhất).
 * - Format giờ thành "2h - 3h".
 * - Nâng cấp Insights (Phễu, Creative, Hook, Mâu thuẫn)
 */
async function generateDeepReportDetailed({
  byDate = {},
  byHour = {},
  byAgeGender = {},
  byRegion = {},
  byPlatform = {},
  targeting = {},
  goal = VIEW_GOAL,
} = {}) {
  // -------------------------
  // Helpers (Sử dụng các hàm format toàn cục nếu có)
  // -------------------------
  const safeNumber = (v) =>
    typeof v === "number" && !Number.isNaN(v) ? v : +v || 0;

  const formatMoney = (n) => {
    if (typeof window !== "undefined" && window.formatMoney)
      return window.formatMoney(n);
    try {
      return n === 0
        ? "0đ"
        : n.toLocaleString("vi-VN", {
          style: "currency",
          currency: "VND",
          maximumFractionDigits: 0,
        });
    } catch {
      return `${Math.round(n)}đ`;
    }
  };

  const formatNumber = (n) => {
    if (typeof window !== "undefined" && window.formatNumber)
      return window.formatNumber(n);
    if (n === null || typeof n === "undefined" || Number.isNaN(+n)) return 0;
    return Math.round(n);
  };

  const formatPercent = (n) => `${(safeNumber(n) * 100).toFixed(2)}%`;

  // Hàm getResultsSafe (từ code của bạn, đã tốt)
  const getResultsSafe = (dataSegment) => {
    if (window.getResults)
      return safeNumber(window.getResults(dataSegment, VIEW_GOAL));
    const actions = dataSegment?.actions || {};
    const g = (VIEW_GOAL || goal || "").toUpperCase();
    if (g === "REACH") return safeNumber(dataSegment.reach || 0);
    if (g === "LEAD_GENERATION" || g === "QUALITY_LEAD") {
      const leadKeys = ["onsite_conversion.lead_grouped"];
      let leadSum = 0;
      for (const k of leadKeys) {
        if (actions[k]) leadSum += safeNumber(actions[k]);
      }
      if (leadSum > 0) return leadSum;
    }
    if (g === "REPLIES" || g === "MESSAGE") {
      if (actions["onsite_conversion.total_messaging_connection"])
        return safeNumber(
          actions["onsite_conversion.total_messaging_connection"]
        );
    }
    const preferred = [
      "offsite_conversion.purchase",
      "purchase",
      "onsite_conversion.lead_grouped",
      "onsite_conversion.total_messaging_connection",
      "landing_page_view",
      "link_click",
      "post_engagement",
    ];
    for (const k of preferred) {
      if (actions[k]) return safeNumber(actions[k]);
    }
    return 0;
  };

  const calculateCPR = (spend, result, VIEW_GOAL = "") => {
    spend = safeNumber(spend);
    result = safeNumber(result);
    if (spend <= 0 || result <= 0) return 0;
    if ((VIEW_GOAL || goal).toUpperCase() === "REACH")
      return (spend / result) * 1000;
    return spend / result;
  };

  const formatCPR = (cprValue, VIEW_GOAL = "") => {
    if (!cprValue || cprValue === 0) return "N/A";
    const formatted = formatMoney(Math.round(cprValue));
    return (VIEW_GOAL || goal).toUpperCase() === "REACH"
      ? `${formatted} / 1000 reach`
      : formatted;
  };

  const topN = (arr, keyFn, n = 3, asc = false) => {
    const copy = (arr || []).slice();
    copy.sort((x, y) => {
      const vx = keyFn(x),
        vy = keyFn(y);
      return asc ? vx - vy : vy - vx;
    });
    return copy.slice(0, n);
  };

  // <<< THAY ĐỔI: Hàm format tên/key
  const formatKeyName = (key, type) => {
    if (!key) return "N/A";
    try {
      if (type === "hour") {
        const hour = parseInt((key || "0").split(":")[0], 10);
        if (isNaN(hour)) return key;
        return `${hour}h - ${hour + 1}h`; // Format 2h - 3h
      }
      if (type === "platform" || type === "age_gender") {
        return (key || "")
          .replace(/_/g, " ")
          .replace(/\b\w/g, (c) => c.toUpperCase());
      }
    } catch (e) {
      console.warn("Lỗi format key:", key, e);
      return key; // Trả về key gốc nếu lỗi
    }
    return key; // Default cho Region
  };

  const toArray = (obj) =>
    Object.entries(obj || {}).map(([k, v]) => ({ key: k, ...v }));

  // -------------------------
  // Tính toán Metrics Phễu (Funnel Metrics)
  // -------------------------

  const computeBreakdownMetrics = (keyedObj) => {
    const arr = toArray(keyedObj);
    return arr.map((item) => {
      const spend = safeNumber(item.spend);
      const impressions = safeNumber(item.impressions);
      const reach = safeNumber(item.reach);
      const result = getResults(item);
      const linkClicks = safeNumber(
        item.actions?.link_click || item.actions?.link_clicks || 0
      );
      return {
        key: item.key,
        spend,
        impressions,
        reach,
        result,
        linkClicks,
        cpr: calculateCPR(spend, result, goal),
        cpm: impressions > 0 ? (spend / impressions) * 1000 : 0,
        ctr: impressions > 0 ? linkClicks / impressions : 0, // Tỷ lệ Click
        cvr_proxy: linkClicks > 0 ? result / linkClicks : 0, // Tỷ lệ Chuyển đổi từ Click
      };
    });
  };

  const byDateArr = computeBreakdownMetrics(byDate);
  const byAgeGenderArr = computeBreakdownMetrics(byAgeGender);
  const byRegionArr = computeBreakdownMetrics(byRegion);
  const byPlatformArr = computeBreakdownMetrics(byPlatform);
  const byHourArr = computeBreakdownMetrics(byHour);

  let totalSpend = 0,
    totalImpressions = 0,
    totalReach = 0,
    totalResults = 0,
    totalLinkClicks = 0;
  byDateArr.forEach((d) => {
    totalSpend += d.spend;
    totalImpressions += d.impressions;
    totalReach += d.reach;
    totalResults += d.result;
    totalLinkClicks += d.linkClicks;
  });

  const overallCPR = calculateCPR(totalSpend, totalResults, goal);
  const overallCPM =
    totalImpressions > 0 ? (totalSpend / totalImpressions) * 1000 : 0;
  const overallFreq = totalReach > 0 ? totalImpressions / totalReach : 0;
  const overallCTR =
    totalImpressions > 0 ? totalLinkClicks / totalImpressions : 0;
  const overallCVRProxy =
    totalLinkClicks > 0 ? totalResults / totalLinkClicks : 0;

  const summary = {
    goal: goal || "Not specified",
    totalSpend,
    totalImpressions,
    totalReach,
    totalResults,
    totalLinkClicks,
    overallCPR,
    overallCPM,
    overallFreq,
    overallCTR,
    overallCVRProxy,
    formatted: {
      totalSpend: formatMoney(totalSpend),
      totalResults: formatNumber(totalResults),
      overallCPR: formatCPR(overallCPR, goal),
      overallCPM: formatMoney(Math.round(overallCPM)),
      overallFreq: overallFreq.toFixed(2),
      overallCTR: formatPercent(overallCTR),
      overallCVRProxy: formatPercent(overallCVRProxy),
    },
  };

  // -------------------------
  // TẠO INSIGHTS (Trọng tâm của chuyên gia)
  // -------------------------
  const recommendations = [];

  // 1. Phân tích Phễu (Funnel Analysis) - Nâng cấp theo yêu cầu
  (function analyzeFunnel() {
    const LOW_CTR_THRESHOLD = 0.005; // 0.5%
    const LOW_CVR_THRESHOLD = 0.02; // 2%

    if (totalResults === 0 && totalLinkClicks === 0 && totalImpressions > 0) {
      recommendations.push({
        area: "Creative & Hook",
        reason: `Quảng cáo đã chạy (CPM: ${summary.formatted.overallCPM}) nhưng có **CTR (Tỷ lệ click) cực thấp (${summary.formatted.overallCTR})**.`,
        action: `Đây là dấu hiệu **Creative (Hình ảnh/Video/Copy) không hiệu quả** hoặc **Targeting sai** hoàn toàn. Nội dung "hook" (điểm thu hút) 3 giây đầu tiên đã thất bại. Cần A/B test khẩn cấp creative mới, đặc biệt là hook.`,
      });
    } else if (totalResults === 0 && totalLinkClicks > 0) {
      recommendations.push({
        area: "Landing Page & Offer",
        reason: `Quảng cáo thu hút được người click (CTR: ${summary.formatted.overallCTR}) nhưng **không tạo ra BẤT KỲ kết quả nào (CVR: 0.00%)**.`,
        action: `Vấn đề nghiêm trọng nằm ở *sau khi click*. Kiểm tra ngay: 1. **Alignment**: Lời hứa trên quảng cáo có khớp với nội dung landing page không? 2. **Form Friction**: Form đăng ký có quá dài, khó hiểu, hoặc yêu cầu thông tin nhạy cảm không? 3. **Tốc độ tải trang** (Page Speed).`,
      });
    } else if (overallCTR < LOW_CTR_THRESHOLD) {
      recommendations.push({
        area: "Creative (CTR)",
        reason: `Tỷ lệ Click (CTR) đang ở mức rất thấp (${summary.formatted.overallCTR}).`,
        action: `Creative chưa đủ thu hút. Tập trung cải thiện **Hook** (3 giây đầu video / ảnh chính) và **CTA (Call-to-Action)**. Đảm bảo quảng cáo nổi bật trên newsfeed.`,
      });
    } else if (
      overallCVRProxy < LOW_CVR_THRESHOLD &&
      overallCTR >= LOW_CTR_THRESHOLD
    ) {
      recommendations.push({
        area: "Landing Page (CVR)",
        reason: `CTR ở mức chấp nhận được (${summary.formatted.overallCTR}) nhưng **Tỷ lệ Chuyển đổi (CVR) sau click rất thấp (${summary.formatted.overallCVRProxy})**.`,
        action: `Người dùng quan tâm (click) nhưng không chuyển đổi. Tối ưu **Landing Page**: 1. Tăng tốc độ tải trang. 2. Đảm bảo thông điệp khớp 100% với quảng cáo. 3. Đơn giản hóa Form đăng ký.`,
      });
    } else if (
      overallCTR >= LOW_CTR_THRESHOLD &&
      overallCVRProxy >= LOW_CVR_THRESHOLD
    ) {
      // <<< THAY ĐỔI: Thêm insight "TỐT"
      recommendations.push({
        area: "Funnel Performance",
        reason: `Phễu hoạt động tốt: CTR (${summary.formatted.overallCTR}) và CVR (${summary.formatted.overallCVRProxy}) đều ở mức chấp nhận được.`,
        action: `Tiếp tục theo dõi. Có thể bắt đầu test A/B các creative/offer mới để tìm điểm tối ưu hơn nữa (scale-up).`,
      });
    }
  })();

  // 2. Phân tích Tần suất (Frequency)
  (function analyzeFrequency() {
    if (overallFreq > 2.5) {
      recommendations.push({
        area: "Frequency (Mỏi quảng cáo)",
        reason: `Tần suất trung bình cao (${summary.formatted.overallFreq}). Khách hàng có thể đã thấy quảng cáo này quá nhiều.`,
        action: `Chuẩn bị làm mới creative (nội dung/hình ảnh) để tránh "mỏi quảng cáo". Xem xét loại trừ tệp những người đã tương tác/click nhưng không chuyển đổi.`,
      });
    }
  })();

  // 3. Phân tích Mâu thuẫn Ngân sách (Budget Mismatch)
  (function analyzeBudgetMismatch() {
    if (totalResults === 0) return;
    const topSpendSegment = topN(byAgeGenderArr, (x) => x.spend, 1)[0];
    const bestCprSegment = topN(
      byAgeGenderArr.filter((x) => x.cpr > 0),
      (x) => x.cpr,
      1,
      true
    )[0];

    if (
      topSpendSegment &&
      bestCprSegment &&
      topSpendSegment.key !== bestCprSegment.key
    ) {
      recommendations.push({
        area: "Budget Mismatch (Age/Gender)",
        reason: `Ngân sách đang tập trung nhiều nhất vào nhóm <b>${formatKeyName(
          topSpendSegment.key,
          "age_gender"
        )}</b> (CPR: ${formatCPR(topSpendSegment.cpr, goal)}).`,
        action: `Tuy nhiên, nhóm hiệu quả nhất (CPR rẻ nhất) lại là <b>${formatKeyName(
          bestCprSegment.key,
          "age_gender"
        )}</b> (CPR: ${formatCPR(
          bestCprSegment.cpr,
          goal
        )}). Cân nhắc *chuyển dịch ngân sách* từ nhóm kém hiệu quả sang nhóm hiệu quả nhất.`,
      });
    }
  })();

  // 4. Phân tích Cơ hội Bỏ lỡ (Untapped Opportunity)
  (function analyzeOpportunity() {
    if (totalResults === 0) return;
    const bestCprPlatforms = topN(
      byPlatformArr.filter((x) => x.cpr > 0),
      (x) => x.cpr,
      3,
      true
    );
    const lowSpendOpportunities = bestCprPlatforms.filter(
      (p) => p.spend < totalSpend * 0.1
    );

    if (lowSpendOpportunities.length > 0) {
      const opportunity = lowSpendOpportunities[0];
      recommendations.push({
        area: "Untapped Opportunity (Placement)",
        reason: `Vị trí <b>${formatKeyName(
          opportunity.key,
          "platform"
        )}</b> đang có CPR cực kỳ tốt (${formatCPR(
          opportunity.cpr,
          goal
        )}) nhưng mới chỉ tiêu ${formatMoney(opportunity.spend)}.`,
        action: `Đây là một "mỏ vàng" chưa khai thác. <b>Tạo chiến dịch riêng (CBO) hoặc nhóm quảng cáo riêng</b> chỉ nhắm vào vị trí này và tăng ngân sách cho nó để scale.`,
      });
    }
  })();

  // -------------------------
  // Tạo Sections Data (Giữ lại Best CPR)
  // -------------------------
  const N_TOP = 3; // Đã định nghĩa ở trên
  const sections = [];

  // 1) Timing (Hours)
  (function () {
    const arr = byHourArr;

    if (!arr.length)
      return sections.push({ title: "Timing (Hourly)", note: "No data" });
    const formatList = (list) =>
      list.map((item) => ({ ...item, key: formatKeyName(item.key, "hour") }));
    sections.push({
      title: "Timing (Hourly)",
      topSpend: formatList(topN(arr, (x) => x.spend, N_TOP)),
      topResult: formatList(topN(arr, (x) => x.result, N_TOP)),
      bestCpr: formatList(
        topN(
          arr.filter((x) => x.cpr > 0),
          (x) => x.cpr,
          N_TOP,
          true
        )
      ),
    });
  })();

  // 2) Age & Gender
  (function () {
    const arr = byAgeGenderArr;
    if (!arr.length)
      return sections.push({ title: "Age & Gender", note: "No data" });
    const formatList = (list) =>
      list.map((item) => ({
        ...item,
        key: formatKeyName(item.key, "age_gender"),
      }));
    sections.push({
      title: "Age & Gender",
      topSpend: formatList(topN(arr, (x) => x.spend, N_TOP)),
      topResult: formatList(topN(arr, (x) => x.result, N_TOP)), // <<< THÊM Top Result
      bestCpr: formatList(
        topN(
          arr.filter((x) => x.cpr > 0),
          (x) => x.cpr,
          N_TOP,
          true
        )
      ),
    });
  })();

  // 3) Region
  (function () {
    const arr = byRegionArr;
    if (!arr.length) return sections.push({ title: "Region", note: "No data" });
    sections.push({
      title: "Region",
      topSpend: topN(arr, (x) => x.spend, N_TOP),
      topResult: topN(arr, (x) => x.result, N_TOP), // <<< THÊM Top Result
      bestCpr: topN(
        arr.filter((x) => x.cpr > 0),
        (x) => x.cpr,
        N_TOP,
        true
      ),
    });
  })();

  // 4) Platform & Placement
  (function () {
    const arr = byPlatformArr;
    if (!arr.length)
      return sections.push({ title: "Platform & Placement", note: "No data" });
    const formatList = (list) =>
      list.map((item) => ({
        ...item,
        key: formatKeyName(item.key, "platform"),
      }));
    sections.push({
      title: "Platform & Placement",
      topSpend: formatList(topN(arr, (x) => x.spend, N_TOP)),
      topResult: formatList(topN(arr, (x) => x.result, N_TOP)), // <<< THÊM Top Result
      bestCpr: formatList(
        topN(
          arr.filter((x) => x.cpr > 0),
          (x) => x.cpr,
          N_TOP,
          true
        )
      ),
    });
  })();

  // 5) Device
  // (function () {
  //   const arr = byDeviceArr;
  //   if (!arr.length) return sections.push({ title: "Device", note: "No data" });
  //   sections.push({
  //     title: "Device",
  //     topSpend: topN(arr, (x) => x.spend, N_TOP),
  //     topResult: topN(arr, (x) => x.result, N_TOP), // <<< THÊM Top Result
  //     bestCpr: topN(
  //       arr.filter((x) => x.cpr > 0),
  //       (x) => x.cpr,
  //       N_TOP,
  //       true
  //     ),
  //   });
  // })();

  // 6) Creative (Section rỗng, chỉ có insight)
  sections.push({
    title: "Creative & Frequency",
    note: "Phân tích đã được gộp trong phần Đề xuất.",
  });

  // -------------------------
  // Trả về Report Object (ĐÃ CẬP NHẬT)
  // -------------------------
  const reportObject = {
    generatedAt: new Date().toISOString(),
    summary,
    recommendations, // Chỉ trả về insight
    sections, // <<< THAY ĐỔI: Trả về sections (chứa Top 3)
  };

  // Log ra console (Đã cập nhật)
  console.table([
    {
      Spend: summary.formatted.totalSpend,
      Results: summary.formatted.totalResults,
      CPR: summary.formatted.overallCPR,
      CPM: summary.formatted.overallCPM,
      CTR: summary.formatted.overallCTR,
      CVR_Click: summary.formatted.overallCVRProxy,
      Freq: summary.formatted.overallFreq,
    },
  ]);

  sections.forEach((sec) => {
    console.groupCollapsed(`🔹 ${sec.title}`);
    if (sec.note) {
      console.log(sec.note);
    } else {
      if (sec.topSpend) {
        console.log("Top 3 Chi tiêu (Spend):");
        console.table(
          sec.topSpend.map((s) => ({
            Key: s.key,
            Spend: formatMoney(s.spend),
            Results: s.result,
            CPR: formatCPR(s.cpr, goal),
          }))
        );
      }
      if (sec.topResult) {
        console.log("Top 3 Kết quả (Result):");
        console.table(
          sec.topResult.map((s) => ({
            Key: s.key,
            Spend: formatMoney(s.spend),
            Results: s.result,
            CPR: formatCPR(s.cpr, goal),
          }))
        );
      }
      if (sec.bestCpr) {
        console.log("Top 3 CPR Tốt nhất (Best CPR):");
        console.table(
          sec.bestCpr.map((s) => ({
            Key: s.key,
            Spend: formatMoney(s.spend),
            Results: s.result,
            CPR: formatCPR(s.cpr, goal),
          }))
        );
      }
      // Đã bỏ worstCpr
    }
    console.groupEnd();
  });

  console.group("✅ Recommendations");
  if (recommendations.length === 0) {
    console.log("Hiệu suất ổn định, chưa có đề xuất rõ ràng.");
  } else {
    recommendations.forEach((r, idx) => {
      console.log(`${idx + 1}. [${r.area}] ${r.reason}`);
      console.log(`   → Đề xuất: ${r.action}`);
    });
  }
  console.groupEnd();
  console.groupEnd();

  return reportObject;
}

async function runDeepReport() {
  const report = await generateDeepReportDetailed({
    meta: window.campaignSummaryData,
    byDate: window.dataByDate,
    byHour: window.processedByHour,
    byAgeGender: window.processedByAgeGender,
    byRegion: window.processedByRegion,
    byPlatform: window.processedByPlatform,
    byDevice: window.processedByDevice,
    targeting: window.targetingData,
    goal: VIEW_GOAL,
  });
  renderAdReportWithVibe(report);
}
/**
 * ===================================================================
 * HÀM RENDER CHÍNH
 * Render dữ liệu JSON báo cáo quảng cáo theo "vibe" của VTCI.
 * ===================================================================
 */

// Đảm bảo bạn đã có 2 hàm này ở đâu đó
// const formatMoney = (v) => v != null && !isNaN(v) ? Math.round(v).toLocaleString("vi-VN") + "đ" : "0đ";
// const formatNumber = (v) => v != null && !isNaN(v) ? Math.round(v).toLocaleString("vi-VN") : "0";

/**
 * Render báo cáo vào UI.
 * @param {object} rawReportData - Đối tượng JSON thô bạn đã cung cấp.
 */
/**
 * ===================================================================
 * HÀM RENDER UI (PHIÊN BẢN NÂNG CẤP V2)
 * ===================================================================
 */

/**
 * Render báo cáo vào UI.
 * @param {object} report - Đối tượng report đã được generate.
 */
function renderAdReportWithVibe(report) {
  console.log("Rendering Ad Report (V2)...", report);
  const container = document.querySelector(".dom_ai_report_content");
  if (!container) {
    console.error("Không tìm thấy container .dom_ai_report_content");
    return;
  }

  const adNameEl = document.querySelector(".dom_detail_id > span:first-child");
  const adName = adNameEl ? adNameEl.textContent.trim() : "Quảng cáo";

  const { summary, recommendations, sections, generatedAt } = report;

  const html = [];
  let delay = 1;

  // --- Bắt đầu khối báo cáo ---
  html.push('<div class="ai_report_block ads">');
  html.push(
    `<h4><i class="fa-solid fa-magnifying-glass-chart"></i> Phân tích: ${adName}</h4>`
  );
  html.push('<div class="ai_report_inner"><section class="ai_section">');

  // --- 1. Phần Tóm tắt Phễu (Funnel KPI Grid) ---
  html.push(createKpiGrid(summary, delay));
  delay += 2;

  // --- 2. Phần Insights & Đề xuất ---
  html.push(createInsightList(recommendations, delay));
  delay += 2;

  // --- 3. Phần Breakdown (Sections) ---
  if (sections) {
    for (const section of sections) {
      // Bỏ qua section "Creative" vì nó chỉ có insight (đã hiển thị ở trên)
      if (section.title.includes("Creative")) {
        continue;
      }

      let type = "default";
      if (section.title.includes("Timing")) type = "hour";
      else if (section.title.includes("Age & Gender")) type = "age";
      else if (section.title.includes("Region")) type = "region";
      else if (section.title.includes("Platform")) type = "platform";
      else if (section.title.includes("Device")) type = "device";

      // <<< THAY ĐỔI: Gọi hàm render breakdown MỚI
      html.push(createBreakdownSection(section, type, delay));
      delay += 4; // Tăng delay cho mỗi section
    }
  }

  // --- Kết thúc khối báo cáo ---
  html.push("</section></div>");
  html.push(
    `<small class="timestamp">Generated: ${new Date(generatedAt).toLocaleString(
      "vi-VN"
    )}</small>`
  );
  html.push("</div>");

  container.innerHTML = html.join("");

  // Kích hoạt animation
  setTimeout(() => {
    container
      .querySelectorAll(".fade_in_item")
      .forEach((el, i) => setTimeout(() => el.classList.add("show"), i * 200));
  }, 3000);
}

/**
 * Tạo lưới KPI tóm tắt (Đã cập nhật)
 */

/**
 * Tạo danh sách Insights/Đề xuất.
 */
function createInsightList(recommendations, delayStart = 1) {
  let listItems =
    '<li><i class="fa-solid fa-check-circle" style="color:#28a745;"></i> <strong>[TỔNG QUAN]</strong> Hiệu suất ổn định, chưa phát hiện vấn đề nghiêm trọng.</li>';

  if (recommendations && recommendations.length > 0) {
    listItems = recommendations
      .map((rec) => {
        let icon = "fa-solid fa-lightbulb";
        let color = "#ffc107"; // Vàng
        if (
          rec.area.includes("Mismatch") ||
          rec.reason.includes("thấp") ||
          rec.reason.includes("cao") ||
          rec.area.includes("Creative")
        ) {
          icon = "fa-solid fa-triangle-exclamation";
          color = "#e17055"; // Đỏ cam
        } else if (
          rec.area.includes("Opportunity") ||
          rec.reason.includes("tốt nhất")
        ) {
          icon = "fa-solid fa-wand-magic-sparkles";
          color = "#007bff"; // Xanh dương
        } else if (rec.area.includes("Funnel Performance")) {
          icon = "fa-solid fa-check-circle";
          color = "#28a745"; // Xanh lá
        }

        return `<li><i class="${icon}" style="color:${color};"></i> <strong>[${rec.area
          }]</strong> ${rec.reason
          }<br><span class="recommendation-action">→ Đề xuất: ${rec.action || ""
          }</span></li>`;
      })
      .join("");
  }

  return `
        <h5 class="fade_in_item delay-${delayStart}"><i class="fa-solid fa-user-check"></i> Đề xuất từ Chuyên gia</h5>
        <ul class="insight_list fade_in_item delay-${delayStart + 1}">
            ${listItems}
        </ul>
    `;
}

/**
 * <<< THAY ĐỔI: Hàm tạo section breakdown MỚI
 * Tạo một section breakdown đầy đủ (Tiêu đề + 3 bảng).
 */
function createBreakdownSection(section, type, delayStart = 1) {
  if (!section || section.note === "No data") {
    return ""; // Bỏ qua nếu section không có data
  }

  const icon = getIconForType(type);
  const hasResults =
    (section.topResult && section.topResult.length > 0) ||
    (section.bestCpr && section.bestCpr.length > 0);

  return `
        <h5 class="fade_in_item delay-${delayStart}"><i class="${icon}"></i> Phân tích ${section.title
    }</h5>
        
        <div class="fade_in_item delay-${delayStart + 1}">
            <h6>Top 3 Chi tiêu (Spend)</h6>
            ${createBreakdownTable(section.topSpend, type)}
        </div>
        
        ${hasResults
      ? `
            <div class="fade_in_item delay-${delayStart + 2}">
                <h6>Top 3 Kết quả (Result)</h6>
                ${createBreakdownTable(section.topResult, type)}
            </div>
            
            <div class="fade_in_item delay-${delayStart + 3}">
                <h6>Top 3 CPR Tốt nhất (Best CPR)</h6>
                ${createBreakdownTable(section.bestCpr, type)}
            </div>
        `
      : `
            <div class="fade_in_item delay-${delayStart + 2}">
                <p class="no-result-note"><i class="fa-solid fa-info-circle"></i> Không có dữ liệu Kết quả (Result) để phân tích CPR cho mục này.</p>
            </div>
        `
    }
    `;
}

/**
 * Tạo HTML cho một bảng 'mini_table'.
 */
function createBreakdownTable(dataArray, type) {
  if (!dataArray || dataArray.length === 0)
    return '<p class="no-result-note" style="margin-left: 0;">Không có dữ liệu.</p>';

  // Dùng hàm formatMoney và formatNumber (đảm bảo chúng tồn tại)
  const formatMoneySafe = (n) =>
    window.formatMoney ? window.formatMoney(n) : `${Math.round(n || 0)}đ`;
  const formatNumberSafe = (n) =>
    window.formatNumber ? window.formatNumber(n) : Math.round(n || 0);
  const formatCPRSafe = (n, goal) =>
    window.formatCPR
      ? window.formatCPR(n, goal)
      : n > 0
        ? formatMoneySafe(n)
        : "N/A";

  const rows = dataArray
    .map(
      (item) => `
        <tr>
            <td>${item.key}</td> <td>${formatMoneySafe(item.spend)}</td>
            <td>${formatNumberSafe(item.result)}</td>
            <td>${formatCPRSafe(item.cpr, item.goal)}</td>
            <td>${formatMoneySafe(item.cpm)}</td>
        </tr>
    `
    )
    .join("");

  return `
        <table class="mini_table">
            <thead>
                <tr>
                    <th>Phân khúc</th>
                    <th>Chi phí</th>
                    <th>Kết quả</th>
                    <th>CPR</th>
                    <th>CPM</th>
                </tr>
            </thead>
            <tbody>
                ${rows}
            </tbody>
        </table>
    `;
}

/**
 * Helper lấy icon Font Awesome dựa trên loại breakdown.
 */
function getIconForType(type) {
  switch (type) {
    case "hour":
      return "fa-solid fa-clock";
    case "age":
      return "fa-solid fa-users";
    case "region":
      return "fa-solid fa-map-location-dot";
    case "platform":
      return "fa-solid fa-laptop-device";
    case "device":
      return "fa-solid fa-mobile-screen-button";
    default:
      return "fa-solid fa-chart-bar";
  }
}

/**
 * Tạo lưới KPI tóm tắt (Đã cập nhật
 */
function createKpiGrid(summary, delayStart = 1) {
  if (!summary || !summary.formatted) return "";
  const { formatted, goal } = summary;

  // Thêm CTR và CVR vào lưới KPI
  return `
    <h5 class="fade_in_item delay-${delayStart}"><i class="fa-solid fa-chart-pie"></i> Tóm tắt Phễu Hiệu suất</h5>
    <div class="ai_kpi_grid fade_in_item delay-${delayStart + 1}">
        <div class="kpi_item">
            <span>Tổng chi phí</span>
            <b>${formatted.totalSpend || "N/A"}</b>
        </div>
        <div class="kpi_item">
            <span>Tổng kết quả</span>
            <b>${formatted.totalResults || "N/A"} (${goal || "N/A"})</b>
        </div>
        <div class="kpi_item">
            <span>CPR (Chi phí/Kết quả)</span>
            <b>${formatted.overallCPR || "N/A"}</b>
        </div>
        <div class="kpi_item">
            <span>CPM (Chi phí/1000 Lượt xem)</span>
            <b>${formatted.overallCPM || "N/A"}</b>
        </div>
        <div class="kpi_item">
            <span>CTR (Tỷ lệ Click)</span>
            <b class="${summary.overallCTR < 0.005 ? "metric-bad" : "metric-good"
    }">${formatted.overallCTR || "N/A"}</b>
        </div>
        <div class="kpi_item">
            <span>CVR (Click -> Kết quả)</span>
             <b class="${summary.overallCVRProxy < 0.02 ? "metric-bad" : "metric-good"
    }">${formatted.overallCVRProxy || "N/A"}</b>
        </div>
        <div class="kpi_item">
            <span>Tiếp cận (Reach)</span>
            <b>${summary.totalReach || "N/A"}</b>
        </div>
        <div class="kpi_item">
            <span>Tần suất (Freq)</span>
            <b>${formatted.overallFreq || "N/A"}</b>
        </div>
    </div>
  `;
}

/**
 * Tạo danh sách Insights/Đề xuất.
 */
function createInsightList(recommendations, delayStart = 1) {
  let listItems =
    '<li><i class="fa-solid fa-check-circle" style="color:#28a745;"></i> <strong>[TỔNG QUAN]</strong> Hiệu suất ổn định, chưa phát hiện vấn đề nghiêm trọng.</li>';

  if (recommendations && recommendations.length > 0) {
    listItems = recommendations
      .map((rec) => {
        // Xác định icon và màu
        let icon = "fa-solid fa-lightbulb"; // Insight (Vàng)
        let color = "#ffc107";
        if (
          rec.area.includes("Mismatch") ||
          rec.reason.includes("thấp") ||
          rec.reason.includes("cao")
        ) {
          icon = "fa-solid fa-triangle-exclamation"; // Vấn đề (Đỏ cam)
          color = "#e17055";
        } else if (
          rec.area.includes("Opportunity") ||
          rec.reason.includes("tốt nhất")
        ) {
          icon = "fa-solid fa-wand-magic-sparkles"; // Cơ hội (Xanh dương)
          color = "#007bff";
        }

        return `<li><i class="${icon}" style="color:${color};"></i> <strong>[${rec.area
          }]</strong> ${rec.reason
          }<br><span class="recommendation-action">→ Đề xuất: ${rec.action || ""
          }</span></li>`;
      })
      .join("");
  }

  return `
    <h5 class="fade_in_item delay-${delayStart}"><i class="fa-solid fa-user-check"></i> Đề xuất từ Chuyên gia</h5>
    <ul class="insight_list fade_in_item delay-${delayStart + 1}">
        ${listItems}
    </ul>
  `;
}
/**
 * ===================================================================
 * CÁC HÀM HELPER CHO VIỆC RENDER
 * ===================================================================
 */

/**
 * Tạo lưới KPI tóm tắt.
 * @param {object} summary - Object summary từ JSON.
 * @param {number} delayStart - Số delay bắt đầu cho animation.
 */

/**
 * Tạo danh sách Insights/Đề xuất.
 * @param {Array} recommendations - Mảng recommendations từ JSON.
 * @param {number} delayStart - Số delay bắt đầu cho animation.
 */
function createInsightList(recommendations, delayStart = 1) {
  let listItems = "<li>Không có đề xuất nổi bật.</li>"; // Mặc định

  if (recommendations && recommendations.length > 0) {
    listItems = recommendations
      .map((rec) => {
        // Xác định icon và màu dựa trên reason/area
        let icon = "fa-solid fa-lightbulb";
        let color = "#007bff"; // Màu xanh dương mặc định
        if (rec.reason.includes("thấp")) {
          icon = "fa-solid fa-triangle-exclamation";
          color = "#e17055"; // Màu đỏ cam
        }

        return `<li><i class="${icon}" style="color:${color}"></i> <b>[${rec.area
          }]</b> ${rec.reason} ${rec.action || ""}</li>`;
      })
      .join("");
  }

  return `
      <h5 class="fade_in_item delay-${delayStart}"><i class="fa-solid fa-lightbulb"></i> Insights & Đề xuất</h5>
      <ul class="insight_list fade_in_item delay-${delayStart + 1}">
          ${listItems}
      </ul>
  `;
}

function createBreakdownSection(section, type, delayStart = 1) {
  if (!section || section.note === "No data") {
    return ""; // Bỏ qua nếu section không có data
  }

  const icon = getIconForType(type); // Lấy icon dựa trên loại

  // Dữ liệu JSON có result=0 và cpr=0 ở mọi nơi.
  // Nếu không có kết quả, bảng 'Best CPR' và 'Worst CPR' sẽ giống hệt nhau
  // và không có ý nghĩa. Chúng ta sẽ chỉ hiển thị 'Top Spend' trong trường hợp này.
  const hasResults = parseFloat(section.topSpend[0]?.result || 0) > 0; // Kiểm tra xem có kết quả nào không

  return `
      <h5 class="fade_in_item delay-${delayStart}"><i class="${icon}"></i> Phân tích ${section.title
    }</h5>
      
      <div class="fade_in_item delay-${delayStart + 1}">
          <h6>Top chi tiêu (Spend)</h6>
          ${createBreakdownTable(section.topSpend, type)}
      </div>
      
      ${hasResults
      ? `
          <div class="fade_in_item delay-${delayStart + 2}">
              <h6>Top CPR Tốt nhất (Best CPR)</h6>
              ${createBreakdownTable(section.bestCpr, type)}
          </div>
         
      `
      : `
          <div class="fade_in_item delay-${delayStart + 2}">
              <p class="no-result-note"><i class="fa-solid fa-info-circle"></i> Không có dữ liệu Kết quả (Result) để phân tích CPR cho mục này.</p>
          </div>
      `
    }
  `;
}

/**
 * Tạo HTML cho một bảng 'mini_table'.
 * @param {Array} dataArray - Mảng dữ liệu (ví dụ: section.topSpend).
 * @param {string} type - 'hour', 'age', 'region', 'platform'.
 */
function createBreakdownTable(dataArray, type) {
  if (!dataArray || dataArray.length === 0) return "<p>Không có dữ liệu.</p>";

  const rows = dataArray
    .map(
      (item) => `
      <tr>
          <td>${formatKeyName(item.key, type)}</td>
          <td>${formatMoney(item.spend)}</td>
          <td>${formatNumber(item.result)}</td>
          <td>${item.cpr === 0 ? "N/A" : formatMoney(item.cpr)}</td>
          <td>${formatMoney(item.cpm)}</td>
      </tr>
  `
    )
    .join("");

  return `
      <table class="mini_table">
          <thead>
              <tr>
                  <th>Phân khúc</th>
                  <th>Chi phí</th>
                  <th>Kết quả</th>
                  <th>CPR</th>
                  <th>CPM</th>
              </tr>
          </thead>
          <tbody>
              ${rows}
          </tbody>
      </table>
  `;
}

/**
 * Helper lấy icon Font Awesome dựa trên loại breakdown.
 */
function getIconForType(type) {
  switch (type) {
    case "hour":
      return "fa-solid fa-clock";
    case "age":
      return "fa-solid fa-users";
    case "region":
      return "fa-solid fa-map-location-dot";
    case "platform":
      return "fa-solid fa-laptop-device";
    default:
      return "fa-solid fa-chart-bar";
  }
}

/**
 * Helper làm đẹp tên (key) của breakdown.
 */
function formatKeyName(key, type) {
  if (!key) return "N/A";
  return key
    .replace(/_/g, " ")
    .replace(
      /\b(facebook|instagram)\b/gi,
      (match) => match.charAt(0).toUpperCase() + match.slice(1)
    ) // Viết hoa Facebook, Instagram
    .replace("unknown", "Không xác định");
}

function setupAIReportModal() {
  // 1. Tìm các phần tử DOM cần thiết
  const openButton = document.querySelector(".ai_report_compare");
  const reportContainer = document.querySelector(".dom_ai_report");
  const closeButton = reportContainer.querySelector(".dom_ai_report_close");
  const reportTitle = reportContainer.querySelector("h3");

  // 2. Kiểm tra xem các phần tử có tồn tại không
  if (!openButton || !reportContainer || !closeButton || !reportTitle) {
    console.warn(
      "Không tìm thấy các phần tử AI Report (nút mở, container, nút đóng hoặc tiêu đề)."
    );
    return;
  }

  // 3. Gán sự kiện Click cho nút MỞ report
  openButton.addEventListener("click", (e) => {
    e.preventDefault(); // Ngăn hành vi mặc định (nếu là thẻ <a>)

    // Lấy ngày tháng từ .dom_date
    const dateEl = document.querySelector(".dom_date");
    const dateText = dateEl ? dateEl.textContent.trim() : "N/A";

    // Cập nhật tiêu đề
    reportTitle.innerHTML = `
    
    <p><img src="https://dev-trongphuc.github.io/DOM_MISA_IDEAS_CRM/logotarget.png">
      <span>DOM AI REPORT </span></p>
    <p class="report_time">${dateText}</p>
   `;

    // Hiển thị modal
    reportContainer.classList.add("active");

    // Gọi hàm chạy phân tích
    if (typeof runDeepReport === "function") {
      runDeepReport(); // Gọi hàm của bạn
    } else {
      console.error("Hàm runDeepReport() không được định nghĩa.");
      // Hiển thị lỗi trên UI nếu cần
      const contentEl = reportContainer.querySelector(".dom_ai_report_content");
      if (contentEl) {
        contentEl.innerHTML =
          '<p style="color:red; padding: 20px;">Lỗi: Không tìm thấy hàm runDeepReport().</p>';
      }
    }
  });

  // 4. Gán sự kiện Click cho nút ĐÓNG report
  closeButton.addEventListener("click", () => {
    reportContainer.classList.remove("active");

    // Tùy chọn: Xóa nội dung report cũ khi đóng
    const contentEl = reportContainer.querySelector(".dom_ai_report_content");
    if (contentEl) {
      contentEl.innerHTML = ""; // Xóa nội dung để lần sau load lại
    }
  });
}

/**
 * 📊 Export ads data to CSV
 * Báo cáo nghiệm thu chi tiết ads theo thời gian đang xem
 */
function exportAdsToCSV() {
  const data = window._ALL_CAMPAIGNS;
  if (!data || !Array.isArray(data) || data.length === 0) {
    alert("Không có dữ liệu để xuất!");
    return;
  }

  // 1. Định nghĩa headers
  const headers = [
    "Time Range",
    "Campaign ID",
    "Campaign Name",
    "Adset ID",
    "Adset Name",
    "Ad ID",
    "Ad Name",
    "Status",
    "Goal",
    "Spent (VND)",
    "Results",
    "Cost per Result",
    "Impressions",
    "Reach",
    "Frequency",
    "CPM",
    "Link Clicks",
    "Messages",
    "Leads"
  ];

  // 2. Chuyển đổi data sang rows
  const rows = [];
  const timeRange = `${startDate} - ${endDate}`;

  data.forEach((campaign) => {
    const adsets = campaign.adsets || [];
    adsets.forEach((adset) => {
      const ads = adset.ads || [];
      ads.forEach((ad) => {
        const frequency = ad.reach > 0 ? (ad.impressions / ad.reach).toFixed(2) : "0";
        const cpm = ad.impressions > 0 ? ((ad.spend / ad.impressions) * 1000).toFixed(0) : "0";
        const cpr = ad.result > 0 ? (ad.spend / ad.result).toFixed(0) : "0";

        rows.push([
          timeRange,
          campaign.id,
          campaign.name,
          adset.id,
          adset.name,
          ad.id,
          ad.name,
          ad.status,
          ad.optimization_goal || "Unknown",
          ad.spend.toFixed(0),
          ad.result || 0,
          cpr,
          ad.impressions || 0,
          ad.reach || 0,
          frequency,
          cpm,
          ad.link_clicks || 0,
          ad.message || 0,
          ad.lead || 0
        ]);
      });
    });
  });

  // 3. Tạo nội dung CSV (Dùng BOM để Excel hiển thị đúng tiếng Việt UTF-8)
  let csvContent = "\uFEFF";
  csvContent += headers.map(h => `"${h}"`).join(",") + "\r\n";

  rows.forEach((row) => {
    const rowString = row.map(val => {
      const str = String(val).replace(/"/g, '""'); // Escape double quotes
      return `"${str}"`;
    }).join(",");
    csvContent += rowString + "\r\n";
  });

  // 4. Tạo download link và click tự động
  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.setAttribute("href", url);
  link.setAttribute("download", `Meta_Ads_Report_${startDate}_${endDate}.csv`);
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}


