"""mitmproxy addon：自动捕获 AutoClaw 国际版登录响应中的 refresh_token。

用法：
    brew install mitmproxy
    mitmdump -s tools/mitm_autoclaw_intl.py       # 推荐：无 TUI，插件输出直接可见
    mitmproxy -s tools/mitm_autoclaw_intl.py      # TUI：底栏 [scripts:1] 表示已加载，事件按 E 查看

然后让流量经过代理（macOS：系统设置 → 网络 → 代理 127.0.0.1:8080），并信任证书
（浏览器访问 http://mitm.it），再让 AutoClaw 国际版客户端退出重登。
捕获到 zai-oauth-login / google-oauth-login 的响应后，refresh_token 会写入项目根目录
`.autoclaw-intl-token`（0600，已 gitignore），并打印下一步命令。用完关掉系统代理。

说明：只读取本机、本人账号的登录响应，不上报任何数据；token 属账号凭证，请勿外泄。
"""

import json
import os

from mitmproxy import http

TOKEN_FILE = ".autoclaw-intl-token"


def response(flow: http.HTTPFlow) -> None:
    url = flow.request.pretty_url
    if "overseasv1" not in url or "oauth-login" not in url:
        return

    try:
        body = json.loads(flow.response.get_text())
    except (ValueError, AttributeError):
        return

    data = body.get("data") or {}
    refresh_token = data.get("refresh_token")
    if not refresh_token:
        return

    with open(TOKEN_FILE, "w", encoding="utf-8") as handle:
        handle.write(refresh_token)
    os.chmod(TOKEN_FILE, 0o600)

    print("\n" + "=" * 64)
    print(f"已捕获 AutoClaw 国际版 refreshToken → {TOKEN_FILE}（仅本机可读）")
    print('下一步：npm run autoclaw-intl-login -- --token "$(cat .autoclaw-intl-token)"')
    print("=" * 64 + "\n")
