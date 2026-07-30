/**
 * 多端同步：
 * - Worker KV 同步任务勾选、运动打卡等设备状态
 * - 飞书 Sheet 作为灵感宝箱的实时数据源
 * - 同步口令仅保存在当前设备，不进入公开源码
 */
(function () {
  'use strict';

  var API_BASE = 'https://dudu-life-sync.duting51.workers.dev';
  var KEY_STORAGE = 'dudu_sync_key';
  var SYNC_KEYS = [
    'dudu_tasks',
    'dudu_last_tasks_date',
    'dudu_raw_tasks',
    'dudu_jots',
    'dudu_inspire_done',
    'dudu_deleted_feishu'
  ];
  var SYNC_PREFIXES = ['exercise_checked_'];
  var pendingKeyPromise = null;

  function syncToast(message) {
    try {
      if (typeof window.showToast === 'function') window.showToast(message);
    } catch (error) {}
  }

  function ensureSyncKey() {
    var key = localStorage.getItem(KEY_STORAGE);
    if (key) return Promise.resolve(key);
    if (pendingKeyPromise) return pendingKeyPromise;

    pendingKeyPromise = new Promise(function (resolve) {
      var overlay = document.createElement('div');
      overlay.id = 'dudu-sync-setup';
      overlay.style.cssText = 'position:fixed;inset:0;background:rgba(45,45,58,.46);z-index:100000;display:flex;align-items:center;justify-content:center;padding:20px;';
      overlay.innerHTML =
        '<div style="width:min(92vw,390px);background:#fffdf8;border-radius:20px;padding:24px;box-shadow:0 18px 60px rgba(45,45,58,.24);font-family:inherit;">' +
          '<div style="font-size:1.05rem;font-weight:700;color:#2d2d3a;margin-bottom:8px;">☁️ 开启手机与电脑同步</div>' +
          '<div style="font-size:.8rem;line-height:1.7;color:#77758a;margin-bottom:14px;">请输入同步口令。口令只保存在当前设备，不会写入公开网站源码。</div>' +
          '<input id="dudu-sync-key-input" type="password" autocomplete="current-password" placeholder="输入同步口令" style="width:100%;box-sizing:border-box;border:1.5px solid rgba(201,177,208,.55);border-radius:12px;padding:11px 12px;font:inherit;font-size:.88rem;outline:none;background:white;">' +
          '<div id="dudu-sync-key-error" style="min-height:18px;margin-top:5px;font-size:.72rem;color:#c47070;"></div>' +
          '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:8px;">' +
            '<button id="dudu-sync-skip" type="button" style="border:1px solid rgba(45,45,58,.12);background:white;border-radius:10px;padding:8px 13px;font:inherit;font-size:.78rem;cursor:pointer;">暂不设置</button>' +
            '<button id="dudu-sync-confirm" type="button" style="border:0;background:#c9b1d0;color:#2d2d3a;border-radius:10px;padding:8px 15px;font:inherit;font-size:.78rem;font-weight:700;cursor:pointer;">保存并同步</button>' +
          '</div>' +
        '</div>';
      document.body.appendChild(overlay);

      var input = overlay.querySelector('#dudu-sync-key-input');
      var error = overlay.querySelector('#dudu-sync-key-error');
      var finish = function (value) {
        overlay.remove();
        pendingKeyPromise = null;
        resolve(value);
      };
      overlay.querySelector('#dudu-sync-confirm').addEventListener('click', function () {
        var value = input.value.trim();
        if (value.length < 16) {
          error.textContent = '口令格式不正确，请检查后重试';
          input.focus();
          return;
        }
        localStorage.setItem(KEY_STORAGE, value);
        finish(value);
      });
      overlay.querySelector('#dudu-sync-skip').addEventListener('click', function () {
        finish('');
      });
      input.addEventListener('keydown', function (event) {
        if (event.key === 'Enter') overlay.querySelector('#dudu-sync-confirm').click();
      });
      setTimeout(function () { input.focus(); }, 50);
    });
    return pendingKeyPromise;
  }

  function apiRequest(path, options) {
    return ensureSyncKey().then(function (key) {
      if (!key) throw new Error('尚未设置同步口令');
      var requestOptions = options || {};
      requestOptions.headers = Object.assign({}, requestOptions.headers || {}, {
        'X-Dudu-Sync-Key': key
      });
      return fetch(API_BASE + path, requestOptions).then(function (response) {
        return response.json().catch(function () { return {}; }).then(function (data) {
          if (response.status === 401) {
            localStorage.removeItem(KEY_STORAGE);
            throw new Error('同步口令无效，请重新输入');
          }
          if (!response.ok || data.status === 'error') {
            throw new Error(data.message || ('HTTP ' + response.status));
          }
          return data;
        });
      });
    });
  }

  function shouldSync(key) {
    if (SYNC_KEYS.indexOf(key) !== -1) return true;
    return SYNC_PREFIXES.some(function (prefix) { return key.indexOf(prefix) === 0; });
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
        self._loading = true;
        return self._fetchCloud().then(function (cloudState) {
          var merged = self._merge(cloudState || {}, self._readLocal());
          self._writeLocal(merged);
          self._loading = false;
          self._initialized = true;
          self._rerender();
          if (!cloudState || !Object.keys(cloudState).length || self._queuedChanges) {
            self._queuedChanges = false;
            return self.save();
          }
        }).then(function () {
          setInterval(function () { self._refresh(); }, 10000);
          setInterval(function () { FeishuSync.refresh(false).catch(function () {}); }, 30000);
          document.addEventListener('visibilitychange', function () {
            if (!document.hidden) {
              self._refresh(true);
              FeishuSync.refresh(false);
            }
          });
        });
      }).catch(function (error) {
        self._loading = false;
        self._initialized = true;
        console.warn('Cloud sync init failed:', error);
        syncToast('云同步连接失败：' + error.message);
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

        if (key.indexOf('exercise_checked_') === 0) {
          var days = {};
          (Array.isArray(cloudValue) ? cloudValue : [])
            .concat(Array.isArray(localValue) ? localValue : [])
            .forEach(function (day) { days[day] = true; });
          merged[key] = Object.keys(days);
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
          merged[key] = Object.assign({}, cloudValue || {}, localValue || {});
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

        if (key === 'dudu_tasks') {
          var cloudDate = cloud.dudu_last_tasks_date || '';
          var localDate = local.dudu_last_tasks_date || '';
          if (cloudDate === localDate && cloudDate) {
            var cloudTasks = Array.isArray(cloudValue) ? cloudValue : [];
            var localTasks = Array.isArray(localValue) ? localValue : [];
            var source = localTasks.length ? localTasks : cloudTasks;
            merged[key] = source.map(function (task, index) {
              var peer = cloudTasks[index];
              if (peer && peer.text === task.text) {
                return Object.assign({}, task, { done: Boolean(task.done || peer.done) });
              }
              return task;
            });
          } else {
            merged[key] = localDate >= cloudDate ? (localValue || cloudValue) : (cloudValue || localValue);
          }
          return;
        }

        if (key === 'dudu_last_tasks_date') {
          merged[key] = (localValue || '') >= (cloudValue || '') ? localValue : cloudValue;
          return;
        }

        merged[key] = localValue !== undefined ? localValue : cloudValue;
      });

      merged._meta = { last_updated: new Date().toISOString(), version: 3 };
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
          self._loading = true;
          self._writeLocal(merged);
          self._loading = false;
          self._rerender();
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

    _rerender: function () {
      try {
        if (window.TASKS_DATA) {
          var tasks = localStorage.getItem('dudu_tasks');
          if (tasks) window.TASKS_DATA.tasks = JSON.parse(tasks);
        }
      } catch (error) {}
      try { if (typeof renderTasks === 'function') renderTasks(); } catch (error) {}
      try { if (typeof renderInspirations === 'function') renderInspirations(); } catch (error) {}
      try {
        if (typeof renderCalendar === 'function' && window.EXERCISE_DATA) {
          renderCalendar(window.EXERCISE_DATA);
        }
      } catch (error) {}
      try { if (typeof updateTodoProgress === 'function') updateTodoProgress(); } catch (error) {}
    }
  };

  var FeishuSync = {
    refresh: function (notify) {
      return apiRequest('/api/inspirations', { cache: 'no-store' }).then(function (data) {
        window.LIVE_INSPIRATIONS_DATA = data;
        if (typeof renderInspirations === 'function') renderInspirations();
        if (notify) syncToast('飞书灵感数据已更新');
        return data;
      }).catch(function (error) {
        console.warn('Feishu refresh failed:', error);
        if (notify) syncToast('飞书刷新失败：' + error.message);
        throw error;
      });
    },

    mutate: function (payload) {
      return apiRequest('/api/inspirations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      }).then(function (data) {
        var live = window.LIVE_INSPIRATIONS_DATA || { items: [] };
        live.items = Array.isArray(live.items) ? live.items : [];
        if (payload.action === 'create' && data.item) {
          live.items.push(data.item);
        } else if (payload.action === 'delete') {
          live.items = live.items.filter(function (item) { return item.id !== payload.id; });
        } else if (payload.action === 'update') {
          live.items.forEach(function (item) {
            if (item.id === payload.id) item.text = payload.text;
          });
        } else if (payload.action === 'reclassify') {
          live.items.forEach(function (item) {
            if (item.id === payload.id) item.type = payload.type;
          });
        }
        window.LIVE_INSPIRATIONS_DATA = live;
        if (typeof renderInspirations === 'function') renderInspirations();

        // 飞书写入后偶尔需要短暂时间才能在读取接口中可见。
        return new Promise(function (resolve) {
          setTimeout(resolve, 800);
        }).then(function () {
          return FeishuSync.refresh(false);
        }).catch(function () {
          return data;
        });
      });
    }
  };

  CloudSync._interceptLocalStorage();
  window.CloudSync = CloudSync;
  window.FeishuSync = FeishuSync;
})();
