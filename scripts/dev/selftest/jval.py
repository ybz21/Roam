#!/usr/bin/env python3
"""从 stdin 的 JSON 里按点分路径取一个值，给自检脚本用。

`{"data": …}` 那层自动剥掉——后端两种形状都有（裸数组，或包一层 data）。
容器类型打长度：「几个会话」「几个项目」正是要问的那个数。
取不到就 exit 1、不打印，调用方据此判失败。

    echo '{"data":{"cpu":{"usagePercent":7.3}}}' | jval.py cpu.usagePercent   # 7.3
    echo '[1,2,3]' | jval.py                                                  # 3
"""
import json
import sys

try:
    cur = json.load(sys.stdin)
except Exception:
    sys.exit(1)

if isinstance(cur, dict) and "data" in cur:
    cur = cur["data"]

for key in [p for p in (sys.argv[1] if len(sys.argv) > 1 else "").split(".") if p]:
    if isinstance(cur, list) and key.isdigit():
        cur = cur[int(key)] if int(key) < len(cur) else sys.exit(1)
    elif isinstance(cur, dict) and key in cur:
        cur = cur[key]
    else:
        sys.exit(1)

print(len(cur) if isinstance(cur, (list, dict)) else cur)
