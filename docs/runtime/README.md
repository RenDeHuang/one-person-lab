# OPL Runtime

Runtime 文档只解释当前运行对象和运维边界。

- [Runtime 命名与边界](./opl-runtime-naming-and-boundary-contract.md)
- [Stage graph 与 AI route](./stage-graph-route-transition-runtime.md)
- [Temporal service supervision](./temporal-service-supervision.md)
- [Foundry Kernel control plane](./opl-foundry-kernel-control-plane.md)
- [Family Runtime Python client](./family-runtime-python-client.md)

动态 provider、worker、Attempt 和 health 状态从 fresh CLI readback读取。外部框架调研、迁移计划和已完成 adoption 过程不属于本目录。

依赖发布解析由 `scripts/resolve-dependency-releases.mjs` 消费
`contracts/opl-framework/dependency-release-sources.json`。需要同时构建源码的依赖声明
`source_commit_required`：GitHub release 解析准确 tag 的 commit，npm 解析所选发布的
`gitHead` 并在指定仓库回读。App 消费该不可变结果，不以当前 main 替代发布来源。
