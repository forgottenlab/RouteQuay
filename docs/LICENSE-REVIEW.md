# MIT 许可证与第三方许可审阅

## 项目许可

维护者在本轮任务明确选择 MIT，并指定 Copyright (c) 2026 ForgottenLab；根目录 [LICENSE](../LICENSE) 使用 GitHub licenses/mit API 提供的完整标准英文文本，替换年份与权利人字段。package.json 与锁文件根包均标记 MIT，private: true 保持，禁止意外 npm 发布。

授权依据是维护者本轮指示；来源清单中的24个文件与维护者指定开发工作树字节一致，源仓库现有提交作者为 forgottenlab，GitHub登录与noreply身份匹配。检查源码/脚本/配置及文档未发现冲突版权声明或未经许可第三方复制标记。此记录不是替任何第三方出具授权证明；以后引入其他贡献或第三方源码仍须单独审阅。

[来源清单](SOURCE-SNAPSHOT.json) 的 files 仅描述复制来源；新建 LICENSE 不加入该复制清单，正式候选由 check-candidate 的精确名单单独纳入。

## 第三方

| 内容 | 许可 | 本仓库处理 |
|---|---|---|
| TypeScript 5.9.3 | Apache-2.0 | 开发依赖，不提交 node_modules；保留包内许可 |
| @types/node 22.20.5 | MIT | 开发依赖，包内许可保持 |
| undici-types 6.21.0 | MIT | 传递开发依赖，包内许可保持 |
| Xray | MPL-2.0 | 不复制本体源码或二进制；运行时另从官方固定版本下载，独立适用上游许可 |

项目无生产 npm 依赖。Xray 的下载/调用不表示其本体改用 MIT；若未来重新分发它的二进制或源码，应针对实际版本处理源码提供和通知等义务。[上游许可](https://github.com/XTLS/Xray-core/blob/main/LICENSE)。

本轮只授权 Private Commit/Push，未授权修改可见性、打标签、Release 或 npm 发布。MIT 已选定；公开仍需要维护者单独批准。
