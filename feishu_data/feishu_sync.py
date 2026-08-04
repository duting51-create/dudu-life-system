#!/usr/bin/env python3
"""
飞书数据同步脚本 - 模块化重构版
每个数据源独立获取并写入独立 JSON 文件，前端通过 fetch() 异步加载
"""
import subprocess
import json
import csv
import os
import re
import shutil
import time
import urllib.request
import ssl
from io import StringIO
from datetime import datetime, timedelta

WORKSPACE = os.path.dirname(os.path.abspath(__file__))

# ── GitHub Gist 配置（用于数据-UI 分离：网站前端从 Gist 动态读取数据） ──
GIST_ID = '7ac2c821c9a34056192c3fc598f6635a'
GITHUB_TOKEN = os.environ.get('DUDU_GIST_TOKEN', '')


def upload_to_gist(data):
    """上传合并后的数据到 GitHub Gist，供线上网站 fetch 读取"""
    if not GITHUB_TOKEN:
        print("  ⚠️ 未设置 DUDU_GIST_TOKEN，跳过 Gist 上传")
        return
    print("☁️  Uploading to GitHub Gist...")
    url = f'https://api.github.com/gists/{GIST_ID}'
    payload = json.dumps({
        "files": {
            "dashboard_data.json": {
                "content": json.dumps(data, ensure_ascii=False, indent=2)
            }
        }
    })
    try:
        # 使用 curl 避免 macOS Python SSL 问题
        import tempfile
        with tempfile.NamedTemporaryFile(mode='w', delete=False, suffix='.json') as f:
            f.write(payload)
            tmp_path = f.name
        cmd = [
            'curl', '-s', '-o', '/dev/null', '-w', '%{http_code}',
            '-X', 'PATCH', url,
            '-H', f'Authorization: token {GITHUB_TOKEN}',
            '-H', 'Content-Type: application/json',
            '-d', f'@{tmp_path}'
        ]
        result = subprocess.run(cmd, capture_output=True, text=True)
        os.unlink(tmp_path)
        if result.stdout.strip() == '200':
            print("  ✅ Gist upload successful!")
        else:
            print(f"  ⚠️ Gist upload returned HTTP {result.stdout.strip()}: {result.stderr.strip()}")
    except Exception as e:
        print(f"  ⚠️ Gist upload failed: {e}")


def run_lark(cmd_list):
    """Run lark-cli command and return parsed result."""
    full_cmd = (
        'export PATH="/Users/jane/.local/bin:/Users/jane/.workbuddy/binaries/node/versions/22.22.2/bin:$PATH" && '
        + " ".join(cmd_list)
    )
    result = subprocess.run(
        ["bash", "-c", full_cmd],
        capture_output=True, text=True,
        cwd=WORKSPACE
    )
    return result.stdout, result.stderr


def save_json(filename, data):
    """保存数据到独立 JSON 文件"""
    path = os.path.join(WORKSPACE, filename)
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    return path


def load_json(filename, default=None):
    """读取 JSON 文件，失败时返回默认值"""
    path = os.path.join(WORKSPACE, filename)
    if os.path.exists(path):
        try:
            with open(path) as f:
                return json.load(f)
        except:
            pass
    return default if default is not None else {}


# ═══════════════════════════════════════════════════════
# 1. 今日待办 - 计划任务 + 备忘提醒
# ═══════════════════════════════════════════════════════
"""
飞书表格：https://my.feishu.cn/sheets/TnOCsqGGVhgjRyt5Jj3cV9FFnhg?sheet=e7d0c4
字段：日期(A)、星期(B)、计划任务(C)、备忘提醒(D)、临时任务(E)、今日收获(F)、情绪波动(G)

【今日安排】逻辑：
- 找到今天的日期行，取「计划任务」(C列)
- 没有完成的任务，顺势滚到第二天（未完成的任务保留）
- 格式：1.任务名  ✅=已完成  ❌=已取消

【备忘提醒】逻辑：
- 扫描「备忘提醒」(D列)
- 显示最近10条备忘（划掉的不显示）

【灵感宝箱】逻辑：
- 扫描所有行，取「临时任务」(E列)、「今日收获」(F列) 和「情绪波动」(G列) 有内容的行
- 每一行按类型分别生成条目（收获/任务/情绪）
- 如果今日有更新，发飞书消息提醒用户做复盘
"""

def parse_sheet_csv(csv_text):
    reader = csv.reader(StringIO(csv_text))
    rows = list(reader)
    return rows


def clean_date(raw_date):
    return re.sub(r'\[row=\d+\]\s*', '', raw_date).strip() if raw_date else ''


def parse_tasks(tasks_text):
    """解析任务文本，返回任务列表"""
    if not tasks_text:
        return []
    tasks = []
    lines = tasks_text.strip().split('\n')
    for line in lines:
        line = line.strip()
        if not line:
            continue
        is_done = '✅' in line
        is_cancelled = '❌' in line
        # 移除前缀标记
        cleaned = re.sub(r'^[✅❌]\s*', '', line).strip()
        cleaned = re.sub(r'^\d+[.、：:）)\-\s]+', '', cleaned).strip()
        if not cleaned:
            continue
        priority = 'high' if any(kw in cleaned for kw in ['必须完成', '紧急', '重要']) else \
                   'mid' if any(kw in cleaned for kw in ['考虑', '设计', '整理']) else 'low'
        tasks.append({'text': cleaned, 'done': is_done, 'cancelled': is_cancelled, 'priority': priority})
    return tasks


def parse_active_memo_lines(lines):
    """清理备忘行；lines 为 (文本, 是否删除线) 元组。"""
    items = []
    for line, is_struck in lines:
        clean = line.strip()
        if not clean or is_struck or '✅' in clean:
            continue
        clean = re.sub(r'^\d+[.、）)\-\s]+', '', clean)
        clean = re.sub(r'^[○◦▪●❖◆🔹🔸1️⃣2️⃣3️⃣4️⃣5️⃣6️⃣7️⃣8️⃣9️⃣🔟]+\s*', '', clean)
        clean = re.sub(r'^[❶❷❸❹❺❻❼❽❾❿]+\s*', '', clean)
        clean = clean.strip()
        if not clean or (clean.startswith('~~') and clean.endswith('~~')):
            continue
        if clean.startswith('🌿全部待做事项'):
            continue
        items.append(clean)
    return items


def parse_active_memos(memo_text):
    """兼容纯文本备忘；用于样式接口不可用时降级。"""
    return parse_active_memo_lines([
        (line, False) for line in (memo_text or '').splitlines()
    ])


def parse_rich_text_memos(cell):
    """按逻辑行解析飞书富文本，任一片段有删除线则剔除整行。"""
    segments = cell.get('rich_text') if isinstance(cell, dict) else None
    if not segments:
        value = cell.get('value', '') if isinstance(cell, dict) else ''
        return parse_active_memos(value)

    lines = []
    current_text = ''
    current_struck = False

    for segment in segments:
        if not isinstance(segment, dict):
            continue
        text = str(segment.get('text') or '')
        font_line = (segment.get('style') or {}).get('font_line', '')
        segment_struck = 'line-through' in str(font_line)

        for chunk in text.splitlines(keepends=True):
            has_line_break = chunk.endswith('\n') or chunk.endswith('\r')
            current_text += chunk.rstrip('\r\n')
            if segment_struck:
                current_struck = True
            if has_line_break:
                lines.append((current_text, current_struck))
                current_text = ''
                current_struck = False

    if current_text:
        lines.append((current_text, current_struck))
    return parse_active_memo_lines(lines)


def fetch_today_tasks_and_memos():
    """获取今日计划任务和备忘提醒"""
    print("📋 Fetching today's tasks and memos from sheet...")

    stdout, _ = run_lark([
        'lark-cli', 'sheets', '+csv-get',
        '--url', 'https://my.feishu.cn/sheets/TnOCsqGGVhgjRyt5Jj3cV9FFnhg',
        '--sheet-id', 'e7d0c4',
        '--range', 'A1:G125'
    ])

    # CSV 只返回文本，不包含删除线；单独读取 D 列富文本样式。
    memo_style_stdout, _ = run_lark([
        'lark-cli', 'sheets', '+cells-get',
        '--url', 'https://my.feishu.cn/sheets/TnOCsqGGVhgjRyt5Jj3cV9FFnhg',
        '--sheet-id', 'e7d0c4',
        '--range', 'D2:D125',
        '--include', 'value,style',
        '--max-chars', '500000'
    ])

    today = datetime.now()
    today_str = f"{today.month}月{today.day}日"

    # 找今天的行
    today_row = None
    all_rows = []

    if stdout:
        try:
            data = json.loads(stdout)
            csv_text = data.get('data', {}).get('annotated_csv', '')
            rows = parse_sheet_csv(csv_text)
            for row in rows[1:]:  # 跳过表头
                if not row or not row[0]:
                    continue
                date_str = clean_date(row[0])
                all_rows.append({'date': date_str, 'row': row})

                # 匹配今日
                if today_str in date_str or f"{today.month}/{today.day}" in date_str:
                    today_row = row
        except Exception as e:
            print(f"  ⚠️ Parse error: {e}")

    # ── 今日安排 ──
    # 线上渲染器读取 TASKS_DATA.items，因此把 C 列计划任务写入 items；
    # 同时保留 tasks/raw_tasks_text 以兼容旧版编辑器/回退逻辑。
    tasks = {'date': today_str, 'items': [], 'raw_text': '', 'tasks': [], 'raw_tasks_text': ''}
    if today_row and len(today_row) > 2:
        tasks_text = today_row[2].strip() if len(today_row) > 2 else ''
        parsed = parse_tasks(tasks_text)
        tasks['items'] = parsed
        tasks['raw_text'] = tasks_text
        tasks['tasks'] = parsed[:]
        tasks['raw_tasks_text'] = tasks_text
        print(f"  ✅ 今日安排: {len(tasks['items'])} 条任务")
    else:
        print(f"  ⚠️ 未找到今日 ({today_str}) 计划任务")

    # ── 备忘提醒（D 列最近 10 条未划掉内容）──
    memos = {'items': [], 'total': 0}
    memo_items = []
    memo_cells = {}

    if stdout:
        try:
            data = json.loads(stdout)
            csv_text = data.get('data', {}).get('annotated_csv', '')
            rows = parse_sheet_csv(csv_text)

            if memo_style_stdout:
                style_data = json.loads(memo_style_stdout).get('data', {})
                ranges = style_data.get('ranges') or []
                if ranges:
                    range_data = ranges[0]
                    row_indices = range_data.get('row_indices') or []
                    cell_rows = range_data.get('cells') or []
                    for index, row_number in enumerate(row_indices):
                        row_cells = cell_rows[index] if index < len(cell_rows) else []
                        if row_cells and isinstance(row_cells[0], dict):
                            memo_cells[int(row_number)] = row_cells[0]

            # 表格按日期从旧到新排列，因此倒序扫描；先过滤再截取，确保补足 10 条。
            for row_index, row in reversed(list(enumerate(rows[1:], start=2))):
                if not row or len(row) < 4:
                    continue
                date_str = clean_date(row[0])
                memo_text = row[3].strip()
                if row_index in memo_cells:
                    active_lines = parse_rich_text_memos(memo_cells[row_index])
                else:
                    active_lines = parse_active_memos(memo_text)
                for line_index, text in reversed(list(enumerate(active_lines))):
                    memo_items.append({
                        'date': date_str,
                        'text': text,
                        'id': f'memo_{row_index}_{line_index}'
                    })

            memos['items'] = memo_items[:10]
            memos['total'] = len(memos['items'])
            print(
                f"  ✅ 备忘提醒: {len(memos['items'])} 条未完成内容"
                f"（已读取 {len(memo_cells)} 个单元格样式）"
            )
        except Exception as e:
            print(f"  ⚠️ Memos parse error: {e}")

    save_json('tasks.json', tasks)
    save_json('memos.json', memos)

    return tasks, memos


def fetch_inspirations():
    """获取灵感宝箱数据（灵感 + 今日收获 + 临时任务 + 情绪波动）"""
    print("💡 Fetching inspirations...")

    stdout, _ = run_lark([
        'lark-cli', 'sheets', '+csv-get',
        '--url', 'https://my.feishu.cn/sheets/TnOCsqGGVhgjRyt5Jj3cV9FFnhg',
        '--sheet-id', 'e7d0c4',
        '--range', 'A1:G125'
    ])

    inspirations = {'items': [], 'last_updated': '', 'today_updated': False}

    if stdout:
        try:
            data = json.loads(stdout)
            csv_text = data.get('data', {}).get('annotated_csv', '')
            rows = parse_sheet_csv(csv_text)

            today = datetime.now()
            today_str = f"{today.month}月{today.day}日"

            for row in rows[1:]:
                if not row or not row[0]:
                    continue
                memo = row[3].strip() if len(row) > 3 else ''     # D列 = 备忘提醒
                task = row[4].strip() if len(row) > 4 else ''     # E列 = 临时任务
                harvest = row[5].strip() if len(row) > 5 else ''  # F列 = 今日收获
                mood = row[6].strip() if len(row) > 6 else ''     # G列 = 情绪波动
                date_str = clean_date(row[0])
                inspiration_lines = []
                for line in memo.splitlines():
                    cleaned = re.sub(r'^\s*\d+[.、）)\-\s]+', '', line).strip()
                    if cleaned.startswith('💡'):
                        inspiration_lines.append(cleaned[1:].strip())
                inspiration = '\n'.join(
                    f'{index + 1}.{text}'
                    for index, text in enumerate(inspiration_lines)
                )

                if inspiration or harvest or task or mood:
                    inspirations['items'].append({
                        'date': date_str,
                        'inspiration': inspiration,
                        'harvest': harvest,
                        'task': task,
                        'mood': mood
                    })
                    if date_str == today_str:
                        inspirations['today_updated'] = True

            inspirations['items'] = inspirations['items'][:30]  # 最多30条
            if inspirations['items']:
                inspirations['last_updated'] = inspirations['items'][0]['date']

            print(f"  ✅ Inspirations: {len(inspirations['items'])} 条，今日有更新: {inspirations['today_updated']}")

            # 如果今日有更新，发送飞书提醒（通过日志标记，由 cron 触发通知）
            if inspirations['today_updated']:
                print("  🔔 今日灵感有更新，建议做复盘！")
        except Exception as e:
            print(f"  ⚠️ Inspirations error: {e}")

    save_json('inspirations.json', inspirations)
    return inspirations


# ═══════════════════════════════════════════════════════
# 2. 财务数据
# ═══════════════════════════════════════════════════════
"""
飞书 Base：https://my.feishu.cn/base/MCrBbfuvSaEHF9sNJeeczfs9nZd?table=tblL5D2SEXh9JDfT

【📝复盘表】字段：月份、总收入、总支出
- 只抓取2026年数据
- 本年收入 = sum(2026年所有月份总收入)
- 本年支出 = sum(2026年所有月份总支出)

【💰交易明细】字段：年月、日、收支类型、金额
- 昨日支出 = 汇总昨日的支出金额
"""

def to_num(v):
    if isinstance(v, (int, float)):
        return v
    if isinstance(v, str):
        try:
            return float(v.replace(',', '').replace('¥', ''))
        except:
            return 0
    return 0


def _parse_month(s):
    """解析飞书月份字段 → (year, month)"""
    s = str(s or '').strip()
    if not s:
        return None
    # "2026-07-01 00:00:00"
    if '-' in s and len(s) >= 7:
        parts = s.split('-')
        try:
            return (int(parts[0]), int(parts[1]))
        except:
            pass
    # "2026年7月"
    m = re.match(r'(\d{4})年(\d{1,2})月', s)
    if m:
        return (int(m.group(1)), int(m.group(2)))
    return None


def fetch_finance():
    """获取家庭财务数据"""
    print("💰 Fetching family finance data...")

    import datetime
    now = datetime.datetime.now()
    now_ym = (now.year, now.month)

    finance = {
        'year_income': '¥--',
        'year_expense': '¥--',
        'monthly_data': [],       # 最近6个月 [ {month, income, expense} ]
        'yesterday_expense': '¥--',  # 昨日支出
        'month_expense_to_yesterday': '¥--',  # 本月截至昨日累计支出
        'last_updated': now.strftime('%Y-%m-%d')
    }

    # ── 从复盘表获取年月收支 ──
    stdout, _ = run_lark([
        'lark-cli', 'base', '+record-list',
        '--base-token', 'MCrBbfuvSaEHF9sNJeeczfs9nZd',
        '--table-id', 'tblL5D2SEXh9JDfT',
        '--format', 'json',
        '--limit', '50'
    ])

    if stdout:
        try:
            data = json.loads(stdout)
            records = data.get('data', {}).get('data', [])

            # 2026年记录
            year_records = []
            for r in records:
                if len(r) > 0:
                    ym = _parse_month(r[0])
                    if ym and ym[0] == now.year:
                        year_records.append(r)

            # 累计收支
            total_income = sum(to_num(r[5]) for r in year_records if len(r) > 5)
            total_expense = sum(to_num(r[4]) for r in year_records if len(r) > 4)
            finance['year_income'] = f'¥{int(total_income):,}'
            finance['year_expense'] = f'¥{int(total_expense):,}'

            # monthly_data: 最近6个2026年月（不含当月）
            monthly = []
            for r in records:
                ym = _parse_month(r[0] if len(r) > 0 else '')
                if not ym or ym == now_ym or ym[0] != now.year:
                    continue
                year, month = ym
                monthly.append({
                    'month': f'{year}年{month}月',
                    'income': to_num(r[5]) if len(r) > 5 else 0,
                    'expense': to_num(r[4]) if len(r) > 4 else 0
                })
            finance['monthly_data'] = monthly[:6]

            # 上月支出/收入（取最后一个有实际数据的月份）
            if monthly:
                last_m = None
                for m in reversed(monthly):
                    if m['expense'] > 0 or m['income'] > 0:
                        last_m = m
                        break
                if last_m:
                    finance['last_month_expense'] = f'¥{last_m["expense"]:,.2f}'
                    finance['last_month_income'] = f'¥{last_m["income"]:,.2f}'
                    print(f"  ✅ 上月 ({last_m['month']}): 支出 {finance['last_month_expense']}, 收入 {finance['last_month_income']}")

            print(f"  ✅ 财务: 本年收入 {finance['year_income']}, 本年支出 {finance['year_expense']}")
        except Exception as e:
            print(f"  ⚠️ Finance parse error: {e}")

    # ── 从交易明细获取昨日支出 ──
    yesterday = now - timedelta(days=1)
    ym_str = f"{yesterday.year}-{yesterday.month}"
    yesterday_str = f"{yesterday.year}年{yesterday.month}月{yesterday.day}日"

    stdout2, _ = run_lark([
        'lark-cli', 'base', '+record-list',
        '--base-token', 'MCrBbfuvSaEHF9sNJeeczfs9nZd',
        '--table-id', 'tblXojr9un9EXX9h',
        '--format', 'json',
        '--limit', '200',
        '--filter-json', "'" + json.dumps({"logic": "and", "conditions": [["年月", "==", ym_str]]}) + "'"
    ])

    if stdout2:
        try:
            data2 = json.loads(stdout2)
            records2 = data2.get('data', {}).get('data', [])

            yesterday_total = 0.0
            yesterday_count = 0
            month_total = 0.0
            month_count = 0
            today_day = now.day
            # JSON 格式输出，records 是字段值数组，列顺序同表格字段
            # fields顺序: 0=日期, 1=流水, 2=备注, 3=日, 4=收支类型, 5=二级分类, 6=金额, 7=账单分类, 8=年, 9=年月, 10=月
            for r in records2:
                if len(r) > 6 and str(r[4]) == '支出':
                    try:
                        day = int(str(r[3]))
                    except ValueError:
                        day = 0
                    amount = to_num(r[6])
                    if day == yesterday.day:
                        yesterday_count += 1
                        yesterday_total += amount
                    # 本月截至昨日累计（排除今天，因为今天还没过完）
                    if 1 <= day < today_day:
                        month_count += 1
                        month_total += amount

            if yesterday_count > 0:
                finance['yesterday_expense'] = f'¥{yesterday_total:.2f}'
                print(f"  ✅ 昨日 ({yesterday.day}日) 支出: {finance['yesterday_expense']} ({yesterday_count} 笔)")
            else:
                print(f"  ℹ️ 昨日无支出记录")
            if month_count > 0:
                finance['month_expense_to_yesterday'] = f'¥{month_total:.2f}'
                print(f"  ✅ 本月截至昨日累计支出: {finance['month_expense_to_yesterday']} ({month_count} 笔)")
        except Exception as e:
            print(f"  ⚠️ Yesterday expense error: {e}")

    save_json('finance.json', finance)
    return finance


def fetch_expense_categories():
    """获取上月支出分类排名（Top 7）"""
    print("🏷️  Fetching expense categories (last month)...")

    now = datetime.now()
    # 上月年月
    if now.month == 1:
        last_year, last_month = now.year - 1, 12
    else:
        last_year, last_month = now.year, now.month - 1
    ym_str = f'{last_year}-{last_month}'

    categories = {'items': [], 'month': f'{last_year}年{last_month}月', 'last_updated': now.strftime('%Y-%m-%d')}

    filter_json = "'" + json.dumps({
        'logic': 'and',
        'conditions': [['年月', '==', ym_str]]
    }) + "'"

    stdout, _ = run_lark([
        'lark-cli', 'base', '+record-list',
        '--base-token', 'MCrBbfuvSaEHF9sNJeeczfs9nZd',
        '--table-id', 'tblXojr9un9EXX9h',
        '--format', 'json',
        '--limit', '200',
        '--filter-json', filter_json
    ])

    if stdout:
        try:
            data = json.loads(stdout)
            records = data.get('data', {}).get('data', [])

            from collections import defaultdict
            cat_totals = defaultdict(float)
            for r in records:
                if len(r) > 6 and r[4] == '支出':
                    cats = r[5] if r[5] else []
                    cat = cats[0] if cats else '未分类'
                    amount = float(r[6] or 0)
                    cat_totals[cat] += amount

            sorted_cats = sorted(cat_totals.items(), key=lambda x: -x[1])
            max_amount = sorted_cats[0][1] if sorted_cats else 1

            # Emoji 映射
            EMOJI_MAP = {
                '房贷': '🏠', '赵晗支出': '👤', '房租': '🏠', '武装大脑': '📚',
                '固定支出': '🔒', '买药看病': '🏥', '一日三餐': '🍽️', '日用采购': '🛒',
                '出行交通': '🚇', '人情往来': '🎁', '投资理财': '💹', '未分类': '📌',
                '护肤保健': '💄', '孕期护理': '🤰', '宠物': '🐶', '娱乐': '🎮',
                '学习': '📖', '生活日常': '🚇', '医疗健康': '🏥', '亲友礼物': '🎁',
            }

            for i, (cat, amount) in enumerate(sorted_cats[:7], 1):
                categories['items'].append({
                    'rank': i,
                    'category': cat,
                    'emoji': EMOJI_MAP.get(cat, '📌'),
                    'amount': f'¥{int(amount):,}',
                    'amount_raw': amount,
                    'percent': round((amount / max_amount) * 100)
                })

            print(f"  ✅ 支出分类（{last_year}年{last_month}月）: {len(categories['items'])} 个分类，第1名 {sorted_cats[0][0] if sorted_cats else 'N/A'} ¥{int(sorted_cats[0][1]) if sorted_cats else 0:,}")
        except Exception as e:
            print(f"  ⚠️ Expense categories error: {e}")

    save_json('expense_categories.json', categories)
    return categories



# ═══════════════════════════════════════════════════════
# 3. 阅读挑战 + 微信读书
# ═══════════════════════════════════════════════════════
"""
微信读书 API 抓取：
- 阅读天数、挑战天数（从7月28日算作142天，依次往后滚动）
- 书架数据（最近在读书）
- 勋章数据（最多5条，放在阅读挑战右边模块底部）
"""

WEREAD_API_URL = 'https://i.weread.qq.com/api/agent/gateway'
SKILL_VERSION = '1.0.4'


def get_weread_api_key():
    api_key = os.environ.get('WEREAD_API_KEY', '').strip()
    if api_key:
        return api_key

    candidate_files = [
        os.path.expanduser('~/.bash_profile'),
        os.path.expanduser('~/.zprofile'),
        os.path.expanduser('~/.zshrc'),
    ]
    pattern = re.compile(r'^\s*export\s+WEREAD_API_KEY=(["\']?)(.+?)\1\s*$')
    for path in candidate_files:
        if not os.path.exists(path):
            continue
        try:
            with open(path, 'r', encoding='utf-8') as f:
                for raw_line in f:
                    line = raw_line.strip()
                    match = pattern.match(line)
                    if match:
                        value = match.group(2).strip()
                        if value:
                            os.environ['WEREAD_API_KEY'] = value
                            print(f"  🔐 Loaded WEREAD_API_KEY from {os.path.basename(path)}")
                            return value
        except Exception:
            continue
    return ''


def call_weread_api(api_name, params=None):
    api_key = get_weread_api_key()
    if not api_key:
        print("  ⚠️ WEREAD_API_KEY not set, skipping WeRead API")
        return None
    if params is None:
        params = {}
    body = {'api_name': api_name, 'skill_version': SKILL_VERSION, **params}
    ctx = ssl.create_default_context()
    req = urllib.request.Request(
        WEREAD_API_URL,
        data=json.dumps(body, ensure_ascii=False).encode('utf-8'),
        headers={'Content-Type': 'application/json', 'Authorization': f'Bearer {api_key}'}
    )
    try:
        with urllib.request.urlopen(req, context=ctx, timeout=15) as resp:
            return json.loads(resp.read().decode('utf-8'))
    except Exception as e:
        print(f"  ⚠️ WeRead API error ({api_name}): {e}")
        return None


def fetch_reading():
    """获取微信读书阅读数据"""
    print("📖 Fetching WeRead reading data...")

    base_date = datetime(2026, 7, 28)
    today = datetime.now()
    days_since_base = (today - base_date).days + 142

    medals = []
    read_days = 0

    read_stats = call_weread_api('/readdata/detail', {'mode': 'overall'})
    if read_stats:
        if 'readDays' in read_stats:
            read_days = read_stats['readDays']
        if 'medals' in read_stats:
            medals = read_stats['medals'][:5]

    # 从 API readStat 提取书籍计数（"读过"和"读完"），避免依赖静态文件
    total_read_books = None
    total_finished_books = None
    if read_stats and 'readStat' in read_stats:
        for stat_item in read_stats['readStat']:
            stat_name = stat_item.get('stat', '')
            counts_str = stat_item.get('counts', '0本')
            match = re.search(r'(\d+)', counts_str)
            if match:
                counts_num = int(match.group(1))
                if stat_name == '读过':
                    total_read_books = counts_num
                elif stat_name == '读完':
                    total_finished_books = counts_num

    weekly_read_time = None
    yesterday_read_time = None
    try:
        weekly_stats = call_weread_api('/readdata/detail', {'mode': 'weekly', 'baseTime': 0})
        if weekly_stats:
            # WeRead returns seconds. The dashboard displays whole minutes.
            weekly_seconds = weekly_stats.get('totalReadTime')
            if isinstance(weekly_seconds, (int, float)):
                weekly_read_time = round(weekly_seconds / 60)

            yesterday = (today - timedelta(days=1)).date()
            for timestamp, seconds in (weekly_stats.get('readTimes') or {}).items():
                try:
                    bucket_date = datetime.fromtimestamp(int(timestamp)).date()
                    if bucket_date == yesterday and isinstance(seconds, (int, float)):
                        yesterday_read_time = round(seconds / 60)
                        break
                except (TypeError, ValueError, OSError):
                    continue

            print(f"  ✅ 本周阅读时间（API）: {weekly_read_time}")
            print(f"  ✅ 昨日阅读时间（周数据）: {yesterday_read_time}")
    except Exception as e:
        print(f"  ⚠️ 周阅读数据 API 失败: {e}")

    total_seconds = read_stats.get('totalReadTime') if read_stats else None
    if isinstance(total_seconds, (int, float)):
        total_read_hours = round(total_seconds / 3600)
    else:
        total_read_hours = None

    # 从书架获取最近在读（仅保留未读完的书，按最近阅读排序）
    currently_reading = []
    shelf_data = call_weread_api('/shelf/sync')
    if shelf_data and 'books' in shelf_data:
        raw_books = shelf_data['books']
        valid_books = [
            b for b in raw_books
            if b.get('readUpdateTime') and b.get('finishReading') not in (1, True)
        ]
        valid_books.sort(key=lambda b: b.get('readUpdateTime', 0), reverse=True)
        for b in valid_books[:5]:
            read_ts = b.get('readUpdateTime', 0)
            last_read = time.strftime('%Y-%m-%d', time.localtime(read_ts)) if read_ts else ''
            progress = b.get('readingProgress')
            if not isinstance(progress, (int, float)):
                progress = b.get('progress')
            if not isinstance(progress, (int, float)):
                progress = 0
            progress = max(0, min(100, round(progress)))
            currently_reading.append({
                'title': b.get('title', '未知书名'),
                'author': b.get('author', '未知作者'),
                'status': '在读',
                'progress': progress,
                'last_read': last_read,
                'created': last_read,
            })

    reading = {
        'challenge_days': days_since_base,
        'challenge_target': 365,
        'rolling_day': days_since_base,
        'total_days': read_days,
        'weekly_read_time': weekly_read_time,
        'yesterday_read_time': yesterday_read_time,
        'weekly_data': {
            'weekly_read_time': weekly_read_time,
            'yesterday_read_time': yesterday_read_time,
            'source': '周数据',
        },
        'total_read_hours': total_read_hours,
        'total_read_books': total_read_books,
        'total_finished_books': total_finished_books,
        'total_data': {
            'total_read_hours': total_read_hours,
            'total_read_books': total_read_books,
            'total_finished_books': total_finished_books,
            'source': '总数据',
        },
        'currently_reading': currently_reading,
        'medals': medals[:5],
        'last_updated': today.strftime('%Y-%m-%d')
    }

    print(f"  ✅ 阅读挑战: 第{reading['rolling_day']}天, 勋章:{len(medals)}条, 在读:{len(currently_reading)}本")
    save_json('reading.json', reading)
    return reading


# ═══════════════════════════════════════════════════════
# 4. 一人公司
# ═══════════════════════════════════════════════════════
"""
一人公司订单数据：
https://my.feishu.cn/base/OmyJbJW48ar09wszbwccIZwhnVf?table=tbl1dYLGMLAve7vV&view=vew4KXOALE

统计规则：
- 总订单 = 支付件数求和
- 总营收 = 支付金额求和
- 趋势图 = 周营收趋势（按支付时间聚合）
"""

def _unwrap_cell_text(value):
    if isinstance(value, list):
        if not value:
            return ''
        return str(value[0] or '').strip()
    return str(value or '').strip()


def _parse_datetime_text(value):
    text = str(value or '').strip()
    if not text:
        return None
    for fmt in ('%Y-%m-%d %H:%M:%S', '%Y-%m-%d'):
        try:
            return datetime.strptime(text, fmt)
        except ValueError:
            continue
    return None


def _format_currency(value):
    value = round(float(value or 0), 1)
    if abs(value - round(value)) < 1e-9:
        return f'¥{int(round(value)):,}'
    return f'¥{value:,.1f}'


def _format_count(value):
    value = float(value or 0)
    if abs(value - round(value)) < 1e-9:
        return int(round(value))
    return round(value, 1)


def fetch_one_company():
    """获取一人公司核心经营数据"""
    print("🏢 Fetching one-company business data...")

    limit = 200
    offset = 0
    fields = []
    rows = []

    while True:
        stdout, stderr = run_lark([
            'lark-cli', 'base', '+record-list',
            '--base-token', 'OmyJbJW48ar09wszbwccIZwhnVf',
            '--table-id', 'tbl1dYLGMLAve7vV',
            '--view-id', 'vew4KXOALE',
            '--format', 'json',
            '--limit', str(limit),
            '--offset', str(offset)
        ])

        if stderr.strip():
            print(f"  ⚠️ 一人公司 stderr(offset={offset}): {stderr.strip()[:300]}")

        if not stdout.strip():
            break

        try:
            data = json.loads(stdout)
            payload = data.get('data', {})
            page_fields = payload.get('fields', [])
            page_rows = payload.get('data', [])
            if page_fields and not fields:
                fields = page_fields
            rows.extend(page_rows)
            print(f"  📄 一人公司第 {offset // limit + 1} 页: {len(page_rows)} 条")
            if len(page_rows) < limit or not payload.get('has_more'):
                break
            offset += limit
        except Exception as e:
            print(f"  ⚠️ One-company parse error(offset={offset}): {e}")
            break

    existing = load_json('one_company.json', {})
    if not fields or not rows:
        print("  ⚠️ 一人公司没有取到有效记录，保留现有数据")
        return existing

    field_index = {name: idx for idx, name in enumerate(fields)}
    amount_idx = field_index.get('支付金额')
    count_idx = field_index.get('支付件数')
    time_idx = field_index.get('支付时间')

    if amount_idx is None or count_idx is None:
        print("  ⚠️ 一人公司缺少关键字段（支付金额/支付件数），保留现有数据")
        return existing

    total_revenue = 0.0
    total_orders = 0.0
    weekly_totals = {}

    for row in rows:
        if not isinstance(row, list):
            continue
        if not any(item not in (None, '', []) for item in row):
            continue

        amount = to_num(row[amount_idx]) if amount_idx < len(row) else 0
        order_count = to_num(row[count_idx]) if count_idx < len(row) else 0
        pay_time = row[time_idx] if time_idx is not None and time_idx < len(row) else ''

        if amount == 0 and order_count == 0 and not pay_time:
            continue

        total_revenue += amount
        total_orders += order_count

        paid_at = _parse_datetime_text(pay_time)
        if paid_at:
            week_start = (paid_at.date() - timedelta(days=paid_at.weekday()))
            weekly_totals[week_start] = weekly_totals.get(week_start, 0) + amount

    current_week_start = (datetime.now().date() - timedelta(days=datetime.now().weekday()))
    week_starts = [current_week_start - timedelta(days=7 * i) for i in range(5, -1, -1)]
    weekly_revenue = [
        {
            'label': f'{week_start.month}/{week_start.day}',
            'revenue': round(weekly_totals.get(week_start, 0), 1)
        }
        for week_start in week_starts
    ]

    result = dict(existing)
    result['total_revenue'] = _format_currency(total_revenue)
    result['total_orders'] = _format_count(total_orders)
    result['weekly_revenue'] = weekly_revenue
    result['monthly_revenue'] = []
    result['last_updated'] = datetime.now().strftime('%Y-%m-%d')

    print(f"  ✅ 一人公司: 总营收 {result['total_revenue']} | 总订单 {result['total_orders']}")
    save_json('one_company.json', result)
    return result


# ═══════════════════════════════════════════════════════
# 5. 已发布笔记
# ═══════════════════════════════════════════════════════
"""
飞书 Base：https://my.feishu.cn/base/OmyJbJW48ar09wszbwccIZwhnVf?table=tblZBv6PmC3ZLkrz&view=vewTGyeXC6

限制不要是100（因为已超过100条），用 --limit 200 获取全部
已发布视图 vewTGyeXC6（区别于全部记录视图）
"""

def fetch_published_notes():
    """获取已发布笔记数量（总数 + 本月发布数）

    数据源：飞书 Base 已发布视图（vewTGyeXC6）。
    产品进度应用「本月（按 发布时间 字段）已发布记录数」，而非累计总笔记数。
    """
    print("📝 Fetching published notes...")

    limit = 200
    offset = 0
    count = 0
    month_count = 0
    now = datetime.now()
    target_ym = (now.year, now.month)

    while True:
        stdout, stderr = run_lark([
            'lark-cli', 'base', '+record-list',
            '--base-token', 'OmyJbJW48ar09wszbwccIZwhnVf',
            '--table-id', 'tblZBv6PmC3ZLkrz',
            '--view-id', 'vewTGyeXC6',
            '--format', 'json',
            '--limit', str(limit),
            '--offset', str(offset)
        ])

        if stderr.strip():
            print(f"  ⚠️ 已发布笔记 stderr(offset={offset}): {stderr.strip()[:300]}")

        page_count = 0
        if stdout:
            try:
                data = json.loads(stdout)
                records = data.get('data', {}).get('data', [])
                page_count = len(records)
                count += page_count
                # 统计「发布时间」落在本月（当前年-月）的已发布记录数
                for rec in records:
                    if not isinstance(rec, list):
                        continue
                    for cell in rec:
                        if (isinstance(cell, str) and len(cell) >= 10
                                and cell[4] == '-' and cell[7] == '-' and cell[:4].isdigit()):
                            try:
                                yr = int(cell[:4])
                                mo = int(cell[5:7])
                                if (yr, mo) == target_ym:
                                    month_count += 1
                            except Exception:
                                pass
                            break  # 一条记录只取第一个日期字段作为「发布时间」
                print(f"  📄 已发布笔记第 {offset // limit + 1} 页: {page_count} 条")
            except Exception as e:
                print(f"  ⚠️ Parse error(offset={offset}): {e}")
                break

        if page_count < limit:
            break
        offset += limit

    result = {
        'total': count,
        'month_count': month_count,
        'last_updated': datetime.now().strftime('%Y-%m-%d'),
    }
    print(f"  ✅ 已发布笔记: 总计 {count} 篇，本月（{now.year}年{now.month}月）发布 {month_count} 篇")
    save_json('published_notes.json', result)
    return result


# ═══════════════════════════════════════════════════════
# 5. 运动打卡（保持现有数据文件）
# ═══════════════════════════════════════════════════════

def fetch_exercise():
    """运动打卡数据（只同步视频库，不推送个人打卡记录）"""
    print("🏃 Checking exercise data...")

    # 读取现有数据，如果文件不存在则返回空
    exercise = load_json('exercise_data.json', None)
    if exercise:
        print(f"  ✅ 运动数据已存在: {exercise.get('month', 'unknown')}")
    else:
        print("  ⚠️ 运动数据文件不存在，跳过")
        exercise = {}

    # 返回数据前清除 checked_days，个人打卡记录以 localStorage 为准
    # 防止同步时把旧打卡记录推送到新部署的站点
    # 同时写回文件以保证 generate_dashboard() 读取时不含 checked_days
    if 'checked_days' in exercise:
        del exercise['checked_days']
        save_json('exercise_data.json', exercise)
        print("  🧹 已清除 checked_days 并写回文件")

    return exercise


# ═══════════════════════════════════════════════════════
# ═══════════════════════════════════════════════════════
# 6. 热点资讯
# ═══════════════════════════════════════════════════════

def _fetch_page(url, timeout=12):
    """通用页面抓取，失败返回空字符串"""
    try:
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        req = urllib.request.Request(url, headers={
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'zh-CN,zh;q=0.9',
        })
        with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
            raw = resp.read().decode('utf-8', errors='replace')
        return raw
    except Exception as e:
        print(f"  ⚠️ Fetch failed for {url}: {e}")
        return ''


def _parse_rss_items(xml_text, limit=10):
    """解析 RSS/Atom，返回标准化 item 列表"""
    items = []
    if not xml_text:
        return items
    try:
        import xml.etree.ElementTree as ET
        root = ET.fromstring(xml_text)
        channel = root.find('channel') or root
        for item in channel.findall('item')[:limit]:
            title_raw = item.findtext('title') or ''
            title = re.sub(r'<!\[CDATA\[(.*?)\]\]>', r'\1', title_raw).strip()
            link_raw = item.findtext('link') or ''
            link = re.sub(r'<!\[CDATA\[(.*?)\]\]>', r'\1', link_raw).strip()
            pub = item.findtext('pubDate') or ''
            author_raw = item.findtext('author') or ''
            author = re.sub(r'<!\[CDATA\[(.*?)\]\]>', r'\1', author_raw).strip() if author_raw else ''
            if title:
                items.append({'title': title, 'url': link, 'published': pub, 'author': author})
        # Atom fallback
        if not items:
            for entry in channel.findall('entry')[:limit]:
                title_raw = entry.findtext('title') or ''
                title = re.sub(r'<!\[CDATA\[(.*?)\]\]>', r'\1', title_raw).strip()
                link_el = entry.find('link')
                link = link_el.get('href') if link_el is not None else (entry.findtext('link') or '')
                link = re.sub(r'<!\[CDATA\[(.*?)\]\]>', r'\1', str(link)).strip()
                pub = entry.findtext('published') or entry.findtext('updated') or ''
                if title:
                    items.append({'title': title, 'url': link, 'published': pub})
    except Exception as e:
        print(f"  ⚠️ RSS parse error: {e}")
    return items


def _days_ago(pub_text):
    """从 pubDate 文本估算相对天数"""
    if not pub_text:
        return '未知'
    try:
        from email.utils import parsedate
        import time
        t = parsedate(pub_text)
        if t:
            pub_ts = time.mktime(t)
            days = int((time.time() - pub_ts) / 86400)
            if days == 0:
                return '今天'
            elif days == 1:
                return '昨天'
            elif days < 7:
                return f'{days}天前'
            elif days < 30:
                return f'{days // 7}周前'
            else:
                return f'{days // 30}月前'
    except:
        pass
    return pub_text[5:10] if pub_text else '未知'


def _fetch_rss_source(name, url, limit=10):
    """抓取单个 RSS 源，返回标准化列表"""
    raw = _fetch_page(url)
    if not raw or raw.startswith('ERROR'):
        return []
    items = _parse_rss_items(raw, limit)
    for item in items:
        item['source'] = name
        item['time_ago'] = _days_ago(item.get('published', ''))
    return items


def _fetch_podcast_episodes(name, podcast_id, limit=3, use_ximalaya=False, xiaoyuzhou_id=None, rsshub_url=None):
    """
    抓取播客最新节目列表。
    use_ximalaya=True 时使用喜马拉雅 RSS，否则使用 feed.xyzfm.space（小宇宙）。
    rsshub_url: RSShub 公开实例 URL（用于小宇宙播客的 RSS 代理）。
    返回格式与 RSS item 一致。
    xiaoyuzhou_id: 小宇宙播客的 podcast ID，用于构造正确的 App 唤起链接。
    """
    if rsshub_url:
        rss_url = rsshub_url
    elif use_ximalaya:
        rss_url = f'https://www.ximalaya.com/album/{podcast_id}.xml'
    else:
        rss_url = f'https://feed.xyzfm.space/{podcast_id}'
    
    items = _fetch_rss_source(name, rss_url, limit)
    
    # 构造小宇宙 App 唤起链接（使用正确的小宇宙 podcast ID）
    xyz_url_id = xiaoyuzhou_id or podcast_id
    for item in items:
        item['xiaoyuzhou_url'] = f'https://www.xiaoyuzhoufm.com/podcast/{xyz_url_id}'
        item['category'] = '播客'
    return items


def _pick_one_company_fillers(limit=6):
    """补足一人公司资讯：优先搞钱/商业/增长向文章，不足再用最新商业文章补位。"""
    strong_keywords = [
        '创业', '创始', '副业', '搞钱', '赚钱', '出海', '增长', '品牌', '营销', '获客',
        '流量', '电商', '开店', '产品', '用户', '消费', '公司', '商业', '生意',
        '市场', '内容', '变现', '私域', 'SaaS', 'ToB', '飞书', '钉钉', '众筹'
    ]
    weak_keywords = ['经济', '零售', '行业', '企业', '资本', '消费', '平台', 'AI', '模型', '组织调整']
    noise_keywords = ['汽车', '续航', '火星', '手机', '指数', '停牌', '智能手机出货量', '小米澎程']

    source_specs = [
        ('钛媒体', 'https://www.tmtpost.com/rss.xml', 14),
        ('极客公园', 'https://www.geekpark.net/rss', 14),
        ('36氪', 'https://36kr.com/feed-article', 14),
        ('爱范儿', 'https://www.ifanr.com/feed', 12),
    ]

    candidates = []
    for source_name, source_url, source_limit in source_specs:
        candidates.extend(_fetch_rss_source(source_name, source_url, source_limit))

    selected = []
    seen_titles = set()
    seen_urls = set()

    def try_add(item):
        title = (item.get('title') or '').strip()
        url = (item.get('url') or '').strip()
        if not title or title in seen_titles or (url and url in seen_urls):
            return False
        normalized = dict(item)
        normalized['category'] = '资讯'
        normalized['source'] = normalized.get('source') or '36氪'
        selected.append(normalized)
        seen_titles.add(title)
        if url:
            seen_urls.add(url)
        return True

    for item in candidates:
        title = item.get('title') or ''
        if any(keyword in title for keyword in noise_keywords):
            continue
        if any(keyword in title for keyword in strong_keywords):
            try_add(item)
        if len(selected) >= limit:
            return selected

    for item in candidates:
        title = item.get('title') or ''
        if any(keyword in title for keyword in noise_keywords):
            continue
        if any(keyword in title for keyword in weak_keywords):
            try_add(item)
        if len(selected) >= limit:
            return selected

    for item in candidates:
        title = item.get('title') or ''
        if any(keyword in title for keyword in noise_keywords):
            continue
        try_add(item)
        if len(selected) >= limit:
            return selected

    return selected


def _load_manual_links():
    """读取手动收藏的链接文件（公众号、播客等无法自动抓取的内容）"""
    path = os.path.join(WORKSPACE, 'manual_links.json')
    if os.path.exists(path):
        try:
            with open(path) as f:
                return json.load(f)
        except:
            pass
    return {'user_pain_points': [], 'one_company': [], 'ai_news': []}


def fetch_hot_topics():
    """
    热点资讯数据抓取：AI资讯 + 用户痛点 + 一人公司
    
    播客策略（按优先级）：
    1. 喜马拉雅公开 RSS（最强可访问性）
    2. feed.xyzfm.space（小宇宙 RSS）
    3. 小宇宙 Universal Link（App 唤起，手机上直接打开）
    
    公众号策略：
    - 官方无 RSS → 手动收藏链接（manual_links.json）
    """
    print("🔥 Fetching hot topics (AI news, pain points, one-person company)...")

    today_str = datetime.now().strftime('%Y-%m-%d')
    hot = {
        'user_pain_points': [],
        'ai_news': [],
        'one_company_news': [],
        'last_updated': today_str,
    }

    # ── 1. AI 资讯 RSS ──────────────────────────────────
    # 固定只使用两个来源：AI HOT + 36氪；总量控制为 10 条。
    ai_hot_items = _fetch_rss_source('AI HOT', 'https://aihot.virxact.com/feed', 10)
    kr_items = _fetch_rss_source('36氪', 'https://36kr.com/feed', 10)

    # 从 AI HOT 的 author 字段提取真实来源（如 "noreply@... (IT之家（RSS）)" → "IT之家（RSS）"）
    for item in ai_hot_items:
        auth = item.pop('author', '')
        if auth:
            m = re.search(r'\((.+)\)\s*$', auth)
            if m:
                item['source'] = m.group(1)

    primary_ai_hot = ai_hot_items[:5]
    primary_36kr = kr_items[:5]
    ai_candidates = primary_ai_hot + primary_36kr + ai_hot_items[5:] + kr_items[5:]

    deduped_ai = []
    seen_ai_titles = set()
    for item in ai_candidates:
        title_key = (item.get('title') or '').strip()
        if not title_key or title_key in seen_ai_titles:
            continue
        deduped_ai.append(item)
        seen_ai_titles.add(title_key)
        if len(deduped_ai) >= 10:
            break

    hot['ai_news'].extend(deduped_ai)
    print(f"  ✅ AI资讯-AI HOT: {len(ai_hot_items)} 条原始抓取")
    print(f"  ✅ AI资讯-36氪: {len(kr_items)} 条原始抓取")
    print(f"  ✅ AI资讯合并后: {len(deduped_ai)} 条（来源固定：AI HOT + 36氪）")

    # ── 2. 一人公司播客 ─────────────────────────────────
    # 一人公司播客配置：
    # 小宇宙 Universal Link: https://www.xiaoyuzhoufm.com/podcast/{id}
    # feed.xyzfm.space RSS: https://feed.xyzfm.space/{xyzfm_id}
    # 喜马拉雅 RSS: https://www.ximalaya.com/album/{album_id}.xml
    # RSShub 公开实例: https://rsshub.rssforever.com/xiaoyuzhou/podcast/{xyz_id}
    # 一人公司资讯：固定 4 个商业/科技来源（钛媒体、极客公园、36氪、爱范儿），
    # 每个来源只保留最新 1 篇，避免模块过长。各来源提供多个 RSS 端点做容错重试。
    one_company_sources = [
        ('钛媒体', ['https://www.tmtpost.com/rss.xml', 'https://www.tmtpost.com/rss', 'https://www.tmtpost.com/feed']),
        ('极客公园', ['https://www.geekpark.net/rss', 'https://www.geekpark.net/feed']),
        ('36氪', ['https://36kr.com/feed-article', 'https://36kr.com/feed']),
        ('爱范儿', ['https://www.ifanr.com/feed', 'https://www.ifanr.com/rss']),
    ]
    for src_name, src_urls in one_company_sources:
        src_items = []
        for u in src_urls:
            src_items = _fetch_rss_source(src_name, u, 3)
            if src_items:
                break
        if src_items:
            top = src_items[0]
            top['category'] = '资讯'
            top['source'] = src_name
            hot['one_company_news'].append(top)
            print(f"  ✅ 一人公司-{src_name}: 保留最新 1 篇")
        else:
            print(f"  ⚠️ 一人公司-{src_name}: RSS 不可用，本来源跳过")

    # 兜底：若 4 个来源全部抓取失败，保留少量通用商业资讯补位（不使用播客）
    if not hot['one_company_news']:
        filler_items = _pick_one_company_fillers(limit=4)
        hot['one_company_news'].extend(filler_items)
        if filler_items:
            print(f"  ✅ 一人公司-补位资讯: {len(filler_items)} 条")

    # 手动收藏链接（公众号等无 RSS 内容）
    manual = _load_manual_links()
    manual_one_company = manual.get('one_company', [])
    hot['one_company_news'].extend(manual_one_company)
    if manual_one_company:
        print(f"  ✅ 一人公司-手动收藏: {len(manual_one_company)} 条")

    # ── 3. 用户痛点 ─────────────────────────────────────
    # 飞书表格已有数据（小红书爆款笔记）
    existing = load_json('hot_topics.json', {})
    existing_pain = existing.get('user_pain_points', [])
    # 过滤掉已经是播客链接的条目（重新抓取后替换）
    pain_notes = [p for p in existing_pain if p.get('category') != '播客' and not p.get('url', '').startswith('https://www.xiaoyuzhoufm')]
    hot['user_pain_points'].extend(pain_notes)
    if pain_notes:
        print(f"  ✅ 用户痛点-飞书笔记: {len(pain_notes)} 条")

    # 用户痛点播客（全部使用 feed.xyzfm.space，无则用 RSShub，最后 Universal Link）
    RSSHUB_BASE = 'https://rsshub.rssforever.com/xiaoyuzhou/podcast/'
    pain_point_podcasts = [
        # [名称,           小宇宙ID,                   feed_xyzfm_ID,    ximalaya_id,   rsshub_url]
        ('艾屿回声',      '67bfd11326055d2fe7bcc8bd', None,            None,         None),                           # 无可用 RSS
        ('当个事儿',      '60d2d172afc14743da181066', 'myefm33b8n77', None,         None),                           # feed.xyzfm
        ('嗨咻',          '631812fe43274df80456d001', 'e864f8kmynb9', None,         None),                           # feed.xyzfm
        ('头回当妈',      '6484fbe126fd9f4b4347ad04', 'lvju7r4p7hup', None,         None),                           # feed.xyzfm
        ('畅所育言',      '64d25bd580c9ec4c5fbb0da4', 'mthyv3lb4rcf', None,         None),                           # feed.xyzfm
        ('Alison Yu心理', '67c8dd34d6c2a59e23f2d932', None,            None,         RSSHUB_BASE + '67c8dd34d6c2a59e23f2d932'),  # RSShub
    ]

    for name, xyz_id, xyzfm_id, xm_id, rsshub_url in pain_point_podcasts:
        # 优先 feed.xyzfm.space，其次喜马拉雅，最后 RSShub
        rss_id = xyzfm_id or xm_id
        use_xm = bool(xm_id and not xyzfm_id)
        if rss_id:
            episodes = _fetch_podcast_episodes(name, rss_id, limit=2, use_ximalaya=use_xm, xiaoyuzhou_id=xyz_id)
        elif rsshub_url:
            episodes = _fetch_podcast_episodes(name, xyz_id, limit=2, xiaoyuzhou_id=xyz_id, rsshub_url=rsshub_url)
        else:
            episodes = []
        if episodes:
            for ep in episodes:
                ep['category'] = '播客'
                ep['hotness'] = '🎧'
                ep['url'] = ep.get('xiaoyuzhou_url') or ep.get('url')
            hot['user_pain_points'].append({
                'title': f'🎙 {name} | {episodes[0]["title"][:40]}',
                'url': f'https://www.xiaoyuzhoufm.com/podcast/{xyz_id}',
                'source': name,
                'category': '播客',
                'hotness': '🎧',
                'time_ago': episodes[0].get('time_ago', ''),
            })
            print(f"  ✅ 痛点-{name}: 抓取到最新节目")
        else:
            # Fallback：小宇宙 Universal Link
            hot['user_pain_points'].append({
                'title': f'🎙 【{name}】最新节目',
                'url': f'https://www.xiaoyuzhoufm.com/podcast/{xyz_id}',
                'source': name,
                'category': '播客',
                'hotness': '🎧',
            })
            print(f"  ⚠️ 痛点-{name}: RSS 不可用，使用 App 唤起链接")

    # 手动收藏链接（公众号等）
    manual_pain = manual.get('user_pain_points', [])
    # 避免重复添加（检查 URL）
    existing_urls = {p.get('url') for p in hot['user_pain_points']}
    for item in manual_pain:
        if item.get('url') not in existing_urls:
            hot['user_pain_points'].append(item)
    if manual_pain:
        print(f"  ✅ 用户痛点-手动收藏: {len(manual_pain)} 条")

    # ── 一人公司去重（按来源，每个来源只保留第一篇） ────
    seen_sources = set()
    deduped = []
    for item in hot['one_company_news']:
        s = item.get('source', '')
        if s and s in seen_sources:
            continue
        if s:
            seen_sources.add(s)
        deduped.append(item)
    hot['one_company_news'] = deduped
    print(f"  ✅ 一人公司去重后: {len(deduped)} 条")

    # ── 限制总数 ─────────────────────────────────────────
    hot['ai_news'] = hot['ai_news'][:10]
    hot['one_company_news'] = hot['one_company_news'][:10]
    hot['user_pain_points'] = hot['user_pain_points'][:20]

    save_json('hot_topics.json', hot)
    print(f"  ✅ 热点资讯汇总: AI {len(hot['ai_news'])} | 一人公司 {len(hot['one_company_news'])} | 痛点 {len(hot['user_pain_points'])}")
    return hot


def fetch_douban(force=False):
    """抓取杜杜豆瓣观影清单（想看 + 看过），生成 douban_data.js。失败则保留现有文件。
    默认每周最多抓取一次，避免频繁请求豆瓣（可通过 force=True 或环境变量 DUDU_FORCE_DOUBAN=1 强制刷新）。
    """
    last = load_json('last_douban_sync.json', {})
    last_ts = last.get('last_sync', '')
    now = datetime.now()
    if not force and os.environ.get('DUDU_FORCE_DOUBAN') != '1' and last_ts:
        try:
            days = (now - datetime.fromisoformat(last_ts)).total_seconds() / 86400
            if days < 7:
                print(f"🎬 豆瓣观影清单：距上次抓取仅 {days:.1f} 天，跳过（每周更新一次）。如想立即刷新可设 DUDU_FORCE_DOUBAN=1")
                return
        except Exception:
            pass
    print("🎬 抓取豆瓣观影清单...")
    UID = "250512533"
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    hdr = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36", "Accept-Language": "zh-CN,zh;q=0.9"}

    def clean(t):
        t = re.sub(r"<[^>]+>", "", t).strip()
        return t.split(" / ")[0].strip() or t

    def grab(kind, maxp=4):
        out = []
        for p in range(1, maxp + 1):
            url = f"https://movie.douban.com/people/{UID}/{kind}?start={(p-1)*15}&sort=time"
            try:
                h = urllib.request.urlopen(urllib.request.Request(url, headers=hdr), timeout=15, context=ctx).read().decode("utf-8", "ignore")
            except Exception as e:
                print(f"  ⚠️ 豆瓣 {kind} 抓取失败: {e}")
                break
            rows = re.findall(r'<li class="title">.*?<a href="(https://movie\.douban\.com/subject/(\d+)/)">(.*?)</a>', h, re.S)
            years = re.findall(r'<span class="year">\((\d{4})\)</span>', h)
            rates = re.findall(r'<span class="rating">.*?class="[^"]*"[^>]*>([^<]*)</span>', h, re.S)
            for i, (link, sid, t) in enumerate(rows):
                out.append({"title": clean(t), "year": years[i] if i < len(years) else "", "rating": rates[i].strip() if i < len(rates) else "", "link": link})
            if len(rows) < 15:
                break
        seen = set(); uniq = []
        for r in out:
            if r["link"] in seen:
                continue
            seen.add(r["link"]); uniq.append(r)
        return uniq

    try:
        wish = grab("wish"); collect = grab("collect")
        data = {"updated": datetime.now().strftime('%Y-%m-%d'), "wish": wish, "collect": collect}
        js = "// 豆瓣观影清单（由 feishu_sync.py fetch_douban() 生成）\nwindow.DOUBAN_DATA = " + json.dumps(data, ensure_ascii=False, indent=2) + ";\n"
        with open(os.path.join(WORKSPACE, 'douban_data.js'), 'w') as f:
            f.write(js)
        save_json('last_douban_sync.json', {'last_sync': datetime.now().isoformat(), 'wish': len(wish), 'collect': len(collect)})
        print(f"  ✅ 豆瓣: 想看 {len(wish)} | 看过 {len(collect)}")
    except Exception as e:
        print(f"  ⚠️ 豆瓣抓取异常: {e}")


# ═══════════════════════════════════════════════════════
# 7b. 每日金句与播客最新单集
# ═══════════════════════════════════════════════════════

def fetch_daily_quote():
    """获取每日金句（一言），失败返回 None。"""
    try:
        url = "https://v1.hitokoto.cn/?c=k&c=d&c=i&c=h&max_length=50"
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=10) as r:
            data = json.loads(r.read().decode('utf-8'))
        return {"content": data.get("hitokoto", ""), "source": data.get("from", "")}
    except Exception as e:
        print(f"  ⚠️ 金句获取失败: {e}")
        return None


def fetch_podcast_episodes():
    """获取指定播客的最新单集标题，失败则保留旧数据。带重试与多源兜底。"""
    podcasts = [
        {"name": "嗨咻", "feed": "https://rsshub.rssforever.com/xiaoyuzhou/podcast/631812fe43274df80456d001"},
        {"name": "头回当妈", "feed": "https://feed.xyzfm.space/lvju7r4p7hup"},
        {"name": "畅所育言", "feed": "https://rsshub.rssforever.com/xiaoyuzhou/podcast/64d25bd580c9ec4c5fbb0da4"},
        {"name": "当个事儿", "feed": "https://feed.xyzfm.space/myefm33b8n77"},
        {"name": "Alison Yu心理", "feed": "https://rsshub.rssforever.com/xiaoyuzhou/podcast/67c8dd34d6c2a59e23f2d932"},
    ]
    out = []
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    for p in podcasts:
        title = ""
        last_err = ""
        for attempt in range(3):
            try:
                req = urllib.request.Request(p["feed"], headers={
                    "User-Agent": "Mozilla/5.0 (compatible; RSSReader/1.0)",
                    "Accept-Encoding": "gzip, deflate",
                })
                with urllib.request.urlopen(req, timeout=20, context=ctx) as r:
                    data = r.read()
                    if r.headers.get('Content-Encoding') == 'gzip':
                        import gzip
                        data = gzip.decompress(data)
                    xml = data.decode('utf-8', 'ignore')
                # 取第一个 <item> 的 <title>（兼容 <itunes:title> 与 CDATA）
                m = re.search(r'<item[^>]*>.*?<(?:itunes:)?title[^>]*>(.*?)</(?:itunes:)?title>', xml, re.S | re.I)
                if m:
                    title = re.sub(r'<\!\[CDATA\[(.*?)\]\]>', r'\1', m.group(1), flags=re.S).strip()
                    title = re.sub(r'<[^>]+>', '', title).strip()
                if title:
                    break
            except Exception as e:
                last_err = str(e)
                continue
        if not title:
            print(f"  ⚠️ 播客 {p['name']} 抓取失败（3次重试）: {last_err}")
        out.append({"name": p["name"], "latest": title or "最新单集加载中…"})
    return out


def generate_extra_data():
    """生成 extra_data.js（静态模块数据 + 每日金句 + 播客最新单集）。"""
    print("📦 Generating extra_data.js...")

    # 基础静态数据
    mortgage = {
        "updated": datetime.now().strftime('%Y-%m-%d'),
        "total": 1910000.0,
        "balance": 1717726.07,
        "paid_principal": 192273.93,
        "monthly": 7927.4,
        "rate": 3.1,
        "start": "2023-01-04",
        "end": "2053-01-04",
        "method": "等额本息",
        "pay_day": 21,
        "paid_months": 42,
        "total_months": 360,
        "progress": 0.1007
    }
    invest = {
        "updated": datetime.now().strftime('%Y-%m-%d'),
        "gold": False,
        "accounts": [
            {"name": "股票账户杜", "total": 380956.03, "today": 10565.0, "hold": -51001.13},
            {"name": "股票账户赵", "total": 429811.7, "today": 12214.0, "hold": -54598.92}
        ]
    }
    important_dates = {
        "updated": datetime.now().strftime('%Y-%m-%d'),
        "list": [
            {"name": "爽", "type": "生日", "calendar": "lunar", "lunar": "7-18", "solar": None, "mode": "countdown", "next_date": "2026-08-30", "icon": "🎂"},
            {"name": "晗哥", "type": "生日", "calendar": "lunar", "lunar": "1-1", "solar": None, "mode": "countdown", "next_date": "2027-02-06", "icon": "🎂"},
            {"name": "爸爸", "type": "生日", "calendar": "lunar", "lunar": "1-21", "solar": None, "mode": "countdown", "next_date": "2027-02-26", "icon": "🎂"},
            {"name": "妈妈", "type": "生日", "calendar": "lunar", "lunar": "7-6", "solar": None, "mode": "countdown", "next_date": "2026-08-18", "icon": "🎂"},
            {"name": "何瑜", "type": "生日", "calendar": "lunar", "lunar": "9-6", "solar": None, "mode": "countdown", "next_date": "2026-10-15", "icon": "🎂"},
            {"name": "张娈", "type": "生日", "calendar": "lunar", "lunar": "3-28", "solar": None, "mode": "countdown", "next_date": "2027-05-04", "icon": "🎂"},
            {"name": "郭瑞", "type": "生日", "calendar": "lunar", "lunar": "12-15", "solar": None, "mode": "countdown", "next_date": "2027-01-22", "icon": "🎂"},
            {"name": "丽妍", "type": "生日", "calendar": "solar", "lunar": None, "solar": "08-26", "mode": "countdown", "next_date": "2026-08-26", "icon": "🎂"},
            {"name": "结婚纪念日", "type": "纪念日", "calendar": "solar", "fixed": "2023-04-28", "mode": "elapsed", "icon": "💍"},
            {"name": "买房日", "type": "里程碑", "calendar": "solar", "fixed": "2024-09-30", "mode": "elapsed", "icon": "🏠"}
        ]
    }

    # 与旧数据 deep-merge（保留手动修改的投资/房贷/重要日子）
    extra_path = os.path.join(WORKSPACE, 'extra_data.js')
    existing = {}
    if os.path.exists(extra_path):
        try:
            with open(extra_path, 'r', encoding='utf-8') as f:
                raw = f.read()
            # 正确提取所有 window.NAME = {...} 顶层对象（避免误把内部字段当顶层 key）
            for m in re.finditer(r'window\.(\w+)\s*=\s*', raw):
                start = raw.find('{', m.end())
                if start == -1:
                    continue
                depth = 0
                for i in range(start, len(raw)):
                    if raw[i] == '{':
                        depth += 1
                    elif raw[i] == '}':
                        depth -= 1
                        if depth == 0:
                            try:
                                existing[m.group(1)] = json.loads(raw[start:i + 1])
                            except Exception:
                                pass
                            break
        except Exception as e:
            print(f"  ⚠️ 旧 extra_data.js 解析失败: {e}")

    base = {
        "PODCASTS_DATA": {"updated": datetime.now().strftime('%Y-%m-%d'), "list": fetch_podcast_episodes()},
        "MORTGAGE_DATA": mortgage,
        "INVEST_DATA": invest,
        "IMPORTANT_DATES_DATA": important_dates,
        "DAILY_QUOTE": fetch_daily_quote()
    }
    merged = _deep_merge(base, existing)
    # 静态数据以代码内为准，金句/播客必须重新抓取
    merged["PODCASTS_DATA"] = base["PODCASTS_DATA"]
    merged["DAILY_QUOTE"] = base["DAILY_QUOTE"]
    # 保留日期字段的 next_date 计算？这里简化，直接以代码内为准；如需阴历计算可扩展

    js = "// 新增模块静态数据（由 feishu_sync.py 生成 / 手动维护）\n"
    for key, val in merged.items():
        js += f"window.{key} = {json.dumps(val, ensure_ascii=False, indent=2)};\n"
    with open(extra_path, 'w', encoding='utf-8') as f:
        f.write(js)
    print(f"  ✅ Generated extra_data.js: {os.path.getsize(extra_path)} bytes")


# ═══════════════════════════════════════════════════════
# 8. 生成 dashboard_data.js（汇总所有数据）
# ═══════════════════════════════════════════════════════

def _deep_merge(base, update):
    """深度合并，None/空值不覆盖旧数据"""
    result = dict(base)
    for key, val in update.items():
        if val is None or val == '' or val == [] or val == {}:
            continue
        if key in result and isinstance(result[key], dict) and isinstance(val, dict):
            result[key] = _deep_merge(result[key], val)
        else:
            result[key] = val
    return result


def generate_dashboard():
    """生成 dashboard_data.js，汇总所有独立 JSON 文件"""
    print("📦 Generating dashboard_data.js...")

    # 读取所有独立数据文件
    all_sources = {
        'tasks': load_json('tasks.json', {}),
        'memos': load_json('memos.json', {}),
        'inspirations': load_json('inspirations.json', {}),
        'finance': load_json('finance.json', {}),
        'expense_categories': load_json('expense_categories.json', {}),
        'reading': load_json('reading.json', {}),
        'published_notes': load_json('published_notes.json', {}),
        'exercise': load_json('exercise_data.json', {}),
        'hot_topics': load_json('hot_topics.json', {}),
    }

    # ── 合并一人公司数据：把 published_notes.total 注入 oneCompany ──
    # one_company.json 包含收入/订单/产品信息，published_notes 包含笔记数量
    one_company = load_json('one_company.json', {})
    pub_notes = all_sources.get('published_notes', {})
    if pub_notes.get('total') is not None:
        one_company['total_published_notes'] = pub_notes['total']
    all_sources['oneCompany'] = one_company

    # ── 合并热点资讯：统一使用 camelCase key ──
    hot_topics = all_sources.get('hot_topics', {})
    all_sources['hotTopics'] = hot_topics

    # 深度合并（保留旧数据，失败的数据源不影响）
    dashboard_path = os.path.join(WORKSPACE, 'dashboard_data.js')
    if os.path.exists(dashboard_path):
        try:
            with open(dashboard_path) as f:
                raw = f.read()
            # 提取 JSON（去除注释）
            lines = [l for l in raw.split('\n') if not l.strip().startswith('//')]
            text = '\n'.join(lines)
            start_idx = text.find('{')
            if start_idx >= 0:
                brace_count = 0
                for i, c in enumerate(text[start_idx:]):
                    if c == '{': brace_count += 1
                    elif c == '}': brace_count -= 1
                    if brace_count == 0:
                        existing = json.loads(text[start_idx:start_idx + i + 1])
                        all_sources = _deep_merge(existing, all_sources)
                        print("  🔄 Deep-merged with existing data")
                        break
        except Exception as e:
            print(f"  ⚠️ Existing dashboard parse error: {e}")

    # 确保 exercise 中没有 checked_days（防止旧数据被 deep-merge 保留）
    if 'exercise' in all_sources and 'checked_days' in all_sources['exercise']:
        del all_sources['exercise']['checked_days']
        print("  🧹 最终清理: 已从 exercise 移除 checked_days")

    # 添加同步时间戳
    all_sources['last_sync'] = datetime.now().strftime('%Y-%m-%d %H:%M')

    # 生成 JS 文件（同时生成两个文件名，确保兼容性）
    js_content = '// Auto-generated by feishu_sync.py\n'
    js_content += '// Last updated: ' + all_sources['last_sync'] + '\n'
    js_content += 'const DASHBOARD_DATA = ' + json.dumps(all_sources, ensure_ascii=False, indent=2) + ';\n'

    for filename in ['dashboard_data.js', 'data_latest.js']:
        js_path = os.path.join(WORKSPACE, filename)
        with open(js_path, 'w') as f:
            f.write(js_content)
        print(f"  ✅ Generated {filename}: {os.path.getsize(js_path)} bytes")
    # ── 同步到 deploy 目录 ──
    deploy_dir = os.path.join(os.path.dirname(WORKSPACE), 'deploy', 'feishu_data')
    if os.path.exists(deploy_dir):
        for fname in ['dashboard_data.js', 'data_latest.js', 'exercise_data.json', 'extra_data.js', 'douban_data.js']:
            src_p = os.path.join(WORKSPACE, fname)
            dst_p = os.path.join(deploy_dir, fname)
            if os.path.exists(src_p):
                shutil.copy2(src_p, dst_p)
                print(f"  📦 Deployed: {fname} → deploy/")
    else:
        print("  ⚠️ deploy/feishu_data not found, skipping deploy copy")

    return all_sources


# ═══════════════════════════════════════════════════════
# Main
# ═══════════════════════════════════════════════════════

def main():
    print(f"\n{'='*50}")
    print(f"  飞书数据同步 - {datetime.now().strftime('%Y-%m-%d %H:%M')}")
    print(f"{'='*50}\n")

    # 1. 今日待办 + 灵感宝箱
    tasks, memos = fetch_today_tasks_and_memos()
    inspirations = fetch_inspirations()

    # 2. 财务数据
    finance = fetch_finance()

    # 2b. 支出分类排名
    expense_categories = fetch_expense_categories()

    # 3. 阅读挑战
    reading = fetch_reading()

    # 4. 一人公司经营数据
    one_company = fetch_one_company()

    # 5. 已发布笔记
    published_notes = fetch_published_notes()

    # 6. 运动打卡（保持现有）
    exercise = fetch_exercise()

    # 7. 热点资讯（保持现有）
    hot_topics = fetch_hot_topics()

    # 7b. 豆瓣观影清单（新增）
    fetch_douban()

    # 7c. 每日金句 + 播客最新单集 + extra_data.js
    generate_extra_data()

    # 8. 生成汇总文件
    all_data = generate_dashboard()

    # 9. 上传到 GitHub Gist（供线上网站动态加载）
    upload_to_gist(all_data)

    # 10. 记录同步时间
    save_json('last_sync.json', {
        'last_sync': datetime.now().isoformat(),
        'sources': {
            'tasks': len(tasks.get('items', [])),
            'memos': len(memos.get('items', [])),
            'inspirations': len(inspirations.get('items', [])),
            'finance_year_income': finance.get('year_income', '¥--'),
            'expense_categories': len(expense_categories.get('items', [])),
            'one_company_orders': one_company.get('total_orders', 0),
            'published_notes': published_notes.get('total', 0),
            'reading_day': reading.get('rolling_day', 0),
        }
    })

    print(f"\n{'='*50}")
    print(f"  ✅ 同步完成 {datetime.now().strftime('%H:%M')}")
    print(f"{'='*50}\n")

if __name__ == '__main__':
    main()
