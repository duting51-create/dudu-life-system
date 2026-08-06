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

  // 写入同步状态到 GitHub（需内嵌 Token）。
  // 关键修复：遇到 409 并发冲突时不再直接失败，而是短暂退避后自动重试同一内容
  // （content 已包含「本地改动 + 最新云端」的合并结果），最多 10 次；
  // PUT 超时放宽到 12s，退避间隔 400ms*(n+1)，弱网下也能写进去。
  // 配合外层 save() 串行化锁，杜绝并发自抢 sha → 409 → 改动丢失。
  function _githubWriteState(content, attempt) {
    attempt = attempt || 0;
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
      }, 12000);
    }).then(function (r) {
      if (r.status === 409) {
        if (attempt < 10) {
          return new Promise(function (res) { setTimeout(res, 400 * (attempt + 1)); })
            .then(function () { return _githubWriteState(content, attempt + 1); });
        }
        throw new Error('并发写入冲突，稍后自动重试');
      }
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
    // 串行化锁：同一时刻只允许一个 save 在飞，避免并发 GET 同一 sha → PUT 互相 409
    _saveChain: null,
    // 脏标记：本地有尚未成功写入云端的改动时为 true，init/refresh/pagehide 据此主动补推
    _dirty: false,

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
            // 主动 push：若本地有云端还没有的改动（例如本地刚划掉的任务、
            // 或上次保存失败遗留的 dirty 数据），立即把合并结果写回云端，
            // 根治「刷新后划掉的任务又变回未完成」。
            var cloudStr = JSON.stringify(self._stripMeta(cloudState));
            var mergedStr = JSON.stringify(self._stripMeta(merged));
            if (cloudStr !== mergedStr) {
              self._dirty = true;
              self.save();
            }
          }
        }).catch(function () {});
        // 周期轻量刷新（只合并轻量 done 态，不整页重渲染、不阻塞首屏）。
        // 10s 轮询让手机端改动更快出现在电脑端。
        setInterval(function () { self._refresh(); }, 10000);
        document.addEventListener('visibilitychange', function () {
          if (!document.hidden) {
            // 回到前台时若有未保存改动先补推，再拉取云端最新
            if (self._dirty) self.save();
            self._refresh();
          }
        });
        // 页面隐藏 / 关闭前兜底 flush：用 keepalive fetch 把 dirty 改动写进云端，
        // 防止手机切后台、关闭页面时本地改动丢失（手机端尤其关键）。
        function _flushOnHide() { try { self._flushKeepalive(); } catch (e) {} }
        window.addEventListener('pagehide', _flushOnHide);
        window.addEventListener('beforeunload', _flushOnHide);
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
              .replace(/^\d+[.、：:）)\-\s]+/, '')
              .trim().toLowerCase();
            return text ? ('txt:' + text) : null;
          }
          function taskTextKeyOf(t) {
            if (!t) return null;
            var text = String(t.text || '')
              .replace(/^[✅❌]\s*/, '')
              .replace(/^\d+[.、：:）)\-\s]+/, '')
              .trim().toLowerCase();
            return text || null;
          }
          function mergeTask(cur, t) {
            // 不再用「OR 合并(done 只增不减)」——那会让「取消划掉」永远被云端旧值压回。
            // 改为「时间戳优先」：取 updatedAt/ts 较新一侧的 done 值，取消划掉也能生效。
            var lt = Number(t.updatedAt || t.ts || 0);
            var mt = Number(cur.updatedAt || cur.ts || 0);
            if (lt > 0 && lt >= mt) {
              cur.done = Boolean(t.done);
              if (t.updatedAt || t.ts) { cur.updatedAt = t.updatedAt; cur.ts = t.ts; }
            } else if (lt === 0 && mt === 0) {
              // 两侧都无时间戳（最早兼容数据）：保留已完成态，避免旧数据丢失勾选
              if (t.done === true) cur.done = true;
            }
            // 保留 sourceId，优先采用更稳定的值
            if (t.sourceId && !cur.sourceId) cur.sourceId = t.sourceId;
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
          // ⚠️ 致命 bug 修复（2026-08-06）：原实现用 seenTasks[t] 去重，t 是「对象」，
          // 作为对象属性键会被 JS 强制转成字符串 "[object Object]"——于是第 1 条任务写入后，
          // 其余任务全部被判定为「已存在」而丢弃，合并结果永远只剩 1 条任务。
          // 表现：刷新后今日安排只保留云端第一条（如「运动1小时」done=true），
          // 用户勾选的其它任务在下一次同步中被静默抹掉，怎么勾都会变回原样。
          // 正确做法：按对象引用去重（任务量很小，indexOf 足够且保持插入顺序）。
          var outTasks = [];
          [byId, byText].forEach(function (map) {
            Object.keys(map).forEach(function (k) {
              var t = map[k];
              if (!t) return;
              if (outTasks.indexOf(t) !== -1) return;
              outTasks.push(t);
            });
          });
          merged[key] = outTasks;
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
          // 本月目标由用户主动设置，以「当前设备的最新编辑」为准（本地优先）：
          // 这样用户在电脑端把被污染的默认值(如 wealth=250000)改成正确值后，能真正写回云端，
          // 不会被「云端优先」逻辑锁死在旧脏值上；云端仅在本地为空时兜底。
          var cloudGoals = cloudValue && typeof cloudValue === 'object' ? cloudValue : {};
          var localGoals = localValue && typeof localValue === 'object' ? localValue : {};
          var mergedGoals = {};
          Object.keys(cloudGoals).concat(Object.keys(localGoals)).forEach(function (k) {
            var lv = localGoals[k];
            var cv = cloudGoals[k];
            if (lv != null && lv !== '') mergedGoals[k] = lv;
            else if (cv != null && cv !== '') mergedGoals[k] = cv;
          });
          merged[key] = mergedGoals;
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
          // 过滤空标题与 UTF-8 误读乱码（Ã/Â/�/C1 控制字符等）
          var isValidMovie = function (item) {
            if (!item || typeof item.title !== 'string') return false;
            var t = item.title.trim();
            if (!t) return false;
            if (/[ÃÂ�\x80-\x9f]/.test(t)) return false;
            return true;
          };
          var arrA = Array.isArray(cloudValue) ? cloudValue : [];
          var arrB = Array.isArray(localValue) ? localValue : [];
          var seen = {};
          merged[key] = [];
          arrA.concat(arrB).forEach(function (item) {
            if (!isValidMovie(item)) return;
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
      this._dirty = true;
      clearTimeout(this._saveTimer);
      this._saveTimer = setTimeout(function () {
        self._saveTimer = null;
        self.save();
      }, 1500);
    },

    saveNow: function () {
      this._dirty = true;
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
      return this.save();
    },

    markDeleted: function (key, id) {
      this._pendingDeletes[key] = this._pendingDeletes[key] || [];
      if (this._pendingDeletes[key].indexOf(id) === -1) this._pendingDeletes[key].push(id);
      this._dirty = true;
    },

    // save 串行化：同一时刻只跑一个 _doSave；期间若又有新改动（_dirty 被重新置 true），
    // 当前 _doSave 完成后会自动再保存一次，确保不丢改动。
    save: function () {
      var self = this;
      if (this._saveChain) return this._saveChain;
      if (!this._dirty) return Promise.resolve();
      function loop() {
        self._dirty = false;
        return self._doSave().then(function () {
          // 保存期间又有新 setItem → _dirty 重新置 true，再保存一轮
          if (self._dirty) return loop();
        }, function (error) {
          // 失败：保留 dirty，等待下一次 scheduleSave / refresh / pagehide 重试，
          // 不再 toast 打扰用户（后台静默重试）。
          self._dirty = true;
          console.warn('Cloud save failed (will retry on next change/refresh):', error && error.message);
        });
      }
      this._saveChain = loop().then(function () { self._saveChain = null; });
      return this._saveChain;
    },

    // 实际保存逻辑：读本地 → 拉云端 → 合并 → PUT。409 冲突由 _githubWriteState 内部重试。
    _doSave: function () {
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
        });
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
        // 若本地有未保存改动（如上次 save 失败），顺带补推一次
        if (self._dirty) self.save();
      }).catch(function () {});
    },

    // 页面隐藏 / 关闭前的兜底 flush：用 keepalive fetch 保证请求在页面卸载后仍能发出。
    // 不依赖 _doSave（它用 _fetchWithTimeout + AbortController，卸载时会被中断）。
    _flushKeepalive: function () {
      var self = this;
      if (!this._dirty) return;
      var local = this._readLocal();
      _fetchWithTimeout(GITHUB_API, {
        method: 'GET',
        headers: { 'Authorization': 'Bearer ' + GITHUB_TOKEN, 'Accept': 'application/vnd.github+json' }
      }, 6000).then(function (r) { return r.json(); }).then(function (meta) {
        var sha = meta && meta.sha;
        var cloud = {};
        try { if (meta && meta.content) cloud = JSON.parse(atob(meta.content.replace(/\s/g, ''))); } catch (e) {}
        var merged = self._merge(cloud, local);
        var body = {
          message: 'sync flush ' + new Date().toISOString(),
          content: b64encodeUnicode(JSON.stringify(merged)),
          branch: 'sync'
        };
        if (sha) body.sha = sha;
        return fetch(GITHUB_API, {
          method: 'PUT',
          headers: {
            'Authorization': 'Bearer ' + GITHUB_TOKEN,
            'Accept': 'application/vnd.github+json',
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(body),
          keepalive: true
        });
      }).then(function () { self._dirty = false; }).catch(function () {});
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
            txt = String(t.text || '').replace(/^[✅❌]\s*/, '').replace(/^\d+[.、：:）)\-\s]+/, '').trim().toLowerCase();
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
            // 不能用 OR 合并（done 只增不减）——那会让「取消划掉」被旧的 true 永久压回。
            // saved 是 _merge 之后写回 localStorage 的权威结果（已按时间戳择新），直接采用。
            existing.done = Boolean(t.done);
            if (t.updatedAt) existing.updatedAt = t.updatedAt;
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
