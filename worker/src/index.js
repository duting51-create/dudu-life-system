const FEISHU_API = "https://open.feishu.cn/open-apis";
const SHEET_RANGE = "A1:G125";
const STATE_KEY = "dudu-user-state";
const MAX_STATE_BYTES = 100 * 1024;

// 用用户自己设置的同步口令作为 KV 命名空间（不再是固定 env.SYNC_KEY），
// 这样两端填同一个口令即可共享同一份数据，无需知道任何服务器密钥。
function stateKeyFor(request) {
  const supplied = (request.headers.get("X-Dudu-Sync-Key") || "").trim();
  return supplied || STATE_KEY;
}

const TYPE_CONFIG = {
  inspiration: { column: "D", index: 3, marker: "💡" },
  task: { column: "E", index: 4, marker: "" },
  harvest: { column: "F", index: 5, marker: "" },
  mood: { column: "G", index: 6, marker: "" },
};

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const cors = corsHeaders(origin, env);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return json({ status: "ok" }, 200, cors);
    }

    if (!isAuthorized(request, env)) {
      return json({ status: "error", message: "同步口令无效" }, 401, cors);
    }

    try {
      if (url.pathname === "/api/state" && request.method === "GET") {
        const state = await env.DUDU_STATE.get(stateKeyFor(request), "json");
        return json(state || {}, 200, cors);
      }

      if (url.pathname === "/api/state" && request.method === "PUT") {
        const raw = await request.text();
        if (new TextEncoder().encode(raw).byteLength > MAX_STATE_BYTES) {
          return json({ status: "error", message: "同步数据过大" }, 413, cors);
        }
        const state = JSON.parse(raw || "{}");
        state._server_updated_at = new Date().toISOString();
        await env.DUDU_STATE.put(stateKeyFor(request), JSON.stringify(state));
        return json({ status: "ok", updated_at: state._server_updated_at }, 200, cors);
      }

      if (url.pathname === "/api/inspirations" && request.method === "GET") {
        const result = await readTodayInspirations(env);
        return json({ status: "ok", ...result }, 200, cors);
      }

      if (url.pathname === "/api/inspirations" && request.method === "POST") {
        const body = await request.json();
        const result = await mutateInspiration(env, body);
        return json({ status: "ok", ...result }, 200, cors);
      }

      if (url.pathname === "/api/trigger-daily" && request.method === "POST") {
        const board = await buildDailyBoard(env);
        const js = `window.DAILY_BOARD = ${JSON.stringify(board, null, 2)};\n`;
        await writeToGithub(env, "feishu_data/daily_board.js", js);
        return json({ status: "ok", date: board.date, written: "feishu_data/daily_board.js" }, 200, cors);
      }

      return json({ status: "error", message: "Not found" }, 404, cors);
    } catch (error) {
      console.error(error);
      return json(
        { status: "error", message: error.message || "服务器处理失败" },
        500,
        cors,
      );
    }
  },

  // 每日定时（由 wrangler.jsonc 的 triggers.crons 触发，UTC 01:00 = 北京时间 09:00）：
  // 从飞书「每日表格」拉取今天的行，生成 feishu_data/daily_board.js 并写回 GitHub Pages 仓库。
  // 这样「今日安排 / 灵感宝箱 / 备忘」不再依赖本地 Mac 与代理，云端定时即可更新。
  async scheduled(event, env) {
    try {
      const board = await buildDailyBoard(env);
      const js = `window.DAILY_BOARD = ${JSON.stringify(board, null, 2)};\n`;
      await writeToGithub(env, "feishu_data/daily_board.js", js);
      console.log("daily board written:", board.date);
    } catch (err) {
      console.error("scheduled daily-board failed:", err);
    }
  },
};

function corsHeaders(origin, env) {
  const allowed = new Set([
    env.SITE_ORIGIN,
    "http://localhost:3847",
    "http://127.0.0.1:3847",
  ]);
  return {
    "Access-Control-Allow-Origin": allowed.has(origin) ? origin : env.SITE_ORIGIN,
    "Access-Control-Allow-Headers": "Content-Type, X-Dudu-Sync-Key",
    "Access-Control-Allow-Methods": "GET, PUT, POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
    "Cache-Control": "no-store",
  };
}

function json(value, status, headers) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { ...headers, "Content-Type": "application/json; charset=utf-8" },
  });
}

function isAuthorized(request, env) {
  // 用户的同步口令即命名空间：任意 ≥16 位口令都被接受，作为各自独立的数据分区。
  const supplied = (request.headers.get("X-Dudu-Sync-Key") || "").trim();
  return supplied.length >= 16;
}

async function getTenantToken(env) {
  const response = await fetch(`${FEISHU_API}/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      app_id: env.FEISHU_APP_ID,
      app_secret: env.FEISHU_APP_SECRET,
    }),
  });
  const data = await response.json();
  if (!response.ok || data.code !== 0) {
    throw new Error(`飞书授权失败：${data.msg || response.status}`);
  }
  return data.tenant_access_token;
}

async function readSheet(env, token) {
  const range = `${env.SHEET_ID}!${SHEET_RANGE}`;
  const response = await fetch(
    `${FEISHU_API}/sheets/v2/spreadsheets/${env.SPREADSHEET_TOKEN}/values/${range}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const data = await response.json();
  if (!response.ok || data.code !== 0) {
    throw new Error(`读取飞书 Sheet 失败：${data.msg || response.status}`);
  }
  return data.data?.valueRange?.values || [];
}

async function updateCell(env, token, column, rowNumber, value) {
  const range = `${env.SHEET_ID}!${column}${rowNumber}:${column}${rowNumber}`;
  const response = await fetch(
    `${FEISHU_API}/sheets/v2/spreadsheets/${env.SPREADSHEET_TOKEN}/values`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        valueRange: { range, values: [[value]] },
      }),
    },
  );
  const data = await response.json();
  if (!response.ok || data.code !== 0) {
    throw new Error(`写入飞书 Sheet 失败：${data.msg || response.status}`);
  }
}

// 以富文本（带样式）方式写入单元格，用于保留 / 设置删除线（划线）等样式。
async function updateCellRich(env, token, column, rowNumber, segments) {
  const range = `${env.SHEET_ID}!${column}${rowNumber}:${column}${rowNumber}`;
  const response = await fetch(
    `${FEISHU_API}/sheets/v2/spreadsheets/${env.SPREADSHEET_TOKEN}/values`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        valueRange: { range, values: [[segments]] },
      }),
    },
  );
  const data = await response.json();
  if (!response.ok || data.code !== 0) {
    throw new Error(`写入飞书 Sheet 失败：${data.msg || response.status}`);
  }
}

// 把 [{ text, struck }] 行数组按编号写入单元格，struck 为 true 的行加删除线样式（划线）。
async function writeLinesRich(env, token, column, rowNumber, lines) {
  const segments = [];
  lines.forEach((lineObj, idx) => {
    segments.push({
      type: "text",
      text: `${idx + 1}.${lineObj.text}`,
      segmentStyle: { strikeThrough: lineObj.struck === true },
    });
    if (idx < lines.length - 1) {
      segments.push({ type: "text", text: "\n", segmentStyle: {} });
    }
  });
  await updateCellRich(env, token, column, rowNumber, segments);
}

function shanghaiToday() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
  };
}

function cellText(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((segment) => (typeof segment === "object" ? segment.text || "" : segment))
      .join("");
  }
  return String(value);
}

function dateCellMatches(value, today) {
  if (typeof value === "number") {
    const date = new Date(Date.UTC(1899, 11, 30 + Math.trunc(value)));
    return (
      date.getUTCFullYear() === today.year &&
      date.getUTCMonth() + 1 === today.month &&
      date.getUTCDate() === today.day
    );
  }
  const text = cellText(value);
  return [
    `${today.month}月${today.day}日`,
    `${today.month}/${today.day}`,
    `${today.year}-${String(today.month).padStart(2, "0")}-${String(today.day).padStart(2, "0")}`,
    `${today.year}/${today.month}/${today.day}`,
  ].some((pattern) => text.includes(pattern));
}

function findTodayRow(rows) {
  const today = shanghaiToday();
  for (let index = 0; index < rows.length; index += 1) {
    if (rows[index]?.length && dateCellMatches(rows[index][0], today)) {
      return { rowNumber: index + 1, row: rows[index], today };
    }
  }
  throw new Error("飞书 Sheet 中没有找到今天的日期行");
}

function shanghaiDateKey(date) {
  return `${date.year}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`;
}

function dateCellKey(value, today) {
  if (typeof value === "number") {
    const date = new Date(Date.UTC(1899, 11, 30 + Math.trunc(value)));
    return date.toISOString().slice(0, 10);
  }

  const text = cellText(value);
  let match = text.match(/(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})日?/);
  let year;
  let month;
  let day;
  if (match) {
    year = Number(match[1]);
    month = Number(match[2]);
    day = Number(match[3]);
  } else {
    match = text.match(/(\d{1,2})月(\d{1,2})日|(\d{1,2})\/(\d{1,2})/);
    if (!match) return "";
    year = today.year;
    month = Number(match[1] || match[3]);
    day = Number(match[2] || match[4]);
    const tentative = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    if (tentative > shanghaiDateKey(today)) year -= 1;
  }
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function findPreviousRow(rows, today) {
  const todayKey = shanghaiDateKey(today);
  let previous = null;
  for (let index = 0; index < rows.length; index += 1) {
    const key = dateCellKey(rows[index]?.[0], today);
    if (!key || key >= todayKey) continue;
    if (!previous || key > previous.dateKey) {
      previous = { rowNumber: index + 1, row: rows[index], dateKey: key };
    }
  }
  return previous;
}

function parseLines(value) {
  return cellText(value)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) =>
      line
        .replace(/^\d+[.、）)\-\s]+/, "")
        .replace(/^[❶❷❸❹❺❻❼❽❾❿]+\s*/, "")
        .trim(),
    );
}

function serializeLines(lines) {
  return lines.map((line, index) => `${index + 1}.${line}`).join("\n");
}

function displayText(type, value) {
  if (type !== "inspiration") return value;
  return value.replace(/^💡\s*/, "").trim();
}

function storedText(type, value) {
  const clean = value.trim();
  return type === "inspiration" ? `💡 ${clean}` : clean;
}

// 去掉行首编号（1. / ❶ / 1、等），保留标记（💡）与正文
function stripLeadingNumber(raw) {
  return String(raw)
    .replace(/^\d+[.、）)\-\s]+/, "")
    .replace(/^[❶❷❸❹❺❻❼❽❾❿]+\s*/, "")
    .trim();
}

// 将单元格原始值（可能是纯字符串，也可能是富文本段数组）归一化为 {text, strike} 段列表。
// Feishu 的删除线(划线)以富文本段 segmentStyle.strikeThrough 形式存在，需从段样式中读取。
// ⚠️ 字段名是 segmentStyle（不是 style），写错飞书会静默忽略，导致划线永远落不下去。
function normalizeSegments(value) {
  if (value == null) return [];
  if (typeof value === "string") return [{ text: value, strike: false }];
  if (Array.isArray(value)) {
    return value.map((seg) => {
      if (typeof seg === "string") return { text: seg, strike: false };
      const segmentStyle = (seg && seg.segmentStyle) ? seg.segmentStyle : {};
      const strike = Boolean(segmentStyle.strikeThrough) || Boolean(segmentStyle.strike);
      return { text: seg && typeof seg.text === "string" ? seg.text : "", strike };
    });
  }
  return [{ text: String(value), strike: false }];
}

// 把一列单元格值按行拆分，返回 [{ raw, struck }]。
// raw 保留原始行文本（含编号与 💡 标记），struck 表示该行是否被飞书划线（删除线）。
function getColumnLinesWithStyle(value) {
  const segments = normalizeSegments(value);
  const lines = [];
  let cur = { text: "", struck: false };
  for (const seg of segments) {
    const parts = String(seg.text).split("\n");
    for (let i = 0; i < parts.length; i += 1) {
      if (i > 0) {
        lines.push(cur);
        cur = { text: "", struck: false };
      }
      if (parts[i].length) {
        cur.text += parts[i];
        if (seg.strike) cur.struck = true;
      }
    }
  }
  lines.push(cur);
  return lines
    .filter((l) => l.text.trim().length)
    .map((l) => ({ raw: l.text.trim(), struck: l.struck }));
}

function listItems(rowNumber, row, date = shanghaiToday()) {
  const items = [];
  for (const [type, config] of Object.entries(TYPE_CONFIG)) {
    const lines = getColumnLinesWithStyle(row[config.index]);
    lines.forEach((lineObj, sourceIndex) => {
      const cleaned = stripLeadingNumber(lineObj.raw);
      if (type === "inspiration" && !cleaned.startsWith(config.marker)) return;
      const display = displayText(type, cleaned);
      if (!display) return;
      items.push({
        id: `live_${rowNumber}_${config.column}_${sourceIndex}`,
        date: `${date.month}月${date.day}日`,
        type,
        text: display,
        done: lineObj.struck,
        sourceIndex,
      });
    });
  }
  return items;
}

// 跨天延续（只读，绝不写回飞书）：
// 把「昨天没划掉」的任务/灵感继续带出来展示——网站侧本来就靠 dudu_jots 跨天保留，
// 无需再复制进今天这行的飞书单元格。否则会违反「写回一次就不再重复写」的规则，
// 导致周五的临时任务被复制进周六的飞书行（2026-09-19 修复）。
// 划掉延续项时，Worker 按 text 反查到它原本所在的行（昨天）并在该行划线，而非复制到今天再划。
async function readTodayInspirations(env) {
  const token = await getTenantToken(env);
  const rows = await readSheet(env, token);
  const current = findTodayRow(rows);
  const items = listItems(current.rowNumber, current.row, current.today);
  const previous = findPreviousRow(rows, current.today);
  if (previous) {
    // 用「今天」作为日期，使延续项在网站侧按当天逻辑展示；id 仍指向它原本所在的行，
    // 这样划掉时 Worker 能精准定位到原行划线，而不是今天这行。
    const prevItems = listItems(previous.rowNumber, previous.row, current.today)
      .filter((it) => !it.done);
    const seen = new Set(items.map((it) => `${it.type}:${it.text}`));
    for (const it of prevItems) {
      const key = `${it.type}:${it.text}`;
      if (!seen.has(key)) { items.push(it); seen.add(key); }
    }
  }
  return {
    date: `${current.today.month}月${current.today.day}日`,
    row: current.rowNumber,
    rolled: 0,
    items,
  };
}

function assertType(type) {
  if (!TYPE_CONFIG[type]) throw new Error(`不支持的分类：${type}`);
}

function parseItemId(id) {
  const match = /^live_(\d+)_([DEFG])_(\d+)$/.exec(id || "");
  if (!match) throw new Error("记录标识无效，请刷新后重试");
  return {
    rowNumber: Number(match[1]),
    column: match[2],
    sourceIndex: Number(match[3]),
  };
}

async function mutateInspiration(env, body) {
  const action = body.action || "create";
  const token = await getTenantToken(env);
  const rows = await readSheet(env, token);
  const { rowNumber, row, today } = findTodayRow(rows);

  if (action === "create") {
    const type = body.type || "inspiration";
    const text = String(body.text || "").trim();
    assertType(type);
    if (!text) throw new Error("内容不能为空");
    const config = TYPE_CONFIG[type];
    const lines = parseLines(row[config.index]);
    lines.push(storedText(type, text));
    await updateCell(env, token, config.column, rowNumber, serializeLines(lines));
    return {
      item: {
        id: `live_${rowNumber}_${config.column}_${lines.length - 1}`,
        date: `${today.month}月${today.day}日`,
        type,
        text,
        sourceIndex: lines.length - 1,
      },
    };
  }

  // 跨天延续项可能位于「昨天」行：按 id 定位到对应行（今天或昨天），不再强制只能改今天。
  // 这样周五延续到周六的临时任务，在周六划掉时能精准落到周五那行划线，而非复制到周六再划。
  const previous = findPreviousRow(rows, today);
  let targetRowNumber = rowNumber;
  let targetRowObj = row;
  let srcColumn = null;
  let srcIndex = -1;
  if (body.id) {
    try {
      const parsed = parseItemId(body.id);
      srcColumn = parsed.column;
      srcIndex = parsed.sourceIndex;
      if (parsed.rowNumber === rowNumber) { targetRowNumber = rowNumber; targetRowObj = row; }
      else if (previous && parsed.rowNumber === previous.rowNumber) { targetRowNumber = previous.rowNumber; targetRowObj = previous.row; }
      else { srcColumn = null; srcIndex = -1; } // 既非今天也非昨天：交给 type/text 兜底
    } catch (e) { srcColumn = null; srcIndex = -1; }
  }
  // 分类：优先用 id 解析出的列，否则用前端传入的 type
  let oldType = srcColumn
    ? Object.keys(TYPE_CONFIG).find((t) => TYPE_CONFIG[t].column === srcColumn)
    : (body.type && TYPE_CONFIG[body.type] ? body.type : null);
  if (!oldType) throw new Error("记录分类无效");
  const oldConfig = TYPE_CONFIG[oldType];
  const oldLines = parseLines(targetRowObj[oldConfig.index]);

  if (action === "done" || action === "undone") {
    const struck = action === "done";
    let lines = getColumnLinesWithStyle(targetRowObj[oldConfig.index]);
    let idx = srcIndex;
    // 兜底：按 text 在「今天 + 昨天」行里找未划掉的匹配项（跨天延续项原本所在的行）
    if (idx < 0) {
      const norm = stripLeadingNumber(displayText(oldType, body.text || "")).trim();
      const candidates = [{ rn: rowNumber, lines: getColumnLinesWithStyle(row[oldConfig.index]) }];
      if (previous) candidates.push({ rn: previous.rowNumber, lines: getColumnLinesWithStyle(previous.row[oldConfig.index]) });
      for (const c of candidates) {
        const found = c.lines.findIndex((l) => !l.struck && stripLeadingNumber(l.raw).trim() === norm);
        if (found >= 0) { targetRowNumber = c.rn; lines = c.lines; idx = found; break; }
      }
    }
    if (idx < 0) throw new Error("记录已经变化，请刷新后重试");
    const rebuilt = lines.map((l, i) => ({
      text: stripLeadingNumber(l.raw),
      struck: i === idx ? struck : (l.struck === true),
    }));
    await writeLinesRich(env, token, oldConfig.column, targetRowNumber, rebuilt);
    return { updated: `live_${targetRowNumber}_${oldConfig.column}_${idx}`, done: struck };
  }

  if (action === "delete") {
    if (srcIndex < 0 || srcIndex >= oldLines.length) throw new Error("记录已经变化，请刷新后重试");
    oldLines.splice(srcIndex, 1);
    await updateCell(env, token, oldConfig.column, targetRowNumber, serializeLines(oldLines));
    return { deleted: body.id };
  }

  if (action === "update") {
    const text = String(body.text || "").trim();
    if (!text) throw new Error("内容不能为空");
    if (srcIndex < 0 || srcIndex >= oldLines.length) throw new Error("记录已经变化，请刷新后重试");
    oldLines[srcIndex] = storedText(oldType, text);
    await updateCell(env, token, oldConfig.column, targetRowNumber, serializeLines(oldLines));
    return { updated: body.id };
  }

  if (action === "reclassify") {
    const newType = body.type;
    assertType(newType);
    if (newType === oldType) return { updated: body.id };
    if (srcIndex < 0 || srcIndex >= oldLines.length) throw new Error("记录已经变化，请刷新后重试");
    const text = displayText(oldType, oldLines[srcIndex]);
    oldLines.splice(srcIndex, 1);
    await updateCell(env, token, oldConfig.column, targetRowNumber, serializeLines(oldLines));

    const newConfig = TYPE_CONFIG[newType];
    const freshRows = await readSheet(env, token);
    const freshRow = freshRows[targetRowNumber - 1] || [];
    const newLines = parseLines(freshRow[newConfig.index]);
    newLines.push(storedText(newType, text));
    await updateCell(env, token, newConfig.column, targetRowNumber, serializeLines(newLines));
    return { updated: body.id };
  }

  throw new Error(`不支持的操作：${action}`);
}

// ═══════════════════════════════════════════════════════
// 每日定时抓取：把飞书「每日表格」写成 daily_board.js 写回 GitHub Pages
// ═══════════════════════════════════════════════════════

// UTF-8 安全的 base64（Cloudflare Workers 的 btoa 仅支持 Latin1）
function toBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

// 通过 GitHub Contents API 写回仓库文件（存在则带 sha 更新，不存在则新建）
async function writeToGithub(env, path, content) {
  const token = env.GITHUB_TOKEN;
  if (!token) throw new Error("缺少 GITHUB_TOKEN，无法写回 daily_board.js");
  const repo = env.GITHUB_REPO || "duting51-create/dudu-life-system";
  const branch = env.GITHUB_BRANCH || "main";
  const api = "https://api.github.com";
  const url = `${api}/repos/${repo}/contents/${path}?ref=${branch}`;
  let sha;
  try {
    const head = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "dudu-life-sync-worker",
      },
    });
    if (head.ok) sha = (await head.json()).sha;
  } catch (e) {
    // 新文件：无 sha
  }
  const body = {
    message: `chore: daily board auto-update ${new Date().toISOString()}`,
    content: toBase64(content),
    branch,
  };
  if (sha) body.sha = sha;
  const res = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/vnd.github+json",
      "User-Agent": "dudu-life-sync-worker",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`GitHub 写回失败 ${res.status}: ${t}`);
  }
  return res.json();
}

// 解析「今日安排」单元格（C 列）为任务项，与 feishu_sync.py 的 parse_tasks 行为一致
function parseTasksJs(value) {
  const text = cellText(value);
  if (!text) return [];
  const out = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const isDone = line.includes("✅");
    const isCancelled = line.includes("❌");
    let cleaned = line
      .replace(/^[✅❌]\s*/, "")
      .trim()
      .replace(/^\d+[.、：:）)\-\s]+/, "")
      .trim();
    if (!cleaned) continue;
    const priority = /必须完成|紧急|重要/.test(cleaned)
      ? "high"
      : /考虑|设计|整理/.test(cleaned)
        ? "mid"
        : "low";
    out.push({ text: cleaned, done: isDone, cancelled: isCancelled, priority });
  }
  return out;
}

// 把日期单元格归一化为「M月D日」（与 feishu_sync 的 clean_date 输出格式一致）
function cleanDateJs(value) {
  const text = cellText(value);
  let m = text.match(/(\d{1,2})月(\d{1,2})[日号]?/);
  if (m) return `${Number(m[1])}月${Number(m[2])}日`;
  m = text.match(/(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})/);
  if (m) return `${Number(m[2])}月${Number(m[3])}日`;
  return text.trim();
}

// 扫描所有行，构建灵感宝箱（D=💡灵感 / E=临时任务 / F=今日收获 / G=情绪波动）+ 删除线 done_map
function buildInspirationsJs(rows, today) {
  const items = [];
  const done_map = {};
  const todayStr = `${today.month}月${today.day}日`;
  for (let i = 1; i < rows.length; i += 1) {
    const row = rows[i];
    if (!row || !row[0]) continue;
    const dateStr = cleanDateJs(row[0]);
    const memo = cellText(row[3] || "");
    const task = cellText(row[4] || "");
    const harvest = cellText(row[5] || "");
    const mood = cellText(row[6] || "");
    if (!memo && !task && !harvest && !mood) continue;

    const inspLines = memo
      .split("\n")
      .map((l) => l.replace(/^\s*\d+[.、）)\-\s]+/, "").trim())
      .filter((l) => l.startsWith("💡"))
      .map((l) => l.slice(1).trim());
    const inspiration = inspLines.map((t, idx) => `${idx + 1}.${t}`).join("\n");

    // 飞书删除线 = 已完成真相源
    const struckD = getColumnLinesWithStyle(row[3]).filter((l) => l.struck).map((l) => stripLeadingNumber(l.raw).trim());
    const struckE = getColumnLinesWithStyle(row[4]).filter((l) => l.struck).map((l) => stripLeadingNumber(l.raw).trim());
    const struckG = getColumnLinesWithStyle(row[6]).filter((l) => l.struck).map((l) => stripLeadingNumber(l.raw).trim());
    struckD.forEach((l) => { if (l) done_map[`inspiration:${l}`] = true; });
    struckE.forEach((l) => { if (l) done_map[`task:${l}`] = true; });
    struckG.forEach((l) => { if (l) done_map[`mood:${l}`] = true; });

    items.push({ date: dateStr, inspiration, harvest, task, mood });
  }
  return {
    items: items.slice(0, 30),
    last_updated: items.length ? items[0].date : "",
    today_updated: items.some((it) => it.date === todayStr),
    done_map,
  };
}

// 备忘提醒（D 列非 💡、未划掉，最近 10 条），与 feishu_sync 的 parse_active_memo_lines 一致
function buildMemosJs(rows) {
  const items = [];
  for (let i = rows.length - 1; i >= 1; i -= 1) {
    const row = rows[i];
    if (!row || row.length < 4) continue;
    const dateStr = cleanDateJs(row[0]);
    const lines = getColumnLinesWithStyle(row[3]);
    for (let li = lines.length - 1; li >= 0; li -= 1) {
      const l = lines[li];
      const clean = stripLeadingNumber(l.raw)
        .replace(/^[○◦▪●❖◆🔹🔸1️⃣2️⃣3️⃣4️⃣5️⃣6️⃣7️⃣8️⃣9️⃣🔟❶❷❸❹❺❻❼❽❾❿]+\s*/, "")
        .trim();
      if (
        !clean ||
        l.struck ||
        clean.startsWith("💡") ||
        clean.startsWith("🌿全部待做事项") ||
        (clean.startsWith("~~") && clean.endsWith("~~"))
      ) {
        continue;
      }
      items.push({ date: dateStr, text: clean, id: `memo_${i}_${li}` });
    }
    if (items.length >= 10) break;
  }
  return { items: items.slice(0, 10), total: items.length };
}

async function buildDailyBoard(env) {
  const token = await getTenantToken(env);
  const rows = await readSheet(env, token);
  const today = shanghaiToday();
  const todayKey = shanghaiDateKey(today);

  // ⚠️ FAIL-SAFE(2026-09-02): 找不到「今天」的行 = 异常（用户每天都建行），
  // 绝不能用空 items 写 daily_board.js —— 前端 overlay 会拿它覆盖正常的今日安排
  // （9/2 本地 feishu_sync 已发生同款「空覆盖」事故，commit 88ba615→2b867f5）。
  // 抛错 → scheduled() catch → 不写文件 → 线上保留昨天的 daily_board → 前端 date 不匹配不覆盖。
  if (!rows || rows.length < 2) {
    throw new Error(`buildDailyBoard: sheet 无有效数据行 (rows=${rows ? rows.length : 0})，跳过写入`);
  }
  // 今日安排（C 列 = index 2）
  let todayRow = null;
  for (let i = 0; i < rows.length; i += 1) {
    if (rows[i]?.[0] && dateCellMatches(rows[i][0], today)) {
      todayRow = rows[i];
      break;
    }
  }
  if (!todayRow) {
    throw new Error(`buildDailyBoard: 未找到今天 ${todayKey} 的行，跳过写入（不覆盖已有看板）`);
  }
  const tasks = {
    date: `${today.month}月${today.day}日`,
    items: todayRow ? parseTasksJs(todayRow[2]) : [],
    raw_text: todayRow ? cellText(todayRow[2]) : "",
    tasks: [],
    raw_tasks_text: "",
  };
  tasks.tasks = tasks.items.slice();
  tasks.raw_tasks_text = tasks.raw_text;

  const inspirations = buildInspirationsJs(rows, today);
  const memos = buildMemosJs(rows);

  return {
    updated_at: new Date().toISOString(),
    date: todayKey,
    source: "cloudflare-worker",
    tasks,
    inspirations,
    memos,
  };
}
