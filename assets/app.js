(() => {
  const profiles = window.DS2_MAP_PROFILES || {};
  const profileIds = Object.keys(profiles);

  if (!profileIds.length) {
    console.error("No map profiles found.");
    return;
  }

  const refs = {
    mapSwitch: document.getElementById("mapSwitch"),
    categoryWrap: document.getElementById("categoryWrap"),
    showAllBtn: document.getElementById("showAllBtn"),
    hideAllBtn: document.getElementById("hideAllBtn"),
    toggleLabelBtn: document.getElementById("toggleLabelBtn"),
    exportSelectedBtn: document.getElementById("exportSelectedBtn"),
    searchInput: document.getElementById("searchInput"),
    searchResult: document.getElementById("searchResult"),
    sidebar: document.getElementById("sidebar"),
    mobileToggle: document.getElementById("mobileToggle"),
    themeToggle: document.getElementById("themeToggle"),
  };

  const state = {
    map: null,
    tileLayer: null,
    currentProfileId: "",
    currentProfile: null,
    categories: new Map(),
    pointsIndex: [],
    searchMatches: [],
    showLabels: true,
    theme: "light",
    themeSwitchTimer: null,
    exportingIcons: false,
    enrichedProfiles: new Map(),
    markerByPointKey: new Map(),
    completedPointKeys: new Set(),
    switchRequestToken: 0,
  };

  const THEME_STORAGE_KEY = "ds2map_theme_mode_v4";
  const COMPLETED_POINTS_STORAGE_KEY = "ds2map_completed_points_v1";
  const EXPORT_BUTTON_LABEL = "导出当前地图";
  const EXPORT_LOCALHOST_HINT =
    "若要使用“导出当前标记地图”，请勿直接打开 HTML 文件，请通过 localhost（本地服务器）访问当前页面后再重试。";
  const REMOTE_API_BASE = "https://mapapi.gamersky.com";
  const REMOTE_MAP_ID_BY_PROFILE_ID = {
    mexico: 108,
    australia: 109,
  };
  const remoteProfilePromises = new Map();

  const MAP_NAME_FALLBACK = {
    mexico: "墨西哥",
    australia: "澳大利亚",
  };

  function getMapDisplayName(id, profile) {
    if (MAP_NAME_FALLBACK[id]) {
      return MAP_NAME_FALLBACK[id];
    }
    const raw = String((profile && profile.name) || "").trim();
    if (raw && !/^\?+$/.test(raw)) {
      return raw;
    }
    return MAP_NAME_FALLBACK[id] || id;
  }

  function cloneProfile(profile) {
    if (typeof structuredClone === "function") {
      return structuredClone(profile);
    }
    return JSON.parse(JSON.stringify(profile));
  }

  function decodeHtmlEntities(text) {
    const textarea = document.createElement("textarea");
    textarea.innerHTML = String(text || "");
    return textarea.value;
  }

  function normalizeDescription(raw) {
    const text = String(raw || "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/div>/gi, "\n")
      .replace(/<div[^>]*>/gi, "")
      .replace(/<\/p>/gi, "\n")
      .replace(/<p[^>]*>/gi, "")
      .replace(/&nbsp;/gi, " ")
      .replace(/<[^>]+>/g, "");
    return decodeHtmlEntities(text).replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  function descriptionToHtml(text) {
    const safe = escapeHtml(text || "暂无介绍");
    return safe.replace(/\n/g, "<br>");
  }

  function normalizePointTitle(text) {
    return String(text || "")
      .trim()
      .replace(/\s+/g, "")
      .replace(/[()（）[\]【】]/g, "")
      .toLowerCase();
  }

  function getPointStorageKey(profileId, categoryKey, point) {
    if (point && point.remoteLandmarkId) {
      return `${profileId}:remote:${point.remoteLandmarkId}`;
    }
    return `${profileId}:${categoryKey}:${point && point.id ? point.id : "point"}`;
  }

  function loadCompletedPointKeys() {
    try {
      const raw = localStorage.getItem(COMPLETED_POINTS_STORAGE_KEY);
      if (!raw) {
        return;
      }
      const list = JSON.parse(raw);
      if (Array.isArray(list)) {
        state.completedPointKeys = new Set(list.filter((item) => typeof item === "string"));
      }
    } catch {
      state.completedPointKeys = new Set();
    }
  }

  function saveCompletedPointKeys() {
    try {
      localStorage.setItem(COMPLETED_POINTS_STORAGE_KEY, JSON.stringify(Array.from(state.completedPointKeys)));
    } catch {
      // Ignore storage failures in restricted environments.
    }
  }

  function isPointCompleted(pointKey) {
    return state.completedPointKeys.has(pointKey);
  }

  function togglePointCompleted(pointKey) {
    if (!pointKey) {
      return false;
    }
    if (state.completedPointKeys.has(pointKey)) {
      state.completedPointKeys.delete(pointKey);
    } else {
      state.completedPointKeys.add(pointKey);
    }
    saveCompletedPointKeys();
    return state.completedPointKeys.has(pointKey);
  }

  function syncMarkerCompletedState(marker) {
    const element = marker && marker.getElement ? marker.getElement() : null;
    if (!element) {
      return;
    }
    element.classList.toggle("is-completed", isPointCompleted(marker.__pointKey));
  }

  async function copyText(text) {
    const value = String(text || "").trim();
    if (!value) {
      return false;
    }
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(value);
        return true;
      }
    } catch {
      // Ignore clipboard API failures and fall back below.
    }

    const input = document.createElement("textarea");
    input.value = value;
    input.setAttribute("readonly", "");
    input.style.position = "fixed";
    input.style.opacity = "0";
    document.body.appendChild(input);
    input.select();
    const copied = document.execCommand("copy");
    input.remove();
    return copied;
  }

  function getPointCopyText(marker) {
    const point = marker && marker.__pointData ? marker.__pointData : null;
    const meta = marker && marker.__popupMeta ? marker.__popupMeta : null;
    const lines = [point && point.title ? point.title : ""];
    if (meta && meta.groupTitle && meta.categoryTitle) {
      lines.push(`${meta.groupTitle} / ${meta.categoryTitle}`);
    }
    return lines.filter(Boolean).join("\n");
  }

  function buildPointPopupContent(marker) {
    const point = marker && marker.__pointData ? marker.__pointData : null;
    const meta = marker && marker.__popupMeta ? marker.__popupMeta : null;
    const title = point && point.title ? point.title : "未命名点位";
    const description = normalizeDescription(point && point.description);
    const pointKey = marker && marker.__pointKey ? marker.__pointKey : "";
    const completed = isPointCompleted(pointKey);
    const categoryTitle = meta && meta.categoryTitle ? meta.categoryTitle : "";
    const groupTitle = meta && meta.groupTitle ? meta.groupTitle : "";
    const detailLine = [groupTitle, categoryTitle].filter(Boolean).join(" / ");

    return `
      <div class="point-popup" data-point-key="${escapeHtml(pointKey)}">
        <div class="point-popup__head">
          <div class="point-popup__title-wrap">
            <span class="point-popup__title">${escapeHtml(title)}</span>
            ${meta && meta.icon ? `<img class="point-popup__title-icon" src="${escapeHtml(meta.icon)}" alt="">` : ""}
          </div>
          <div class="point-popup__head-actions">
            <button type="button" class="point-popup__text-action" data-popup-action="locate">定位</button>
            <button type="button" class="point-popup__close" data-popup-action="close" aria-label="关闭">×</button>
          </div>
        </div>
        <div class="point-popup__description">${descriptionToHtml(description)}</div>
        <div class="point-popup__meta">${escapeHtml(detailLine || "死亡搁浅 2 互动地图")}</div>
        <div class="point-popup__footer">
          <button type="button" class="point-popup__footer-btn" data-popup-action="copy">复制名称</button>
          <button
            type="button"
            class="point-popup__footer-btn point-popup__footer-btn--primary${completed ? " is-completed" : ""}"
            data-popup-action="complete"
          >
            ${completed ? "取消完成" : "完成该点位"}
          </button>
        </div>
      </div>
    `;
  }

  function refreshMarkerPopup(marker) {
    if (!marker || !marker.getPopup()) {
      return;
    }
    marker.getPopup().setContent(buildPointPopupContent(marker));
    marker.__pointTitle = marker.__pointData && marker.__pointData.title ? marker.__pointData.title : marker.__pointTitle;
    syncMarkerCompletedState(marker);
  }

  async function handleMapActionClick(event) {
    const actionButton = event.target.closest("[data-popup-action]");
    if (!actionButton) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    const popup = actionButton.closest(".point-popup");
    const pointKey = popup ? popup.dataset.pointKey : "";
    const marker = state.markerByPointKey.get(pointKey);
    if (!marker) {
      return;
    }

    const action = actionButton.dataset.popupAction;
    if (action === "close") {
      marker.closePopup();
      return;
    }

    if (action === "locate") {
      state.map.setView(marker.getLatLng(), Math.max(state.map.getZoom(), 4), { animate: true });
      return;
    }

    if (action === "copy") {
      const copied = await copyText(getPointCopyText(marker));
      if (copied) {
        const previous = actionButton.textContent;
        actionButton.textContent = "已复制";
        window.setTimeout(() => {
          actionButton.textContent = previous;
        }, 1200);
      }
      return;
    }

    if (action === "complete") {
      togglePointCompleted(pointKey);
      refreshMarkerPopup(marker);
    }
  }

  async function postRemoteJson(path, payload) {
    const response = await fetch(`${REMOTE_API_BASE}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json;charset=UTF-8",
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`Remote API error: ${response.status} ${path}`);
    }

    return response.json();
  }

  async function fetchRemoteProfileBundle(profileId) {
    const remoteMapId = REMOTE_MAP_ID_BY_PROFILE_ID[profileId];
    if (!remoteMapId) {
      return null;
    }

    const [mapPayload, landmarkPayload] = await Promise.all([
      postRemoteJson("/map/getMap", { gameMapId: remoteMapId }),
      postRemoteJson("/landmark/getLandmarkList", {
        gameMapId: remoteMapId,
        keyword: null,
        catalogIdsSelected: [],
        userId: 0,
      }),
    ]);

    if (!mapPayload || mapPayload.error || !mapPayload.map) {
      throw new Error(`Failed to fetch map metadata for ${profileId}`);
    }
    if (!landmarkPayload || landmarkPayload.error || !Array.isArray(landmarkPayload.landmarks)) {
      throw new Error(`Failed to fetch landmarks for ${profileId}`);
    }

    return {
      map: mapPayload.map,
      landmarks: landmarkPayload.landmarks,
    };
  }

  function enrichProfileWithRemoteData(profileId, localProfile, remoteBundle) {
    const nextProfile = cloneProfile(localProfile);
    if (!remoteBundle) {
      return nextProfile;
    }

    const catalogById = new Map();
    remoteBundle.map.landmarkCatalogGroups.forEach((group) => {
      group.landmarkCatalogs.forEach((catalog) => {
        catalogById.set(String(catalog.id), {
          groupTitle: group.groupName,
          title: catalog.name,
          count: catalog.landmarksCount,
        });
      });
    });

    const landmarksByCatalogId = new Map();
    remoteBundle.landmarks.forEach((landmark) => {
      const key = String(landmark.landmarkCatalogId);
      if (!landmarksByCatalogId.has(key)) {
        landmarksByCatalogId.set(key, []);
      }
      landmarksByCatalogId.get(key).push(landmark);
    });

    nextProfile.name = MAP_NAME_FALLBACK[profileId] || nextProfile.name;

    nextProfile.points.forEach((group) => {
      let nextGroupTitle = "";

      group.data.forEach((section) => {
        const catalogMeta = catalogById.get(String(section.id));
        const remotePoints = landmarksByCatalogId.get(String(section.id)) || [];
        const remoteQueuesByTitle = new Map();
        const usedRemoteIds = new Set();

        remotePoints.forEach((remotePoint) => {
          const titleKey = normalizePointTitle(remotePoint.name);
          if (!titleKey) {
            return;
          }
          if (!remoteQueuesByTitle.has(titleKey)) {
            remoteQueuesByTitle.set(titleKey, []);
          }
          remoteQueuesByTitle.get(titleKey).push(remotePoint);
        });

        if (catalogMeta) {
          section.title = catalogMeta.title;
          section.num = Number.isFinite(catalogMeta.count) ? catalogMeta.count : section.data.length;
          nextGroupTitle = nextGroupTitle || catalogMeta.groupTitle;
        }

        section.data = section.data.map((point, index) => {
          let remotePoint = null;
          const titleKey = normalizePointTitle(point.title);
          const matchedQueue = titleKey ? remoteQueuesByTitle.get(titleKey) : null;
          if (matchedQueue && matchedQueue.length) {
            remotePoint = matchedQueue.shift();
          }

          if (!remotePoint) {
            const indexedCandidate = remotePoints[index];
            if (indexedCandidate && !usedRemoteIds.has(indexedCandidate.id)) {
              remotePoint = indexedCandidate;
            }
          }

          if (!remotePoint) {
            remotePoint = remotePoints.find((candidate) => !usedRemoteIds.has(candidate.id)) || null;
          }

          if (!remotePoint) {
            return {
              ...point,
              description: normalizeDescription(point.description),
            };
          }

          usedRemoteIds.add(remotePoint.id);
          return {
            ...point,
            title: remotePoint.name || point.title,
            description: normalizeDescription(remotePoint.description),
            remoteLandmarkId: remotePoint.id,
            remoteLandmarkUrl: remotePoint.landmarkUrl || "",
          };
        });
      });

      if (nextGroupTitle) {
        group.title = nextGroupTitle;
      }
    });

    return nextProfile;
  }

  async function getRenderableProfile(profileId) {
    if (state.enrichedProfiles.has(profileId)) {
      return state.enrichedProfiles.get(profileId);
    }

    if (remoteProfilePromises.has(profileId)) {
      return remoteProfilePromises.get(profileId);
    }

    const promise = (async () => {
      const localProfile = profiles[profileId];
      const remoteBundle = await fetchRemoteProfileBundle(profileId);
      const nextProfile = enrichProfileWithRemoteData(profileId, localProfile, remoteBundle);
      state.enrichedProfiles.set(profileId, nextProfile);
      remoteProfilePromises.delete(profileId);
      return nextProfile;
    })().catch((error) => {
      console.warn(`Failed to enrich profile "${profileId}" from remote data.`, error);
      const fallbackProfile = cloneProfile(profiles[profileId]);
      state.enrichedProfiles.set(profileId, fallbackProfile);
      remoteProfilePromises.delete(profileId);
      return fallbackProfile;
    });

    remoteProfilePromises.set(profileId, promise);
    return promise;
  }

  function escapeHtml(text) {
    return String(text)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function normalizeTheme(theme) {
    return theme === "dark" ? "dark" : "light";
  }

  function updateThemeToggleButton() {
    if (!refs.themeToggle) {
      return;
    }
    const isDark = state.theme === "dark";
    refs.themeToggle.setAttribute(
      "aria-label",
      isDark ? "切换为白天模式" : "切换为夜间模式"
    );
    refs.themeToggle.setAttribute("data-theme", state.theme);
  }

  function applyTheme(theme, options = {}) {
    const { animate = true } = options;
    state.theme = normalizeTheme(theme);
    document.body.classList.toggle("theme-dark", state.theme === "dark");
    if (animate) {
      document.body.classList.add("theme-switching");
      if (state.themeSwitchTimer) {
        clearTimeout(state.themeSwitchTimer);
      }
      state.themeSwitchTimer = setTimeout(() => {
        document.body.classList.remove("theme-switching");
        state.themeSwitchTimer = null;
      }, 480);
    }
    updateThemeToggleButton();
  }

  function handleThemeToggleChange(event) {
    const nextTheme = normalizeTheme(event && event.detail);
    applyTheme(nextTheme, { animate: true });
    try {
      localStorage.setItem(THEME_STORAGE_KEY, nextTheme);
    } catch {
      // Ignore storage failures in restricted environments.
    }
  }

  function initTheme() {
    let savedTheme = "";
    try {
      savedTheme = localStorage.getItem(THEME_STORAGE_KEY) || "";
    } catch {
      savedTheme = "";
    }

    if (!savedTheme && window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) {
      savedTheme = "dark";
    }
    applyTheme(savedTheme || "light", { animate: false });
  }

  function unproject(profile, x, y) {
    return state.map.unproject([x, y], profile.mapMaxZoom);
  }

  function getBounds(profile) {
    const southWest = unproject(profile, 0, profile.mapSize);
    const northEast = unproject(profile, profile.mapSize, 0);
    return L.latLngBounds(southWest, northEast);
  }

  function setMarkerLabel(marker, enabled) {
    if (!enabled) {
      marker.unbindTooltip();
      return;
    }

    if (!marker.getTooltip()) {
      marker.bindTooltip(marker.__pointTitle, {
        permanent: true,
        direction: "top",
        className: "point-label",
        offset: [0, -22],
      });
    }
  }

  function updateLabelButton() {
    refs.toggleLabelBtn.classList.toggle("active", state.showLabels);
    refs.toggleLabelBtn.textContent = state.showLabels ? "显示标点名称" : "隐藏标点名称";
  }

  function buildMapSwitch() {
    refs.mapSwitch.innerHTML = profileIds
      .map((id) => `<button type="button" data-map="${id}">${escapeHtml(getMapDisplayName(id, profiles[id]))}</button>`)
      .join("");

    refs.mapSwitch.addEventListener("click", (event) => {
      const btn = event.target.closest("button[data-map]");
      if (!btn) {
        return;
      }
      void switchProfile(btn.dataset.map);
    });
  }

  function updateMapSwitchState() {
    refs.mapSwitch.querySelectorAll("button[data-map]").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.map === state.currentProfileId);
    });
  }

  function createMap() {
    state.map = L.map("map", {
      crs: L.CRS.Simple,
      minZoom: 1,
      maxZoom: 6,
      attributionControl: false,
      zoomControl: true,
      preferCanvas: true,
      fadeAnimation: true,
      zoomAnimation: true,
      markerZoomAnimation: true,
      zoomAnimationThreshold: 8,
    });
  }

  function createMarkerIcon(iconUrl) {
    return L.divIcon({
      className: "poi-icon",
      iconSize: [34, 34],
      iconAnchor: [17, 34],
      html: `<img src="${escapeHtml(iconUrl)}" alt="">`,
    });
  }

  function clearProfileLayers() {
    if (state.map) {
      state.map.closePopup();
    }
    state.categories.forEach((category) => {
      state.map.removeLayer(category.layer);
    });
    state.categories.clear();
    state.pointsIndex = [];
    state.markerByPointKey.clear();

    if (state.tileLayer) {
      state.map.removeLayer(state.tileLayer);
      state.tileLayer = null;
    }
  }

  function buildCategoryUI(profile) {
    let html = "";
    profile.points.forEach((group, groupIndex) => {
      html += `<div class="group-card"><h3 class="group-title">${escapeHtml(group.title)}</h3>`;

      group.data.forEach((section, sectionIndex) => {
        const categoryKey = `${groupIndex}-${sectionIndex}-${section.id}`;
        html += `
          <div class="category-item" data-cat-key="${categoryKey}">
            <img src="${escapeHtml(section.icon)}" alt="">
            <span class="name">${escapeHtml(section.title)}</span>
            <span class="count">${section.num}</span>
          </div>
        `;

        const layer = L.layerGroup();
        const markers = [];
        const icon = createMarkerIcon(section.icon);
        section.data.forEach((point) => {
          const pointKey = getPointStorageKey(state.currentProfileId, categoryKey, point);
          const marker = L.marker(unproject(profile, point.x, point.y), {
            icon,
            riseOnHover: true,
          });

          marker.__pointData = point;
          marker.__popupMeta = {
            categoryKey,
            categoryTitle: section.title,
            groupTitle: group.title,
            icon: section.icon,
          };
          marker.__pointKey = pointKey;
          marker.__pointTitle = point.title;
          marker.bindPopup(buildPointPopupContent(marker), {
            className: "point-popup-shell",
            closeButton: false,
            autoPan: true,
            autoPanPadding: [32, 32],
            maxWidth: 460,
            minWidth: 320,
          });
          marker.on("add", () => {
            syncMarkerCompletedState(marker);
            setMarkerLabel(marker, state.showLabels);
          });
          marker.addTo(layer);
          markers.push(marker);
          state.markerByPointKey.set(pointKey, marker);

          state.pointsIndex.push({
            title: point.title,
            marker,
            categoryKey,
            categoryTitle: section.title,
            groupTitle: group.title,
          });
        });

        state.categories.set(categoryKey, {
          layer,
          markers,
          visible: false,
          title: section.title,
          icon: section.icon,
          groupTitle: group.title,
        });
      });

      html += "</div>";
    });

    refs.categoryWrap.innerHTML = html;
  }

  function updateCategoryState(categoryKey) {
    const category = state.categories.get(categoryKey);
    const item = refs.categoryWrap.querySelector(`[data-cat-key="${categoryKey}"]`);
    if (!category || !item) {
      return;
    }
    item.classList.toggle("active", category.visible);
  }

  function updateShowAllButtonState() {
    if (!refs.showAllBtn) {
      return;
    }

    const total = state.categories.size;
    if (!total) {
      refs.showAllBtn.classList.remove("active");
      return;
    }

    let visibleCount = 0;
    state.categories.forEach((category) => {
      if (category.visible) {
        visibleCount += 1;
      }
    });

    refs.showAllBtn.classList.toggle("active", visibleCount === total);
  }

  function toggleCategory(categoryKey, forceVisible = null) {
    const category = state.categories.get(categoryKey);
    if (!category) {
      return;
    }

    const shouldShow = forceVisible === null ? !category.visible : forceVisible;
    if (shouldShow === category.visible) {
      return;
    }

    category.visible = shouldShow;
    if (shouldShow) {
      state.map.addLayer(category.layer);
      category.markers.forEach((marker) => {
        syncMarkerCompletedState(marker);
        setMarkerLabel(marker, state.showLabels);
      });
    } else {
      category.markers.forEach((marker) => setMarkerLabel(marker, false));
      state.map.removeLayer(category.layer);
    }

    updateCategoryState(categoryKey);
    updateShowAllButtonState();
  }

  function toggleAllCategories(visible) {
    state.categories.forEach((_, categoryKey) => {
      toggleCategory(categoryKey, visible);
    });
    if (!visible) {
      refs.showAllBtn.classList.remove("active");
    }
  }

  function getSelectedCategories() {
    const selected = [];
    state.categories.forEach((category) => {
      if (category.visible) {
        selected.push(category);
      }
    });
    return selected;
  }

  function buildTileUrl(template, z, x, y) {
    return template.replace("{z}", String(z)).replace("{x}", String(x)).replace("{y}", String(y));
  }

  function isDirectFileAccess() {
    return window.location.protocol === "file:";
  }

  function drawRoundedRectPath(ctx, x, y, width, height, radius) {
    const r = Math.min(radius, width / 2, height / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + width - r, y);
    ctx.arcTo(x + width, y, x + width, y + r, r);
    ctx.lineTo(x + width, y + height - r);
    ctx.arcTo(x + width, y + height, x + width - r, y + height, r);
    ctx.lineTo(x + r, y + height);
    ctx.arcTo(x, y + height, x, y + height - r, r);
    ctx.lineTo(x, y + r);
    ctx.arcTo(x, y, x + r, y, r);
    ctx.closePath();
  }

  function loadImageWithTimeout(url, timeoutMs = 7000) {
    return new Promise((resolve) => {
      const img = new Image();
      let done = false;

      const finish = (result) => {
        if (done) {
          return;
        }
        done = true;
        clearTimeout(timer);
        resolve(result);
      };

      const timer = setTimeout(() => finish(null), timeoutMs);
      img.onload = () => finish(img);
      img.onerror = () => finish(null);
      img.src = url;
    });
  }

  async function mapWithConcurrency(items, limit, mapper) {
    const results = new Array(items.length);
    let cursor = 0;
    const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length || 1)) }, async () => {
      while (true) {
        const index = cursor;
        cursor += 1;
        if (index >= items.length) {
          return;
        }
        results[index] = await mapper(items[index], index);
      }
    });
    await Promise.all(workers);
    return results;
  }

  async function exportSelectedMapAsImage() {
    if (state.exportingIcons) {
      return;
    }

    const selected = getSelectedCategories();

    const mapContainer = state.map && state.map.getContainer ? state.map.getContainer() : null;
    if (!mapContainer) {
      window.alert("地图还没初始化，暂时无法导出。");
      return;
    }

    const profile = state.currentProfile;
    if (!profile || !profile.tileTemplate) {
      window.alert("当前地图数据不完整，无法导出。");
      return;
    }

    if (isDirectFileAccess()) {
      window.alert(EXPORT_LOCALHOST_HINT);
      return;
    }

    state.exportingIcons = true;
    if (refs.exportSelectedBtn) {
      refs.exportSelectedBtn.disabled = true;
      refs.exportSelectedBtn.textContent = "导出中...";
    }

    try {
      const targetZoom = Number.isFinite(profile.mapMaxZoom) ? profile.mapMaxZoom : 6;
      const bounds = state.map.getBounds();
      const nw = state.map.project(bounds.getNorthWest(), targetZoom);
      const se = state.map.project(bounds.getSouthEast(), targetZoom);

      const rawWidth = Math.max(1, Math.ceil(se.x - nw.x));
      const rawHeight = Math.max(1, Math.ceil(se.y - nw.y));

      const MAX_CANVAS_SIDE = 32767;
      const MAX_CANVAS_PIXELS = 268000000;
      if (rawWidth > MAX_CANVAS_SIDE || rawHeight > MAX_CANVAS_SIDE || rawWidth * rawHeight > MAX_CANVAS_PIXELS) {
        throw new Error("Export resolution exceeds browser canvas limits.");
      }

      const outWidth = rawWidth;
      const outHeight = rawHeight;

      const canvas = document.createElement("canvas");
      canvas.width = outWidth;
      canvas.height = outHeight;

      const ctx = canvas.getContext("2d");
      if (!ctx) {
        throw new Error("Canvas context is unavailable.");
      }

      const mapBg = getComputedStyle(mapContainer).backgroundColor || "#000000";
      ctx.fillStyle = mapBg;
      ctx.fillRect(0, 0, outWidth, outHeight);

      const tileSize = 256;
      const maxTileIndex = Math.max(0, Math.ceil(profile.mapSize / tileSize) - 1);
      const xStart = Math.max(0, Math.floor(nw.x / tileSize));
      const yStart = Math.max(0, Math.floor(nw.y / tileSize));
      const xEnd = Math.min(maxTileIndex, Math.floor((se.x - 1) / tileSize));
      const yEnd = Math.min(maxTileIndex, Math.floor((se.y - 1) / tileSize));

      if (xStart > xEnd || yStart > yEnd) {
        throw new Error("No visible tiles for current bounds.");
      }

      const tileJobs = [];
      for (let y = yStart; y <= yEnd; y += 1) {
        for (let x = xStart; x <= xEnd; x += 1) {
          tileJobs.push({
            x,
            y,
            url: buildTileUrl(profile.tileTemplate, targetZoom, x, y),
          });
        }
      }

      const tileResults = await mapWithConcurrency(tileJobs, 16, async (job) => {
        const img = await loadImageWithTimeout(job.url);
        return { ...job, img };
      });

      tileResults.forEach((tile) => {
        if (!tile.img) {
          return;
        }
        const drawX = tile.x * tileSize - nw.x;
        const drawY = tile.y * tileSize - nw.y;
        const drawSize = tileSize;
        ctx.drawImage(tile.img, drawX, drawY, drawSize, drawSize);
      });

      const iconUrls = Array.from(new Set(selected.map((category) => category.icon)));
      const iconEntries = await mapWithConcurrency(iconUrls, 8, async (url) => {
        const img = await loadImageWithTimeout(url);
        return [url, img];
      });
      const iconMap = new Map(iconEntries);
      const overlayReferenceZoom = 3;
      const exportUiScale = Math.pow(2, targetZoom - overlayReferenceZoom);

      const iconWidth = 34 * exportUiScale;
      const iconHeight = 34 * exportUiScale;
      const iconAnchorX = 17 * exportUiScale;
      const iconAnchorY = 34 * exportUiScale;

      selected.forEach((category) => {
        const icon = iconMap.get(category.icon);
        if (!icon) {
          return;
        }
        category.markers.forEach((marker) => {
          const point = state.map.project(marker.getLatLng(), targetZoom);
          const drawX = point.x - nw.x - iconAnchorX;
          const drawY = point.y - nw.y - iconAnchorY;
          const drawW = iconWidth;
          const drawH = iconHeight;

          if (drawX > outWidth || drawY > outHeight || drawX + drawW < 0 || drawY + drawH < 0) {
            return;
          }
          ctx.drawImage(icon, drawX, drawY, drawW, drawH);
        });
      });

      const shouldDrawLabels =
        state.showLabels || Boolean(refs.toggleLabelBtn && refs.toggleLabelBtn.classList.contains("active"));
      if (shouldDrawLabels) {
        const labelFontSize = 12 * exportUiScale;
        const labelFont = `${labelFontSize}px 'Segoe UI', 'PingFang SC', 'Noto Sans SC', sans-serif`;
        const labelPadX = 6 * exportUiScale;
        const labelHeight = 20 * exportUiScale;
        const labelRadius = 4 * exportUiScale;
        const labelGap = 6 * exportUiScale;

        ctx.font = labelFont;
        ctx.textBaseline = "middle";
        ctx.textAlign = "left";
        ctx.lineJoin = "round";
        ctx.lineWidth = Math.max(1, 1.8 * exportUiScale);

        selected.forEach((category) => {
          category.markers.forEach((marker) => {
            const title = String(marker.__pointTitle || "").trim();
            if (!title) {
              return;
            }

            const point = state.map.project(marker.getLatLng(), targetZoom);
            const centerX = point.x - nw.x;
            const iconTopY = point.y - nw.y - iconAnchorY;

            const textWidth = Math.ceil(ctx.measureText(title).width);
            const boxWidth = textWidth + labelPadX * 2;
            const boxX = Math.round(centerX - boxWidth / 2);
            const boxY = Math.round(iconTopY - labelGap - labelHeight);

            if (boxX > outWidth || boxY > outHeight || boxX + boxWidth < 0 || boxY + labelHeight < 0) {
              return;
            }

            drawRoundedRectPath(ctx, boxX, boxY, boxWidth, labelHeight, labelRadius);
            ctx.fillStyle = "rgba(8, 12, 20, 0.86)";
            ctx.fill();

            ctx.fillStyle = "#ffffff";
            ctx.strokeStyle = "rgba(0, 0, 0, 0.45)";
            ctx.strokeText(title, boxX + labelPadX, boxY + labelHeight / 2);
            ctx.fillText(title, boxX + labelPadX, boxY + labelHeight / 2);
          });
        });
      }

      const imageBlob = await new Promise((resolve, reject) => {
        canvas.toBlob(
          (blob) => {
            if (!blob) {
              reject(new Error("Canvas export failed."));
              return;
            }
            resolve(blob);
          },
          "image/png",
          1
        );
      });

      const safeMapId = (state.currentProfileId || "map").replace(/[^a-z0-9_-]/gi, "");
      const now = new Date();
      const timePart = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(
        now.getDate()
      ).padStart(2, "0")}-${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(
        2,
        "0"
      )}${String(now.getSeconds()).padStart(2, "0")}`;

      const link = document.createElement("a");
      const blobUrl = URL.createObjectURL(imageBlob);
      link.href = blobUrl;
      const exportKind = selected.length ? "with-markers" : "base-map";
      link.download = `${safeMapId}-map-z${targetZoom}-${exportKind}-${timePart}.png`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(blobUrl), 2000);
    } catch (error) {
      console.error(error);
      const errorMessage = String((error && error.message) || "");
      if (errorMessage.includes("canvas limits")) {
        window.alert(
          "导出失败。当前视野分辨率超出浏览器画布上限，无法按原始大图导出。请稍微缩小范围后重试。"
        );
      } else if (isDirectFileAccess()) {
        window.alert(EXPORT_LOCALHOST_HINT);
      } else {
        window.alert(
          "导出失败。请确认图标资源都能正常加载，然后再试一次。"
        );
      }
    } finally {
      state.exportingIcons = false;
      if (refs.exportSelectedBtn) {
        refs.exportSelectedBtn.disabled = false;
        refs.exportSelectedBtn.textContent = EXPORT_BUTTON_LABEL;
      }
    }
  }

  function toggleLabels() {
    state.showLabels = !state.showLabels;
    state.categories.forEach((category) => {
      category.markers.forEach((marker) => {
        setMarkerLabel(marker, state.showLabels && category.visible);
      });
    });
    updateLabelButton();
  }

  function renderSearchResult(matches) {
    if (!matches.length) {
      refs.searchResult.innerHTML = "";
      refs.searchResult.classList.remove("show");
      return;
    }

    refs.searchResult.innerHTML = matches
      .map(
        (item, index) =>
          `<li data-index="${index}">${escapeHtml(item.title)} <small>(${escapeHtml(item.groupTitle)} / ${escapeHtml(item.categoryTitle)})</small></li>`
      )
      .join("");
    refs.searchResult.classList.add("show");
  }

  function handleSearchInput() {
    const keyword = refs.searchInput.value.trim().toLowerCase();
    if (!keyword) {
      state.searchMatches = [];
      renderSearchResult([]);
      return;
    }

    state.searchMatches = state.pointsIndex
      .filter((item) => item.title.toLowerCase().includes(keyword))
      .slice(0, 30);
    renderSearchResult(state.searchMatches);
  }

  function focusSearchResult(index) {
    const item = state.searchMatches[index];
    if (!item) {
      return;
    }

    toggleCategory(item.categoryKey, true);
    state.map.setView(item.marker.getLatLng(), Math.max(state.map.getZoom(), 4), { animate: true });
    item.marker.openPopup();

    refs.searchResult.classList.remove("show");
  }

  async function switchProfile(profileId) {
    const baseProfile = profiles[profileId];
    if (!baseProfile) {
      return;
    }

    const requestToken = ++state.switchRequestToken;
    state.currentProfileId = profileId;
    updateMapSwitchState();

    let profile = baseProfile;
    try {
      profile = await getRenderableProfile(profileId);
    } catch (error) {
      console.warn(`Failed to load renderable profile "${profileId}".`, error);
      profile = cloneProfile(baseProfile);
    }

    if (requestToken !== state.switchRequestToken) {
      return;
    }

    clearProfileLayers();
    state.currentProfileId = profileId;
    state.currentProfile = profile;

    state.map.setMaxZoom(profile.mapMaxZoom);

    const tileTemplate = profile.tileTemplate;
    if (!tileTemplate) {
      throw new Error(`Missing tileTemplate for profile: ${profile.id || profileId}`);
    }

    const bounds = getBounds(profile);
    state.tileLayer = L.tileLayer(tileTemplate, {
      noWrap: true,
      minZoom: 1,
      maxZoom: profile.mapMaxZoom,
      maxNativeZoom: profile.mapMaxZoom,
      keepBuffer: 12,
      updateWhenIdle: false,
      updateWhenZooming: true,
      updateInterval: 120,
      bounds,
      attribution: "",
    });
    state.tileLayer.addTo(state.map);

    state.map.setMaxBounds(bounds.pad(0.2));
    state.map.fitBounds(bounds, { animate: false, padding: [20, 20] });
    state.map.setView(unproject(profile, profile.mapSize / 2, profile.mapSize / 2), 2, { animate: false });

    buildCategoryUI(profile);
    refs.searchInput.value = "";
    state.searchMatches = [];
    renderSearchResult([]);
    updateMapSwitchState();
    updateLabelButton();
    updateShowAllButtonState();
  }

  function bindEvents() {
    refs.categoryWrap.addEventListener("click", (event) => {
      const item = event.target.closest(".category-item");
      if (!item) {
        return;
      }
      toggleCategory(item.dataset.catKey);
    });

    refs.showAllBtn.addEventListener("click", () => toggleAllCategories(true));
    refs.hideAllBtn.addEventListener("click", () => toggleAllCategories(false));
    refs.toggleLabelBtn.addEventListener("click", toggleLabels);
    if (refs.exportSelectedBtn) {
      refs.exportSelectedBtn.textContent = EXPORT_BUTTON_LABEL;
      refs.exportSelectedBtn.addEventListener("click", exportSelectedMapAsImage);
    }

    refs.searchInput.addEventListener("input", handleSearchInput);
    refs.searchResult.addEventListener("click", (event) => {
      const li = event.target.closest("li[data-index]");
      if (!li) {
        return;
      }
      focusSearchResult(Number(li.dataset.index));
    });

    document.addEventListener("click", (event) => {
      if (!refs.searchInput.contains(event.target) && !refs.searchResult.contains(event.target)) {
        refs.searchResult.classList.remove("show");
      }
    });

    refs.mobileToggle.addEventListener("click", () => {
      refs.sidebar.classList.toggle("open");
    });

    const mapContainer = state.map && state.map.getContainer ? state.map.getContainer() : null;
    if (mapContainer) {
      mapContainer.addEventListener("click", (event) => {
        void handleMapActionClick(event);
      });
    }

    state.map.on("popupopen", (event) => {
      const marker = event && event.popup ? event.popup._source : null;
      if (!marker) {
        return;
      }
      refreshMarkerPopup(marker);
    });

    if (refs.themeToggle) {
      refs.themeToggle.addEventListener("change", handleThemeToggleChange);
    }
  }

  function resolveInitialProfileId() {
    const params = new URLSearchParams(window.location.search);
    const queryValue = (params.get("map") || params.get("profile") || "").toLowerCase();
    if (!queryValue) {
      return "";
    }

    const byId = profileIds.find((id) => id.toLowerCase() === queryValue);
    if (byId) {
      return byId;
    }

    const byCommonName = profileIds.find(
      (id) => String(profiles[id].commonName || "").toLowerCase() === queryValue
    );
    return byCommonName || "";
  }

  initTheme();
  loadCompletedPointKeys();
  buildMapSwitch();
  createMap();
  bindEvents();
  const initial = resolveInitialProfileId() || (profileIds.includes("mexico") ? "mexico" : profileIds[0]);
  void switchProfile(initial);
})();
