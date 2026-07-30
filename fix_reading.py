#!/usr/bin/env python3
"""
一键修改 feishu_sync.py - 添加微信读书实时 API
双击运行或在终端运行: python3 fix_reading.py
"""
import os, shutil, sys

# 自动搜索 feishu_sync.py
candidates = [
    os.path.expanduser('~/Workbuddy/2026-07-20-12-07/feishu_data/feishu_sync.py'),
    os.path.expanduser('~/Workbuddy/2026-07-28/feishu_data/feishu_sync.py'),
    os.path.expanduser('~/.agents/skills/life-dashboard-builder/scripts/feishu_sync.py'),
]

# 也搜索一下
for root, dirs, files in os.walk(os.path.expanduser('~')):
    for f in files:
        if f == 'feishu_sync.py':
            candidates.append(os.path.join(root, f))

# 找到包含 fetch_reading 的那个
target = None
for fp in candidates:
    if os.path.exists(fp):
        try:
            c = open(fp).read()
            if 'def fetch_reading' in c and 'weekly_read_time' in c:
                target = fp
                break
        except:
            pass

if not target:
    print("❌ 没找到 feishu_sync.py（含 fetch_reading 的版本）")
    print("   请确认你的文件在 /Users/jane/Workbuddy/ 目录下")
    sys.exit(1)

print(f"✅ 找到目标文件: {target}")

c = open(target).read()
lines = c.split('\n')

# 找 weekly_read_time 那行
found = None
for i, line in enumerate(lines):
    if 'weekly_read_time' in line and 'challenge.get' in line:
        found = i
        break

if found is None:
    print(f"❌ 没找到 weekly_read_time 那行")
    sys.exit(1)

print(f"   weekly_read_time 在第 {found+1} 行")

# 替换这两行
new_lines = [
    '    weekly_read_time = None',
    '    yesterday_read_time = None',
    '    try:',
    "        weekly_stats = call_weread_api('/readdata/detail', {'mode': 'weekly'})",
    '        if weekly_stats:',
    "            weekly_read_time = weekly_stats.get('readTime') or weekly_stats.get('weeklyReadTime')",
    '            print(f"  ✅ 本周阅读时间（API）: {weekly_read_time}")',
    '    except Exception as e:',
    '        print(f"  ⚠️ 本周阅读时间 API 失败: {e}")',
    '    try:',
    '        yesterday = today - timedelta(days=1)',
    "        yesterday_str = yesterday.strftime('%Y-%m-%d')",
    "        daily_stats = call_weread_api('/readdata/detail', {'mode': 'daily', 'date': yesterday_str})",
    '        if daily_stats:',
    "            yesterday_read_time = daily_stats.get('readTime') or daily_stats.get('dailyReadTime')",
    '            print(f"  ✅ 昨日阅读时间（API）: {yesterday_read_time}")',
    '    except Exception as e:',
    '        print(f"  ⚠️ 昨日阅读时间 API 失败: {e}")',
    '    if weekly_read_time is None:',
    "        weekly_read_time = challenge.get('weekly_read_time', 0)",
    '    if yesterday_read_time is None:',
    "        yesterday_read_time = challenge.get('yesterday_read_time', 0)",
]

end = found + 1
while end < len(lines) and 'yesterday_read_time' in lines[end]:
    end += 1

new_content = '\n'.join(lines[:found] + new_lines + lines[end:])
shutil.copy2(target, target + '.bak')
open(target, 'w').write(new_content)
print("✅ 修改完成！已备份原文件到 .bak")
print("✅ 现在可以运行 feishu_sync.py 了")
