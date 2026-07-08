# plugins/ — 插件统一目录

所有插件都住在这里,**每个插件一个目录、一个独立 Go 模块**(或一个插件包)。

```
plugins/
  im/                # IM 机器人(飞书已支持,钉钉等可扩展;常驻 concierge 管家)
    go.mod           #   独立模块 roam-plugins/im(provider 适配见 im/provider.go)
  reviewmesh/        # 智能互审(空闲自动互审、意见回灌)
    go.mod           #   独立模块 roam-plugins/reviewmesh
  examples/
    hello-py/        # exec 运行时示例插件(Python,插件包形态)
      roam-plugin.json
      main.py
```

## 两种形态

**builtin Go 插件(im、reviewmesh)**:每个插件是独立 Go 模块,经 cli 模块的
`replace` 编译进 ttmux 二进制——开箱即用、默认启用,不走安装流程。约定:

- 只依赖公开 SDK `ttmux-cli-go/pkg/plugin/sdk`,不触碰宿主 internal;
- manifest 声明与 Activate 接线在注册表
  `cli/ttmux-cli-go/internal/plugin/builtin/builtin.go`;
- 新增一个 builtin 插件 = 建 `plugins/<名>/go.mod` + 在 cli go.mod 加
  require/replace + 注册表加一行;
- 改完插件代码需要重新构建安装 ttmux 才生效。

**插件包(examples/ 及第三方)**:目录带 `roam-plugin.json` manifest(格式见
[docs/design/plugin/05-manifest.md](../docs/design/plugin/05-manifest.md)),
node/exec 运行时,走安装流程:

```sh
ttmux plugin install plugins/examples/hello-py   # 目录或 .tgz 均可
ttmux plugin enable hello-py                     # 安装后默认不启用
```

安装后的文件落 `$TTMUX_HOME/plugins/installed/<id>/<version>/`;开发指南见
[docs/design/plugin/09-plugin-development.md](../docs/design/plugin/09-plugin-development.md)。
