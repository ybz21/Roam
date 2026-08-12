#!/usr/bin/env python3
"""把 19 号稿拆成「问题篇 index.html」与「改进方向 design.html」。

复用的正文块在 _parts/ 下（从原单页切出来的），标题编号与交叉引用在这里统一改，
新写的章节（目标架构、会话存储现状、这次丢了什么）直接写在下面。
改稿只改这个脚本或 _parts/ 里的块，然后重跑：python3 _build.py
"""
import pathlib

HERE = pathlib.Path(__file__).parent
P = HERE / '_parts'
B = {f.stem: f.read_text() for f in P.glob('*.html') if not f.stem.startswith('sec')}
STYLE = B.pop('_style')


def sub(text, pairs):
    for a, b in pairs:
        assert text.count(a) == 1, f'期望唯一命中: {a!r} 实际 {text.count(a)} 次'
        text = text.replace(a, b)
    return text


def page(title, kicker, h1, nav, body):
    style = STYLE.replace('<title>Roam · 元数据持久化与重启恢复</title>',
                          f'<title>{title}</title>')
    return f'''{style}
</head>
<body>

<div class="top">
  <div>
    <div class="kicker">{kicker}</div>
    <h1>{h1}</h1>
  </div>
  <span class="sp"></span>
  {nav}
  <button class="tbtn" onclick="document.documentElement.dataset.theme=document.documentElement.dataset.theme==='light'?'dark':'light'">切换明暗</button>
</div>

<div class="wrap">
{body}
</div>
</body>
</html>
'''


TO_DESIGN = '<a class="tbtn" href="./design.html">改进方向 →</a>'
TO_PROBLEM = '<a class="tbtn" href="./index.html">← 问题</a>'

# ══════════════════════════════════════════════════════════════════
# 问题篇
# ══════════════════════════════════════════════════════════════════

PROBLEM_LEDE = '''
<p class="lede">
机器重启后打开 Roam：项目卡全空、会话一个不剩、翻不到任何历史。这不是「重启当然会丢」——
tmux 会话死掉是必然，但<b>「这个会话存在过、在哪个目录、干过什么、日志在哪」是用户数据</b>，
不该跟着 tmux 一起消失。
</p>
<p class="lede">
本篇只做一件事：<b>把数据现在存在哪、为什么一重启就没，查清楚说明白</b>。
所有结论都带本机实测。改法在<a href="./design.html" style="color:var(--accent)">改进方向</a>那篇。
</p>

<div class="note bad">
<b>结论先放这：</b>最要命的不是「数据被删了」，而是<b>绝大多数会话从来没往盘上写过任何东西</b>。
写日志（<code>pipe-pane</code>）只在蜂群成员、任务会话、插件会话三条路径上设置；
日常的 <code>ttmux new</code> 和 Web「新建会话」建出来的会话，在 Roam 主目录里一个字节都不留。
</div>
'''

SESSION_STORAGE_NOW = '''
<h2>3. 会话存储（ttmux 层）</h2>

<p class="lede">
会话整个活在 <b>ttmux 层</b>：Roam 层不生成会话 id、也不直接写会话台账，它调
<code>ttmux new --json</code>，id 的唯一出处在 CLI。问题是——<b>写不写盘，取决于会话是怎么建的</b>。
同样是一个 tmux 会话，走不同入口，留在盘上的东西差了三个数量级：
</p>

<div class="tablewrap">
<table>
<thead><tr><th>建会话的入口</th><th>sessmeta 行</th><th>输出日志</th><th>任务描述</th><th>代码</th></tr></thead>
<tbody>
<tr><td><b>任务会话</b> <code>ttmux spawn</code></td><td class="good">有</td><td class="good">有 <code>pipe-pane</code></td><td class="good"><code>meta/&lt;id&gt;/*.txt</code></td><td><code>spawn/spawn.go</code></td></tr>
<tr><td><b>蜂群成员</b></td><td class="good">有</td><td class="good">有 <code>pipe-pane</code></td><td class="good"><code>swarm.db</code> members</td><td><code>swarm/members.go</code></td></tr>
<tr><td><b>插件会话</b></td><td class="good">有</td><td class="good">有 <code>pipe-pane</code></td><td class="good"><code>plugin_sessions</code></td><td><code>plugin/hostapi.go</code></td></tr>
<tr><td><b>fork 子会话</b></td><td class="good">有</td><td class="bad">无</td><td class="bad">无</td><td><code>session/fork.go</code></td></tr>
<tr><td class="bad"><b><code>ttmux new</code> / Web「新建会话」</b></td><td class="bad"><b>无</b></td><td class="bad"><b>无</b></td><td class="bad"><b>无</b></td><td><code>runtime.CreateSession</code></td></tr>
</tbody>
</table>
</div>

<div class="note bad">
最后一行就是<b>你每天用的那个入口</b>。它建出来的会话在 <code>~/.roam</code> 里彻底隐形：
既没有 <code>sessions</code> 行，也没有 <code>logs/&lt;id&gt;.log</code>，连「它存在过」都无从证明。
下一节 §4.1 是这条的实测。
</div>

<h3>3.1 会话 id 本身是好的</h3>
<p class="lede">
值得说清楚的是：<b>会话的身份设计没问题，出问题的是台账拿什么当主键</b>。
会话 id（<code>2026-0812-1740-0000</code>）由 <code>id.ForSession(session_created, session_id)</code> 派生，
<b>包含创建时刻</b>，因此不可变、跨 tmux server 重启唯一且永不复用 ——
它天生就是一个可以跨重启用的键。台账早就有这个键，只是没拿它当主键（§4.2）。
</p>
'''

WHAT_WAS_LOST = '''
<h2>6. 这次实际丢了什么、捞回了什么</h2>

<p class="lede">
2026-08-12 17:36 机器重启，重启前有 <b>15 个 Claude 会话</b>在跑。事后逐项清点：
</p>

<div class="tablewrap">
<table>
<thead><tr><th>东西</th><th>重启后</th><th>能不能捞回来</th></tr></thead>
<tbody>
<tr><td><b>pane 里的 agent 进程</b></td><td class="bad">全死</td><td class="bad">不能 —— 进程就是进程</td></tr>
<tr><td><b>会话台账</b> <code>meta.db</code> <code>sessions</code></td><td class="bad">0 行（整表被 <code>Reconcile</code> 删空）</td><td class="good">能 —— 从 logs / meta / swarms / plugin_sessions / 老备份拼回 <b>150 条</b></td></tr>
<tr><td><b>项目台账</b></td><td>13 个，<b>discovered = 0</b></td><td>发现型的已被历次重启清干净，只能按会话历史反推</td></tr>
<tr><td><b>会话输出日志</b></td><td class="good">38.4MB 都在</td><td class="good">在 —— 但重建索引前没人找得到它们</td></tr>
<tr><td><b>agent 对话</b> <code>~/.claude/projects/</code></td><td class="good">1.1GB / 166 段，一段没丢</td><td class="good">在 —— 与 tmux 无关；但 Roam 不认识它，界面上接不起来</td></tr>
</tbody>
</table>
</div>

<pre class="code">$ <b>python3 scripts/dev/rebuild-session-history.py</b>
残骸        150 个会话
  有归属目录  62
  有起始时间  64
  有日志      115
按月分布：2026-05 → 9 · 06 → 88 · 07 → 51 · 08 → 2      <s># 时间轴与实际使用对得上</s></pre>

<div class="note">
<b>这张表就是三条设计结论的来源：</b>
进程救不回 → 恢复的目标是<b>壳</b>不是现场；
日志和对话都还在、只差索引 → 台账的价值是<b>把它们指回来</b>；
残骸能拼回 150 条 → 这些信息本来就该被<b>直接记下来</b>，而不是事后靠考古。
</div>
'''

problem_body = '\n'.join([
    PROBLEM_LEDE,
    # §1 现状：两层
    B['now_two_layers'],
    # §2 项目存储（Roam 层）：引子 + 读模型 + 身份 + 字段
    sub(B['proj_head'], [
        ('<h2>5. 项目存储（Roam 层）</h2>', '<h2>2. 项目存储（Roam 层）</h2>'),
        ('<h3>5.1 项目是读模型，不是用户建的对象</h3>', '<h3>2.1 项目是读模型，不是用户建的对象</h3>'),
    ]),
    sub(B['proj_identity'], [
        ('<h3>5.2 身份是不可变 id，目录只是可变属性</h3>', '<h3>2.2 身份是不可变 id，目录只是可变属性</h3>'),
        ('<h3>5.3 存了什么</h3>', '<h3>2.3 存了什么</h3>'),
    ]),
    # §3 会话存储（ttmux 层）
    SESSION_STORAGE_NOW,
    # §4 为什么归零
    sub(B['why_zero'], [
        ('<h2>2. 为什么重启后归零</h2>', '<h2>4. 为什么重启后归零</h2>'),
        ('<h3>2.0 普通会话在盘上不留痕迹（根因）</h3>', '<h3>4.1 普通会话在盘上不留痕迹（根因）</h3>'),
        ('<h3>2.1 <code>sessions</code> 表拿 tmux 的 <code>$N</code> 当主键</h3>',
         '<h3>4.2 <code>sessions</code> 表拿 tmux 的 <code>$N</code> 当主键</h3>'),
        ('<h3>2.2 发现型项目按「此刻有没有会话」退场</h3>', '<h3>4.3 发现型项目按「此刻有没有会话」退场</h3>'),
        ('<h3>2.3 <code>$N</code> 跨重启复用 → 静默串档</h3>', '<h3>4.4 <code>$N</code> 跨重启复用 → 静默串档</h3>'),
        ('下面四条已经全部在 M1 修掉，\n改法与验收见 <a href="#m1" style="color:var(--accent)">§10</a>；',
         '下面四条已经全部在 M1 修掉，\n改法与验收见<a href="./design.html#m1" style="color:var(--accent)">改进方向 §9</a>；'),
    ]),
    # §5 跨层 join
    sub(B['proj_join'], [
        ('<h3>5.5 项目 ↔ 会话：一条没有外键的跨层 join</h3>',
         '<h2>5. 项目 ↔ 会话：一条没有外键的跨层 join</h2>'),
        ('§2.3 串档就出在这', '§4.4 串档就出在这'),
        ('<b>M2 并库要解决的正是这个。</b>', '<b>这正是<a href="./design.html" style="color:var(--accent)">改进方向</a>里 M2 并库要解决的。</b>'),
    ]),
    # §6 这次丢了什么
    WHAT_WAS_LOST,
    '''
<div class="note good" style="max-width:none">
读完这篇，接<a href="./design.html" style="color:var(--accent);font-weight:600">改进方向 —— 目标架构与数据分层设计 →</a>
</div>
''',
])

# ══════════════════════════════════════════════════════════════════
# 改进方向
# ══════════════════════════════════════════════════════════════════

DESIGN_LEDE = '''
<p class="lede">
<a href="./index.html" style="color:var(--accent)">问题篇</a>查清了四条病根：普通会话不落盘、
<code>sessions</code> 拿 <code>$N</code> 当主键、项目按「此刻有没有会话」退场、<code>$N</code> 跨重启复用串档。
本篇给<b>最终状态</b>：改完之后数据长什么样、分几层、谁是真相源，以及重启恢复怎么走通。
</p>
'''

FINAL_STATE = '''
<h2>1. 最终状态与目标架构</h2>

<p class="lede">
一句话：<b>台账进一个库，配置留文件，大对象留盘，tmux 只回答「现在谁活着」。</b>
</p>
<ul class="pts">
  <li><b>一个真相源，一套库</b>：项目、会话、归属、父子、竞赛、蜂群全在 <code>meta.db</code>，
      有 schema 版本、有事务、有外键。<b>ttmux 层与 Roam 层不再是两套存储</b> ——
      「两层」改完之后只是代码归属，不是存储边界。唯一保留的划分是
      <b>每张表一个写者</b>（会话类归 CLI、项目类归后端，见 <a href="#owner" style="color:var(--accent)">§8.1</a>），
      那是为了不让两个进程抢同一批行，不是把层分回来。</li>
  <li><b>台账不随 tmux 生死</b>：主键是持久会话 id（含创建时刻，跨重启唯一），
      <code>$N</code> 降级成一列运行时句柄。会话死了<b>置 dead 不删行</b>。</li>
  <li><b>项目不因「此刻没会话」消失</b>：退场判「从来没有过会话」，干过活的转归档。</li>
  <li><b>重启后可恢复到三级</b>：台账在 → 历史在 → 能一键重开（连带接回 agent 对话）。</li>
</ul>

<div class="figure">
<svg viewBox="0 0 1080 460" width="1080" role="img" aria-label="目标架构：写入口、三层存储、运行时">
  <rect x="16" y="40" width="188" height="60" rx="10" class="svg-box" fill="var(--accent-soft)" stroke="var(--accent-border)"/>
  <text x="110" y="66" class="svg-t" text-anchor="middle">ttmux CLI</text>
  <text x="110" y="84" class="svg-m" text-anchor="middle">建/杀会话 · 蜂群 · 插件</text>

  <rect x="16" y="116" width="188" height="60" rx="10" class="svg-box" fill="var(--purple-soft)" stroke="var(--purple-border)"/>
  <text x="110" y="142" class="svg-t" text-anchor="middle">Roam 后端</text>
  <text x="110" y="160" class="svg-m" text-anchor="middle">项目 · 归属 · 竞赛 · 偏好</text>

  <path d="M204 70 L252 70 L252 128 L268 128" class="svg-line" stroke-width="1.4" marker-end="url(#d1)"/>
  <path d="M204 146 L252 146 L252 134 L268 134" class="svg-line" stroke-width="1.4" marker-end="url(#d1)"/>

  <rect x="276" y="100" width="150" height="76" rx="10" class="svg-box" stroke="var(--ok-border)"/>
  <text x="351" y="128" class="svg-t" text-anchor="middle">internal/metadb</text>
  <text x="351" y="146" class="svg-m" text-anchor="middle">WAL · busy_timeout</text>
  <text x="351" y="162" class="svg-m" text-anchor="middle">单例 · 事务 · 外键</text>
  <text x="351" y="90" class="svg-k" text-anchor="middle">唯一写入口</text>

  <path d="M426 138 L474 138" class="svg-line" stroke-width="1.4" marker-end="url(#d1)"/>

  <rect x="482" y="24" width="316" height="128" rx="12" class="svg-box" fill="var(--ok-soft)" stroke="var(--ok-border)"/>
  <text x="500" y="48" class="svg-k">台账 · SQLITE · 有事务有版本</text>
  <text x="500" y="70" class="svg-t">meta.db</text>
  <text x="500" y="92" class="svg-m">schema_meta · tmux_epochs</text>
  <text x="500" y="110" class="svg-m">projects · project_aliases</text>
  <text x="500" y="128" class="svg-m">sessions · swarms · swarm_members</text>
  <text x="500" y="146" class="svg-m">races · plugin_sessions</text>

  <rect x="482" y="168" width="316" height="72" rx="12" class="svg-box" fill="var(--purple-soft)" stroke="var(--purple-border)"/>
  <text x="500" y="192" class="svg-k">配置 · JSON · 人手要能改</text>
  <text x="500" y="214" class="svg-m">preferences · browser · phone · speech</text>
  <text x="500" y="232" class="svg-m">home-sites · totp · cluster/node</text>

  <rect x="482" y="256" width="316" height="72" rx="12" class="svg-box" stroke="var(--border)"/>
  <text x="500" y="280" class="svg-k">大对象 · 文件系统 · 库里只存索引</text>
  <text x="500" y="302" class="svg-m">logs/&lt;id&gt;.log</text>
  <text x="500" y="320" class="svg-m">meta/&lt;id&gt;/ · activity.log</text>

  <rect x="856" y="24" width="208" height="104" rx="12" class="svg-box" fill="var(--warn-soft)" stroke="var(--warn-border)"/>
  <text x="874" y="48" class="svg-k">运行时 · 不入库</text>
  <text x="874" y="70" class="svg-t">tmux server</text>
  <text x="874" y="90" class="svg-s">只回答「现在谁活着」</text>
  <text x="874" y="110" class="svg-m">$N · attached · activity</text>

  <rect x="856" y="144" width="208" height="96" rx="12" class="svg-box" stroke="var(--border)"/>
  <text x="874" y="168" class="svg-k">派生 · 一次请求</text>
  <text x="874" y="190" class="svg-s">git 状态 · worktree 列表</text>
  <text x="874" y="210" class="svg-s">pane 内容 · waiting 判定</text>
  <text x="874" y="230" class="svg-m">现算，入库只会不一致</text>

  <rect x="856" y="256" width="208" height="72" rx="12" class="svg-box" fill="var(--ok-soft)" stroke="var(--ok-border)"/>
  <text x="874" y="280" class="svg-k">第三方 · 只存引用</text>
  <text x="874" y="300" class="svg-s">agent transcript</text>
  <text x="874" y="320" class="svg-m">sessions.agent_session_uuid</text>

  <path d="M798 88 L848 88" class="svg-line" stroke="var(--warn)" stroke-width="1.3" stroke-dasharray="4 3" marker-end="url(#d2)"/>
  <text x="823" y="76" class="svg-m" text-anchor="middle" fill="var(--warn)">对账</text>
  <path d="M798 292 L848 292" class="svg-line" stroke="var(--ok)" stroke-width="1.3" stroke-dasharray="4 3" marker-end="url(#d3)"/>

  <rect x="16" y="356" width="1048" height="88" rx="12" class="svg-box" fill="var(--list-hover)"/>
  <text x="34" y="380" class="svg-t">重启之后</text>
  <text x="34" y="404" class="svg-s">tmux 那一列清空 → <tspan fill="var(--warn)">台账里的会话置 dead（不删）</tspan> → 项目判「有没有过会话」<tspan fill="var(--ok)">一个不少</tspan></text>
  <text x="34" y="426" class="svg-s">→ 界面上出现「已结束的会话」，每条带原目录/agent/对话引用，<tspan fill="var(--text-bright)">可一键重开</tspan></text>

  <defs>
    <marker id="d1" markerWidth="7" markerHeight="7" refX="6" refY="3" orient="auto"><path d="M0 0 L6 3 L0 6 z" fill="var(--border)"/></marker>
    <marker id="d2" markerWidth="7" markerHeight="7" refX="6" refY="3" orient="auto"><path d="M0 0 L6 3 L0 6 z" fill="var(--warn)"/></marker>
    <marker id="d3" markerWidth="7" markerHeight="7" refX="6" refY="3" orient="auto"><path d="M0 0 L6 3 L0 6 z" fill="var(--ok)"/></marker>
  </defs>
</svg>
<div class="legend">
  <span><i style="background:var(--ok-soft);border:1px solid var(--ok-border)"></i>台账（真相源）</span>
  <span><i style="background:var(--purple-soft);border:1px solid var(--purple-border)"></i>配置</span>
  <span><i style="background:var(--warn-soft);border:1px solid var(--warn-border)"></i>运行时（易失）</span>
  <span><i style="border:1px solid var(--border)"></i>大对象 / 派生 / 第三方</span>
</div>
</div>

<div class="note">
<b>和现在的差别就两处，但都是根上的：</b>
① 写入口从「各写各的 JSON / 各开各的 sqlite 连接」收成一个 <code>internal/metadb</code>；
② <code>tmux</code> 从「台账的一部分」降级成「一列可对账的运行时状态」。
其余（配置留 JSON、日志留文件）保持不变 —— 它们本来就存对了地方。
</div>
'''

design_body = '\n'.join([
    DESIGN_LEDE,
    FINAL_STATE,
    sub(B['layering'], [('<h2>3. 分层原则：台账 / 配置 / 大对象</h2>',
                         '<h2>2. 数据分层设计：台账 / 配置 / 大对象</h2>')]),
    sub(B['schema'], [
        ('<h2>4. 表设计</h2>', '<h2>3. 目标 schema</h2>'),
        ('<h3>4.1 DDL</h3>', '<h3>3.1 DDL</h3>'),
        ('逐项状态见\n<a href="#m1" style="color:var(--accent)">§10</a>。', '逐项状态见 <a href="#m1" style="color:var(--accent)">§9</a>。'),
        ('<s>-- 重开所需的全部输入（§8）</s>', '<s>-- 重开所需的全部输入（§7）</s>'),
    ]),
    sub(B['proj_life'], [
        ('<h3>5.4 生命周期：退场判「有没有过」，不判「此刻有没有」</h3>',
         '<h2>4. 项目生命周期：退场判「有没有过」，不判「此刻有没有」</h2>'),
        ('<code>archived_at</code> 出现在 §4 的目标 schema 与本图的虚线框里，属于 M3。',
         '<code>archived_at</code> 出现在 §3 的目标 schema 与本图的虚线框里，属于 M3。'),
    ]),
    sub(B['sess_life'], [('<h2>6. 会话生命周期（ttmux 层）：软删，不硬删</h2>',
                          '<h2>5. 会话生命周期：软删，不硬删</h2>')]),
    sub(B['restore_chain'], [('<h2>7. 重启恢复链路</h2>', '<h2>6. 重启恢复链路</h2>')]),
    sub(B['reopen'], [
        ('<h2>8. 重开（restore），不是自动恢复</h2>', '<h2>7. 重开（restore），不是自动恢复</h2>'),
        ('<h3>8.1 对话（agent transcript）怎么接回来</h3>', '<h3>7.1 对话（agent transcript）怎么接回来</h3>'),
    ]),
    sub(B['concurrency'], [
        ('<h2>9. 并发、写入口与迁移</h2>', '<h2>8. 一套库：写者、直连与迁移</h2>'),
        ('<h3>9.1 一套库，不分层——但要分「谁写哪张表」</h3>', '<h3 id="owner">8.1 一套库，不分层——但要分「谁写哪张表」</h3>'),
        ('<h3>9.2 后端要不要直连这个库</h3>', '<h3>8.2 后端要不要直连这个库</h3>'),
        ('<h3>9.3 一个该留在外面的例外：蜂群 posts</h3>', '<h3>8.3 一个该留在外面的例外：蜂群 posts</h3>'),
        ('<h3>9.4 连接层</h3>', '<h3>8.4 连接层</h3>'),
        ('<h3>9.5 迁移</h3>', '<h3>8.5 迁移</h3>'),
        ('<code>posts</code> 原地不动（§9.3）', '<code>posts</code> 原地不动（§8.3）'),
        ('问题篇 §5 那条跨层长链换成一次 <code>JOIN</code>',
         '<a href="./index.html" style="color:var(--accent)">问题篇 §5</a> 那条跨层长链换成一次 <code>JOIN</code>'),
    ]),
    sub(B['milestones'], [
        ('<h2 id="m1">10. 分期与落地记录</h2>', '<h2 id="m1">9. 分期与落地记录</h2>'),
        ('连接层 + schema + 迁移（§4/§9）', '连接层 + schema + 迁移（§3/§8）'),
        ('重开按钮 + 对话回接（§8.1）', '重开按钮 + 对话回接（§7.1）'),
    ]),
])

# milestones 是原单页的最后一块，尾巴上带着 .wrap/body/html 的收尾标签；
# page() 自己会补，这里从「关闭 .wrap 的那个 </div>」起整段切掉。
_tail = '</div>\n</body>'
assert design_body.count(_tail) == 1
design_body = design_body[:design_body.rindex(_tail)].rstrip()

(HERE / 'index.html').write_text(page(
    'Roam · 元数据存储：现状与病根', 'Roam · Web · 19 · 问题',
    '元数据存储：现状与病根', TO_DESIGN, problem_body))
(HERE / 'design.html').write_text(page(
    'Roam · 元数据持久化：目标架构与改进方向', 'Roam · Web · 19 · 改进方向',
    '目标架构与数据分层设计', TO_PROBLEM, design_body))
print('index.html / design.html 已生成')
