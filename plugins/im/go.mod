// IM 桥插件(飞书/钉钉…提供方适配)——独立 Go 模块,经 replace 编译进 ttmux 二进制(builtin)。
// 只依赖公开 SDK ttmux-cli-go/pkg/plugin/sdk,不触碰宿主 internal。
module roam-plugins/im

go 1.22

require (
	github.com/larksuite/oapi-sdk-go/v3 v3.9.8
	ttmux-cli-go v0.0.0
)

require (
	github.com/gogo/protobuf v1.3.2 // indirect
	github.com/gorilla/websocket v1.5.0 // indirect
)

replace ttmux-cli-go => ../../cli/ttmux-cli-go
