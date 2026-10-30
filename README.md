# Carrot Gantt

适用于 Obsidian 的项目甘特图。支持 TaskNotes，可单独打开，也可嵌入 Carrot Home。

## 实际效果

![Carrot Gantt 实际运行截图：虚构项目的任务排期、项目进度、今日线及已完成项目折叠区](docs/images/project-gantt.png)

在同一条时间轴上查看项目和关联任务：左侧汇总完成数量、日期范围和进度，右侧展示任务排期与今日线；顶部可搜索项目、切换状态筛选，已完成项目可折叠收纳。

> 截图来自 Obsidian 桌面端的独立演示库，展示 **Carrot Gantt 1.2.0 嵌入 Carrot Home 2.0.1** 的实际效果，配合 TaskNotes 4.13.1 使用。项目名、任务内容和日期均为虚构示例，不含私人笔记或真实账号数据。背景与卡片外观属于 Carrot Home 的演示设置，仅用于展示；Carrot Gantt 也可独立打开，无需安装 Carrot Home。

## 通过 BRAT 安装与更新

1. 在 Obsidian 社区插件中安装并启用 **BRAT**。
2. 打开 BRAT 设置，点击 **Add Beta plugin**。
3. 输入 `carrot-tree/carrot-gantt`，或本仓库地址：

   https://github.com/carrot-tree/carrot-gantt

4. 选择跟踪最新版本并添加插件，再到社区插件列表启用 **Carrot Gantt**。

之后可由 BRAT 检查更新。开启 BRAT 的自动检查选项后，它会检查本仓库的新 Release。需要自动跟随新版时，请选择最新版本，避免固定到某一个历史版本。

## 功能

- 项目排序：临期优先、手动、截止日期、开始日期、最近创建、名称。
- 项目置顶、折叠，以及当前筛选下的全部收起或展开。
- 按项目名、路径和关联任务名搜索；支持多个关键词。
- 全部、进行中、逾期、待结项、已完成、已归档快捷筛选。
- 进度、完成计数和日期范围按全部关联任务计算。
- 手动结项、归档、取消归档和恢复进行中；不自动改变关联子任务状态。
- 项目与任务改名后保留手动顺序及项目置顶、折叠设置。
- 横向缩放和延展时间轴；筛选切换时保持正在查看的日期。

## 首次使用

- 要求 **Obsidian 1.8.7 或以上**。
- 安装并启用 **TaskNotes**。本插件遵循它的任务身份、字段映射、自定义状态和归档标签。
- 单独使用时，在 Carrot Gantt 设置或甘特图「数据源」中选择 **TaskNotes 全部任务**。
- 使用 Carrot Home 时，可选择「当前 Dashboard」，跟随其 Tasks 卡片的数据源和显示筛选。
- 在任务的 `projects` 属性中关联项目笔记。也可以从甘特图「新项目」或「选择现有」创建或添加项目。
- 命令面板搜索 **Carrot Gantt**，打开项目甘特图。

普通笔记也可作为项目。所有关联任务完成后，项目显示「可结项」，由你决定何时移入已完成区或归档。搜索和快捷筛选是当前视图的临时状态，不覆盖手动顺序。

已在 Obsidian 桌面版验证；手机尚未完成真机验收。

## 手动安装

从 [Releases](https://github.com/carrot-tree/carrot-gantt/releases/latest) 下载三个**独立附件** `main.js`、`manifest.json`、`styles.css`，放到笔记库的 `.obsidian/plugins/carrot-gantt/`，然后启用插件。升级时保留现有 `data.json`。

## 开发与发布

本仓库的 `main.js` 即可运行，不需要构建工具或额外 npm 依赖。Node.js 22 或以上执行：

```sh
node --check main.js
node --test tests/*.test.cjs
node scripts/verify-release.cjs
```

测试仅使用内存中的虚构笔记，不访问本地 Obsidian 笔记库。

发布新版本时，更新 `manifest.json` 的 `version`、`versions.json`、`CHANGELOG.md` 和 `RELEASE_NOTES.md` 并提交。随后可以在 GitHub **Actions → Release plugin → Run workflow** 中输入版本号，或推送与版本号完全一致的标签，例如：

```sh
git tag 1.2.1
git push origin main 1.2.1
```

GitHub Actions 会先检查版本、执行回归测试，再创建 Release 并上传 BRAT 需要的三个独立附件。标签使用 `1.2.1` 形式，不加 `v` 前缀。

BRAT 发布格式依据 [官方开发者指南](https://github.com/TfTHacker/obsidian42-brat/blob/main/BRAT-DEVELOPER-GUIDE.md)。

## 问题反馈

请在 [Issues](https://github.com/carrot-tree/carrot-gantt/issues) 中附上 Obsidian、TaskNotes 和插件版本，以及可复现步骤。请使用虚构示例替代私人笔记内容。

## 许可证与署名

MIT，见 [LICENSE](LICENSE)。保留原有 manifest 作者署名；本仓库由 [carrot-tree](https://github.com/carrot-tree) 维护。上游署名见 [NOTICE.md](NOTICE.md)。
