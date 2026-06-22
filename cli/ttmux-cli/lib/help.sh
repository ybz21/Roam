# ══════════════════════════════════════════
# ── 帮助 ──
# ══════════════════════════════════════════

show_help() {
    cat <<EOF

  ${bold}ttmux${reset} ${dim}v${TTMUX_VERSION} — AI-native tmux wrapper${reset}

  ${bold}用法${reset}:  ttmux ${cyan}<命令>${reset} [参数...]

  ${bold}会话管理${reset}
    ${green}ls${reset}    ${dim}[--json]${reset}              列出所有会话
    ${green}new${reset}   ${dim}[名称]${reset}                新建会话
    ${green}a${reset}     ${dim}[名称]${reset}                附加会话 ${dim}(无参数交互选择)${reset}
    ${green}d${reset}     ${dim}[名称]${reset}                分离会话
    ${green}kill${reset}  ${dim}[名称]${reset}                关闭会话
    ${green}killall${reset}                    关闭所有会话
    ${green}rename${reset} ${dim}<旧名> <新名>${reset}        重命名会话

  ${bold}任务编排 ${magenta}(命令 / Agent 统一)${reset}
    ${green}spawn${reset}  ${dim}<组名> <名称> <命令> ...${reset}      批量创建命令任务
    ${green}spawn${reset}  ${dim}--agent <组名> <名称> <任务> ...${reset}  批量创建 Claude Agent
    ${green}spawn${reset}  ${dim}[--agent] --file <组名> <文件>${reset}   从文件读取
    ${green}status${reset} ${dim}<组名> [--json]${reset}            查看状态 (命令+Agent)
    ${green}wait${reset}   ${dim}<组名> [--timeout N]${reset}       等待任务组完成
    ${green}collect${reset} ${dim}<组名> [--json]${reset}           收集所有任务输出
    ${green}send${reset}   ${dim}<会话名> <指令>${reset}            向任务/Agent 追加指令
    ${green}group${reset}  ${dim}ls | kill <组名>${reset}           列出 / 清理任务组
    ${green}capture${reset} ${dim}<会话> [--lines N]${reset}        捕获会话输出

    ${dim}Agent 选项: --dir <目录>  --model <模型>  --perm <权限模式>  --max-turns <N>${reset}
    ${dim}兼容别名: agent spawn|status|send|collect|kill 仍可用${reset}

  ${bold}蜂群编排 ${magenta}(swarm — 有目标的任务组, 可被 cc 接管)${reset}
    ${green}swarm new${reset}    ${dim}<名> [--goal "..."] [--no-master]${reset}  新建蜂群(默认自带 Leader, --no-master 跳过)
    ${green}swarm add${reset}    ${dim}<群> <成员> --type task|agent [--kind claude|codex] [--role leader|member] ...${reset}  加成员(首个 agent 默认 leader)
                ${dim}[--dir/--perm/--model] [--depends-on a,b] <命令或任务>${reset}
    ${green}swarm ls${reset}     ${dim}[--json]${reset}                    列出蜂群 (目标/状态/指挥)
    ${green}swarm status${reset} ${dim}<群> [--json]${reset}             成员/依赖/挂起 + 看板摘要 + 广场最近
    ${green}swarm activate${reset} ${dim}<群> [成员] [--force]${reset}   解锁挂起成员 (--force 无视依赖)
    ${green}swarm done${reset}   ${dim}<群> [成员]${reset}             带成员=标该成员完成并解锁下游, 无成员=整群完成
    ${green}swarm collect${reset} ${dim}<群> [--json]${reset}          收集成员输出
    ${green}swarm migrate${reset}                          迁移旧版蜂群元数据并补齐成员索引
    ${magenta}广场${reset} ${green}swarm say${reset} ${dim}<群> [--as 成员][--to 目标][--kind 类型][--re id] <消息>${reset}  发言(@提及/自动署名)
         ${green}swarm feed${reset} ${dim}<群> [-n N][--from][--kind][--since id][--json]${reset}  读消息流
         ${green}swarm listen${reset} ${dim}<群> [--as leader|成员][--once][--mentions]${reset}  agent 监听增量消息
         ${green}swarm watch${reset} ${dim}<群>${reset}                  实时跟随广场
    ${magenta}看板${reset} ${green}swarm board${reset} ${dim}<群> [--json]${reset}             看板全貌(按列)
         ${green}swarm task add${reset} ${dim}<群> "标题" [--desc/--assignee/--deps/--col]${reset}  建卡
         ${green}swarm task${reset} ${dim}<ls|show|assign|move|done|rm> <群> ...${reset}  列/详情/派活/流转/删
    ${green}swarm sql${reset}    ${dim}<群> [--json] "SELECT ..."${reset}     只读查每群 swarm.db (web/调试)
    ${green}swarm adopt${reset}  ${dim}<群> [--by <cc会话>]${reset}     cc 接管 (拉起指挥会话)
    ${green}swarm archive${reset}|${green}rm${reset} ${dim}<群>${reset}             归档 / 删除

  ${dim}浏览器自动化是独立命令 ${reset}${green}chrome${reset}${dim}（Playwright over CDP）—— chrome help${reset}

  ${bold}窗口 / 窗格${reset}
    ${green}nw${reset}    ${dim}[名称]${reset}                新建窗口
    ${green}lw${reset}                         列出窗口
    ${green}kw${reset}    ${dim}[窗口号]${reset}              关闭窗口
    ${green}sp${reset}    ${dim}[-h|-v]${reset}               分割窗格 ${dim}(默认垂直)${reset}
    ${green}kp${reset}                         关闭窗格

  ${bold}全局环境变量${reset}
    ${green}env${reset}                        列出当前环境变量
    ${green}env set${reset}  ${dim}<KEY=VALUE>${reset}       设置环境变量
    ${green}env rm${reset}   ${dim}<KEY>${reset}             删除环境变量
    ${green}env clear${reset}                  清空所有环境变量
    ${green}env push${reset}                   推送到所有已有会话

  ${bold}其他${reset}
    ${green}send${reset}   ${dim}[会话] <命令>${reset}        发送命令
    ${green}info${reset}                       服务器信息
    ${green}source${reset}                     重载 tmux.conf
    ${green}completion${reset}                 安装 Tab 补全
    ${green}help${reset}                       显示此帮助

  ${bold}示例${reset}
    ${dim}\$${reset} ttmux new work                        ${dim}# 新建会话${reset}
    ${dim}\$${reset} ttmux spawn build \\
        "lint" "npm run lint" \\
        "test" "npm test"                       ${dim}# 并行任务${reset}

    ${dim}\$${reset} ttmux spawn --agent refactor \\
        "api"   "重构用户认证模块" \\
        "db"    "优化数据库查询性能" \\
        "tests" "补充单元测试" \\
        --dir ~/project --perm auto             ${dim}# 多 Agent${reset}
    ${dim}\$${reset} ttmux status refactor                  ${dim}# 查看进度 (命令+Agent)${reset}
    ${dim}\$${reset} ttmux send refactor-api "加上JWT"       ${dim}# 追加指令${reset}
    ${dim}\$${reset} ttmux collect refactor                  ${dim}# 收集结果${reset}
    ${dim}\$${reset} ttmux group kill refactor               ${dim}# 清理${reset}

    ${dim}\$${reset} ttmux swarm new login --goal "加登录功能"  ${dim}# 建蜂群${reset}
    ${dim}\$${reset} ttmux swarm add login api --type agent "实现登录 API"
    ${dim}\$${reset} ttmux swarm adopt login                 ${dim}# 交给 cc 监护${reset}

  ${dim}未识别的命令会直接转发给 tmux${reset}

EOF
}
