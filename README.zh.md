# dsh-session-purge

**彻底删除一个 DSH 会话**（DSH 自身只提供「归档 / 取消归档」）。

会话日志是只追加的、持久化接缝没有删除接口、工作区登记表也只删登记不删会话 —— 本插件补上这个缺口。

## 它提供什么

### 1. 两个 Agent 工具（宿主端）

| 工具 | 作用 |
|---|---|
| `session_purge_list` | 列出磁盘上全部会话：标题、字节数、最后修改时间、**是否已归档 / 是否有活 Agent / 是否是当前会话**（只读，删除前确认目标用） |
| `session_purge_delete` | 删除一个会话，需要 `confirm: true`；可选 `allow_unarchived` / `allow_live` / `prune_registry` |

### 2. 界面入口（客户端半边，v0.2.0 起）

在侧栏**会话行**上追加一处（**纯追加**，不覆盖任何内置项，`replaceRisk: none`）：

| 席位 | 表现 |
|---|---|
| `sidebar.workspaces.session.menu.item` | 会话行 `⋯` 菜单里多一行「彻底删除」（带一条分隔线，排在"取消归档"下面） |

> 早期版本还用了 `sidebar.workspaces.session.row.action`（会话行右侧悬浮按钮），
> 用户反馈"占地方、不好看"，已按要求**移除**，只保留菜单里那一行。

**只对「已归档」的会话渲染**；「是否已归档」由宿主端回答（`GET /api/dsh-session-purge/state`），客户端不猜快照结构。

**删除不可恢复，所以要连点两次**：第一次把按钮变成「确认删除？」（4 秒内有效），第二次才真正执行。
（不用系统弹窗，因为 Electron 渲染进程可能禁用 `window.confirm`。）

## 删除动作会做什么

一次清干净三处状态：

1. `<DSH_HOME>/sessions/<工作区>/<会话 id>/` —— 会话日志本体
2. `<DSH_HOME>/storages/session_projcache/sessions/<会话 id>.json` —— 投影缓存（标题在这里）
3. `<DSH_HOME>/storages/workspace.json` —— 登记表里的 id（**先写 `.bak-<时间戳>` 备份**再原子替换）

另外写审计日志 `<DSH_HOME>/session-purge.log`。

## 安全闸门

| # | 闸门 |
|---|---|
| 1 | 界面入口只对**已归档**的会话显示（工具侧未归档需显式 `allow_unarchived: true`） |
| 2 | 拒绝删除**当前正在对话的会话**（self-destruct） |
| 3 | 拒绝删除**仍有活 Agent** 的会话（内存里还在跑，删了会被 flush 写回） |
| 4 | 界面删除后再复查一次文件是否被写回（`resurrected`），写回则明确提示 |
| 5 | 界面操作需连点两次确认；HTTP 路由要求**每次启动随机生成的令牌**（经 `tapIndex` 注入页面） |

## HTTP 路由（仅供本插件客户端半边使用）

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/dsh-session-purge/state` | 返回 `{ ok, archived: [sessionId…] }` |
| `POST` | `/api/dsh-session-purge/delete` | body `{ sessionId, confirm: true }` |

两者都必须带请求头 `x-dsh-session-purge: <token>`（令牌每次宿主启动重新生成）。
路由只挂在 DSH 自己的本机 Web 服务上，不额外监听端口。

## 安装 / 更新

它作为 `file:` 依赖装在 profile 里（复制，不是链接）。**改完源码必须重新复制 + 重启 DSH**：

```powershell
# 1) 把包复制进 profile（覆盖旧副本）
$src = '<本目录>'
$dst = "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-session-purge"
robocopy $src $dst /MIR /XD node_modules
# 2) 重启 DSH（客户端半边不热生效）
```

## 卸载 / 回退

从 profile 的 `package.json` 依赖与 `dsh.profile.bundles` 里移除 `dsh-session-purge`，删掉
`node_modules\dsh-session-purge`，重启 DSH。菜单项与悬浮按钮随之消失，其他一切不变。

> ⚠️ **删除过的会话无法恢复** —— 这是本插件唯一不可逆的部分，故有二次确认。
> 附件目录（`$DSH_HOME/attachments/v1`）是内容寻址、可能被多个会话共用，**刻意不触碰**。

## 已知行为

- 删除后侧栏可能仍显示该会话（登记表由 storage 服务缓存）→ 界面在成功后 **900ms 自动刷新页面**。
- 若界面删除返回「仍有活 Agent」，把它从侧栏移出（或重启 DSH）再删即可。
- 不要用界面去删**你正在看的那个会话**：归档列表与当前会话通常不同，但若你确实正在看它，删完刷新即可。

## 以后想上架到插件市场（2026-10-03 查证，未执行）

**上架路径**（`dshmarket` 自己的 README 写明）：

1. **建仓库 + 把 `lib/` 产物提交进 git**（GitHub tarball 安装直接取仓库内容，没有 `lib/` 装不上）+ MIT LICENSE + 中英双语 README + topics `dsh` / `deepseek-harness` / `plugin`
2. **发布到 npm**（市场条目带 npm 映射）
3. **去 [`awesome-dsh-plugin/awesome-dsh-plugin`](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 提一条 PR**（列表里加一行；网站与市场**一天内自动收录**）。**不要**往 `dsh-market/dsh-market` 提插件条目。

**⚠️ 已有一处冲突**：npm 包名 `dsh-session-purge` 已被占用（维护者 `verdana`，0.4.1 ~ 0.4.4，2026-09-25 起），功能高度重合。
**差异化点**：对方 README 自己写着"已归档的会话在侧边栏里看不到，菜单自然也点不到，想删先取消归档"——
而**本插件专门只对「已归档」会话显示**，正好补这个缺口。上架前需换一个不冲突的包名（或 scoped 包）。

**本机现状**：`git` 未安装（VS Code 有，但不带 git 二进制）；本机可连通 `github.com:443`，但 **DSH 沙箱内的 shell 出站 HTTPS 被拦**（`curl` 返回 000，PowerShell 报"基础连接已关闭"）→ 下载/推送这类联网动作需要在 **DSH 之外**的终端里做。
