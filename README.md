# 🎵 拾音

> 拾音是一款本地音视频工具。粘贴汽水音乐、抖音或 B 站的分享链接，即可提取音乐并整理歌单。

![拾音音频提取工作台示意](docs/images/app-overview.png)

## 立即下载

| 系统 | 下载 |
| --- | --- |
| Windows| [下载 Windows 版（.exe）](https://github.com/xiaoyoumi9924/shiyin/releases/latest/download/Shiyin-Windows-x64.exe) |
| macOS| [下载 macOS 版（.dmg）](https://github.com/xiaoyoumi9924/shiyin/releases/latest/download/Shiyin-macOS-Apple-Silicon.dmg) |
| Linus| [下载 Linux 版（.deb）](https://github.com/xiaoyoumi9924/shiyin/releases/latest/download/Shiyin-Linux-x64.deb) |

安装包内置 FFmpeg 和 FFprobe。抖音链接解析及登录窗口可使用 **Microsoft Edge 或 Google Chrome**。安装任意一个即可，Windows 优先使用 Edge。

## 浏览器扩展

拾音浏览器扩展可以在抖音和 B 站视频页面直接将音频或视频交给桌面版保存。

1. [下载拾音浏览器扩展](https://github.com/xiaoyoumi9924/shiyin/releases/download/v0.7.0/Shiyin-Browser-Extension.zip)，解压 ZIP，保留其中的 `browser-extension` 文件夹。
2. 安装并打开拾音桌面版。在 Microsoft Edge 地址栏输入 `edge://extensions`，开启「开发人员模式」，点击「加载解压缩的扩展」，选择 `browser-extension` 文件夹。
3. 在 Edge 中打开抖音或 B 站普通视频，点击播放器右上角的保存图标，选择「保存音频」或「保存视频」。浏览器首次询问是否允许打开拾音时，选择允许。
4. 在拾音桌面版确认保存，再到「任务」查看进度。音频保存为 MP3，视频保存为 MP4，文件位于设置中选择的目录。

如果视频页没有出现保存按钮，请刷新页面并稍等。B 站支持当前分 P，番剧、课程和直播暂不支持。扩展的更多说明见[使用说明](browser-extension/使用说明.md)。


## 功能

- **音频提取**支持汽水音乐单曲和歌单、抖音视频原声、B 站视频音轨，以及本地音视频批量导入。可选择保留来源音轨，或导出 MP3、M4A。本地批量处理也支持 WAV。
- **视频保存**支持抖音和 B 站普通视频，B 站可解析分 P，保存为 MP4。
- **音频剪辑**支持波形选段、试听和淡入淡出。可编辑歌名、歌手与专辑，并嵌入可用封面。
- **歌单整理**支持收藏、自建歌单、连续播放、导出 M3U8 和可移动的歌曲文件夹。
- **任务管理**支持排队、暂停队列、重试和恢复中断任务。可分别设置音频和视频目录，也可重新关联已移动的文件。

## 使用步骤

1. **添加来源** 在「音频提取」粘贴分享链接或选择「本地文件」。批量粘贴多条分享链接或一次导入多个文件，即可批量处理。
2. **确认并保存** 解析后确认来源音质、格式和保存位置，再点「提取并保存」。只想保存视频时，切换到「视频提取」。
3. **连接账号** 如需访问账号歌单或平台授权的资源，到「设置 → 账号连接」按提示登录。在「音频提取 → 汽水音乐」打开「我的歌单」或粘贴歌单链接，再选择要保存的歌曲。
4. **查看结果** 在「任务」查看进度、播放结果或打开文件夹。在「歌单」可以收藏、整理或导出音频。文件默认保存在「音乐」文件夹下的「拾音」，可在「设置 → 文件保存」更改。



## 来源与许可

拾音使用 Electron、Vue、Playwright、[FFmpeg](https://ffmpeg.org/)、LAME 和 [soda-decrypt](https://github.com/520Qiuyu/qishui-decrypt-tool)。桌面安装包的 `resources/licenses/`（macOS 为 `Contents/Resources/licenses/`）包含媒体组件的许可、构建脚本和源码归档。

