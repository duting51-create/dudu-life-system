/* =====================================================================
 * 小巴提醒 · Dudu Reminder   (v2, 2026-11-12)
 * ---------------------------------------------------------------------
 * 打开网站时汇总三类提醒，弹一次卡片；也可随时点右下角铃铛查看。
 *   1) 未来 7 天内的生日 / 纪念日（数据源 IMPORTANT_DATES_DATA，农历用
 *      Intl 中文日历动态换算，不依赖会过期的 next_date 静态值）
 *   2) 灵感宝箱里超过 7 天仍未划掉的事（飞书回流 + 本地 jots + done 态）
 *   3) 运动 / 英语超过 7 天没打卡（localStorage 打卡记录）
 *
 * v2 新增「逐条分诊」：每条提醒可以单独安排去处，三档语义互不混淆
 *   本次关掉 once   → 今天不再提示这一条，明天自动回来
 *   暂时搁置 snooze → 7 天内不提示，到期自动回来
 *   永久放弃 drop   → 永不再提示这一条
 * 动作按「内容指纹」存 dudu_reminder_item_actions（跨设备同步，见 cloud-sync.js），
 * 支持 5 秒内撤销；撤销写 action:'none' 墓碑，避免云端旧记录把它顶回来。
 *
 * 设计原则：纯前端、无网络依赖、只读不写业务数据（仅写自己的免打扰/分诊标记）；
 * 任何数据源缺失都静默跳过该类别，绝不影响主站渲染。
 * ===================================================================== */
(function () {
  'use strict';

  var CFG = {
    birthdayDays: 7,      // 「临近」窗口
    staleDays: 7,         // 灵感/打卡「超过一周」阈值
    maxStaleShow: 5,      // 弹窗里最多列几条，避免刷屏
    snoozeDays: 7,        // 「暂时搁置」的时长
    undoMs: 5000,         // 撤销条保留时间
    autoDelayMs: 1400     // 等数据脚本就绪
  };
  var DISMISS_KEY = 'dudu_reminder_dismiss_date';   // 整弹窗：今天不再提醒（连角标一起静音）
  var SEEN_KEY = 'dudu_reminder_seen_date';         // 今天已经弹过一次（角标仍保留）
  var ACTIONS_KEY = 'dudu_reminder_item_actions';   // 逐条分诊动作

  /* ---------------- 通用工具 ---------------- */
  function pad(n) { return String(n).padStart(2, '0'); }
  function isoOf(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function todayISO() { return isoOf(new Date()); }
  function plusDays(n) {
    var d = new Date();
    d.setHours(12, 0, 0, 0);           // 正中午，避开夏令时边界
    d.setDate(d.getDate() + n);
    return isoOf(d);
  }
  function utcMs(iso) { return Date.parse(iso + 'T00:00:00Z'); }
  function daysFromToday(iso) { return Math.round((utcMs(iso) - utcMs(todayISO())) / 86400000); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function lsGet(key, fallback) {
    try { var v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); }
    catch (e) { return fallback; }
  }
  function lsSet(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {}
  }
  // 与前端 inspireFp 一致的归一化指纹
  function normText(t) {
    return String(t == null ? '' : t).trim().replace(/\s+/g, ' ').replace(/[~✅]/g, '');
  }
  // 🔥 11/12: 飞书 done_map 的 key 里「带编号」和「不带编号」两种都存在
  //（如 task:1.写5篇… 与 task:解决配图…），比对时必须统一去掉编号前缀，
  // 否则已划掉的任务会被误报成「超过一周没做」。
  function stripNo(s) {
    return String(s == null ? '' : s).trim()
      .replace(/^([a-z]+:)?\s*\d+[.、：:）)\-\s]+/, '$1')
      .replace(/^[❶❷❸❹❺❻❼❽❾❿]+\s*/, '')
      .replace(/\s+/g, ' ');
  }
  // 一条内容的多种等价写法（去/不去编号），用于与 done_map 双向匹配
  function variants(type, text) {
    var t = normText(text);
    var bare = stripNo(t);
    return [(type || '') + ':' + t, (type || '') + ':' + bare, t, bare];
  }
  function fp(type, text) { return (type || '') + ':' + normText(text); }
  // 拆条：优先按「1. / 1、」编号，否则按换行
  function splitLines(text) {
    var s = String(text == null ? '' : text).trim();
    if (!s) return [];
    var raw = s.split('\n'), out = [], cur = '', numbered = false;
    raw.forEach(function (line) {
      var l = line.trim();
      if (!l) return;
      var m = l.match(/^\s*\d+[.、：:）)\-\s]+(.*)$/);
      var circled = /^[❶❷❸❹❺❻❼❽❾❿]/.test(l);
      if (m || circled) {
        if (cur) out.push(cur.trim());
        cur = m ? m[1] : l.replace(/^[❶❷❸❹❺❻❼❽❾❿]+\s*/, '');
        numbered = true;
      } else {
        cur += (cur ? ' ' : '') + l;
      }
    });
    if (cur) out.push(cur.trim());
    // 单行带编号（如 "1.看电影《好朋友们》"）也要去掉编号，否则与 done_map 指纹对不上
    if (numbered) return out.filter(Boolean);
    return raw.map(function (x) { return x.trim(); }).filter(Boolean);
  }
  // 「11月6日」/「2026-11-06」→ ISO（跨年自动归到去年）
  function parseItemDate(s) {
    s = String(s == null ? '' : s).trim();
    var today = new Date(), y = today.getFullYear(), m, d;
    var m1 = s.match(/(\d{1,2})月(\d{1,2})/);
    var m2 = s.match(/(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/);
    if (m2) { y = +m2[1]; m = +m2[2]; d = +m2[3]; }
    else if (m1) { m = +m1[1]; d = +m1[2]; }
    else return null;
    if (m < 1 || m > 12 || d < 1 || d > 31) return null;
    var iso = y + '-' + pad(m) + '-' + pad(d);
    // 未来日期不可能是一条历史记录 → 归到去年
    if (utcMs(iso) > utcMs(todayISO()) + 86400000) {
      iso = (y - 1) + '-' + pad(m) + '-' + pad(d);
    }
    return iso;
  }

  /* ---------------- 逐条分诊（v2） ---------------- */
  function loadActions() {
    var a = lsGet(ACTIONS_KEY, {});
    return (a && typeof a === 'object' && !Array.isArray(a)) ? a : {};
  }
  function saveActions(a) { lsSet(ACTIONS_KEY, a); }
  // 稳定指纹：生日不带年份（明年同一个人仍被忽略），灵感按任务文本，
  // 打卡按类别（运动/英语是持续状态，不是某一条具体事件）。
  function itemFp(secKey, it) {
    if (secKey === 'dates') return 'date:' + normText(it.name) + ':' + normText(it.type);
    if (secKey === 'stale') return fp(it.type, it.text);
    return 'checkin:' + normText(it.name);
  }
  function isHidden(k, acts) {
    var e = acts[k];
    if (!e || !e.action || e.action === 'none') return false;   // 撤销墓碑 = 恢复提醒
    if (e.action === 'drop') return true;
    if (e.action === 'once') return e.until === todayISO();      // 仅今天静音
    if (e.action === 'snooze') return !!e.until && todayISO() <= e.until;
    return false;
  }

  /* ---------------- 1) 生日 / 纪念日 ---------------- */
  // 阳历 MM-DD → 下一次出现的 ISO
  function nextSolar(mmdd, fromISO) {
    var parts = String(mmdd || '').split('-');
    var m = +parts[0], d = +parts[1];
    if (!m || !d) return null;
    var y = +fromISO.slice(0, 4);
    for (var k = 0; k < 3; k++) {
      var iso = (y + k) + '-' + pad(m) + '-' + pad(d);
      if (utcMs(iso) >= utcMs(fromISO)) return iso;
    }
    return null;
  }
  // 农历 M-D → 下一次出现的 ISO（用 Intl 中文日历逐日扫描，跳过闰月）
  var _lunarFmtNum = null, _lunarFmtLong = null, _lunarOK = true;
  try {
    _lunarFmtNum = new Intl.DateTimeFormat('zh-CN-u-ca-chinese', { month: 'numeric', day: 'numeric' });
    _lunarFmtLong = new Intl.DateTimeFormat('zh-CN-u-ca-chinese', { month: 'long' });
  } catch (e) { _lunarOK = false; }
  // 不同引擎可能返回数字(7)或中文(七月/腊月/闰四月)，统一解析
  var CN_NUM = { '正': 1, '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6,
    '七': 7, '八': 8, '九': 9, '十': 10, '冬': 11, '腊': 12 };
  var CN_DAY = { '初一': 1, '初二': 2, '初三': 3, '初四': 4, '初五': 5, '初六': 6,
    '初七': 7, '初八': 8, '初九': 9, '初十': 10, '十一': 11, '十二': 12, '十三': 13,
    '十四': 14, '十五': 15, '十六': 16, '十七': 17, '十八': 18, '十九': 19, '二十': 20,
    '廿一': 21, '廿二': 22, '廿三': 23, '廿四': 24, '廿五': 25, '廿六': 26,
    '廿七': 27, '廿八': 28, '廿九': 29, '三十': 30 };
  function cnNum(s, isMonth) {
    s = String(s == null ? '' : s).trim();
    if (/^\d+$/.test(s)) return Number(s);
    if (CN_DAY[s] != null) return CN_DAY[s];
    if (isMonth) {
      var t = s.replace(/^闰/, '').replace(/月$/, '');
      if (t === '十一月' || t === '冬月') return 11;
      if (t === '十二月' || t === '腊月') return 12;
      if (t === '十月') return 10;
      if (t === '正月') return 1;
      var m = t.match(/^(.)月?$/);
      if (m && CN_NUM[m[1]] != null) return CN_NUM[m[1]];
    }
    return null;
  }
  function nextLunar(lunarStr, fromISO) {
    if (!_lunarOK) return null;
    var p = String(lunarStr || '').split('-');
    var M = +p[0], D = +p[1];
    if (!M || !D) return null;
    var base = utcMs(fromISO);
    for (var i = 0; i < 800; i++) {
      var dt = new Date(base + i * 86400000);
      var iso = dt.toISOString().slice(0, 10);
      var noon = new Date(iso + 'T12:00:00Z');
      var parts = _lunarFmtNum.formatToParts(noon);
      var mv = parts.filter(function (x) { return x.type === 'month'; })[0];
      var dv = parts.filter(function (x) { return x.type === 'day'; })[0];
      if (!mv || !dv) continue;
      var longParts = _lunarFmtLong.formatToParts(noon);
      var lm = longParts.filter(function (x) { return x.type === 'month'; })[0];
      if ((lm && lm.value.indexOf('闰') !== -1) || String(mv.value).indexOf('闰') !== -1) continue; // 闰月不算生日
      if (cnNum(mv.value, true) === M && cnNum(dv.value, false) === D) return iso;
    }
    return null;
  }
  function collectDates() {
    var dd = window.IMPORTANT_DATES_DATA;
    if (!dd || !Array.isArray(dd.list)) return [];
    var out = [], from = todayISO();
    dd.list.forEach(function (it) {
      var iso = null, label = '';
      if (it.mode === 'countdown') {
        if (it.calendar === 'lunar') {
          iso = nextLunar(it.lunar, from);
          label = '农历 ' + it.lunar;
        } else {
          iso = nextSolar(it.solar || (it.next_date || '').slice(5), from);
          label = '阳历 ' + (it.solar || '');
        }
        // Intl 不可用时退回静态 next_date 的「自动 +1 年」
        if (!iso && it.next_date) {
          var nd = new Date(it.next_date + 'T00:00:00');
          if (!isNaN(nd.getTime())) {
            var guard = 0;
            while (nd.getTime() < utcMs(from) && guard < 12) { nd.setFullYear(nd.getFullYear() + 1); guard++; }
            iso = isoOf(nd);
          }
        }
      } else if (it.type === '纪念日' && it.fixed) {
        // 结婚纪念日之类：按固定日期的月日年年循环
        iso = nextSolar(it.fixed.slice(5), from);
        label = '每年 ' + it.fixed.slice(5).replace('-', '月') + '日';
      }
      if (!iso) return;
      var days = daysFromToday(iso);
      if (days < 0 || days > CFG.birthdayDays) return;
      out.push({
        icon: it.icon || '🎉',
        name: it.name || '重要日子',
        type: it.type || '',
        when: days === 0 ? '就是今天 🎉' : days === 1 ? '明天' : '还有 ' + days + ' 天',
        sub: label || iso,
        days: days
      });
    });
    return out.sort(function (a, b) { return a.days - b.days; });
  }

  /* ---------------- 2) 灵感宝箱超期未完成 ---------------- */
  function collectStaleInspirations() {
    var doneSet = {}, deleted = {};
    var dash = window.DASHBOARD_DATA || {};
    // 飞书 done_map 的 key 里「带编号」和「不带编号」两种都存在，
    // 统一展开成「原样 + 去编号」多份，避免已划掉项被误报。
    function absorb(map) {
      Object.keys(map || {}).forEach(function (k) {
        if (!map[k]) return;
        var nk = normText(k), bare = stripNo(nk);
        doneSet[nk] = true; doneSet[bare] = true;
        if (nk.indexOf(':') !== -1) {
          var tail = nk.slice(nk.indexOf(':') + 1);
          doneSet[tail] = true; doneSet[stripNo(tail)] = true;
        }
      });
    }
    absorb(dash.inspirations_done || {});
    absorb(lsGet('dudu_inspire_done', {}));
    (lsGet('dudu_deleted_feishu_text', []) || []).forEach(function (t) {
      deleted[normText(t)] = true; deleted[stripNo(t)] = true;
    });
    (lsGet('dudu_deleted_feishu', []) || []).forEach(function (t) {
      deleted[normText(t)] = true; deleted[stripNo(t)] = true;
    });

    var seen = {}, out = [];
    function add(type, text, dateStr) {
      var t = String(text || '').trim();
      if (!t || /^[✅❌]/.test(t) || t.indexOf('~~') !== -1 || t.indexOf('✅') !== -1) return;
      var vs = variants(type, t);
      var key = fp(type, t);
      var done = vs.some(function (v) { return doneSet[v] || deleted[v]; });
      if (done || seen[key]) return;
      seen[key] = true;
      var iso = parseItemDate(dateStr);
      if (!iso) return;                       // 没有可信日期就不打扰
      var age = -daysFromToday(iso);
      if (age < CFG.staleDays) return;       // 还不到一周
      out.push({ type: type, text: t, days: age, iso: iso, icon: type === 'task' ? '📋' : '💡' });
    }
    // 与 renderInspirations 一致：实时数据优先，其次内嵌数据
    var live = window.LIVE_INSPIRATIONS_DATA;
    var items = (live && Array.isArray(live.items) && live.items.length)
      ? live.items
      : ((window.INSPIRATIONS_DATA && window.INSPIRATIONS_DATA.items)
        || (dash.inspirations && dash.inspirations.items) || []);
    items.forEach(function (row) {
      if (!row) return;
      if (row.type && row.text) {
        if (!row.done) add(row.type, row.text, row.date);
        return;
      }
      ['task', 'inspiration'].forEach(function (type) {
        splitLines(row[type] || '').forEach(function (t) { add(type, t, row.date); });
      });
    });
    // 网页本地新增的 jots
    (lsGet('dudu_jots', []) || []).forEach(function (j) {
      if (!j || j.syncPending || j.done) return;
      if (j.type !== 'task' && j.type !== 'inspiration') return;
      splitLines(j.text || '').forEach(function (t) { add(j.type, t, j.date); });
    });
    // 最久的排前面（最容易忘）
    return out.sort(function (a, b) { return b.days - a.days; });
  }

  /* ---------------- 3) 打卡超期 ---------------- */
  // 从所有 exercise_checked_YYYY-MM 里找最后一次打卡
  function lastExerciseISO() {
    var best = null;
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var key = localStorage.key(i);
        var m = key && key.match(/^exercise_checked_(\d{4})-(\d{2})$/);
        if (!m) continue;
        var arr = lsGet(key, []) || [];
        arr.forEach(function (v) {
          var iso = /^\d{4}-\d{2}-\d{2}$/.test(String(v))
            ? String(v) : (m[1] + '-' + m[2] + '-' + pad(+v));
          if (/^\d{4}-\d{2}-\d{2}$/.test(iso) && (!best || iso > best)) best = iso;
        });
      }
    } catch (e) {}
    return best;
  }
  function lastEnglishISO() {
    var best = null;
    (lsGet('dudu_english', []) || []).forEach(function (v) {
      var iso = String(v);
      if (/^\d{4}-\d{2}-\d{2}$/.test(iso) && (!best || iso > best)) best = iso;
    });
    return best;
  }
  function collectCheckins() {
    var out = [];
    [['🏃', '运动', lastExerciseISO()], ['🔤', '英语', lastEnglishISO()]].forEach(function (row) {
      var icon = row[0], name = row[1], last = row[2];
      var days = last ? -daysFromToday(last) : null;
      if (days === null) {
        out.push({ icon: icon, name: name, days: null,
          text: '还没有打过卡，今天开始记一笔吧', last: null });
      } else if (days >= CFG.staleDays) {
        out.push({ icon: icon, name: name, days: days,
          text: '已经 ' + days + ' 天没打卡了', last: last });
      }
    });
    return out;
  }

  /* ---------------- 汇总（含分诊过滤） ---------------- */
  function buildSections() {
    var s = [];
    var a, b, c;
    try { a = collectDates(); } catch (e) { a = []; }
    try { b = collectStaleInspirations(); } catch (e) { b = []; }
    try { c = collectCheckins(); } catch (e) { c = []; }
    if (a.length) s.push({ key: 'dates', title: '🎂 快到的日子', hint: '未来 7 天', items: a });
    if (b.length) s.push({ key: 'stale', title: '💡 放了一周没做的事', hint: b.length + ' 件', items: b, cap: CFG.maxStaleShow });
    if (c.length) s.push({ key: 'checkin', title: '🏃 该打卡啦', hint: '超过一周', items: c });

    // 🔥 逐条过滤：处理过的不再进弹窗、也不再计入角标。
    // hint 必须基于过滤后的条数重算，否则会出现「写着 9 件、只剩 3 行」。
    var acts = loadActions();
    return s.map(function (sec) {
      var items = sec.items.filter(function (it) { return !isHidden(itemFp(sec.key, it), acts); });
      return {
        key: sec.key, title: sec.title, items: items, cap: sec.cap,
        hint: sec.key === 'stale' ? (items.length + ' 件') : sec.hint
      };
    }).filter(function (sec) { return sec.items.length > 0; });
  }
  function totalOf(sections) {
    return sections.reduce(function (n, s) { return n + s.items.length; }, 0);
  }

  /* ---------------- 样式 ---------------- */
  var CSS = [
    '.dr-fab{position:fixed;right:22px;bottom:22px;z-index:99990;width:52px;height:52px;border:none;',
      'border-radius:50%;background:#fff;box-shadow:0 6px 22px rgba(45,45,58,.16);cursor:pointer;',
      'font-size:1.35rem;display:flex;align-items:center;justify-content:center;transition:transform .2s,box-shadow .2s;',
      'border:1px solid rgba(45,45,58,.06)}',
    '.dr-fab:hover{transform:translateY(-3px);box-shadow:0 10px 26px rgba(45,45,58,.22)}',
    '.dr-fab .dr-badge{position:absolute;top:-3px;right:-3px;min-width:19px;height:19px;padding:0 5px;',
      'border-radius:10px;background:#E8739B;color:#fff;font-size:.68rem;font-weight:700;line-height:19px;text-align:center}',
    '.dr-mask{position:fixed;inset:0;z-index:99998;background:rgba(45,45,58,.32);',
      'backdrop-filter:blur(3px);display:flex;align-items:center;justify-content:center;padding:18px;',
      'opacity:0;transition:opacity .22s}',
    '.dr-mask.on{opacity:1}',
    '.dr-card{width:min(100%,470px);max-height:min(84vh,720px);overflow:auto;background:#fff;',
      'border-radius:22px;box-shadow:0 22px 60px rgba(45,45,58,.24);padding:22px 22px 18px;',
      'transform:translateY(14px) scale(.98);transition:transform .24s cubic-bezier(.2,.9,.3,1);',
      'font-family:inherit;color:#2D2D3A}',
    '.dr-mask.on .dr-card{transform:none}',
    '.dr-head{display:flex;align-items:flex-start;gap:11px;margin-bottom:4px}',
    '.dr-head-emoji{font-size:1.7rem;line-height:1.2}',
    '.dr-h1{font-size:1.12rem;font-weight:800;margin:0}',
    '.dr-sub{font-size:.76rem;color:#8B8B9A;margin-top:3px}',
    '.dr-x{margin-left:auto;background:none;border:none;font-size:1.15rem;color:#9A9AA8;cursor:pointer;padding:2px 6px}',
    '.dr-x:hover{color:#2D2D3A}',
    '.dr-sec{margin-top:18px}',
    '.dr-sec-t{display:flex;align-items:baseline;gap:8px;font-size:.85rem;font-weight:700;',
      'padding-bottom:7px;border-bottom:1px solid rgba(45,45,58,.07)}',
    '.dr-sec-h{margin-left:auto;font-size:.7rem;color:#9A9AA8;font-weight:500}',
    '.dr-row{display:flex;align-items:flex-start;gap:9px;padding:9px 2px;font-size:.82rem;line-height:1.5;flex-wrap:wrap}',
    '.dr-row+.dr-row{border-top:1px dashed rgba(45,45,58,.07)}',
    '.dr-ico{flex:0 0 auto;font-size:.95rem}',
    '.dr-txt{flex:1;min-width:0;word-break:break-word}',
    '.dr-txt small{display:block;color:#9A9AA8;font-size:.7rem;margin-top:2px}',
    '.dr-when{flex:0 0 auto;font-size:.72rem;font-weight:700;color:#C9B1D0;white-space:nowrap;padding-top:2px}',
    '.dr-acts{flex:0 0 100%;display:flex;gap:6px;flex-wrap:wrap;margin:3px 0 1px 24px}',
    '.dr-act{border:1px solid rgba(45,45,58,.10);background:#FAF8FC;color:#7A7A8C;border-radius:8px;',
      'padding:3px 9px;font-size:.66rem;font-weight:600;cursor:pointer;line-height:1.6;font-family:inherit}',
    '.dr-act:hover{background:#F0E9F4;color:#5A4A66;border-color:rgba(160,130,180,.35)}',
    '.dr-act.warn:hover{background:#FBE9EF;border-color:rgba(232,115,155,.40);color:#B95078}',
    '.dr-more{font-size:.72rem;color:#9A9AA8;padding:6px 2px 0}',
    '.dr-empty{text-align:center;color:#9A9AA8;font-size:.85rem;padding:26px 0 12px}',
    '.dr-legend{font-size:.68rem;color:#8B8B9A;line-height:1.7;margin-top:14px;padding:9px 11px;',
      'background:#FBF9FC;border-radius:10px}',
    '.dr-undo{display:flex;align-items:center;gap:8px;font-size:.72rem;color:#7A7A8C;',
      'margin-top:10px;padding:8px 11px;background:#F4EFF7;border-radius:10px}',
    '.dr-undo button{margin-left:auto;border:none;background:none;color:#9B6FB0;font-weight:700;',
      'font-size:.72rem;cursor:pointer;font-family:inherit}',
    '.dr-foot{display:flex;gap:9px;margin-top:20px;padding-top:14px;border-top:1px solid rgba(45,45,58,.07)}',
    '.dr-btn{flex:1;border-radius:12px;padding:10px 12px;font-size:.82rem;font-weight:700;cursor:pointer;',
      'border:1px solid rgba(45,45,58,.10);background:#fff;color:#5A5A6B;font-family:inherit}',
    '.dr-btn:hover{background:#FAF8FC}',
    '.dr-btn.primary{background:#C9B1D0;border-color:#C9B1D0;color:#fff}',
    '.dr-btn.primary:hover{background:#B99CC2}',
    '@media(max-width:520px){.dr-fab{right:15px;bottom:15px;width:48px;height:48px}',
      '.dr-card{padding:18px 16px 14px;border-radius:18px}.dr-acts{margin-left:0}}'
  ].join('');

  /* ---------------- DOM ---------------- */
  var mask = null, fab = null, sectionsCache = [];
  var lastAction = null, undoTimer = null, closeCard = null;

  var ACT_LABELS = [
    ['once', '本次关掉', '今天不再提示这条，明天自动回来'],
    ['snooze', '暂时搁置', '7 天内不提示，到期自动回来'],
    ['drop', '永久放弃', '这条以后都不再提醒']
  ];

  function renderCard(sections) {
    var total = totalOf(sections);
    var body = '';
    if (!total) {
      body = '<div class="dr-empty">都安排好啦，今天没有要提醒的事 🌿</div>';
    } else {
      sections.forEach(function (sec) {
        body += '<div class="dr-sec"><div class="dr-sec-t"><span>' + esc(sec.title) +
          '</span><span class="dr-sec-h">' + esc(sec.hint) + '</span></div>';
        var list = sec.cap ? sec.items.slice(0, sec.cap) : sec.items;
        list.forEach(function (it) {
          var when = sec.key === 'dates' ? it.when
            : sec.key === 'stale' ? (it.days + ' 天')
            : (it.days === null ? '未开始' : it.days + ' 天');
          var main = sec.key === 'dates'
            ? esc(it.name) + (it.type ? ' · ' + esc(it.type) : '')
            : esc(it.text || it.name);
          var sub = sec.key === 'dates' ? esc(it.sub)
            : sec.key === 'checkin' ? ('上次：' + (it.last || '—'))
            : (it.type === 'task' ? '📋 任务' : '💡 灵感');
          var k = esc(itemFp(sec.key, it));
          var acts = ACT_LABELS.map(function (a) {
            return '<button type="button" class="dr-act' + (a[0] === 'drop' ? ' warn' : '') +
              '" data-act="' + a[0] + '" data-fp="' + k + '" title="' + esc(a[2]) + '">' +
              a[1] + '</button>';
          }).join('');
          body += '<div class="dr-row"><span class="dr-ico">' + (it.icon || '•') + '</span>' +
            '<span class="dr-txt">' + main + '<small>' + sub + '</small></span>' +
            '<span class="dr-when">' + esc(when) + '</span>' +
            '<span class="dr-acts">' + acts + '</span></div>';
        });
        if (sec.cap && sec.items.length > sec.cap) {
          body += '<div class="dr-more">…还有 ' + (sec.items.length - sec.cap) + ' 件，处理完这几条会自动补上</div>';
        }
        body += '</div>';
      });
      body += '<div class="dr-legend">每条都能单独安排：' +
        '<b>本次关掉</b>＝今天不提、明天回来 · ' +
        '<b>暂时搁置</b>＝7 天 · <b>永久放弃</b>＝不再提醒。' +
        '不点就是继续提醒；真正做完了，去灵感宝箱划掉更彻底。</div>';
    }
    var undoHtml = lastAction
      ? '<div class="dr-undo">已安排好啦 <button type="button" id="drUndo">撤销</button></div>' : '';
    var d = new Date();
    var dateLabel = (d.getMonth() + 1) + '月' + d.getDate() + '日';
    return '<div class="dr-card" role="dialog" aria-label="小巴提醒">' +
      '<div class="dr-head"><span class="dr-head-emoji">🔔</span><div>' +
      '<h2 class="dr-h1">小巴提醒</h2><div class="dr-sub">' + esc(dateLabel) + ' · ' +
      (total ? '有 ' + total + ' 件事想跟你说' : '一切都在轨道上') + '</div></div>' +
      '<button class="dr-x" id="drClose" aria-label="关闭">✕</button></div>' +
      body + undoHtml +
      '<div class="dr-foot">' +
      '<button class="dr-btn" id="drMute">今天不再提醒</button>' +
      '<button class="dr-btn primary" id="drOk">知道啦</button>' +
      '</div></div>';
  }

  function repaint() {
    sectionsCache = buildSections();
    if (mask) mask.innerHTML = renderCard(sectionsCache);
    updateBadge();
    if (undoTimer) { clearTimeout(undoTimer); undoTimer = null; }
    if (lastAction) {
      undoTimer = setTimeout(function () {
        lastAction = null;
        if (mask) mask.innerHTML = renderCard(sectionsCache);
      }, CFG.undoMs);
    }
  }

  function applyAction(key, action) {
    if (!key || !action) return;
    var acts = loadActions();
    var prev = Object.prototype.hasOwnProperty.call(acts, key) ? acts[key] : null;
    var e = { action: action, updatedAt: Date.now() };
    if (action === 'once') e.until = todayISO();
    else if (action === 'snooze') e.until = plusDays(CFG.snoozeDays);
    else if (action !== 'drop') return;
    acts[key] = e;
    saveActions(acts);
    lastAction = { key: key, prev: prev };
    repaint();
  }

  function undoAction() {
    if (!lastAction) return;
    var acts = loadActions();
    // 写墓碑而不是 delete：否则云端那条旧动作会在下次合并时把撤销顶回来
    acts[lastAction.key] = lastAction.prev ||
      { action: 'none', updatedAt: Date.now(), until: null };
    saveActions(acts);
    lastAction = null;
    repaint();
  }

  function openReminder(manual) {
    lastAction = null;
    sectionsCache = buildSections();
    if (!mask) return;
    // 只要打开过（自动弹或手动点铃铛），今天就不重复自动弹；角标仍然保留。
    lsSet(SEEN_KEY, todayISO());
    mask.innerHTML = renderCard(sectionsCache);
    mask.style.display = 'flex';
    requestAnimationFrame(function () { mask.classList.add('on'); });
    closeCard = function () {
      mask.classList.remove('on');
      setTimeout(function () { mask.style.display = 'none'; }, 220);
      updateBadge();
    };
    // 用 addEventListener 而非 document.onkeydown，避免覆盖主站已有的键盘逻辑
    if (!mask._escBound) {
      mask._escBound = true;
      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && mask.style.display !== 'none' && closeCard) closeCard();
      });
    }
  }

  // 事件委托：只绑一次，重绘后无需重新绑定
  function onMaskClick(e) {
    var t = e.target;
    var act = t && t.getAttribute ? t.getAttribute('data-act') : null;
    if (act) {
      applyAction(t.getAttribute('data-fp'), act);
      return;
    }
    var id = t && t.id;
    if (id === 'drUndo') { undoAction(); return; }
    if (id === 'drClose' && closeCard) { closeCard(); return; }
    if (id === 'drOk') { lsSet(SEEN_KEY, todayISO()); if (closeCard) closeCard(); return; }
    if (id === 'drMute') { lsSet(DISMISS_KEY, todayISO()); if (closeCard) closeCard(); return; }
    if (t === mask && closeCard) closeCard();
  }

  function updateBadge() {
    if (!fab) return;
    var n = totalOf(buildSections());
    // 「今天不再提醒」是整弹窗静音：连数字一起收起来
    if (String(lsGet(DISMISS_KEY, '')) === todayISO()) n = 0;
    var old = fab.querySelector('.dr-badge');
    if (old) old.remove();
    if (n > 0) {
      var b = document.createElement('span');
      b.className = 'dr-badge';
      b.textContent = n > 99 ? '99+' : n;
      fab.appendChild(b);
    }
    fab.title = n > 0 ? ('小巴提醒 · ' + n + ' 件事') : '小巴提醒 · 今天没有待办提醒';
  }

  function mount() {
    if (document.getElementById('drFab')) return;
    var style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    fab = document.createElement('button');
    fab.id = 'drFab';
    fab.className = 'dr-fab';
    fab.type = 'button';
    fab.innerHTML = '🔔';
    fab.onclick = function () { openReminder(true); };
    document.body.appendChild(fab);

    mask = document.createElement('div');
    mask.className = 'dr-mask';
    mask.style.display = 'none';
    mask.onclick = onMaskClick;
    document.body.appendChild(mask);

    updateBadge();
    // 数据可能晚到，稍后刷新角标；每天首次打开自动弹一次
    setTimeout(function () {
      updateBadge();
      if (String(lsGet(DISMISS_KEY, '')) === todayISO()) return;
      if (String(lsGet(SEEN_KEY, '')) === todayISO()) return;
      if (totalOf(buildSections()) > 0) openReminder(false);
    }, CFG.autoDelayMs);
    // 云端同步合并完成往往晚于首屏，补一次刷新让角标跟上跨设备动作
    setTimeout(updateBadge, 3800);
    // 跨零点后重新判断
    setInterval(updateBadge, 10 * 60 * 1000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
  // 供主站在数据异步刷新后手动调用；act/actions 便于排查
  window.DuduReminder = {
    refresh: updateBadge,
    open: openReminder,
    act: applyAction,
    undo: undoAction,
    actions: loadActions,
    sections: function () { return buildSections(); }
  };
})();
