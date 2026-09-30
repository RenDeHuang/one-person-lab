# OPL 仓库地图

本文只帮助读者找到 authority owner，不维护分支、版本、候选状态或发布进度。

## 产品 owners

| 仓库 | 角色 |
| --- | --- |
| [`one-person-lab`](https://github.com/gaofeng21cn/one-person-lab) | OPL Base / Framework |
| [`one-person-lab-app`](https://github.com/gaofeng21cn/one-person-lab-app) | One Person Lab App |
| [`one-person-lab-cloud`](https://github.com/gaofeng21cn/one-person-lab-cloud) | OPL Cloud |

GUI Shell 由 [App adapter contract](https://github.com/gaofeng21cn/one-person-lab-app/blob/main/contracts/app-shell-adapter.json) 选择。
当前 `opl-studio` 提供 Desktop、WebUI 和 Docker 的生产构建实现，并持有 DSH/Cordis
Application Host；产品与发布 truth 归 App，Framework runtime 与 Package projection
归 Framework。两个 Host 的范围见 [Host scope boundary](../architecture.md#host-scope-boundary)。

`opl-aion-shell` 只保留旧版升级来源、迁移基线、固定历史夹具与 Git provenance，不再作为生产构建来源。
Preview 到 Stable 的终端 handoff 与旧版升级验收由 [App 发布合同](https://github.com/gaofeng21cn/one-person-lab-app/blob/main/contracts/app-release-channel.json)
和 [App 当前状态](https://github.com/gaofeng21cn/one-person-lab-app/blob/main/docs/status.md) 维护；Shell 选择和 Stable 发布不能单独证明这些迁移路径已验收。

## Foundry Package owner 示例

- [`med-autoscience`](https://github.com/gaofeng21cn/med-autoscience)：医学研究与论文；
- [`med-autogrant`](https://github.com/gaofeng21cn/med-autogrant)：基金申请；
- [`redcube-ai`](https://github.com/gaofeng21cn/redcube-ai)：演示与视觉交付；
- [`opl-meta-agent`](https://github.com/gaofeng21cn/opl-meta-agent)：Agent设计与诊断；
- [`opl-bookforge`](https://github.com/gaofeng21cn/opl-bookforge)：书籍与长文档。

以上只帮助读者找到专业 owner，并非完整成员目录。成员资格、installed 状态与可调用入口
由 owner descriptor、native carrier 和 Framework projection 动态提供；读取入口见
[动态真相入口](../status.md#动态真相入口)。

## 支撑 owners

- [`opl-flow`](https://github.com/gaofeng21cn/opl-flow)：工作方式、profile和开发协作能力；
- [`homebrew-one-person-lab`](https://github.com/gaofeng21cn/homebrew-one-person-lab)：Homebrew分发；
- 其他专业Package、provider和integration：以各自owner descriptor为准。

## 选择入口

- 使用产品 -> App；
- 开发通用runtime/contract -> Framework；
- 开发专业能力 -> 对应Package owner；
- 远端资源与协作 -> Cloud；
- 处理安装或发布 -> 对应artifact/carrier owner。
