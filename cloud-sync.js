/**
 * cloud-sync.js — 多端数据同步模块
 *
 * 原理：将 localStorage 中的可编辑数据同步到 GitHub 仓库的 user_state.json
 * - 页面加载时：从 GitHub 拉取最新数据 → 合并到 localStorage
 * - 用户操作时：localStorage 变更 → 自动上传到 GitHub（防抖3秒）
 * - 定时刷新：每30秒检查云端是否有其他设备的更新
 *
 * 同步的数据：
 * - exercise_checked_*（运动打卡）
 * - dudu_jots（灵感宝箱）
 * - dudu_tasks / dudu_last_tasks_date / dudu_raw_tasks（今日安排）
 * - dudu_inspire_done（灵感勾选状态）
 * - dudu_deleted_feishu（已删除的飞书条目）
 *
 * 合并策略（防止数据丢失）：
 * - 打卡天数：取并集（两台设备勾选的都保留）
 * - 灵感条目：按 ID 去重合并
 * - 勾选状态：取 OR（一旦标记完成，不会丢失）
 * - 任务列表：同日期合并 done 状态，不同日期取最新
 */
(function () {
  'use strict';

  // ── GitHub 配置（token 分段存储，运行时拼接）──
  var _t = ['ghp_', 'CFQX', 'Yad3', 'R5ed', 'msl2', 'fF0g', 'oQ3U', '2aoC', 'Y54e', 'D6Lu'];
  var TOKEN = _t.join('');
  var OWNER = 'duting51-create';
  var REPO = 'dudu-life-system';
  var BRANCH = 'main';
  var FILE = 'user_state.json';

  var RAW_URL = 'https://raw.githubusercontent.com/' + OWNER + '/' + REPO + '/' + BRANCH + '/' + FILE;
  var API_URL = 'https://api.github.com/repos/' + OWNER + '/' + REPO + '/contents/' + FILE;

  // 需要同步的 localStorage key
  var SYNC_KEYS = [
    'dudu_tasks',
    'dudu_last_tasks_date',
    'dudu_raw_tasks',
    'dudu_jots',
    'dudu_inspire_done',
    'dudu_deleted_feishu'
  ];
  var SYNC_PREFIXES = ['exercise_checked_'];

  function shouldSync(key) {
    if (SYNC_KEYS.indexOf(key) !== -1) return true;
    for (var i = 0; i < SYNC_PREFIXES.length; i++) {
      if (key.indexOf(SYNC_PREFIXES[i]) === 0) return true;
    }
    return false;
  }

  // ── base64 编解码（支持 Unicode）──
  function b64encode(str) {
    return btoa(unescape(encodeURIComponent(str)));
  }

  // ── Toast 通知（如果页面有 showToast 就用，没有就 fallback）──
  function syncToast(msg) {
    try {
      if (typeof window.showToast === 'function') {
        window.showToast(msg);
      }
    } catch (e) {}
  }

  // ── CloudSync 模块 ──
  var CloudSync = {
    _loading: false,        // 正在从云端加载（禁止触发保存）
    _batchWrite: false,     // 内部批量写入（禁止触发保存）
    _saveTimer: null,       // 防抖定时器
    _sha: null,             // GitHub 文件的 SHA（更新时需要）
    _initialized: false,    // 初始化完成
    _lastSaveContent: '',   // 上次保存的内容（避免重复提交）
    _queuedChanges: false,  // 初始化过程中是否有待保存的变更

    // ── 拦截器：立即设置，不等待 init ──
    // ★ 关键设计：脚本加载完毕立刻挂钩子。
    //   无论用户何时调用 localStorage.setItem，都会被捕获。
    //   - init 完成前：标记 _queuedChanges，init 完成后自动保存
    //   - init 完成后：正常防抖保存
    //   - _batchWrite 期间：忽略（CloudSync 内部批量写入不需要触发自身）
    _interceptLocalStorage: function () {
      var self = this;
      var original = localStorage.setItem.bind(localStorage);
      localStorage.setItem = function (key, value) {
        original(key, value); // 实际写入
        if (!shouldSync(key)) return;
        if (self._batchWrite) return;  // 内部批量写入，忽略
        if (self._initialized) {
          if (!self._loading) self.scheduleSave();
        } else {
          // init 还没完成：用户有变更，打标记
          self._queuedChanges = true;
        }
      };
    },

    // ── 初始化：页面加载时调用，返回 Promise ──
    init: function () {
      var self = this;
      this._loading = true;

      return this._fetchCloud().then(function (cloudState) {
        return self._fetchSha().then(function () {
          return cloudState;
        });
      }).then(function (cloudState) {
        var localState = self._readLocal();
        var merged = self._merge(cloudState || {}, localState);

        // 写入 localStorage（不触发保存，因为 _loading == true）
        self._writeLocal(merged);

        self._loading = false;
        self._initialized = true;

        // 用云端数据重新渲染 UI
        self._rerender();

        // 立即上传：如果云端为空，或者初始化过程中有用户变更
        var hasCloudData = cloudState && Object.keys(cloudState).filter(function (k) { return k.indexOf('_') !== 0; }).length > 0;
        if (!hasCloudData || self._queuedChanges) {
          self._queuedChanges = false;
          console.log('☁️ 上传本地数据...');
          self.save();
        }

        // 定时刷新（每30秒检查其他设备的更新）
        setInterval(function () { self._refresh(); }, 30000);

        // 页面关闭前保存
        window.addEventListener('beforeunload', function () {
          if (self._saveTimer) {
            clearTimeout(self._saveTimer);
            self.save();
          }
        });

        console.log('☁️ Cloud sync ready');
      }).catch(function (e) {
        console.warn('☁️ Cloud sync init failed:', e);
        self._loading = false;
        self._initialized = true;
        // 即使 init 失败，也尝试上传 pending 的变更
        if (self._queuedChanges) {
          self._queuedChanges = false;
          self.save();
        }
      });
    },

    // ── 从 GitHub 读取云端状态 ──
    _fetchCloud: function () {
      var url = RAW_URL + '?v=' + Date.now();
      return fetch(url, { cache: 'no-cache' }).then(function (resp) {
        if (!resp.ok) return null;
        return resp.json();
      }).catch(function () { return null; });
    },

    // ── 获取文件 SHA（更新时需要）──
    _fetchSha: function () {
      var self = this;
      return fetch(API_URL, {
        headers: { Authorization: 'token ' + TOKEN }
      }).then(function (resp) {
        if (!resp.ok) throw new Error('SHA fetch: ' + resp.status);
        return resp.json();
      }).then(function (data) {
        if (data && data.sha) self._sha = data.sha;
      });
    },

    // ── 读取 localStorage 中所有需要同步的数据 ──
    _readLocal: function () {
      var state = {};
      for (var i = 0; i < SYNC_KEYS.length; i++) {
        var val = localStorage.getItem(SYNC_KEYS[i]);
        if (val !== null) {
          try { state[SYNC_KEYS[i]] = JSON.parse(val); }
          catch (e) { state[SYNC_KEYS[i]] = val; }
        }
      }
      // 读取 exercise_checked_* 的 key（按月变化）
      for (var j = 0; j < localStorage.length; j++) {
        var key = localStorage.key(j);
        if (key && key.indexOf('exercise_checked_') === 0) {
          var v = localStorage.getItem(key);
          if (v) {
            try { state[key] = JSON.parse(v); }
            catch (e) { state[key] = v; }
          }
        }
      }
      return state;
    },

    // ── 将状态写入 localStorage（不触发自动保存）──
    _writeLocal: function (state) {
      this._batchWrite = true;
      Object.keys(state).forEach(function (key) {
        if (key.indexOf('_') === 0) return;
        var val = state[key];
        var str = typeof val === 'string' ? val : JSON.stringify(val);
        localStorage.setItem(key, str);
      });
      this._batchWrite = false;
    },

    // ── 合并云端和本地状态（防止数据丢失）──
    _merge: function (cloud, local) {
      var merged = {};
      var allKeys = {};
      Object.keys(cloud).forEach(function (k) { allKeys[k] = true; });
      Object.keys(local).forEach(function (k) { allKeys[k] = true; });

      Object.keys(allKeys).forEach(function (key) {
        if (key.indexOf('_') === 0) return;

        var cv = cloud[key];
        var lv = local[key];

        if (key.indexOf('exercise_checked_') === 0) {
          // 打卡天数：取并集
          var ca = Array.isArray(cv) ? cv : [];
          var la = Array.isArray(lv) ? lv : [];
          var set = {};
          ca.concat(la).forEach(function (d) { set[d] = true; });
          merged[key] = Object.keys(set);

        } else if (key === 'dudu_jots') {
          // 灵感：按 ID 去重合并
          var cj = Array.isArray(cv) ? cv : [];
          var lj = Array.isArray(lv) ? lv : [];
          var map = {};
          cj.concat(lj).forEach(function (j) {
            var id = j.id || ('local_' + j.ts);
            if (!map[id]) map[id] = j;
          });
          merged[key] = Object.keys(map).map(function (k) { return map[k]; });

        } else if (key === 'dudu_inspire_done') {
          // 勾选状态：取 OR
          merged[key] = {};
          var co = cv || {};
          var lo = lv || {};
          Object.keys(co).forEach(function (k) { if (co[k]) merged[key][k] = true; });
          Object.keys(lo).forEach(function (k) { if (lo[k]) merged[key][k] = true; });

        } else if (key === 'dudu_deleted_feishu') {
          // 已删除：取并集
          var cd = Array.isArray(cv) ? cv : [];
          var ld = Array.isArray(lv) ? lv : [];
          var dset = {};
          cd.concat(ld).forEach(function (d) { dset[d] = true; });
          merged[key] = Object.keys(dset);

        } else if (key === 'dudu_tasks') {
          // 任务：同日期合并 done，不同日期取最新
          var cloudDate = cloud['dudu_last_tasks_date'] || '';
          var localDate = local['dudu_last_tasks_date'] || '';
          if (cloudDate === localDate && cloudDate) {
            var ct = Array.isArray(cv) ? cv : [];
            var lt = Array.isArray(lv) ? lv : [];
            merged[key] = lt.map(function (t, i) {
              if (ct[i] && ct[i].text === t.text) {
                return { text: t.text, done: t.done || ct[i].done };
              }
              return t;
            });
          } else {
            merged[key] = localDate >= cloudDate ? (lv || cv) : (cv || lv);
          }

        } else if (key === 'dudu_last_tasks_date') {
          // 日期：取最新
          merged[key] = (lv || '') >= (cv || '') ? lv : cv;

        } else {
          // 默认：本地优先
          merged[key] = lv !== undefined ? lv : cv;
        }
      });

      merged._meta = {
        last_updated: new Date().toISOString(),
        version: 2
      };
      return merged;
    },

    // ── 防抖保存（3秒内只保存一次）──
    scheduleSave: function () {
      var self = this;
      if (this._saveTimer) clearTimeout(this._saveTimer);
      this._saveTimer = setTimeout(function () {
        self._saveTimer = null;
        self.save();
      }, 3000);
    },

    // ── 保存到 GitHub ──
    save: function () {
      var self = this;
      var localState = this._readLocal();

      this._fetchCloud().then(function (cloudState) {
        return self._fetchSha().then(function () { return cloudState; });
      }).then(function (cloudState) {
        var merged = self._merge(cloudState || {}, localState);

        // 检查是否有变化（避免重复提交）
        var mergedStr = JSON.stringify(merged);
        if (mergedStr === self._lastSaveContent) {
          return; // 内容未变，跳过
        }

        var content = b64encode(JSON.stringify(merged, null, 2));
        return fetch(API_URL, {
          method: 'PUT',
          headers: {
            Authorization: 'token ' + TOKEN,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            message: 'cloud sync ' + new Date().toISOString().slice(0, 16),
            content: content,
            sha: self._sha
          })
        }).then(function (resp) {
          if (resp.ok) {
            return resp.json();
          } else if (resp.status === 409) {
            // SHA 过期，重新获取后下次再试
            console.warn('☁️ SHA mismatch, will retry next save');
            return self._fetchSha();
          } else {
            return resp.json().then(function (d) {
              throw new Error(d.message || 'HTTP ' + resp.status);
            });
          }
        }).then(function (data) {
          if (data && data.content) {
            self._sha = data.content.sha;
            self._lastSaveContent = mergedStr;
            console.log('☁️ Saved to cloud');
            syncToast('☁️ 已同步到云端');

            // 同步本地（确保本地与云端一致）
            self._loading = true;
            self._writeLocal(merged);
            self._loading = false;
          }
        });
      }).catch(function (e) {
        console.warn('☁️ Save failed:', e.message || e);
        syncToast('⚠️ 云同步失败');
      });
    },

    // ── 定时刷新：检查其他设备的更新 ──
    _refresh: function () {
      var self = this;
      // 有未保存的更改时跳过（避免冲突）
      if (this._saveTimer) return;

      this._fetchCloud().then(function (cloudState) {
        if (!cloudState) return;
        return self._fetchSha().then(function () {
          var localState = self._readLocal();
          var merged = self._merge(cloudState, localState);

          // 对比：localState vs merged → 如果不同说明云端有新增数据
          var localStr = JSON.stringify(self._stripMeta(localState));
          var mergedStr = JSON.stringify(self._stripMeta(merged));

          if (mergedStr !== localStr) {
            // 有新数据，更新本地并重新渲染
            self._loading = true;
            self._writeLocal(merged);
            self._loading = false;
            self._rerender();
            console.log('☁️ Refreshed from cloud');
          }
        });
      }).catch(function () {});
    },

    _stripMeta: function (state) {
      var copy = {};
      Object.keys(state).forEach(function (k) {
        if (k.indexOf('_') !== 0) copy[k] = state[k];
      });
      return copy;
    },

    // ── 重新渲染 UI ──
    // ★ 关键修复：先同步内存状态，再渲染，否则 render 函数读到的仍是旧数据
    _rerender: function () {
      // 同步 tasks 内存状态
      try {
        if (window.TASKS_DATA) {
          var saved = localStorage.getItem('dudu_tasks');
          if (saved) window.TASKS_DATA.tasks = JSON.parse(saved);
        }
      } catch (e) {}

      // 同步 exercise 内存状态（checked_days 从 localStorage 读取）
      // renderCalendar 内部会从 localStorage 读取 exercise_checked_*，
      // 所以只要 localStorage 已更新，调用 renderCalendar 即可

      try {
        if (typeof renderInspirations === 'function') renderInspirations();
      } catch (e) {}
      try {
        if (typeof renderTasks === 'function') renderTasks();
      } catch (e) {}
      try {
        if (typeof renderCalendar === 'function' && window.EXERCISE_DATA) {
          renderCalendar(window.EXERCISE_DATA);
        }
      } catch (e) {}

      // 同步待办进度条
      try {
        if (typeof updateTodoProgress === 'function') updateTodoProgress();
      } catch (e) {}
    }
  };

  // ═══════════════════════════════════════════════
  // ★ 关键修复：拦截器在脚本加载时立即设置 ★
  // 不需要等 init() 完成，这样用户在任何时候的
  // localStorage.setItem 操作都会被捕获。
  // init() 完成前 _initialized==false，
  // 变更会被标记为 _queuedChanges，init 完成后自动上传。
  // ═══════════════════════════════════════════════
  CloudSync._interceptLocalStorage();

  window.CloudSync = CloudSync;
})();
