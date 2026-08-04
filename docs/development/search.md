# 全局搜索（⌘K）

一个查询同时打项目、会话、项目文件、插件、蜂群；文件内容另走一条显式的全文搜索。
本文只讲**怎么加一类可搜的东西**和**为什么是现在这个形状**。

## 三路结果

| 来源 | 内容 | 延迟 | 何时跑 |
|---|---|---|---|
| 本地（前端内存） | 页面导航、已打开的会话 | 0ms | 每次按键 |
| `GET /api/search` | 项目、**全部**会话、项目文件名、插件、蜂群 | 20–100ms | 每次按键（120ms 防抖 + AbortSignal 掐上一发） |
| `GET /api/search/content` | 文件内容（rg，没装则 grep） | 几十 ms ～ 8s | 用户按 ⌘⏎ 或点底部那条时 |

本地那一路先渲染，后端结果回来再并进去：搜索框最忌讳「按一个键顿一下」，所以网络
永远不挡在渲染前面。

## 加一类可搜的东西

**只改一个文件**：`backend/api/search_sources.go`。

```go
func (a *API) cronJobSource() search.Source {
    return search.FuncSource{KindName: "cronjob", Max: 6, List: func(ctx context.Context) []search.Doc {
        return []search.Doc{{
            ID:       job.ID,
            Title:    job.Name,          // 主字段：命中打满分并高亮
            Subtitle: job.Schedule,      // 副字段：命中打 75 折，不高亮
            Aliases:  []string{job.ID},  // 参与匹配但不显示
            Action:   search.Action{Type: "route", Target: "#/plugins"},
        }}
    }}
}
```

然后把它加进 `Search` handler 的 `all` 列表。前端**一行都不用改**：

- 打分、排序、每类条数上限在引擎里（`backend/search/engine.go`）；
- 「点开做什么」由 `Action` 表达，只有三种：`route`（换 hash 路由）、`session`
  （打开终端）、`file`（打开文件），前端只认这三种；
- 类别顺序与图标在 `frontend/src/shell/palette/`，没登记的新类别会排在最后、
  用类别名当分组标题、用放大镜当图标——**少一行译文也不会导致整组结果消失**。

要吐几万条候选的源（如文件）不要用 `FuncSource`，自己实现 `Source`：`Each` 是推的，
边走边吐，不必先攒成切片。

## 打分

`backend/search/score.go` 与 `frontend/src/search/score.ts` 是**同一套算法的两份实现**
（本地条目和后端结果必须同尺度，否则合并后的排序自相矛盾）。改一处就要改另一处，
两边的用例分别钉在 `score_test.go` 与 `score.test.ts`。

规则照 fzf 的思路做了一版小的：子序列匹配 + 位置奖励（词首 / 驼峰拐点 / 连续）+
间隔惩罚。所以 `ovw` 能命中 `Overview.tsx`，而 `a…b…c` 那种跨半个路径的巧合排在后面。
查询按空白切词做 AND（`api search`），命中位置回传给 UI 加粗。

性能上有两条硬要求：

1. `Query` 是**编译一次、打几十万次**的（切词与转 rune 只做一次）；
2. `Score` 一进门先做零分配的子序列预筛（`CouldMatch`）。没有这一道时，光是
   「转 rune + 算位置奖励」两次分配就把一次搜索从 20ms 拖到 500ms。

## 文件索引

`backend/search/index.go`：一个项目根一份相对路径清单，TTL 120s。

- **遍历永远在后台**，请求绝不等它。第一版同步走树，八个项目里有几棵大的，第一次
  按键卡了半分钟；现在 `Files()` 立刻交出手上那份（第一次是空的），同时后台重建，
  面板显示「文件索引还在建」。
- 有三重上限：条数（60000）、访问条目（400000）、时间预算（15s）。任何一条触发都
  标记 `truncated`，UI 会说一句「结果较多」。
- 跳过产物与依赖目录（`node_modules` / `dist` / `.git` / `__pycache__` …），也跳过
  `.worktrees`——roam 自己的 worktree 就在仓库内，不跳的话同一个文件会以「主仓库一份
  + 每个 worktree 一份」重复出现。
- 不做 fsnotify 常驻监听：为此要吃掉每个项目的 inotify 配额，而 TTL 足够。

搜索时会给「当前会话所属项目」的文件加分（`activeProjectBoost`）：搜 `ovw` 时你要的
多半是手头这个项目的 `Overview.tsx`，而不是另一个项目里反编译出来的
`OnVideoNotWorkCallback.java`——后者按字形还更「像」。

## 入口

面板挂在 `shell/palette/GlobalSearch`，**不在顶栏里**：手机没有顶栏、单终端页
（`#/term/xxx`）也没有，而搜索要处处能唤起。入口有三个：顶栏那枚框、手机「更多」里
那一行、`⌘K` / `Ctrl+K`（`/` 也行，但在输入框和终端里不抢）。

快捷键监听走**捕获阶段**：xterm 在自己的 textarea 上挂 keydown 并会 stopPropagation，
冒泡阶段的监听在终端聚焦时根本收不到 ⌘K。
