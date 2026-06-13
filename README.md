# PDF 自动滚动阅读器

这是一个用于 VS Code 的通用 PDF 自动阅读扩展。任意 PDF 都可以持续、平滑地向上滚动；由 LaTeX 生成且包含 SyncTeX 数据的 PDF 还可以通过 `Ctrl+左击` 跳转到源码。

## 环境要求

- VS Code 1.90 或更高版本
- 普通 PDF 阅读不需要 LaTeX 环境
- 源码反向跳转需要 TeX Live 或 MiKTeX 提供的 `synctex`

## 安装

```powershell
code --install-extension .\latex-auto-scroll-reader-0.3.1.vsix --force
```

安装后重新启动 VS Code，或执行“开发人员: 重新加载窗口”。

## 使用

1. 使用原来的 PDF 预览器打开任意 PDF。
2. 点击 PDF 标签页右上角的播放按钮。
3. 当前标签页切换为自动滚动阅读器，并立即开始滚动。

普通 PDF 仍默认使用原预览器，本扩展不会改变全局 PDF 打开方式，也不会修改 PDF 文件。需要切回时，可点击错误页中的“Open normal preview”，或者在标签页上选择“重新打开方式”。

## 操作

- PDF 标签右上角播放按钮：切换到自动阅读器并立即开始
- `Ctrl+Alt+Space`：开始或暂停当前阅读器
- `Ctrl+Alt+.`：提高速度
- `Ctrl+Alt+,`：降低速度
- 工具栏速度滑杆：实时调速
- `-` / `+`：调整缩放
- 在 PDF 区域移动鼠标或滚轮：暂停
- `Ctrl+左击 PDF 内容`：跳转到对应 LaTeX 源码

扩展分别记忆每个 PDF 的速度、缩放、位置和运行状态。关闭 VS Code 前正在滚动的文档，在下次恢复标签页后会从原位置继续滚动；暂停的文档仍保持暂停。

## 恢复与错误处理

扩展会在 VS Code 启动时注册阅读器，因此可以恢复重启前打开的多个标签。PDF 不存在、正在被编译程序替换、文件头无效或 PDF.js 首次加载失败时，标签页内会显示明确错误和重试按钮，不再直接出现“还原视图时出错”。

PDF 重新编译后会自动刷新，并保留当前阅读百分比和滚动状态。加载时使用 Webview URL 流式读取，不会把大型 PDF 整体复制到扩展消息中。

排错日志位于：

1. 打开“查看” -> “输出”。
2. 在输出通道列表选择 `PDF Auto Scroll Reader`。

## SyncTeX

普通 PDF 没有 `.synctex.gz` 时仍可正常滚动，只是不提供源码跳转。LaTeX 编译时可这样启用 SyncTeX：

```powershell
latexmk -pdf -synctex=1 main.tex
```

扩展支持中文、空格和百分号编码路径。Windows 下按 GBK 解码 `synctex.exe` 输出。

## 设置

在 VS Code 设置中搜索 `LaTeX PDF Auto Scroll`：

- `latexAutoScroll.defaultSpeed`
- `latexAutoScroll.minimumSpeed`
- `latexAutoScroll.maximumSpeed`
- `latexAutoScroll.rememberReadingPosition`
- `latexAutoScroll.pauseOnMouseMove`

## 开发验证

PDF.js 已内置在 `media` 目录，预览不依赖网络。

```powershell
npm test
npx @vscode/vsce package
```
