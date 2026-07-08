# plugins/ — 插件统一目录

所有插件都住在这里:官方 builtin 插件的 Go 源码、示例/外部插件包,以及今后
新增的任何插件。

```
plugins/
  go.mod             # roam-plugins 模块(builtin 插件的 Go 实现)
  feishu/            # 飞书管家(常驻 concierge:@机器人 进大脑,复杂活委派 worker)
  reviewmesh/        # 智能互审(空闲自动互审、意见回灌)
  examples/
    hello-py/        # exec 运行时示例插件(Python,插件包形态)
      roam-plugin.json
      main.py
```

## 两种形态

**builtin(feishu、reviewmesh)**:Go 源码在本目录,经 `replace` 编译进 ttmux
二进制,开箱即用、默认启用,不走安装流程。它们只依赖公开 SDK
`ttmux-cli-go/pkg/plugin/sdk`,不触碰宿主 internal;manifest 声明在
`cli/ttmux-cli-go/internal/plugin/builtin/builtin.go`(注册表)。改完插件代码
需要重新构建安装 ttmux 才生效。

**插件包(examples/ 及第三方)**:目录带 `roam-plugin.json` manifest(格式见
[docs/design/plugin/05-manifest.md](../docs/design/plugin/05-manifest.md)),
node/exec 运行时,走安装流程:

```sh
ttmux plugin install plugins/examples/hello-py   # 目录或 .tgz 均可
ttmux plugin enable hello-py                     # 安装后默认不启用
```

安装后的文件落 `$TTMUX_HOME/plugins/installed/<id>/<version>/`;开发指南见
[docs/design/plugin/09-plugin-development.md](../docs/design/plugin/09-plugin-development.md)。
