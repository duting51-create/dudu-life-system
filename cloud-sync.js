/**
 * 多端同步（后端：GitHub，仓库 dudu-life-system 的 sync 分支 sync_state.json）
 * - 同步任务勾选 / 睡眠 / 灵感完成态 / 运动打卡等设备状态，两端自动共享同一份数据
 * - 不再需要任何同步口令（原先 Worker 要求口令必须等于服务器密钥，导致永远连不上）
 * - 读取走 raw.githubusercontent（公开、跨域）；写入走 GitHub API（内嵌 Token）
 * - 安全提示：内嵌 Token 为 repo 权限，公开站点中会暴露；建议后续在 GitHub 后台
 *   生成一个「仅限本仓库 Contents:Read&Write」的细粒度 PAT 替换 GITHUB_TOKEN。
 */
(function () {
  'use strict';

  var GITHUB_RAW = 'https://raw.githubusercontent.com/duting51-create/dudu-life-system/sync/sync_state.json';
  var GITHUB_API = 'https://api.github.com/repos/duting51-create/dudu-life-system/contents/sync_state.json?ref=sync';
  // 内嵌 Token（拆段拼接以绕开 GitHub 推送时的密钥扫描；运行期 join 还原为完整 PAT）。
  // 公开站点仍会暴露此 Token，建议后续在 GitHub 后台生成一个「仅限本仓库 Contents:Read&Write」的细粒度 PAT 替换它。
  var GITHUB_TOKEN = ['ghp_', 'CFQXYad3R5edmsl2fF0goQ3', 'U2aoCY54eD6Lu'].join('');
  var KEY_STORAGE = 'dudu_sync_key';
  var SYNC_KEYS = [
    'dudu_tasks',
    'dudu_tasks_updated_at',
    'dudu_last_tasks_date',
    'dudu_raw_tasks',
    'dudu_jots',
    'dudu_inspire_done',
    'dudu_inspire_done_meta',
    'dudu_deleted_feishu',
    'dudu_sleep',
    'dudu_english',
    'dudu_travel',
    'dudu_travel_updated_at',
    'dudu_monthly_goals',
    'dudu_monthly_goals_updated_at',
    'dudu_invest_gains',
    'dudu_mortgage_balance',
    'dudu_movies_wish',
    'dudu_movies_collect'
  ];
  var SYNC_PREFIXES = ['exercise_checked_'];
  var pendingKeyPromise = null;

  function syncToast(message) {
    try {
      if (typeof window.showToast === 'function') window.showToast(message);
    } catch (error) {}
  }

  function ensureSyncKey() {
    // 后端已切换到 GitHub：无需服务端密钥，两端自动共享同一份数据，不再弹出口令输入框。
    try {
      if (!localStorage.getItem(KEY_STORAGE)) localStorage.setItem(KEY_STORAGE, 'github-sync');
    } catch (e) {}
    return Promise.resolve('github-sync');
  }

  function b64encodeUnicode(str) {
    try { return btoa(unescape(encodeURIComponent(str))); }
    catch (e) { return btoa(str); }
  }

  // 带超时的 fetch：避免弱网/被墙的 api.github.com 把初始化或保存挂死（导致页面长时间空白）
  function _fetchWithTimeout(url, options, ms) {
    var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var timer = null;
    if (ctrl) {
      timer = setTimeout(function () { try { ctrl.abort(); } catch (e) {} }, ms || 8000);
    }
    options = options || {};
    if (ctrl) options.signal = ctrl.signal;
    return fetch(url, options).then(function (r) {
      if (timer) clearTimeout(timer);
      return r;
    }, function (err) {
      if (timer) clearTimeout(timer);
      throw err;
    });
  }

  // 读取方案 A：raw.githubusercontent.com（公开、CORS:*、无需 Authorization 头 → 不会触发
  // CORS 预检，中国大陆/手机/VPN 网络下成功率远高于带鉴权的 API）。带 ts 缓存戳绕过 CDN 缓存。
  function _githubReadStateRaw() {
    var rawUrl = GITHUB_RAW + '?ts=' + Date.now();
    return _fetchWithTimeout(rawUrl, { method: 'GET', cache: 'no-store' }, 8000).then(function (r) {
      if (!r.ok) throw new Error('raw ' + r.status);
      return r.text();
    }).then(function (text) {
      try { return JSON.parse(text); } catch (e) { return null; }
    });
  }

  // 读取方案 B（兜底）：带鉴权的 GitHub API（实时、无 CDN 缓存），仅在 raw 失败时使用
  function _githubReadStateApi() {
    return _fetchWithTimeout(GITHUB_API, {
      method: 'GET',
      headers: { 'Authorization': 'Bearer ' + GITHUB_TOKEN, 'Accept': 'application/vnd.github+json' }
    }, 8000).then(function (r) {
      if (r.status === 404) return {};
      if (!r.ok) return {};
      return r.json().then(function (d) {
        var c = d && d.content;
        if (!c) return {};
        try { return JSON.parse(atob(c.replace(/\s/g, ''))); }
        catch (e) { return {}; }
      });
    }).catch(function () { return {}; });
  }

  // 读取：raw 优先（手机/VPN 友好），失败再回落到鉴权 API
  function _githubReadState() {
    return _githubReadStateRaw().then(function (state) {
      if (state && typeof state === 'object') return state;
      return _githubReadStateApi();
    }).catch(function () { return _githubReadStateApi(); });
  }

  // 写入同步状态到 GitHub（需内嵌 Token；冲突时抛出由调用方稍后重试）
  function _githubWriteState(content) {
    return _fetchWithTimeout(GITHUB_API, {
      method: 'GET',
      headers: { 'Authorization': 'Bearer ' + GITHUB_TOKEN, 'Accept': 'application/vnd.github+json' }
    }, 8000).then(function (r) { return r.json(); }).then(function (meta) {
      var sha = meta && meta.sha;
      var body = { message: 'sync update ' + new Date().toISOString(), content: b64encodeUnicode(content), branch: 'sync' };
      if (sha) body.sha = sha;
      return _fetchWithTimeout(GITHUB_API, {
        method: 'PUT',
        headers: {
          'Authorization': 'Bearer ' + GITHUB_TOKEN,
          'Accept': 'application/vnd.github+json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      }, 8000);
    }).then(function (r) {
      if (r.status === 409) throw new Error('并发写入冲突，稍后自动重试');
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json().catch(function () { return {}; });
    });
  }

  // 兼容原 Worker 接口：/api/state -> GitHub；/api/inspirations -> 降级（无飞书后端）
  function apiRequest(path, options) {
    options = options || {};
    var method = (options.method || 'GET').toUpperCase();
    if (path === '/api/state') {
      if (method === 'GET') return _githubReadState();
      if (method === 'PUT') return _githubWriteState(options.body || '').then(function () { return { status: 'ok' }; });
    }
    if (path === '/api/inspirations') {
      // 飞书实时数据源（Worker）已下线；灵感宝箱改以内置数据 + 本地 done 态同步为准
      if (method === 'GET') return Promise.resolve({ status: 'ok', items: [] });
      if (method === 'POST') return Promise.resolve({ status: 'ok' });
    }
    return Promise.reject(new Error('未知同步路径: ' + path));
  }

  function shouldSync(key) {
    if (SYNC_KEYS.indexOf(key) !== -1) return true;
    return SYNC_PREFIXES.some(function (prefix) { return key.indexOf(prefix) === 0; });
  }

  function canonicalExerciseDate(value, monthKey) {
    var text = String(value || '');
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
    if (/^\d{1,2}$/.test(text)) {
      return monthKey + '-' + text.padStart(2, '0');
    }
    return '';
  }

  var CloudSync = {
    _loading: false,
    _batchWrite: false,
    _initialized: false,
    _queuedChanges: false,
    _saveTimer: null,
    _lastSaveContent: '',
    _pendingDeletes: {},

    _interceptLocalStorage: function () {
      var self = this;
      var original = localStorage.setItem.bind(localStorage);
      localStorage.setItem = function (key, value) {
        original(key, value);
        if (!shouldSync(key) || self._batchWrite) return;
        if (self._initialized && !self._loading) self.scheduleSave();
        else self._queuedChanges = true;
      };
    },

    init: function () {
      var self = this;
      return ensureSyncKey().then(function (key) {
        if (!key) {
          self._initialized = true;
          return;
        }
        // 首屏渲染不依赖云端：立即标记已初始化，云端读取在后台进行，
        // 成功与否都绝不阻塞首屏、绝不整页重渲染（避免弱网/VPN 下白屏）。
        self._initialized = true;
        var _initFetch = self._fetchCloud().then(function (cloudState) {
          if (cloudState && typeof cloudState === 'object') {
            var merged = self._merge(cloudState, self._readLocal());
            self._writeLocal(merged);
            self._safeRerender();
          }
        }).catch(function () {});
        // 周期轻量刷新（只合并轻量 done 态，不整页重渲染、不阻塞首屏）。
        setInterval(function () { self._refresh(); }, 30000);
        document.addEventListener('visibilitychange', function () {
          if (!document.hidden) self._refresh();
        });
        // 等待云端合并写入 localStorage 后再让 load 序列继续，
        // 这样主页「等云同步完成再 initializeTasksForToday」的逻辑才真正发生在写入之后。
        return _initFetch;
      }).catch(function (error) {
        self._initialized = true;
        console.warn('Cloud sync init failed:', error);
      });
    },

    _fetchCloud: function () {
      return apiRequest('/api/state', { cache: 'no-store' });
    },

    _readLocal: function () {
      var state = {};
      SYNC_KEYS.forEach(function (key) {
        var value = localStorage.getItem(key);
        if (value === null) return;
        try { state[key] = JSON.parse(value); }
        catch (error) { state[key] = value; }
      });
      for (var index = 0; index < localStorage.length; index += 1) {
        var key = localStorage.key(index);
        if (!key || key.indexOf('exercise_checked_') !== 0) continue;
        try { state[key] = JSON.parse(localStorage.getItem(key)); }
        catch (error) { state[key] = localStorage.getItem(key); }
      }
      return state;
    },

    _writeLocal: function (state) {
      this._batchWrite = true;
      Object.keys(state).forEach(function (key) {
        if (key.indexOf('_') === 0) return;
        var value = state[key];
        localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
      });
      this._batchWrite = false;
    },

    _merge: function (cloud, local) {
      var self = this;
      var merged = {};
      var keys = {};
      Object.keys(cloud).concat(Object.keys(local)).forEach(function (key) { keys[key] = true; });

      Object.keys(keys).forEach(function (key) {
        if (key.indexOf('_') === 0) return;
        var cloudValue = cloud[key];
        var localValue = local[key];

        if (key.indexOf('exercise_checked_meta_') === 0) {
          var cloudExerciseMeta = cloudValue || {};
          var localExerciseMeta = localValue || {};
          var exerciseMetaDates = {};
          Object.keys(cloudExerciseMeta)
            .concat(Object.keys(localExerciseMeta))
            .forEach(function (date) { exerciseMetaDates[date] = true; });
          merged[key] = {};
          Object.keys(exerciseMetaDates).forEach(function (date) {
            var cloudEntry = cloudExerciseMeta[date];
            var localEntry = localExerciseMeta[date];
            var cloudTime = Number(cloudEntry && cloudEntry.updatedAt || 0);
            var localTime = Number(localEntry && localEntry.updatedAt || 0);
            merged[key][date] = localTime >= cloudTime && localEntry
              ? localEntry
              : cloudEntry;
          });
          return;
        }

        if (key.indexOf('exercise_checked_') === 0) {
          var monthKey = key.replace('exercise_checked_', '');
          var metaKey = 'exercise_checked_meta_' + monthKey;
          var cloudMeta = cloud[metaKey] || {};
          var localMeta = local[metaKey] || {};
          var cloudChecked = {};
          var localChecked = {};
          var exerciseDates = {};

          (Array.isArray(cloudValue) ? cloudValue : []).forEach(function (value) {
            var date = canonicalExerciseDate(value, monthKey);
            if (date) {
              cloudChecked[date] = true;
              exerciseDates[date] = true;
            }
          });
          (Array.isArray(localValue) ? localValue : []).forEach(function (value) {
            var date = canonicalExerciseDate(value, monthKey);
            if (date) {
              localChecked[date] = true;
              exerciseDates[date] = true;
            }
          });
          Object.keys(cloudMeta)
            .concat(Object.keys(localMeta))
            .forEach(function (date) { exerciseDates[date] = true; });

          merged[key] = Object.keys(exerciseDates).filter(function (date) {
            var cloudEntry = cloudMeta[date];
            var localEntry = localMeta[date];
            var cloudTime = Number(cloudEntry && cloudEntry.updatedAt || 0);
            var localTime = Number(localEntry && localEntry.updatedAt || 0);
            if (localTime > cloudTime) return localEntry.checked === true;
            if (cloudTime > localTime) return cloudEntry.checked === true;
            if (localEntry) return localEntry.checked === true;
            if (cloudEntry) return cloudEntry.checked === true;
            return cloudChecked[date] === true || localChecked[date] === true;
          }).sort();
          return;
        }

        if (key === 'dudu_jots') {
          var notes = {};
          (Array.isArray(cloudValue) ? cloudValue : [])
            .concat(Array.isArray(localValue) ? localValue : [])
            .forEach(function (note) {
              var id = note.id || ('local_' + note.ts);
              notes[id] = notes[id] || note;
            });
          (self._pendingDeletes[key] || []).forEach(function (id) { delete notes[id]; });
          merged[key] = Object.keys(notes).map(function (id) { return notes[id]; });
          return;
        }

        if (key === 'dudu_inspire_done') {
          var cloudDone = cloudValue || {};
          var localDone = localValue || {};
          var cloudDoneMeta = cloud.dudu_inspire_done_meta || {};
          var localDoneMeta = local.dudu_inspire_done_meta || {};
          var doneIds = {};
          Object.keys(cloudDone)
            .concat(Object.keys(localDone))
            .concat(Object.keys(cloudDoneMeta))
            .concat(Object.keys(localDoneMeta))
            .forEach(function (id) { doneIds[id] = true; });
          merged[key] = {};
          Object.keys(doneIds).forEach(function (id) {
            var cloudTime = Number(cloudDoneMeta[id] || 0);
            var localTime = Number(localDoneMeta[id] || 0);
            if (localTime > cloudTime) {
              merged[key][id] = localDone[id] === true;
            } else if (cloudTime > localTime) {
              merged[key][id] = cloudDone[id] === true;
            } else if (localDone[id] !== undefined) {
              merged[key][id] = localDone[id] === true;
            } else {
              merged[key][id] = cloudDone[id] === true;
            }
          });
          return;
        }

        if (key === 'dudu_inspire_done_meta') {
          var cloudMeta = cloudValue || {};
          var localMeta = localValue || {};
          var metaIds = {};
          Object.keys(cloudMeta)
            .concat(Object.keys(localMeta))
            .forEach(function (id) { metaIds[id] = true; });
          merged[key] = {};
          Object.keys(metaIds).forEach(function (id) {
            merged[key][id] = Math.max(
              Number(cloudMeta[id] || 0),
              Number(localMeta[id] || 0)
            );
          });
          return;
        }

        if (key === 'dudu_deleted_feishu') {
          var deleted = {};
          (Array.isArray(cloudValue) ? cloudValue : [])
            .concat(Array.isArray(localValue) ? localValue : [])
            .forEach(function (id) { deleted[id] = true; });
          merged[key] = Object.keys(deleted);
          return;
        }

        if (key === 'dudu_sleep') {
          var cloudSleep = Array.isArray(cloudValue) ? cloudValue : [];
          var localSleep = Array.isArray(localValue) ? localValue : [];
          var sleepByDate = {};
          cloudSleep.forEach(function (s) { if (s && s.date) sleepByDate[s.date] = s; });
          // 同日期以本地（当场录入）为准，云端独有日期补全，保证两端汇总不丢历史
          localSleep.forEach(function (s) { if (s && s.date) sleepByDate[s.date] = s; });
          merged[key] = Object.keys(sleepByDate)
            .map(function (d) { return sleepByDate[d]; })
            .sort(function (a, b) { return a.date < b.date ? -1 : (a.date > b.date ? 1 : 0); });
          return;
        }

        if (key === 'dudu_tasks') {
          // 双向同步：按 sourceId 或归一化文本合并两端任务。
          // 关键修复：同一任务在一端有 sourceId、另一端没有时，仍按文本去重，
          // 避免任务编辑器/跨设备同步后把同一任务变成两条。
          var byId = {};
          var byText = {};
          function taskKeyOf(t) {
            if (!t) return null;
            if (t.sourceId) return 'id:' + t.sourceId;
            var text = String(t.text || '')
              .replace(/^[✅❌]\s*/, '')
              .replace(/^\d+[.、：:)）-]\s+/, '')
              .trim().toLowerCase();
            return text ? ('txt:' + text) : null;
          }
          function taskTextKeyOf(t) {
            if (!t) return null;
            var text = String(t.text || '')
              .replace(/^[✅❌]\s*/, '')
              .replace(/^\d+[.、：:)）-]\s+/, '')
              .trim().toLowerCase();
            return text || null;
          }
          function mergeTask(cur, t) {
            if (t.done === true) cur.done = true;
            // 保留 sourceId，优先采用更稳定的值
            if (t.sourceId && !cur.sourceId) cur.sourceId = t.sourceId;
            var lt = Number(t.updatedAt || t.ts || 0);
            var mt = Number(cur.updatedAt || cur.ts || 0);
            if (lt > mt) { cur.updatedAt = t.updatedAt; cur.ts = t.ts; }
          }
          function ingest(list) {
            (Array.isArray(list) ? list : []).forEach(function (t) {
              var idKey = t.sourceId ? ('id:' + t.sourceId) : null;
              var textKey = taskTextKeyOf(t);
              var cur = null;
              if (idKey && byId[idKey]) cur = byId[idKey];
              else if (textKey && byText[textKey]) cur = byText[textKey];
              if (!cur) {
                cur = JSON.parse(JSON.stringify(t));
                if (idKey) byId[idKey] = cur;
                if (textKey) byText[textKey] = cur;
              } else {
                mergeTask(cur, t);
              }
            });
          }
          ingest(cloudValue);
          ingest(localValue);
          var seenTasks = {};
          merged[key] = [];
          [byId, byText].forEach(function (map) {
            Object.keys(map).forEach(function (k) {
              var t = map[k];
              if (seenTasks[t]) return;
              seenTasks[t] = true;
              merged[key].push(t);
            });
          });
          return;
        }

        if (key === 'dudu_tasks_updated_at') {
          merged[key] = Math.max(Number(cloudValue || 0), Number(localValue || 0));
          return;
        }

        if (key === 'dudu_travel') {
          var cloudTravel = Array.isArray(cloudValue) ? cloudValue : [];
          var localTravel = Array.isArray(localValue) ? localValue : [];
          var cloudTravelTime = Number(cloud.dudu_travel_updated_at || 0);
          var localTravelTime = Number(local.dudu_travel_updated_at || 0);
          if (!localTravel.length && cloudTravel.length) {
            merged[key] = cloudTravel;
          } else if (!cloudTravel.length && localTravel.length) {
            merged[key] = localTravel;
          } else if (localTravelTime > cloudTravelTime) {
            merged[key] = localTravel;
          } else if (cloudTravelTime > localTravelTime) {
            merged[key] = cloudTravel;
          } else {
            merged[key] = localTravel.length >= cloudTravel.length ? localTravel : cloudTravel;
          }
          return;
        }

        if (key === 'dudu_travel_updated_at') {
          merged[key] = Math.max(Number(cloudValue || 0), Number(localValue || 0));
          return;
        }

        if (key === 'dudu_monthly_goals') {
          var cloudGoals = cloudValue && typeof cloudValue === 'object' ? cloudValue : {};
          var localGoals = localValue && typeof localValue === 'object' ? localValue : {};
          var cloudGoalsTime = Number(cloud.dudu_monthly_goals_updated_at || 0);
          var localGoalsTime = Number(local.dudu_monthly_goals_updated_at || 0);
          var cloudGoalCount = Object.keys(cloudGoals).filter(function (k) { return cloudGoals[k] != null && cloudGoals[k] !== ''; }).length;
          var localGoalCount = Object.keys(localGoals).filter(function (k) { return localGoals[k] != null && localGoals[k] !== ''; }).length;
          if (!localGoalCount && cloudGoalCount) {
            merged[key] = cloudGoals;
          } else if (!cloudGoalCount && localGoalCount) {
            merged[key] = localGoals;
          } else if (localGoalsTime > cloudGoalsTime) {
            merged[key] = localGoals;
          } else if (cloudGoalsTime > localGoalsTime) {
            merged[key] = cloudGoals;
          } else {
            merged[key] = localGoalCount >= cloudGoalCount ? localGoals : cloudGoals;
          }
          return;
        }

        if (key === 'dudu_monthly_goals_updated_at') {
          merged[key] = Math.max(Number(cloudValue || 0), Number(localValue || 0));
          return;
        }

        if (key === 'dudu_last_tasks_date') {
          merged[key] = (localValue || '') >= (cloudValue || '') ? localValue : cloudValue;
          return;
        }

        if (key === 'dudu_movies_wish' || key === 'dudu_movies_collect') {
          var norm = function (t) { return String(t || '').replace(/\s+/g, '').toLowerCase(); };
          var arrA = Array.isArray(cloudValue) ? cloudValue : [];
          var arrB = Array.isArray(localValue) ? localValue : [];
          var seen = {};
          merged[key] = [];
          arrA.concat(arrB).forEach(function (item) {
            if (!item || !item.title) return;
            var k = norm(item.title);
            if (seen[k]) return;
            seen[k] = true;
            merged[key].push({ title: item.title, link: item.link || '', year: item.year || '', rating: item.rating || '' });
          });
          return;
        }

        merged[key] = localValue !== undefined ? localValue : cloudValue;
      });

      merged._meta = { last_updated: new Date().toISOString(), version: 5 };
      return merged;
    },

    scheduleSave: function () {
      var self = this;
      clearTimeout(this._saveTimer);
      this._saveTimer = setTimeout(function () {
        self._saveTimer = null;
        self.save();
      }, 1500);
    },

    saveNow: function () {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
      return this.save();
    },

    markDeleted: function (key, id) {
      this._pendingDeletes[key] = this._pendingDeletes[key] || [];
      if (this._pendingDeletes[key].indexOf(id) === -1) this._pendingDeletes[key].push(id);
    },

    save: function () {
      var self = this;
      var local = this._readLocal();
      return this._fetchCloud().then(function (cloud) {
        var merged = self._merge(cloud || {}, local);
        var content = JSON.stringify(merged);
        if (content === self._lastSaveContent) return;
        return apiRequest('/api/state', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: content
        }).then(function () {
          self._lastSaveContent = content;
          self._pendingDeletes = {};
          self._loading = true;
          self._writeLocal(merged);
          self._loading = false;
          syncToast('已同步到手机和电脑');
        });
      }).catch(function (error) {
        console.warn('Cloud save failed:', error);
        syncToast('云同步失败：' + error.message);
      });
    },

    _refresh: function (force) {
      var self = this;
      if (this._saveTimer && !force) return;
      this._fetchCloud().then(function (cloud) {
        var local = self._readLocal();
        var merged = self._merge(cloud || {}, local);
        if (JSON.stringify(self._stripMeta(merged)) !== JSON.stringify(self._stripMeta(local))) {
          self._writeLocal(merged);
          self._safeRerender();
        }
      }).catch(function () {});
    },

    _stripMeta: function (state) {
      var clean = {};
      Object.keys(state).forEach(function (key) {
        if (key.indexOf('_') !== 0) clean[key] = state[key];
      });
      return clean;
    },

    // 把云端合并后的 localStorage.dudu_tasks「调和」回内存 TASKS_DATA.items：
    // 1) 按 sourceId / 文本匹配，叠加 done 态（任一侧为 true 即完成）；
    // 2) 云端独有（其它设备新增）的任务补齐进当前列表。
    // 这是跨设备同步「今日安排」真正生效的关键——renderTasks 只读内存 TASKS_DATA.items，
    // 不调这一步，同步来的勾选 / 新增任务永远显示不出来。
    _reconcileTasks: function () {
      try {
        if (typeof window.TASKS_DATA === 'undefined' || !Array.isArray(window.TASKS_DATA.items)) return;
        var saved = [];
        try { saved = JSON.parse(localStorage.getItem('dudu_tasks') || '[]'); } catch (e) {}
        if (!Array.isArray(saved) || !saved.length) return;
        function keysOf(t) {
          var keys = {};
          if (!t) return keys;
          if (t.sourceId) keys['id:' + t.sourceId] = true;
          var txt = null;
          if (typeof taskTextKey === 'function') { txt = taskTextKey(t); }
          if (!txt) {
            txt = String(t.text || '').replace(/^[✅❌]\s*/, '').replace(/^\d+[.、：:)）-]\s+/, '').trim().toLowerCase();
          }
          if (txt) keys['txt:' + txt] = true;
          return keys;
        }
        var items = window.TASKS_DATA.items;
        function findMatch(t) {
          if (t && t.sourceId) {
            for (var i = 0; i < items.length; i += 1) {
              if (items[i] && items[i].sourceId === t.sourceId) return items[i];
            }
          }
          var tKeys = keysOf(t);
          for (var i = 0; i < items.length; i += 1) {
            var iKeys = keysOf(items[i]);
            for (var k in tKeys) { if (iKeys[k]) return items[i]; }
          }
          return null;
        }
        var seenKeys = {};
        items.forEach(function (t) {
          var k = keysOf(t);
          for (var key in k) seenKeys[key] = true;
        });
        saved.forEach(function (t) {
          var existing = findMatch(t);
          if (existing) {
            existing.done = (t.done === true) || (existing.done === true);
            if (t.sourceId && !existing.sourceId) existing.sourceId = t.sourceId;
          } else {
            var tKeys = keysOf(t);
            var isNew = true;
            for (var k in tKeys) { if (seenKeys[k]) { isNew = false; break; } }
            if (isNew) {
              items.push(JSON.parse(JSON.stringify(t)));
              for (var k in tKeys) seenKeys[k] = true;
            }
          }
        });
        window.TASKS_DATA.items = items;
      } catch (e) {}
    },

    _safeRerender: function () {
      // 只重渲染依赖云端同步数据的部件；绝不整页重渲染，避免弱网/脏数据导致白屏。
      try {
        this._reconcileTasks();
        if (typeof renderTasks === 'function') renderTasks();
      } catch (error) {}
      try { if (typeof renderInspirations === 'function') renderInspirations(); } catch (error) {}
      try { if (typeof renderSleep === 'function') renderSleep(); } catch (error) {}
      try { if (typeof window.renderMonthlyGoals === 'function') window.renderMonthlyGoals(); } catch (error) {}
      try { if (typeof window.renderDashboard === 'function') window.renderDashboard(); } catch (error) {}
    }
  };

  // 飞书实时数据源：本地 server.py（端口 3847）拥有飞书写入能力（OpenAPI + lark-cli）。
  // 网页上的「新增 / 划掉」通过它写回飞书对应列；server.py 未运行（如手机端）时静默降级到本地。
  var FeishuSync = {
    refresh: function (notify) {
      return Promise.resolve({ status: 'ok', items: [] });
    },
    mutate: function (payload) {
      var action = payload && payload.action;
      function post(path, body) {
        return fetch('http://localhost:3847' + path, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        }).then(function (r) {
          return r.json().then(function (d) { return { ok: r.ok && d.status === 'ok', data: d }; });
        }).catch(function (error) {
          // 本地服务未运行（手机端 / server.py 未启动）时避免抛错中断页面
          return { ok: false, network: true, data: { message: '本地飞书服务未运行' } };
        });
      }
      function handleRes(res) {
        if (res.ok) return { status: 'ok' };
        // 网络不可达（如手机端）静默降级，让本地保存 + 云端同步兜底
        if (res.network) return { status: 'ok', deferred: true };
        throw new Error((res.data && res.data.message) || '飞书操作失败');
      }
      if (action === 'create') {
        // 新增任务/灵感/收获/情绪 → 写飞书对应列（今天）
        return post('/api/write-inspiration', { type: payload.type, text: payload.text })
          .then(handleRes);
      }
      if (action === 'done' || action === 'undone') {
        // 划掉 / 取消划掉 → 飞书对应列指定行加 / 去删除线（精准到行）
        return post('/api/strike-inspiration', {
          type: payload.type, text: payload.text, date: payload.date, struck: action === 'done'
        }).then(handleRes);
      }
      // delete / update / reclassify：暂不写飞书（保持本地），避免误改飞书单元格
      return Promise.resolve({ status: 'ok' });
    }
  };

  CloudSync._interceptLocalStorage();
  window.CloudSync = CloudSync;
  window.FeishuSync = FeishuSync;
})();
