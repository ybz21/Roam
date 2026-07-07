# plugins/ — 插件包统一目录

所有以**插件包**形态分发的插件(示例、外部、今后新增的)都放在这个目录下,
每个插件一个子目录,根部带 `roam-plugin.json` manifest(格式见
[docs/design/plugin/05-manifest.md](../docs/design/plugin/05-manifest.md))。

```
plugins/
  examples/
    hello-py/          # exec 运行时示例插件(Python)
      roam-plugin.json
      main.py
```

安装与启用:

```sh
ttmux plugin install plugins/examples/hello-py   # 目录或 .tgz 均可
ttmux plugin enable hello-py                     # 安装后默认不启用
```

安装后的文件落 `$TTMUX_HOME/plugins/installed/<id>/<version>/`,仓库里的
这份是源码;开发指南见 [docs/design/plugin/09-plugin-development.md](../docs/design/plugin/09-plugin-development.md)。

> 注:`review-mesh`(智能互审)与 `feishu-bridge`(飞书通知)是 **builtin
> 插件**,Go 源码位于 `cli/ttmux-cli-go/internal/plugin/builtin/`,编译进
> ttmux 二进制、默认启用,不走本目录的包安装通路。
