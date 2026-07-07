#!/usr/bin/env python3
"""Roam exec 插件示例:协议就是 LSP 式 Content-Length framing 的 JSON-RPC 2.0。

宿主(plugind)在 stdin 上派发 initialize / plugin/invokeCommand /
plugin/onEvent / plugin/deactivate,插件在 stdout 上回响应(stdout 只能走
RPC 帧,日志一律写 stderr)。见 docs/design/plugin/09-plugin-development.md §5。
"""
import json
import sys


def read_msg(stdin):
    length = 0
    while True:
        line = stdin.readline()
        if not line:
            return None
        line = line.strip()
        if not line:
            if length:
                break
            continue
        if line.lower().startswith(b"content-length:"):
            length = int(line.split(b":", 1)[1])
    body = stdin.read(length)
    return json.loads(body)


def send(obj):
    body = json.dumps(obj, ensure_ascii=False).encode()
    sys.stdout.buffer.write(b"Content-Length: %d\r\n\r\n" % len(body))
    sys.stdout.buffer.write(body)
    sys.stdout.buffer.flush()


def reply(mid, result=None, error=None):
    msg = {"jsonrpc": "2.0", "id": mid}
    if error is not None:
        msg["error"] = error
    else:
        msg["result"] = result
    send(msg)


def main():
    stdin = sys.stdin.buffer
    ctx = {}
    while True:
        msg = read_msg(stdin)
        if msg is None:
            return
        mid, method = msg.get("id"), msg.get("method")
        params = msg.get("params") or {}
        if method == "initialize":
            ctx.update(params)
            print(f"[hello-py] initialized for workspace {ctx.get('workspace')}", file=sys.stderr)
            reply(mid, {"commands": ["greet"]})
        elif method == "plugin/invokeCommand":
            args = params.get("args") or {}
            if params.get("command") == "greet":
                name = args.get("name", "roam")
                reply(mid, {"text": f"hello, {name}! (from a python exec plugin)",
                            "workspace": ctx.get("workspace", "")})
            else:
                reply(mid, error={"code": -32601, "message": "unknown command"})
        elif method == "plugin/onEvent":
            reply(mid, {"handled": False})
        elif method == "plugin/deactivate":
            reply(mid, {"ok": True})
            return
        elif mid is not None:
            reply(mid, error={"code": -32601, "message": f"unknown method: {method}"})


if __name__ == "__main__":
    main()
