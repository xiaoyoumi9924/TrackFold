import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chromium } from "playwright";

const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const browser = await chromium.launch({ headless: true, ...(existsSync(chrome) ? { executablePath: chrome } : {}) });
const playlistId = "7434476168507637799";
const trackId = "7420006432714688528";
const playlistLink = "https://www.qishui.com/playlist/" + playlistId;
const job = { id: "fixture", title: "测试歌曲", artist: "测试歌手", platform: "qishui", status: "completed", format: "mp3", progress: 100, fileExists: true, completeness: "full", duration: 156, groups: ["剪辑素材"], createdAt: "2026-11-18T08:00:00Z" };

try {
  for (const width of [1220, 860, 390]) {
    const page = await browser.newPage({ viewport: { width, height: width === 860 ? 600 : 900 } });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    let audioPayload, videoPayload;
    const songs = [job, { ...job, id: "second", title: "本地录音", artist: "录音者", platform: "local", groups: [] }];
    const videos = [
      { id: "video-1", title: "傍晚海浪", artist: "影像作者", platform: "bilibili", status: "completed", message: "视频已保存", createdAt: "2026-11-18T09:00:00Z", fileExists: true },
      { id: "video-2", title: "未完成旅行", platform: "douyin", status: "failed", interrupted: true, message: "上次未完成", createdAt: "2026-11-18T07:00:00Z" },
    ];
    await page.route("**/api/jobs", route => {
      if (route.request().method() === "GET") return route.fulfill({ json: songs });
      audioPayload = route.request().postDataJSON();
      return route.fulfill({ json: { ...job, status: "queued" } });
    });
    await page.route("**/api/queue", route => route.fulfill({ json: {
      paused: false, active: 0, waiting: 0, limit: 10,
      lastSummary: { completed: 1, failed: 0, at: new Date().toISOString() },
    } }));
    await page.route("**/api/videos", route => route.fulfill({ json: videos }));
    await page.route("https://fixture.example/video-cover.jpg", route => route.fulfill({ path: "src/assets/playlist-dusk.jpg" }));
    await page.route("**/api/video/resolve", route => route.fulfill({ json: {
      id: "video-preview", title: "沿着海岸线看日落，穿过黄昏的最后一班列车 #旅行随拍 #傍晚",
      cover: "https://fixture.example/video-cover.jpg", platform: "bilibili", height: 720, duration: 52,
    } }));
    await page.route("**/api/video", route => {
      videoPayload = route.request().postDataJSON();
      return route.fulfill({ json: videos[0] });
    });
    await page.route("**/api/recovery", route => route.fulfill({ json: [
      { id: "video-2", title: "未完成旅行", kind: "video", action: "resume", message: "上次未完成" },
    ] }));
    await page.route("**/api/storage/check-folder", route => route.fulfill({ json: { path: route.request().postDataJSON().path } }));
    await page.route("**/api/library/organize", route => {
      assert.deepEqual(route.request().postDataJSON(), { ids: ["second"], action: "add-group", value: "剪辑素材" });
      songs[1] = { ...songs[1], groups: ["剪辑素材"] };
      return route.fulfill({ json: { jobs: [songs[1]], playlists: ["剪辑素材"] } });
    });
    const outputs = { audio: "/fixture/audio", video: "/fixture/video" };
    await page.route(/\/api\/storage(\?|$)/, route => {
      const request = route.request();
      const kind = request.method() === "POST"
        ? request.postDataJSON().kind
        : new URL(request.url()).searchParams.get("kind");
      if (request.method() === "POST") outputs[kind] = request.postDataJSON().outputDir;
      return route.fulfill({ json: { outputDir: outputs[kind ?? "audio"], defaultOutputDir: "/fixture/" + kind, available: true, nativePicker: false, freeBytes: 5 * 1024 ** 3 } });
    });
    await page.route("**/api/library/settings", route => route.fulfill({ json: { naming: "artist-title", embedCover: true } }));
    await page.route("**/api/library/match", route => route.fulfill({ json: { job: null } }));
    await page.route("**/api/resolve", route => route.request().postDataJSON().input === playlistLink
      ? route.fulfill({ status: 400, json: { error: "这是汽水歌单。可以先打开歌单，再选择要提取的歌曲。" } })
      : route.fulfill({ json: {
        token: "demo-resource", platform: "qishui", sourceId: "demo", title: "试听样本", artist: "样本歌手", duration: 60,
        expectedDuration: 180, completeness: "preview", note: "", choices: [
          { id: "test-quality", label: "AAC · 128 kbps", format: "aac", bitrate: 128000 },
          { id: "higher-quality", label: "AAC · 320 kbps", format: "aac", bitrate: 320000 },
        ],
      } }));
    await page.route("**/api/playlists", route => {
      const { input, browse } = route.request().postDataJSON();
      assert.ok(input === playlistLink || input === playlistId);
      assert.equal(browse, true);
      return route.fulfill({ json: {
        source: { title: "测试歌单", reachedEnd: true },
        tracks: [{ id: trackId, title: "歌单里的歌曲", artist: "测试歌手", duration: 150 }],
      } });
    });
    const song = { id: trackId, title: "搜索到的歌曲", artist: "样本", duration: 150 };
    const fullSong = { id: "7420006432714688522", title: job.title, artist: job.artist, duration: 156 };
    const previewJob = { ...job, id: "preview-job", title: song.title, completeness: "preview", status: "downloading", message: "" };
    await page.route("**/api/discovery/my-playlists", route => route.fulfill({ json: {
      items: [{ id: playlistId, title: "我喜欢的音乐", count: 1 }],
    } }));
    let confirmation;
    await page.route("**/api/discovery/search", route => route.fulfill({ json: { items: [song, fullSong] } }));
    let previewAttempts = 0;
    await page.route("**/api/discovery/preview", route => {
      assert.equal(route.request().postDataJSON().id, trackId);
      if (++previewAttempts === 1) return route.fulfill({ status: 400, json: { error: "暂时无法试听" } });
      return route.fulfill({ body: Buffer.alloc(32), contentType: "audio/mpeg" });
    });
    await page.route("**/api/discovery/batches", route => {
      if (route.request().method() === "GET") return route.fulfill({ json: [
        { id: "demo-batch", title: "测试批次", total: 2, status: "ready", createdAt: new Date().toISOString() },
      ] });
      confirmation = route.request().postDataJSON();
      return route.fulfill({ json: { id: "demo-batch" } });
    });
    await page.route("**/api/discovery/batches/demo-batch", route => route.fulfill({ json: {
      id: "demo-batch", status: "ready",
      items: [
        { id: "demo-item", track: song, status: "submitted", jobId: previewJob.id, resource: { completeness: "preview" } },
        { id: "ready-item", track: fullSong, status: "submitted", jobId: job.id, message: "已加入音频队列" },
      ],
    } }));
    await page.goto(process.env.SHIYIN_TEST_URL || "http://127.0.0.1:4173");
    const nav = name => page.getByRole("navigation", { name: "主导航" }).getByRole("button", { name, exact: true });
    const capture = async name => {
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, name + " overflows at " + width);
      if (process.env.SHIYIN_TEST_SCREENSHOTS) await page.screenshot({ path: process.env.SHIYIN_TEST_SCREENSHOTS + "/" + name + "-" + width + ".png", animations: "disabled" });
    };
    assert.equal(await page.getByRole("tab", { name: "批量链接", exact: true }).count(), 0);
    assert.equal(await page.getByText("找歌与测试链接", { exact: true }).count(), 0);
    await page.getByRole("tab", { name: "汽水音乐", exact: true }).click();
    await page.getByRole("heading", { name: "搜索与歌单", exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "解析队列", exact: true }).count(), 0);
    await page.getByRole("button", { name: "我的歌单", exact: true }).click();
    await page.getByRole("button", { name: "打开我喜欢", exact: true }).click();
    assert.equal(await page.getByRole("button", { name: "读取我的歌单", exact: true }).count(), 0);
    await page.getByRole("heading", { name: "测试歌单", exact: true }).waitFor();
    await capture("discovery-playlist");
    await page.getByRole("button", { name: "返回歌单", exact: true }).click();
    await page.getByRole("button", { name: "打开我喜欢", exact: true }).waitFor();
    await page.getByRole("button", { name: "搜索歌曲", exact: true }).click();
    await page.getByRole("textbox", { name: "歌名或歌手", exact: true }).fill("样本");
    await page.getByRole("button", { name: "搜索", exact: true }).click();
    await page.getByRole("button", { name: "试听 搜索到的歌曲", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "暂时无法试听" }).waitFor();
    await page.getByRole("button", { name: "重试试听 搜索到的歌曲", exact: true }).click();
    await page.locator(".discovery audio").waitFor();
    await page.getByRole("button", { name: "关闭试听" }).click();
    assert.equal(await page.locator(".discovery audio").count(), 0);
    await page.getByRole("button", { name: "多选", exact: true }).click();
    await page.getByRole("checkbox", { name: "全选当前结果" }).check();
    await capture("discovery-selection");
    songs.push(previewJob);
    await page.getByRole("button", { name: "解析并下载" }).click();
    const batchToggle = page.getByRole("button", { name: "汽水批次", exact: true });
    assert.equal(await batchToggle.getAttribute("aria-expanded"), "false");
    await batchToggle.click();
    await page.getByText("已解析 2 / 2 首", { exact: true }).waitFor();
    assert.deepEqual(confirmation.tracks, [song, fullSong]);
    assert.equal(confirmation.format, "mp3");
    assert.equal(confirmation.allowPreview, true);
    assert.equal(await page.getByRole("button", { name: "音频", exact: true }).getAttribute("aria-pressed"), "true");
    await page.locator(".discovery-batch-list").getByText("已保存", { exact: true }).waitFor();
    await capture("tasks-discovery");
    assert.equal(await page.getByRole("button", { name: "查看并保存", exact: true }).count(), 0);
    previewJob.status = "failed";
    previewJob.message = "平台暂未提供可用音频";
    await page.getByRole("alert").filter({ hasText: "1 首音频无法获取或保存" }).waitFor();
    await page.locator(".discovery-batch-list").getByText(previewJob.message, { exact: true }).waitFor();
    await capture("tasks-discovery-failed");
    await nav("设置").click();
    await nav("任务").click();
    assert.equal(await batchToggle.count(), 0);
    const batchTypes = page.getByRole("group", { name: "按文件类型筛选任务", exact: true });
    await batchTypes.getByRole("button", { name: "视频", exact: true }).click();
    assert.equal(await batchToggle.count(), 0);
    await batchTypes.getByRole("button", { name: "音频", exact: true }).click();
    assert.equal(await batchToggle.getAttribute("aria-expanded"), "false");
    previewJob.status = "completed";
    await batchToggle.waitFor({ state: "detached" });
    songs.pop();
    await nav("音频提取").click();
    await page.getByRole("tab", { name: "分享链接", exact: true }).click();
    await page.waitForFunction(() => document.querySelector(".recent-source .qishui img")?.naturalWidth === 128);
    const scrollbar = await page.evaluate(() => {
      const styles = getComputedStyle(document.documentElement);
      return [styles.scrollbarWidth, styles.scrollbarColor];
    });
    assert.deepEqual(scrollbar, ["thin", "rgb(118, 93, 86) rgb(27, 21, 21)"]);

    const link = page.getByRole("textbox", { name: "歌曲或视频分享链接" });
    await link.click();
    const focusStyles = () => link.evaluate(input => [
      getComputedStyle(input).outlineStyle,
      getComputedStyle(input.closest(".share-field")).outlineStyle,
    ]);
    assert.deepEqual(await focusStyles(), ["none", "none"]);
    await page.keyboard.press("Tab");
    await page.keyboard.press("Shift+Tab");
    assert.deepEqual(await focusStyles(), ["none", "solid"]);

    await link.fill(playlistLink);
    await page.getByRole("button", { name: "解析链接", exact: true }).click();
    await page.getByRole("button", { name: "打开歌单", exact: true }).click();
    await page.getByRole("heading", { name: "测试歌单", exact: true }).waitFor();
    await page.getByRole("button", { name: "选择歌曲", exact: true }).click();
    assert.equal(await link.inputValue(), "https://music.douyin.com/qishui/share/track?track_id=" + trackId);

    await page.getByRole("button", { name: "解析链接", exact: true }).click();
    await page.getByText("/fixture/audio", { exact: true }).waitFor();
    const result = page.getByRole("region", { name: "解析结果", exact: true });
    assert.equal(await result.getByRole("combobox", { name: "来源音质", exact: true }).count(), 0);
    assert.equal(await result.getByText("音质说明", { exact: true }).count(), 0);
    assert.equal(await result.getByRole("button", { name: "本次更改", exact: true }).count(), 0);
    const submitAudio = page.getByRole("button", {name: "保存试听片段", exact: true});
    assert.equal(await submitAudio.isEnabled(), true);
    assert.equal(await page.getByRole("checkbox", {name: "我知道这是试听，保存此片段"}).count(), 0);
    await page.getByRole("combobox", {name: "保存格式", exact: true}).selectOption("m4a");
    const songOptions = result.getByRole("button", { name: "整理歌曲信息", exact: true });
    assert.equal(await songOptions.getAttribute("aria-expanded"), "false");
    await songOptions.click();
    await result.getByRole("textbox", { name: "歌曲标题", exact: true }).fill("整理后的歌曲");
    await songOptions.click();
    await capture("audio");
    const audioSaved = page.waitForResponse(response => response.url().endsWith("/api/jobs") && response.request().method() === "POST");
    await submitAudio.click();
    assert.equal((await audioSaved).ok(), true);
    assert.equal(await page.getByText("已加入提取任务", { exact: true }).count(), 0);
    assert.deepEqual({ outputDir: audioPayload.outputDir, format: audioPayload.format, choice: audioPayload.choice, allowPreview: audioPayload.allowPreview, title: audioPayload.metadata.title },
      { outputDir: undefined, format: "m4a", choice: "higher-quality", allowPreview: true, title: "整理后的歌曲" });
    await page.getByRole("tab", { name: "本地文件", exact: true }).click();
    await result.getByRole("heading", { name: "等待添加本地文件", exact: true }).waitFor();
    assert.equal(await result.getByRole("heading", { name: "试听样本", exact: true }).count(), 0);
    assert.equal(await submitAudio.count(), 0);
    await capture("audio-local-empty");
    await page.locator(".jobs-section").getByRole("button", { name: "查看全部", exact: true }).click();
    assert.equal(await page.getByRole("button", { name: "音频", exact: true }).getAttribute("aria-pressed"), "true");

    const changeFolder = async path => {
      await page.getByRole("button", {name: "本次更改", exact: true}).click();
      await page.getByRole("textbox", {name: "本次保存文件夹", exact: true}).fill(path);
      await page.getByRole("button", {name: "使用此位置", exact: true}).click();
      await page.getByText(path, {exact: true}).waitFor();
    };
    const savedVideos = videos.splice(0);
    const videoRecent = page.getByRole("region", { name: "最近视频任务", exact: true });
    await nav("视频提取").click();
    await videoRecent.getByText("暂无视频任务", { exact: true }).waitFor();
    assert.equal(await videoRecent.getByRole("button", { name: "暂停视频队列" }).count(), 0);
    await videoRecent.getByRole("button", { name: "查看全部", exact: true }).click();
    assert.equal(await page.getByRole("button", { name: "视频", exact: true }).getAttribute("aria-pressed"), "true");
    videos.push(...savedVideos);
    await nav("视频提取").click();
    await page.getByRole("textbox", {name: "分享链接或分享文案"}).fill("https://www.bilibili.com/video/BV1Sample");
    await page.getByRole("button", {name: "解析链接", exact: true}).click();
    await page.getByText("720p", {exact: true}).waitFor();
    await page.getByText("/fixture/video", {exact: true}).waitFor();
    await changeFolder("/fixture/video-once");
    await capture("video");
    await page.getByRole("button", {name: "保存视频", exact: true}).click();
    await page.locator(".video-resolution").getByText("已保存", {exact: true}).waitFor();
    assert.deepEqual(videoPayload, {previewId: "video-preview", outputDir: "/fixture/video-once"});
    assert.deepEqual(outputs, { audio: "/fixture/audio", video: "/fixture/video" });
    await videoRecent.locator(".video-result").filter({hasText:"傍晚海浪"}).getByText("B 站", {exact:true}).waitFor();
    await videoRecent.locator(".video-result").filter({hasText:"未完成旅行"}).getByText("抖音", {exact:true}).waitFor();
    await capture("video-sources");

    await page.locator(".video-recent").getByRole("button", { name: "查看全部", exact: true }).click();
    const tasks = page.getByRole("region", {name: "提取任务", exact: true});
    const taskTypes = page.getByRole("group", {name: "按文件类型筛选任务", exact: true});
    assert.equal(await taskTypes.getByRole("button", {name: "视频", exact: true}).getAttribute("aria-pressed"), "true");
    assert.equal(await tasks.getByRole("heading", {name: "测试歌曲"}).count(), 0);
    await taskTypes.getByRole("button", {name: "全部任务", exact: true}).click();
    await tasks.getByRole("heading", {name: "测试歌曲"}).waitFor();
    await tasks.getByRole("heading", {name: "傍晚海浪"}).waitFor();
    assert.equal(await page.getByText(/本次运行最近一批/).count(), 0);
    await capture("tasks");
    await page.getByRole("textbox", {name: "搜索任务"}).fill("影像作者");
    await tasks.getByRole("heading", {name: "傍晚海浪"}).waitFor();
    assert.equal(await tasks.getByRole("article").count(), 1);
    await page.getByRole("button", {name: "查看待恢复", exact: true}).click();
    await page.getByRole("checkbox", {name: "恢复 未完成旅行", exact: true}).waitFor();

    await nav("歌单").click();
    await page.getByRole("button", {name: /剪辑素材.*1 首/}).click();
    const songList = page.getByRole("region", {name: "歌曲列表", exact: true});
    await songList.getByRole("heading", {name: "测试歌曲", exact: true}).waitFor();
    await capture("library");
    const alignment = async (picker, captureName) => {
      await picker.click();
      const dx = await picker.evaluate(select => select.options[0].getBoundingClientRect().left - select.getBoundingClientRect().left);
      assert.ok(dx >= 0 && dx <= 8, `dropdown should align with trigger (offset: ${dx}px)`);
      await capture(captureName);
      await page.keyboard.press("Escape");
    };
    await alignment(page.getByRole("combobox", { name: "排序", exact: true }), "aligned-sort");

    await page.getByRole("button", {name: "添加歌曲", exact: true}).click();
    await songList.getByRole("checkbox", {name: "选择音频 本地录音", exact: true}).check();
    await page.getByRole("button", {name: "添加所选歌曲", exact: true}).click();
    await page.getByRole("heading", {name: "剪辑素材", exact: true}).waitFor();
    const searchSongs = page.getByRole("textbox", {name: "搜索音频库", exact: true});
    await searchSongs.fill("录音者");
    await songList.getByRole("heading", {name: "本地录音", exact: true}).waitFor();
    assert.equal(await songList.getByRole("article").count(), 1);
    await page.getByRole("button", {name: "多选", exact: true}).click();
    assert.equal(await page.getByRole("button", {name: "导出播放列表", exact: true}).count(), 0);
    await songList.getByRole("checkbox", {name: "选择音频 本地录音", exact: true}).check();
    await page.getByRole("button", {name: "导出播放列表", exact: true}).waitFor();
    await page.getByRole("button", {name: "筛选", exact: true}).click();
    await page.getByRole("combobox", {name: "文件格式", exact: true}).waitFor();
    const kindPicker = page.getByRole("combobox", {name: "音频类型", exact: true});
    const pickerAppearance = await kindPicker.evaluate(select => [
      getComputedStyle(select).appearance,
      getComputedStyle(select, "::picker(select)").backgroundColor,
    ]);
    assert.deepEqual(pickerAppearance, ["base-select", "rgb(51, 39, 36)"]);
    await kindPicker.click();
    assert.equal(await kindPicker.evaluate(select => select.matches(":open")), true);
    await capture("filters-open");
    await page.keyboard.press("Escape");
    assert.equal(await kindPicker.evaluate(select => select.matches(":open")), false);
    assert.equal(await page.getByText("打开保存目录", {exact: true}).count(), 0);
    assert.equal(await page.getByText("统一音量", {exact: true}).count(), 0);
    await searchSongs.clear();
    const selectAll = page.getByRole("checkbox", {name: "全选", exact: true});
    assert.equal(await selectAll.evaluate(input => input.indeterminate), true);
    await selectAll.check();
    assert.equal(await songList.getByRole("checkbox", {checked: true}).count(), 2);
    await capture("library-selection");
    await selectAll.uncheck();
    assert.equal(await songList.getByRole("checkbox", {checked: true}).count(), 0);


    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("button", { name: "文件保存", exact: true }).click();
    await alignment(page.getByRole("combobox", { name: "输出默认格式", exact: true }), "aligned-format");

    const audio = page.getByRole("textbox", { name: "音频保存文件夹路径" });
    const video = page.getByRole("textbox", { name: "视频保存文件夹路径" });
    await video.fill("/fixture/new-video");
    await page.getByRole("region", { name: "视频文件夹", exact: true }).getByRole("button", { name: "应用保存位置" }).click();
    await page.getByText("保存位置已更新", { exact: false }).waitFor();
    assert.equal(await audio.inputValue(), "/fixture/audio");
    assert.equal(outputs.video, "/fixture/new-video");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    if (width === 1220) {
      const gap = await page.evaluate(() => document.querySelector(".bottom-player").getBoundingClientRect().top - document.querySelector(".settings-pane").getBoundingClientRect().bottom);
      assert.ok(Math.abs(gap - 16) < 2, "settings stretch to the player inset");
    }
    if (process.env.SHIYIN_TEST_SCREENSHOTS) {
      await page.screenshot({ path: process.env.SHIYIN_TEST_SCREENSHOTS + "/settings-" + width + ".png" });
    }
    await page.getByRole("button", { name: "通用", exact: true }).click();
    await page.getByRole("heading", { name: "音频封面", exact: true }).waitFor();
    assert.equal(await page.getByRole("checkbox", { name: "将可用封面写入音频" }).getAttribute("aria-describedby"), "artwork-help");
    assert.equal(await page.getByRole("heading", { name: "导出预设", exact: true }).count(), 0);
    const repeat = page.getByRole("button", { name: "播放模式：顺序播放", exact: true });
    await repeat.click();
    const repeatNotice = page.getByRole("status").filter({ hasText: /^列表循环$/ });
    assert.equal(await repeatNotice.evaluate(notice => {
      const label = notice.getBoundingClientRect();
      const button = notice.previousElementSibling.getBoundingClientRect();
      return label.bottom < button.top && Math.abs((label.left + label.right) - (button.left + button.right)) < 2;
    }), true);
    await capture("player-repeat");
    await page.getByRole("button", { name: "数据与维护", exact: true }).click();
    await capture("settings-maintenance");

    songs.push(...Array.from({ length: 22 }, (_, index) => ({
      ...job, groups: [], id: `page-${index + 1}`, title: `分页样本 ${index + 1}`,
      createdAt: new Date(Date.UTC(2026, 10, 18, 10, 0, index)).toISOString(),
    })));
    await nav("歌单").click();
    await page.getByRole("button", { name: "完成选择", exact: true }).click();
    await page.getByRole("button", { name: /^全部歌曲/ }).click();
    const songsPager = page.getByRole("navigation", { name: "歌曲列表分页", exact: true });
    await songsPager.getByText("第 1 / 3 页", { exact: true }).waitFor();
    assert.equal(await songList.getByRole("article").count(), 10);
    await songsPager.getByRole("button", { name: "下一页", exact: true }).click();
    await songList.getByRole("heading", { name: "分页样本 12", exact: true }).waitFor();
    assert.equal(await songList.getByRole("article").first().locator(".library-index span").innerText(), "11");
    await capture("library-page-two");
    await searchSongs.fill("分页样本 22");
    await songList.getByRole("heading", { name: "分页样本 22", exact: true }).waitFor();
    assert.equal(await songsPager.count(), 0);
    await nav("任务").click();
    await taskTypes.getByRole("button", { name: "音频", exact: true }).click();
    const taskPager = page.getByRole("navigation", { name: "任务列表分页", exact: true });
    await taskPager.getByRole("button", { name: "下一页", exact: true }).click();
    await taskPager.getByRole("button", { name: "下一页", exact: true }).click();
    await taskPager.getByText("第 3 / 3 页", { exact: true }).waitFor();
    assert.equal(await taskPager.getByRole("button", { name: "下一页", exact: true }).isDisabled(), true);
    assert.equal(await tasks.getByRole("article").count(), 4);
    await capture("tasks-last-page");
    await taskPager.getByRole("button", { name: "上一页", exact: true }).click();
    await taskPager.getByText("第 2 / 3 页", { exact: true }).waitFor();
    await page.getByRole("textbox", { name: "搜索任务" }).fill("分页样本 22");
    await tasks.getByRole("heading", { name: "分页样本 22", exact: true }).waitFor();
    assert.equal(await taskPager.count(), 0);
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log("PASS audio source switching, video layout and task navigation, library and task pagination, and existing workspace flows at three widths.");
} finally {
  await browser.close();
}
