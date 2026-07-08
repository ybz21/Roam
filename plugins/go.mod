// roam-plugins 是官方插件实现模块:源码住在仓库根 plugins/,经 replace 编译
// 进 ttmux 二进制(运行时仍是 builtin,开箱即用)。插件只依赖公开的
// ttmux-cli-go/pkg/plugin/sdk,不触碰宿主 internal。
module roam-plugins

go 1.22

require (
	github.com/larksuite/oapi-sdk-go/v3 v3.9.8
	ttmux-cli-go v0.0.0
)

require (
	github.com/gogo/protobuf v1.3.2 // indirect
	github.com/gorilla/websocket v1.5.0 // indirect
)

replace ttmux-cli-go => ../cli/ttmux-cli-go
